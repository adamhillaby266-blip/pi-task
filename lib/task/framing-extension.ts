import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionEntry } from "../types.ts";
import {
  checkTaskContractReadiness,
  parseTaskContract,
  type ContractItem,
  type TaskContractV1,
} from "./contract.ts";
import { getTaskSessionBinding } from "./binding.ts";
import {
  getTaskFramingBranchState,
  TASK_FRAMING_CUSTOM_TYPE,
  TASK_FRAMING_EVENT_SCHEMA_VERSION,
  type TaskFramingBranchState,
} from "./framing-session.ts";
import { getTaskStore, taskStoreExists } from "./store.ts";
import type { TaskRecord } from "./types.ts";

const ITEM_STATUSES = ["confirmed", "agent_suggestion", "assumption"] as const;
const EVIDENCE_KINDS = ["user_message", "project_file", "project_rule", "task", "agent"] as const;
const SOURCE_AVAILABILITIES = ["available", "discover_during_run", "not_applicable", "missing"] as const;
const DELIVERABLE_KINDS = ["file", "data", "page", "decision_record", "external_action", "other"] as const;
const GATE_TIMINGS = ["before_run", "during_run", "before_external_effect", "before_review"] as const;

const EvidenceSchema = Type.Object({
  kind: StringEnum(EVIDENCE_KINDS),
  label: Type.String({ minLength: 1, maxLength: 1_000 }),
  ref: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
});

const ItemSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  text: Type.String({ minLength: 1, maxLength: 20_000 }),
  status: StringEnum(ITEM_STATUSES),
  evidence: Type.Optional(Type.Array(EvidenceSchema, { maxItems: 20 })),
});

const SourceSchema = Type.Object({
  ...ItemSchema.properties,
  availability: StringEnum(SOURCE_AVAILABILITIES),
});

const DeliverableSchema = Type.Object({
  ...ItemSchema.properties,
  kind: StringEnum(DELIVERABLE_KINDS),
  suggestedPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
});

const DecisionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  question: Type.String({ minLength: 1, maxLength: 20_000 }),
  blocking: Type.Boolean(),
  status: StringEnum(["open", "resolved"] as const),
  options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 100 })),
  resolution: Type.Optional(ItemSchema),
});

const GateSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  trigger: Type.String({ minLength: 1, maxLength: 10_000 }),
  requiredAction: Type.String({ minLength: 1, maxLength: 10_000 }),
  timing: StringEnum(GATE_TIMINGS),
});

const ContractSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  title: Type.String({ minLength: 1, maxLength: 240 }),
  outcome: ItemSchema,
  audience: Type.Array(ItemSchema, { maxItems: 100 }),
  authoritativeSources: Type.Array(SourceSchema, { maxItems: 100 }),
  scope: Type.Object({
    included: Type.Array(ItemSchema, { maxItems: 100 }),
    excluded: Type.Array(ItemSchema, { maxItems: 100 }),
  }),
  deliverables: Type.Array(DeliverableSchema, { maxItems: 100 }),
  acceptanceCriteria: Type.Array(ItemSchema, { maxItems: 100 }),
  constraints: Type.Array(ItemSchema, { maxItems: 100 }),
  assumptions: Type.Array(ItemSchema, { maxItems: 100 }),
  openDecisions: Type.Array(DecisionSchema, { maxItems: 100 }),
  gates: Type.Array(GateSchema, { maxItems: 100 }),
});

type BoundTask = Pick<
  TaskRecord,
  "id" | "title" | "goal" | "acceptanceCriteria" | "expectedOutput" | "status" | "version" | "activeRunId"
>;

export interface TaskFramingExtensionOptions {
  resolveTaskForSession?: (sessionId: string) => BoundTask | null;
  createId?: (prefix: "tfs" | "tfd") => string;
}

export class TaskFramingToolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "TaskFramingToolError";
  }
}

function defaultCreateId(prefix: "tfs" | "tfd"): string {
  return `${prefix}_${randomUUID()}`;
}

function defaultResolveTaskForSession(sessionId: string): BoundTask | null {
  const runtimeBinding = getTaskSessionBinding(sessionId);
  if (!taskStoreExists()) {
    if (runtimeBinding) {
      throw new TaskFramingToolError("TASK_BINDING_INVALID", "The prepared Task binding has no Task database");
    }
    return null;
  }
  const store = getTaskStore();
  const persisted = store.findTaskByPrimarySessionId(sessionId);
  const prepared = runtimeBinding ? store.getTaskDetail(runtimeBinding.taskId) : null;
  if (persisted && prepared && persisted.id !== prepared.id) {
    throw new TaskFramingToolError("TASK_BINDING_CONFLICT", "The Session is associated with two different Tasks");
  }
  return prepared ?? persisted;
}

function cleanRequiredText(value: string, field: string, maxLength: number): string {
  const text = value.trim();
  if (!text) throw new TaskFramingToolError("INVALID_INPUT", `${field} is required`);
  if (text.length > maxLength || text.includes("\0")) {
    throw new TaskFramingToolError("INVALID_INPUT", `${field} is invalid or too long`);
  }
  return text;
}

function extensionEntries(value: readonly unknown[]): SessionEntry[] {
  return value as SessionEntry[];
}

function branchState(ctx: { sessionManager: { getEntries(): readonly unknown[]; getLeafId(): string | null } }): TaskFramingBranchState {
  return getTaskFramingBranchState(
    extensionEntries(ctx.sessionManager.getEntries()),
    ctx.sessionManager.getLeafId(),
  );
}

function appendEntryAndReadId(
  appendEntry: (customType: string, data?: unknown) => void,
  ctx: { sessionManager: { getLeafId(): string | null } },
  data: unknown,
): string {
  const previousLeafId = ctx.sessionManager.getLeafId();
  appendEntry(TASK_FRAMING_CUSTOM_TYPE, data);
  const entryId = ctx.sessionManager.getLeafId();
  if (!entryId || entryId === previousLeafId) {
    throw new TaskFramingToolError("SESSION_APPEND_FAILED", "The candidate entry was not persisted in the active Session");
  }
  return entryId;
}

function suggestionUnavailableReason(state: TaskFramingBranchState, task: BoundTask | null): string | null {
  if (task) return `Session is already bound to Task ${task.id}`;
  if (state.declined) return "The user declined Task Framing on this Session branch";
  if (state.latestDraft) return `A candidate contract already exists at ${state.latestDraft.entry.id}`;
  if (state.pendingSuggestion) return `Suggestion ${state.pendingSuggestion.event.suggestionId} is still pending`;
  return null;
}

function assertProposalAllowed(state: TaskFramingBranchState, task: BoundTask | null): void {
  if (state.declined) {
    throw new TaskFramingToolError("FRAMING_DECLINED", "The user declined Task Framing on this branch; wait for an explicit reopened entry");
  }
  if (task?.activeRunId) {
    throw new TaskFramingToolError("ACTIVE_RUN_EXISTS", "The bound Task has an active Run; do not revise its contract during execution");
  }
  const draftTaskId = state.latestDraft?.event.taskId ?? null;
  if (draftTaskId && !task) {
    throw new TaskFramingToolError("TASK_BINDING_REQUIRED", `The latest candidate belongs to Task ${draftTaskId}, but this Session is not bound to it`);
  }
  if (draftTaskId && task && draftTaskId !== task.id) {
    throw new TaskFramingToolError("TASK_BINDING_CONFLICT", `The latest candidate belongs to Task ${draftTaskId}, not ${task.id}`);
  }
}

function statusText(item: ContractItem): string {
  return `[${item.status}] ${item.text}`;
}

function clip(value: string, maxLength: number): string {
  const text = value.trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function itemLines(label: string, items: ContractItem[], maxItems = 12): string {
  if (items.length === 0) return `${label}: none`;
  const lines = items.slice(0, maxItems).map((item) => `- ${clip(statusText(item), 1_200)}`);
  if (items.length > maxItems) lines.push(`- … ${items.length - maxItems} more item(s)`);
  return `${label}:\n${lines.join("\n")}`;
}

export function summarizeTaskContractForAgent(contract: TaskContractV1): string {
  const sources = contract.authoritativeSources.map((source) => ({
    ...source,
    text: `${source.text} (availability: ${source.availability})`,
  }));
  const deliverables = contract.deliverables.map((deliverable) => ({
    ...deliverable,
    text: `${deliverable.text} (kind: ${deliverable.kind}${deliverable.suggestedPath ? `; suggested path: ${deliverable.suggestedPath}` : ""})`,
  }));
  const decisions = contract.openDecisions.slice(0, 12).map((decision) => (
    `- [${decision.status}${decision.blocking ? "; blocking" : ""}] ${clip(decision.question, 1_200)}`
  ));
  const gates = contract.gates.slice(0, 12).map((gate) => (
    `- [${gate.timing}] ${clip(gate.trigger, 600)} → ${clip(gate.requiredAction, 600)}`
  ));
  const summary = [
    `Title: ${clip(contract.title, 240)}`,
    `Outcome: ${clip(statusText(contract.outcome), 2_000)}`,
    itemLines("Audience", contract.audience),
    itemLines("Authoritative sources", sources),
    itemLines("Included scope", contract.scope.included),
    itemLines("Excluded scope", contract.scope.excluded),
    itemLines("Deliverables", deliverables),
    itemLines("Acceptance criteria", contract.acceptanceCriteria),
    itemLines("Constraints", contract.constraints),
    itemLines("Assumptions", contract.assumptions),
    `Open decisions:\n${decisions.length > 0 ? decisions.join("\n") : "none"}`,
    `Gates:\n${gates.length > 0 ? gates.join("\n") : "none"}`,
  ].join("\n\n");
  return clip(summary, 24_000);
}

function boundTaskSummary(task: BoundTask): string {
  return clip([
    `Authoritative SQLite Task: ${task.id} · v${task.version} · ${task.status}`,
    `Title: ${task.title}`,
    `Goal: ${task.goal || "not recorded"}`,
    `Acceptance criteria: ${task.acceptanceCriteria || "not recorded"}`,
    `Expected output: ${task.expectedOutput || "not recorded"}`,
    task.activeRunId ? `Active Run: ${task.activeRunId}` : "Active Run: none",
  ].join("\n"), 12_000);
}

export function buildPiTaskWorkDiscipline(): string {
  return [
    "## Pi Task — Work discipline",
    "Use the existing workspace structure and loaded context files before inventing a new organization.",
    "Before changing files, inspect the relevant sources and choose the smallest effective deliverable. Do not move or overwrite original materials, create broad scaffolding, or change unrelated files unless the user or a confirmed Task agreement explicitly requires it.",
    "When source protection matters, keep generated work separate. Verify the real artifact in its actual format, then report changed paths, checks performed, exceptions, unverified items, and recovery guidance.",
    "These rules guide Agent behavior; they are not an operating-system sandbox.",
  ].join("\n");
}

export function buildTaskFramingSystemPrompt(state: TaskFramingBranchState, task: BoundTask | null): string {
  const latest = state.latestDraft;
  const readiness = latest ? checkTaskContractReadiness(latest.event.contract) : null;
  const current = latest ? [
    `Current candidate entry: ${latest.entry.id}`,
    `Draft: ${latest.event.draftId} revision ${latest.event.revision}`,
    `Candidate readiness: ${readiness?.ready ? "structurally ready for user confirmation" : `blocked (${readiness?.checks.filter((check) => !check.ready).map((check) => check.label).join(", ")})`}`,
    summarizeTaskContractForAgent(latest.event.contract),
    `To revise this candidate, call propose_task_contract with replacesEntryId exactly "${latest.entry.id}". Only the latest revision is authoritative as a candidate.`,
  ].join("\n\n") : "Current candidate: none.";
  const preference = state.declined
    ? "The user declined Task Framing on this branch. Do not proactively suggest or propose a contract until a user action appends a reopened entry."
    : state.pendingSuggestion
      ? `Suggestion ${state.pendingSuggestion.event.suggestionId} is pending. Do not suggest again; continue the conversation or propose only after the user accepts the direction.`
      : latest
        ? "A candidate already exists. Do not call suggest_task_framing again."
        : "If the conversation clearly involves a formal deliverable, cross-turn work, real verification, or consequential risk, you may call suggest_task_framing at most once. Do not use it to optimize Task counts or speed.";
  const authority = task ? boundTaskSummary(task) : "Authoritative SQLite Task: none for this Session.";
  const runRule = task?.activeRunId
    ? "The Task has an active Run. Never call propose_task_contract during that Run; use the Task pause/recovery path instead."
    : "propose_task_contract only appends a candidate Session entry. It cannot save or confirm a Task, start a Run, or authorize external effects.";
  return [
    "## Pi Task — Task Framing",
    "The conversation remains the center of the experience. Draft the task agreement yourself and ask only questions that would change the goal, authority, scope, permissions, or result.",
    preference,
    authority,
    runRule,
    current,
    "Mark every statement as confirmed, agent_suggestion, or assumption. Keep unresolved business choices in openDecisions. Never claim that a candidate is saved, confirmed, queued, started, or completed.",
  ].join("\n\n");
}

export function createTaskFramingExtension(options: TaskFramingExtensionOptions = {}): InlineExtension {
  const resolveTaskForSession = options.resolveTaskForSession ?? defaultResolveTaskForSession;
  const createId = options.createId ?? defaultCreateId;
  return {
    name: "pi-task-framing",
    factory: (pi) => {
      pi.on("before_agent_start", (event, ctx) => {
        const activeTools = pi.getActiveTools();
        const canChangeWorkspace = activeTools.some((tool) => tool === "write" || tool === "edit" || tool === "bash");
        const disciplinedPrompt = canChangeWorkspace
          ? `${event.systemPrompt}\n\n${buildPiTaskWorkDiscipline()}`
          : event.systemPrompt;
        if (!activeTools.includes("propose_task_contract")) {
          return canChangeWorkspace ? { systemPrompt: disciplinedPrompt } : undefined;
        }
        const state = branchState(ctx);
        const task = resolveTaskForSession(ctx.sessionManager.getSessionId());
        return {
          systemPrompt: `${disciplinedPrompt}\n\n${buildTaskFramingSystemPrompt(state, task)}`,
        };
      });

      pi.registerTool({
        name: "suggest_task_framing",
        label: "建议整理任务约定",
        description: "Record one low-pressure suggestion that the current conversation may benefit from a Pi Task agreement. This only appends non-context Session state; it never creates a Task or calls another model.",
        promptSnippet: "Suggest a Task agreement once when a formal deliverable, verification need, cross-turn effort, or consequential risk makes it useful",
        promptGuidelines: [
          "Use suggest_task_framing at most once on the active Session branch, and only when a Task agreement would materially improve delivery quality; never optimize for Task count or speed.",
        ],
        parameters: Type.Object({
          reason: Type.String({ minLength: 1, maxLength: 10_000 }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const state = branchState(ctx);
          const task = resolveTaskForSession(ctx.sessionManager.getSessionId());
          const unavailable = suggestionUnavailableReason(state, task);
          if (unavailable) {
            return {
              content: [{ type: "text", text: `Task Framing suggestion was not recorded: ${unavailable}.` }],
              details: { recorded: false, reason: unavailable },
            };
          }
          const reason = cleanRequiredText(params.reason, "reason", 10_000);
          const suggestionId = createId("tfs");
          const entryId = appendEntryAndReadId(pi.appendEntry.bind(pi), ctx, {
            schemaVersion: TASK_FRAMING_EVENT_SCHEMA_VERSION,
            eventType: "suggested",
            suggestionId,
            reason,
          });
          return {
            content: [{
              type: "text",
              text: "A low-pressure Task Framing suggestion was recorded in this Session. No Task or Run was created.",
            }],
            details: { recorded: true, entryId, suggestionId },
          };
        },
      });

      pi.registerTool({
        name: "propose_task_contract",
        label: "起草任务约定",
        description: "Append a structured TaskContractV1 candidate to the active Pi Session. The candidate is not saved or confirmed as a Task and does not start work.",
        promptSnippet: "Draft or revise a structured Pi Task agreement while preserving user authority",
        promptGuidelines: [
          "Use propose_task_contract only to record a candidate agreement drafted by the main Agent; it cannot confirm a Task, start a Run, or authorize an external effect.",
          "When revising an existing candidate, pass its exact latest entry id as replacesEntryId and summarize only the material changes.",
        ],
        parameters: Type.Object({
          contract: ContractSchema,
          replacesEntryId: Type.Union([
            Type.String({ minLength: 1, maxLength: 128 }),
            Type.Null(),
          ]),
          changeSummary: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 50 }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const state = branchState(ctx);
          const task = resolveTaskForSession(ctx.sessionManager.getSessionId());
          assertProposalAllowed(state, task);

          const latest = state.latestDraft;
          const replacesEntryId = params.replacesEntryId === null
            ? null
            : cleanRequiredText(params.replacesEntryId, "replacesEntryId", 128);
          if (latest && replacesEntryId !== latest.entry.id) {
            throw new TaskFramingToolError("DRAFT_STALE", `Latest candidate is ${latest.entry.id}; refresh before revising it`);
          }
          if (!latest && replacesEntryId !== null) {
            throw new TaskFramingToolError("DRAFT_STALE", "There is no candidate to replace on the active branch");
          }

          const contract = parseTaskContract(params.contract);
          const changeSummary = params.changeSummary.map((item, index) => (
            cleanRequiredText(item, `changeSummary[${index}]`, 2_000)
          ));
          const event = {
            schemaVersion: TASK_FRAMING_EVENT_SCHEMA_VERSION,
            eventType: "draft" as const,
            draftId: latest?.event.draftId ?? createId("tfd"),
            revision: (latest?.event.revision ?? 0) + 1,
            replacesEntryId,
            taskId: task?.id ?? null,
            baseTaskVersion: task?.version ?? null,
            contract,
            changeSummary,
            createdBy: "agent" as const,
          };
          const entryId = appendEntryAndReadId(pi.appendEntry.bind(pi), ctx, event);
          const readiness = checkTaskContractReadiness(contract);
          return {
            content: [{
              type: "text",
              text: `Candidate contract revision ${event.revision} was recorded in the Session at ${entryId}. It has not created or changed a Task or Run. ${readiness.ready ? "It is structurally ready for user confirmation." : "It still has blocking readiness checks."}`,
            }],
            details: {
              recorded: true,
              entryId,
              draftId: event.draftId,
              revision: event.revision,
              taskId: event.taskId,
              readiness,
            },
          };
        },
      });
    },
  };
}
