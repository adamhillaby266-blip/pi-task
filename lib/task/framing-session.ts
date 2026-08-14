import type { CustomEntry, CustomMessage, SessionEntry } from "../types.ts";
import {
  checkTaskContractReadiness,
  parseTaskContract,
  type TaskContractReadiness,
  type TaskContractV1,
} from "./contract.ts";

export const TASK_FRAMING_CUSTOM_TYPE = "pi-task.task-framing";
export const TASK_FRAMING_EVENT_SCHEMA_VERSION = 1 as const;

export type TaskFramingSuggestedEvent = {
  schemaVersion: typeof TASK_FRAMING_EVENT_SCHEMA_VERSION;
  eventType: "suggested";
  suggestionId: string;
  reason: string;
};

export type TaskFramingPreferenceEvent = {
  schemaVersion: typeof TASK_FRAMING_EVENT_SCHEMA_VERSION;
  eventType: "declined" | "reopened";
  suggestionId?: string;
};

export type TaskFramingDraftEvent = {
  schemaVersion: typeof TASK_FRAMING_EVENT_SCHEMA_VERSION;
  eventType: "draft";
  draftId: string;
  revision: number;
  replacesEntryId: string | null;
  taskId: string | null;
  baseTaskVersion: number | null;
  contract: TaskContractV1;
  changeSummary: string[];
  createdBy: "agent" | "system_legacy_adapter";
};

export type TaskFramingCommitReceiptEvent = {
  schemaVersion: typeof TASK_FRAMING_EVENT_SCHEMA_VERSION;
  eventType: "commit_receipt";
  operationId: string;
  sourceDraftEntryId: string;
  action: "save_draft" | "confirm" | "confirm_and_start";
  taskId: string;
  taskVersion: number;
  status: "succeeded" | "start_failed";
  message?: string;
};

export type TaskFramingSessionEventV1 =
  | TaskFramingSuggestedEvent
  | TaskFramingPreferenceEvent
  | TaskFramingDraftEvent
  | TaskFramingCommitReceiptEvent;

export interface TaskFramingMessageDetails {
  kind: "task_framing";
  entryId: string;
  event: TaskFramingSessionEventV1;
  readiness: TaskContractReadiness | null;
  isLatestDraft: boolean;
  supersededByEntryId: string | null;
  restoredAfterCompaction: boolean;
}

export interface ProjectedTaskFramingMessage {
  entryId: string;
  message: CustomMessage;
}

export interface TaskFramingUiProjection {
  byEntryId: ReadonlyMap<string, ProjectedTaskFramingMessage>;
  restored: ProjectedTaskFramingMessage | null;
  latestDraftEntryId: string | null;
}

export interface TaskFramingBranchEvent {
  entry: SessionEntry;
  event: TaskFramingSessionEventV1;
}

export interface TaskFramingBranchState {
  events: TaskFramingBranchEvent[];
  latestDraft: { entry: SessionEntry; event: TaskFramingDraftEvent } | null;
  latestPreference: { entry: SessionEntry; event: TaskFramingPreferenceEvent } | null;
  pendingSuggestion: { entry: SessionEntry; event: TaskFramingSuggestedEvent } | null;
  declined: boolean;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maxLength || text.includes("\0")) return null;
  return text;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return cleanString(value, maxLength) ?? undefined;
}

function nullableString(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  return cleanString(value, maxLength) ?? undefined;
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function nullablePositiveInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  return positiveInteger(value) ?? undefined;
}

function parseStringArray(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const parsed = value.map((item) => cleanString(item, maxLength));
  return parsed.every((item): item is string => item !== null) ? parsed : null;
}

export function parseTaskFramingSessionEvent(value: unknown): TaskFramingSessionEventV1 | null {
  if (!isRecord(value) || value.schemaVersion !== TASK_FRAMING_EVENT_SCHEMA_VERSION) return null;

  if (value.eventType === "suggested") {
    const suggestionId = cleanString(value.suggestionId, 128);
    const reason = cleanString(value.reason, 10_000);
    return suggestionId && reason ? {
      schemaVersion: TASK_FRAMING_EVENT_SCHEMA_VERSION,
      eventType: "suggested",
      suggestionId,
      reason,
    } : null;
  }

  if (value.eventType === "declined" || value.eventType === "reopened") {
    const suggestionId = optionalString(value.suggestionId, 128);
    if (value.suggestionId !== undefined && !suggestionId) return null;
    return {
      schemaVersion: TASK_FRAMING_EVENT_SCHEMA_VERSION,
      eventType: value.eventType,
      ...(suggestionId ? { suggestionId } : {}),
    };
  }

  if (value.eventType === "draft") {
    const draftId = cleanString(value.draftId, 128);
    const revision = positiveInteger(value.revision);
    const replacesEntryId = nullableString(value.replacesEntryId, 128);
    const taskId = nullableString(value.taskId, 256);
    const baseTaskVersion = nullablePositiveInteger(value.baseTaskVersion);
    const changeSummary = parseStringArray(value.changeSummary, 50, 2_000);
    const createdBy = value.createdBy === "agent" || value.createdBy === "system_legacy_adapter"
      ? value.createdBy
      : null;
    if (
      !draftId
      || revision === null
      || replacesEntryId === undefined
      || taskId === undefined
      || baseTaskVersion === undefined
      || !changeSummary
      || !createdBy
    ) return null;
    try {
      return {
        schemaVersion: TASK_FRAMING_EVENT_SCHEMA_VERSION,
        eventType: "draft",
        draftId,
        revision,
        replacesEntryId,
        taskId,
        baseTaskVersion,
        contract: parseTaskContract(value.contract),
        changeSummary,
        createdBy,
      };
    } catch {
      return null;
    }
  }

  if (value.eventType === "commit_receipt") {
    const operationId = cleanString(value.operationId, 256);
    const sourceDraftEntryId = cleanString(value.sourceDraftEntryId, 128);
    const taskId = cleanString(value.taskId, 256);
    const taskVersion = positiveInteger(value.taskVersion);
    const action = value.action === "save_draft" || value.action === "confirm" || value.action === "confirm_and_start"
      ? value.action
      : null;
    const status = value.status === "succeeded" || value.status === "start_failed" ? value.status : null;
    const message = optionalString(value.message, 10_000);
    if (value.message !== undefined && !message) return null;
    if (!operationId || !sourceDraftEntryId || !taskId || taskVersion === null || !action || !status) return null;
    return {
      schemaVersion: TASK_FRAMING_EVENT_SCHEMA_VERSION,
      eventType: "commit_receipt",
      operationId,
      sourceDraftEntryId,
      action,
      taskId,
      taskVersion,
      status,
      ...(message ? { message } : {}),
    };
  }

  return null;
}

export function parseTaskFramingEntry(entry: SessionEntry): TaskFramingSessionEventV1 | null {
  if (entry.type !== "custom" || entry.customType !== TASK_FRAMING_CUSTOM_TYPE) return null;
  return parseTaskFramingSessionEvent((entry as CustomEntry).data);
}

export function getActiveSessionBranch(entries: readonly SessionEntry[], leafId?: string | null): SessionEntry[] {
  if (leafId === null || entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = leafId === undefined ? entries.at(-1) : byId.get(leafId);
  if (!current) return [];

  const reverse: SessionEntry[] = [];
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    reverse.push(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  reverse.reverse();
  return reverse;
}

export function getTaskFramingBranchState(
  entries: readonly SessionEntry[],
  leafId?: string | null,
): TaskFramingBranchState {
  const events = getActiveSessionBranch(entries, leafId).flatMap((entry) => {
    const event = parseTaskFramingEntry(entry);
    return event ? [{ entry, event }] : [];
  });
  const latestDraft = events.findLast((item): item is { entry: SessionEntry; event: TaskFramingDraftEvent } => (
    item.event.eventType === "draft"
  )) ?? null;
  const latestPreference = events.findLast((item): item is { entry: SessionEntry; event: TaskFramingPreferenceEvent } => (
    item.event.eventType === "declined" || item.event.eventType === "reopened"
  )) ?? null;
  const latestSuggestionIndex = events.findLastIndex((item) => item.event.eventType === "suggested");
  const suggestionHandled = latestSuggestionIndex >= 0 && events.slice(latestSuggestionIndex + 1).some((item) => (
    item.event.eventType === "draft"
    || item.event.eventType === "declined"
    || item.event.eventType === "reopened"
  ));
  const pendingSuggestion = latestSuggestionIndex >= 0 && !suggestionHandled
    ? events[latestSuggestionIndex] as { entry: SessionEntry; event: TaskFramingSuggestedEvent }
    : null;
  return {
    events,
    latestDraft,
    latestPreference,
    pendingSuggestion,
    declined: latestPreference?.event.eventType === "declined",
  };
}

function eventSummary(event: TaskFramingSessionEventV1): string {
  switch (event.eventType) {
    case "suggested":
      return `Pi Task 建议整理任务约定：${event.reason}`;
    case "declined":
      return "用户选择本次不整理为任务。";
    case "reopened":
      return "用户重新打开任务约定。";
    case "draft":
      return `任务约定草案 ${event.revision}：${event.contract.title}`;
    case "commit_receipt":
      return event.status === "start_failed"
        ? `任务 ${event.taskId} 已确认，但启动失败。`
        : `任务约定操作已完成：${event.taskId}`;
  }
}

function createProjectedMessage(
  entry: SessionEntry,
  event: TaskFramingSessionEventV1,
  options: {
    isLatestDraft: boolean;
    supersededByEntryId: string | null;
    restoredAfterCompaction: boolean;
  },
): ProjectedTaskFramingMessage {
  const readiness = event.eventType === "draft" ? checkTaskContractReadiness(event.contract) : null;
  const timestamp = Date.parse(entry.timestamp);
  const details: TaskFramingMessageDetails = {
    kind: "task_framing",
    entryId: entry.id,
    event,
    readiness,
    isLatestDraft: options.isLatestDraft,
    supersededByEntryId: options.supersededByEntryId,
    restoredAfterCompaction: options.restoredAfterCompaction,
  };
  return {
    entryId: entry.id,
    message: {
      role: "custom",
      customType: TASK_FRAMING_CUSTOM_TYPE,
      content: eventSummary(event),
      display: true,
      details,
      ...(!Number.isNaN(timestamp) ? { timestamp } : {}),
    },
  };
}

export function projectTaskFramingForUi(
  entries: readonly SessionEntry[],
  leafId: string | null | undefined,
  selectedContextEntryIds: readonly string[],
): TaskFramingUiProjection {
  const parsed = getTaskFramingBranchState(entries, leafId).events;
  const drafts = parsed.filter((item): item is { entry: SessionEntry; event: TaskFramingDraftEvent } => item.event.eventType === "draft");
  const latestDraft = drafts.at(-1) ?? null;
  const nextDraftByEntryId = new Map<string, string>();
  for (let index = 0; index < drafts.length - 1; index += 1) {
    nextDraftByEntryId.set(drafts[index].entry.id, drafts[index + 1].entry.id);
  }

  const byEntryId = new Map<string, ProjectedTaskFramingMessage>();
  for (const item of parsed) {
    byEntryId.set(item.entry.id, createProjectedMessage(item.entry, item.event, {
      isLatestDraft: item.event.eventType === "draft" && item.entry.id === latestDraft?.entry.id,
      supersededByEntryId: item.event.eventType === "draft" ? nextDraftByEntryId.get(item.entry.id) ?? null : null,
      restoredAfterCompaction: false,
    }));
  }

  const selected = new Set(selectedContextEntryIds);
  const restored = latestDraft && !selected.has(latestDraft.entry.id)
    ? createProjectedMessage(latestDraft.entry, latestDraft.event, {
        isLatestDraft: true,
        supersededByEntryId: null,
        restoredAfterCompaction: true,
      })
    : null;

  return {
    byEntryId,
    restored,
    latestDraftEntryId: latestDraft?.entry.id ?? null,
  };
}

export function readTaskFramingMessageDetails(value: unknown): TaskFramingMessageDetails | null {
  if (!isRecord(value) || value.kind !== "task_framing") return null;
  const entryId = cleanString(value.entryId, 128);
  const event = parseTaskFramingSessionEvent(value.event);
  if (!entryId || !event || typeof value.isLatestDraft !== "boolean" || typeof value.restoredAfterCompaction !== "boolean") {
    return null;
  }
  const supersededByEntryId = nullableString(value.supersededByEntryId, 128);
  if (supersededByEntryId === undefined) return null;
  const readiness = event.eventType === "draft" ? checkTaskContractReadiness(event.contract) : null;
  return {
    kind: "task_framing",
    entryId,
    event,
    readiness,
    isLatestDraft: value.isLatestDraft,
    supersededByEntryId,
    restoredAfterCompaction: value.restoredAfterCompaction,
  };
}

export function isTaskFramingCustomMessage(message: { role?: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === TASK_FRAMING_CUSTOM_TYPE;
}
