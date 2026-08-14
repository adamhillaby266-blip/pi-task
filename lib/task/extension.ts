import { StringEnum } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { clearTaskSessionBinding, type TaskSessionBinding } from "./binding";
import { projectTaskContractToLegacyFields } from "./contract";
import { aggregateDelegationUsage, runReadonlyDelegations } from "./moa";
import { getTaskStore } from "./store";
import { DELEGATION_PROFILES, type DelegationRecord } from "./types";

function activeBinding(binding: TaskSessionBinding): { runId: string; capability: string } {
  if (!binding.runId || !binding.capability) {
    throw new Error("No active Pi Task run is bound to this conversation");
  }
  getTaskStore().assertRunCapability(binding.runId, binding.capability);
  return { runId: binding.runId, capability: binding.capability };
}

function modelVisibleDelegationOutput(value: string): string {
  const maxBytes = 10 * 1024;
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= maxBytes) return value;
  let output = value.slice(0, maxBytes);
  while (Buffer.byteLength(output, "utf8") > maxBytes) output = output.slice(0, -1);
  return `${output}\n\n[Output truncated for parent context; ${totalBytes - Buffer.byteLength(output, "utf8")} bytes remain in the Task delegation record.]`;
}

function taskContext(binding: TaskSessionBinding): string {
  const detail = getTaskStore().getTaskDetail(binding.taskId);
  const run = binding.runId ? detail.runs.find((candidate) => candidate.id === binding.runId) : null;
  const snapshot = run?.contractSnapshot ?? null;
  const legacy = snapshot ? projectTaskContractToLegacyFields(snapshot) : null;
  return [
    `Pi Task ID: ${detail.id}`,
    `Title: ${snapshot?.title ?? detail.title}`,
    `Goal: ${legacy?.goal ?? detail.goal}`,
    `Acceptance criteria: ${legacy?.acceptanceCriteria ?? detail.acceptanceCriteria}`,
    `Expected output: ${legacy?.expectedOutput ?? detail.expectedOutput}`,
    snapshot ? `Run contract snapshot: revision ${run?.contractRevision ?? "unknown"}, Task version ${run?.taskVersionAtStart ?? "unknown"}` : "Run contract snapshot: legacy fields",
    `Project root: ${detail.project.rootPath}`,
    detail.recoveryNote ? `Latest return/recovery note: ${detail.recoveryNote}` : "",
  ].filter(Boolean).join("\n");
}

export interface TaskExtensionOptions {
  runReadonlyDelegations?: typeof runReadonlyDelegations;
  enableReadonlyDelegation?: boolean;
}

export function createTaskExtension(
  binding: TaskSessionBinding,
  options: TaskExtensionOptions = {},
): InlineExtension {
  const executeReadonlyDelegations = options.runReadonlyDelegations ?? runReadonlyDelegations;
  const enableReadonlyDelegation = options.enableReadonlyDelegation
    ?? process.env.PI_TASK_ENABLE_READONLY_MOA === "1";
  return {
    name: "pi-task",
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        if (!binding.runId || !binding.capability) return;
        const context = taskContext(binding);
        const guidance = [
          "Use read_task before implementation. Work only inside the project root.",
          "If a business decision or missing input blocks progress, use request_task_input.",
          ...(enableReadonlyDelegation ? [
            "When 2–4 independent read-only perspectives would materially reduce uncertainty, use delegate_readonly_agents; it requires explicit user confirmation and the parent Agent must synthesize the findings.",
          ] : []),
          "After implementation, verify the real artifact and call submit_task_review with changes, verification, unverified items, and risks.",
          "Do not claim that the task is done: only the user can accept a submitted review.",
        ].join(" ");
        return {
          systemPrompt: `${event.systemPrompt}\n\n## Active Pi Task\n${context}\n\n${guidance}`,
        };
      });

      pi.registerTool({
        name: "read_task",
        label: "读取 Pi Task",
        description: "Read the active Pi Task contract, latest return request, runs, artifacts, and review history.",
        parameters: Type.Object({}),
        async execute() {
          activeBinding(binding);
          const detail = getTaskStore().getTaskDetail(binding.taskId);
          const run = binding.runId ? detail.runs.find((candidate) => candidate.id === binding.runId) : null;
          const snapshot = run?.contractSnapshot ?? null;
          const legacy = snapshot ? projectTaskContractToLegacyFields(snapshot) : null;
          const result = {
            id: detail.id,
            title: snapshot?.title ?? detail.title,
            goal: legacy?.goal ?? detail.goal,
            acceptanceCriteria: legacy?.acceptanceCriteria ?? detail.acceptanceCriteria,
            expectedOutput: legacy?.expectedOutput ?? detail.expectedOutput,
            contract: snapshot,
            contractRevision: run?.contractRevision ?? detail.contractRevision,
            taskVersionAtStart: run?.taskVersionAtStart ?? null,
            status: detail.status,
            version: detail.version,
            projectRoot: detail.project.rootPath,
            recoveryNote: detail.recoveryNote,
            previousReviews: detail.reviews.map((review) => ({
              status: review.status,
              summary: review.summary,
              rejectionReason: review.rejectionReason,
              risks: review.risks,
            })),
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: { taskId: detail.id, status: detail.status },
          };
        },
      });

      if (enableReadonlyDelegation) pi.registerTool({
        name: "delegate_readonly_agents",
        label: "并行只读分析",
        description: "Ask 2 to 4 isolated, read-only Pi agents to inspect the active task from independent perspectives. Each child uses the parent model, can only read inside the registered project root, has no Pi Task capability, and cannot submit a Review. The user must confirm the extra model calls.",
        promptSnippet: "Run independent read-only analyses when multiple perspectives materially reduce task risk",
        promptGuidelines: [
          "Use delegate_readonly_agents only for evidence gathering, independent analysis, or skeptical review; the parent Agent remains responsible for synthesis, implementation, verification, and submit_task_review.",
        ],
        parameters: Type.Object({
          tasks: Type.Array(Type.Object({
            profile: StringEnum(DELEGATION_PROFILES, { description: "Fixed read-only specialist profile" }),
            prompt: Type.String({ description: "Focused question and expected evidence for this specialist" }),
          }), { minItems: 2, maxItems: 4 }),
        }),
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          const { runId, capability } = activeBinding(binding);
          const detail = getTaskStore().getTaskDetail(binding.taskId);
          const model = ctx.model;
          if (!model) throw new Error("The parent Pi Task run has no active model for delegation");
          if (!ctx.hasUI) {
            return {
              content: [{ type: "text", text: "Readonly multi-Agent analysis requires an interactive user confirmation." }],
              details: { taskId: binding.taskId, confirmed: false },
            };
          }
          const profiles = params.tasks.map((task) => task.profile).join("、");
          const confirmed = await ctx.ui.confirm(
            "启动多 Agent 只读分析？",
            `将并行启动 ${params.tasks.length} 个隔离子 Agent（${profiles}），使用 ${model.provider}/${model.id}。它们只能读取登记项目目录，不能修改文件或提交验收，但会产生额外模型调用。`,
          );
          if (!confirmed) {
            return {
              content: [{ type: "text", text: "The user declined the additional delegated model calls." }],
              details: { taskId: binding.taskId, confirmed: false },
            };
          }

          const requests = params.tasks.map((task) => ({
            profile: task.profile,
            prompt: `${taskContext(binding)}\n\nDelegated focus:\n${task.prompt}`,
          }));
          const store = getTaskStore();
          let records = store.beginDelegationBatch(runId, capability, requests, `${model.provider}/${model.id}`);
          const resultDetails = () => records.map((record: DelegationRecord) => ({
            id: record.id,
            profile: record.profile,
            status: record.status,
            model: record.model,
            usage: record.usage,
            error: record.error,
          }));
          onUpdate?.({
            content: [{ type: "text", text: `Readonly agents: 0/${records.length} completed` }],
            details: { taskId: binding.taskId, confirmed: true, delegations: resultDetails() },
          });

          try {
            const results = await executeReadonlyDelegations({
              cwd: detail.project.rootPath,
              model: { provider: model.provider, id: model.id },
              thinkingLevel: ctx.thinkingLevel ?? "off",
              requests: records.map((record) => ({ id: record.id, profile: record.profile, prompt: record.prompt })),
              signal,
              onResult: (result, completed, total) => {
                store.finishDelegation(result.id, capability, {
                  status: result.status,
                  output: result.output,
                  error: result.error ?? undefined,
                  usage: result.usage,
                });
                records = records.map((record) => record.id === result.id ? store.getDelegation(result.id) : record);
                onUpdate?.({
                  content: [{ type: "text", text: `Readonly agents: ${completed}/${total} completed` }],
                  details: { taskId: binding.taskId, confirmed: true, delegations: resultDetails() },
                });
              },
            });
            signal?.throwIfAborted();
            const sections = results.map((result) => [
              `### ${result.profile} — ${result.status}`,
              modelVisibleDelegationOutput(result.status === "succeeded" ? result.output : result.error || result.output || "No output"),
            ].join("\n\n"));
            return {
              content: [{
                type: "text",
                text: `Readonly multi-Agent analysis completed (${results.filter((result) => result.status === "succeeded").length}/${results.length} succeeded). The parent Agent must verify and synthesize these findings.\n\n${sections.join("\n\n---\n\n")}`,
              }],
              details: { taskId: binding.taskId, confirmed: true, delegations: resultDetails() },
              usage: aggregateDelegationUsage(results),
            };
          } catch (error) {
            for (const record of records) {
              if (store.getDelegation(record.id).status !== "running") continue;
              try {
                store.finishDelegation(record.id, capability, {
                  status: signal?.aborted ? "canceled" : "failed",
                  error: signal?.aborted ? "Delegated analysis was canceled" : error instanceof Error ? error.message : String(error),
                });
              } catch {
                // Parent Run lifecycle may already have settled the record.
              }
            }
            throw error;
          }
        },
      });

      pi.registerTool({
        name: "request_task_input",
        label: "请求人工决定",
        description: "Pause the active task and ask the user for a business decision or missing input.",
        parameters: Type.Object({
          question: Type.String({ description: "Specific question the user must answer" }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const { runId, capability } = activeBinding(binding);
          getTaskStore().markRunWaitingUser(runId, capability, params.question);
          const answer = await ctx.ui.input(`Pi Task 需要你决定：${params.question}`, "请输入决定或补充信息");
          if (answer === undefined || !answer.trim()) {
            return {
              content: [{ type: "text", text: "The user did not answer. Stop this run and leave a clear explanation." }],
              details: { taskId: binding.taskId, waiting: true },
            };
          }
          getTaskStore().resumeRun(runId, answer);
          return {
            content: [{ type: "text", text: `User response: ${answer}` }],
            details: { taskId: binding.taskId, waiting: false },
          };
        },
      });

      pi.registerTool({
        name: "submit_task_review",
        label: "提交任务验收",
        description: "Submit verified Pi Task artifacts for human review. This does not mark the task done.",
        parameters: Type.Object({
          summary: Type.String({ description: "Concise result summary" }),
          changes: Type.String({ description: "Files or outputs changed and what changed" }),
          verification: Type.String({ description: "Checks performed and their actual results" }),
          unverified: Type.Optional(Type.String({ description: "Anything not verified" })),
          risks: Type.Optional(Type.String({ description: "Remaining risks, or 'None'" })),
          artifacts: Type.Array(Type.Object({
            path: Type.String({ description: "Absolute path or path relative to the project root" }),
            kind: Type.Optional(Type.String({ description: "Artifact type, such as markdown, spreadsheet, or code" })),
            verification: Type.String({ description: "Artifact-specific verification result" }),
          }), { minItems: 1, maxItems: 20 }),
        }),
        async execute(_toolCallId, params) {
          const { runId, capability } = activeBinding(binding);
          const detail = getTaskStore().submitReview(runId, capability, {
            summary: params.summary,
            changes: params.changes,
            verification: params.verification,
            unverified: params.unverified,
            risks: params.risks,
            artifacts: params.artifacts,
          });
          clearTaskSessionBinding(binding);
          return {
            content: [{
              type: "text",
              text: `Task ${detail.id} was submitted for human review with ${detail.artifacts.length} recorded artifact(s). Do not mark it done.`,
            }],
            details: { taskId: detail.id, status: detail.status, artifactCount: detail.artifacts.length },
          };
        },
      });

      pi.on("agent_settled", (_event, ctx) => {
        if (!binding.runId || !binding.capability) return;
        const runId = binding.runId;
        const run = getTaskStore().getRun(runId);
        if (run.status === "starting" || run.status === "running" || run.status === "waiting_user") {
          getTaskStore().failRun(
            runId,
            "Agent stopped without submitting a review; resume in the same conversation",
            true,
          );
          ctx.ui.notify("Agent 未提交验收，本轮已标记为中断", "warning");
        }
        clearTaskSessionBinding(binding);
      });
    },
  };
}
