import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getRpcSession } from "../rpc-manager";
import { isExistingPathWithinRoots } from "../path-security";
import { readSessionHeader, resolveSessionPath } from "../session-reader";
import type { SessionEntry } from "../types";
import {
  checkTaskContractReadiness,
  createLegacyTaskContractCandidate,
  type TaskContractReadiness,
} from "./contract";
import { TaskDomainError } from "./errors";
import {
  getTaskFramingBranchState,
  parseTaskFramingEntry,
  TASK_FRAMING_CUSTOM_TYPE,
  TASK_FRAMING_EVENT_SCHEMA_VERSION,
  type TaskFramingDraftEvent,
} from "./framing-session";
import { getTaskStore } from "./store";
import type {
  ProjectRecord,
  TaskDetail,
  TaskFramingCommitAction,
  TaskFramingOperationRecord,
} from "./types";

interface LoadedFramingSession {
  manager: SessionManager;
  sessionId: string;
  cwd: string;
  entries: SessionEntry[];
  leafId: string | null;
  latestDraftEntryId: string | null;
  latestDraft: TaskFramingDraftEvent | null;
  running: boolean;
}

export interface CommitTaskFramingCandidateInput {
  operationId: string;
  sessionId: string;
  sourceDraftEntryId: string;
  projectId: string;
  taskId: string | null;
  expectedTaskVersion: number | null;
  action: TaskFramingCommitAction;
}

export interface CommitTaskFramingCandidateResult {
  task: TaskDetail;
  operation: TaskFramingOperationRecord;
  receiptEntryId: string | null;
  receiptWarning: string | null;
}

export interface TaskFramingPreferenceResult {
  sessionId: string;
  entryId: string;
  eventType: "declined" | "reopened";
  appended: boolean;
}

export interface TaskFramingStatusResult {
  sessionId: string;
  cwd: string;
  latestDraftEntryId: string | null;
  latestDraft: TaskFramingDraftEvent | null;
  readiness: TaskContractReadiness | null;
  task: TaskDetail | null;
  project: ProjectRecord | null;
  operations: TaskFramingOperationRecord[];
  busy: boolean;
  actions: {
    saveDraft: boolean;
    confirm: boolean;
    confirmAndStart: boolean;
  };
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new TaskDomainError("INVALID_INPUT", `${field} must be a string`, 400);
  const text = value.trim();
  if (!text || text.length > maxLength || text.includes("\0")) {
    throw new TaskDomainError("INVALID_INPUT", `${field} is required or invalid`, 400);
  }
  return text;
}

function optionalTaskId(value: unknown): string | null {
  if (value === null) return null;
  return requiredText(value, "taskId", 256);
}

function expectedVersion(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new TaskDomainError("INVALID_INPUT", "expectedTaskVersion must be null or a positive integer", 400);
  }
  return Number(value);
}

function asMutableSessionManager(value: unknown): SessionManager {
  return value as SessionManager;
}

async function loadFramingSession(sessionIdValue: unknown): Promise<LoadedFramingSession> {
  const sessionId = requiredText(sessionIdValue, "sessionId", 256);
  const live = getRpcSession(sessionId);
  let manager: SessionManager;
  let running = false;
  if (live?.isAlive()) {
    manager = asMutableSessionManager(live.inner.sessionManager);
    running = live.isRunning();
  } else {
    const sessionPath = await resolveSessionPath(sessionId);
    const header = sessionPath ? readSessionHeader(sessionPath) : null;
    if (!sessionPath || !header || header.id !== sessionId) {
      throw new TaskDomainError("INVALID_INPUT", "The Pi Session does not exist or is not persisted", 400);
    }
    manager = SessionManager.open(sessionPath, undefined);
  }
  if (manager.getSessionId() !== sessionId) {
    throw new TaskDomainError("INVALID_INPUT", "The Pi Session identity does not match the request", 400);
  }
  const sessionFile = manager.getSessionFile();
  const persistedHeader = sessionFile ? readSessionHeader(sessionFile) : null;
  if (!sessionFile || !persistedHeader || persistedHeader.id !== sessionId) {
    throw new TaskDomainError("INVALID_INPUT", "The Pi Session is not durably persisted", 400);
  }
  const entries = manager.getEntries() as unknown as SessionEntry[];
  const leafId = manager.getLeafId();
  const state = getTaskFramingBranchState(entries, leafId);
  return {
    manager,
    sessionId,
    cwd: manager.getCwd(),
    entries,
    leafId,
    latestDraftEntryId: state.latestDraft?.entry.id ?? null,
    latestDraft: state.latestDraft?.event ?? null,
    running,
  };
}

function matchingProject(projects: ProjectRecord[], cwd: string): ProjectRecord | null {
  return projects
    .filter((project) => isExistingPathWithinRoots(cwd, new Set([project.rootPath])))
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0] ?? null;
}

function assertDraftIsCurrent(session: LoadedFramingSession, sourceDraftEntryId: string): TaskFramingDraftEvent {
  if (!session.latestDraft || !session.latestDraftEntryId) {
    throw new TaskDomainError("DRAFT_STALE", "This Session branch has no current Task contract candidate", 409);
  }
  if (session.latestDraftEntryId !== sourceDraftEntryId) {
    throw new TaskDomainError("DRAFT_STALE", `The latest candidate is ${session.latestDraftEntryId}; refresh before committing`, 409);
  }
  return session.latestDraft;
}

function appendCommitReceipt(
  session: LoadedFramingSession,
  result: { task: TaskDetail; operation: TaskFramingOperationRecord },
): string | null {
  const existing = (session.manager.getEntries() as unknown as SessionEntry[]).some((entry) => {
    const event = parseTaskFramingEntry(entry);
    return event?.eventType === "commit_receipt" && event.operationId === result.operation.id;
  });
  if (existing) return null;
  session.manager.appendCustomEntry(TASK_FRAMING_CUSTOM_TYPE, {
    schemaVersion: TASK_FRAMING_EVENT_SCHEMA_VERSION,
    eventType: "commit_receipt",
    operationId: result.operation.id,
    sourceDraftEntryId: result.operation.sourceEntryId,
    action: result.operation.action,
    taskId: result.task.id,
    taskVersion: result.task.version,
    status: "succeeded",
  });
  const entryId = session.manager.getLeafId();
  if (!entryId) throw new Error("Session receipt did not produce an entry id");
  return entryId;
}

export async function appendTaskFramingStartFailureReceipt(
  sessionIdValue: unknown,
  operation: TaskFramingOperationRecord,
  task: TaskDetail,
  message: string,
): Promise<string | null> {
  const session = await loadFramingSession(sessionIdValue);
  const existing = (session.manager.getEntries() as unknown as SessionEntry[]).some((entry) => {
    const event = parseTaskFramingEntry(entry);
    return event?.eventType === "commit_receipt"
      && event.operationId === operation.id
      && event.status === "start_failed";
  });
  if (existing) return null;
  session.manager.appendCustomEntry(TASK_FRAMING_CUSTOM_TYPE, {
    schemaVersion: TASK_FRAMING_EVENT_SCHEMA_VERSION,
    eventType: "commit_receipt",
    operationId: operation.id,
    sourceDraftEntryId: operation.sourceEntryId,
    action: "confirm_and_start",
    taskId: task.id,
    taskVersion: task.version,
    status: "start_failed",
    message: message.slice(0, 10_000),
  });
  return session.manager.getLeafId();
}

export async function appendTaskFramingPreference(
  sessionIdValue: unknown,
  eventTypeValue: unknown,
  suggestionIdValue?: unknown,
): Promise<TaskFramingPreferenceResult> {
  const session = await loadFramingSession(sessionIdValue);
  if (session.running) {
    throw new TaskDomainError("ACTIVE_RUN_EXISTS", "Wait for the Pi conversation to become idle before changing Task Framing preferences", 409);
  }
  const eventType = eventTypeValue === "declined" || eventTypeValue === "reopened" ? eventTypeValue : null;
  if (!eventType) throw new TaskDomainError("INVALID_INPUT", "eventType must be declined or reopened", 400);
  const suggestionId = suggestionIdValue === undefined
    ? undefined
    : requiredText(suggestionIdValue, "suggestionId", 128);
  const state = getTaskFramingBranchState(session.entries, session.leafId);

  if (eventType === "declined") {
    if (state.declined && state.latestPreference) {
      return { sessionId: session.sessionId, entryId: state.latestPreference.entry.id, eventType, appended: false };
    }
    const pending = state.pendingSuggestion;
    if (!pending) {
      throw new TaskDomainError("INVALID_TRANSITION", "There is no pending Task Framing suggestion to decline", 409);
    }
    if (suggestionId && pending.event.suggestionId !== suggestionId) {
      throw new TaskDomainError("DRAFT_STALE", "The Task Framing suggestion has changed", 409);
    }
  } else {
    if (!state.declined) {
      if (state.latestPreference?.event.eventType === "reopened") {
        return { sessionId: session.sessionId, entryId: state.latestPreference.entry.id, eventType, appended: false };
      }
      throw new TaskDomainError("INVALID_TRANSITION", "Task Framing has not been declined on this branch", 409);
    }
  }

  session.manager.appendCustomEntry(TASK_FRAMING_CUSTOM_TYPE, {
    schemaVersion: TASK_FRAMING_EVENT_SCHEMA_VERSION,
    eventType,
    ...(suggestionId ? { suggestionId } : {}),
  });
  const entryId = session.manager.getLeafId();
  if (!entryId) throw new Error("Task Framing preference did not produce an entry id");
  return { sessionId: session.sessionId, entryId, eventType, appended: true };
}

export async function getTaskFramingStatus(sessionIdValue: unknown): Promise<TaskFramingStatusResult> {
  const session = await loadFramingSession(sessionIdValue);
  const store = getTaskStore();
  const task = store.findTaskByPrimarySessionId(session.sessionId);
  const project = task ? task.project : matchingProject(store.listProjects(), session.cwd);
  const readiness = session.latestDraft ? checkTaskContractReadiness(session.latestDraft.contract) : null;
  const operations = store.listTaskFramingOperations(session.sessionId, session.latestDraftEntryId ?? undefined);
  const editableTask = !task || ((task.status === "backlog" || task.status === "ready") && !task.activeRunId);
  const baseAllowed = Boolean(session.latestDraft && !session.running && editableTask);
  const sourceAlreadySaved = operations.some((operation) => (
    operation.status === "saved"
    || operation.status === "confirmed"
    || operation.status === "awaiting_start"
    || operation.status === "started"
    || operation.status === "start_failed"
  ));
  const sourceAlreadyConfirmed = operations.some((operation) => (
    operation.status === "confirmed"
    || operation.status === "awaiting_start"
    || operation.status === "started"
    || operation.status === "start_failed"
  ));
  const sourceAlreadyStarted = operations.some((operation) => operation.status === "started");
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    latestDraftEntryId: session.latestDraftEntryId,
    latestDraft: session.latestDraft,
    readiness,
    task,
    project,
    operations,
    busy: session.running,
    actions: {
      saveDraft: baseAllowed && !sourceAlreadySaved,
      confirm: baseAllowed && Boolean(readiness?.ready) && !sourceAlreadyConfirmed,
      confirmAndStart: baseAllowed && Boolean(readiness?.ready) && !sourceAlreadyStarted,
    },
  };
}

export async function commitTaskFramingCandidate(
  input: CommitTaskFramingCandidateInput,
): Promise<CommitTaskFramingCandidateResult> {
  const operationId = requiredText(input.operationId, "operationId", 256);
  if (!/^tfo_[A-Za-z0-9_-]+$/.test(operationId)) {
    throw new TaskDomainError("INVALID_INPUT", "operationId must use the tfo_ prefix", 400);
  }
  const sessionId = requiredText(input.sessionId, "sessionId", 256);
  const sourceDraftEntryId = requiredText(input.sourceDraftEntryId, "sourceDraftEntryId", 128);
  const projectId = requiredText(input.projectId, "projectId", 256);
  const taskId = optionalTaskId(input.taskId);
  const expectedTaskVersion = expectedVersion(input.expectedTaskVersion);
  const action = input.action;
  if (action !== "save_draft" && action !== "confirm" && action !== "confirm_and_start") {
    throw new TaskDomainError("INVALID_INPUT", "Unsupported Task Framing action", 400);
  }

  const session = await loadFramingSession(sessionId);
  if (session.running) {
    throw new TaskDomainError("ACTIVE_RUN_EXISTS", "Wait for the Pi conversation to become idle before committing the Task contract", 409);
  }
  const draft = assertDraftIsCurrent(session, sourceDraftEntryId);
  if (draft.taskId && taskId !== draft.taskId) {
    throw new TaskDomainError("SESSION_ALREADY_BOUND", `The candidate belongs to Task ${draft.taskId}`, 409);
  }

  const store = getTaskStore();
  const project = store.getProject(projectId);
  if (!isExistingPathWithinRoots(session.cwd, new Set([project.rootPath]))) {
    throw new TaskDomainError("INVALID_INPUT", "The Pi Session is outside the selected Project root", 400);
  }
  const bound = store.findTaskByPrimarySessionId(sessionId);
  if (bound && taskId && bound.id !== taskId) {
    throw new TaskDomainError("SESSION_ALREADY_BOUND", `This Session is already bound to Task ${bound.id}`, 409);
  }
  if (draft.taskId && bound?.id !== draft.taskId) {
    throw new TaskDomainError("SESSION_ALREADY_BOUND", "The candidate Task binding no longer matches SQLite", 409);
  }
  if (draft.taskId && bound && draft.baseTaskVersion !== bound.version) {
    const authoritativeContract = bound.contract ?? createLegacyTaskContractCandidate(bound);
    if (JSON.stringify(authoritativeContract) !== JSON.stringify(draft.contract)) {
      throw new TaskDomainError(
        "VERSION_CONFLICT",
        "The Task changed after this candidate was created; refresh it in the Framing Session before saving",
        409,
      );
    }
  }

  const committed = store.commitTaskFraming({
    operationId,
    sessionId,
    sourceEntryId: sourceDraftEntryId,
    projectId,
    taskId,
    expectedTaskVersion,
    action,
    contract: draft.contract,
  });

  let receiptEntryId: string | null = null;
  let receiptWarning: string | null = null;
  try {
    receiptEntryId = appendCommitReceipt(session, committed);
  } catch (error) {
    receiptWarning = error instanceof Error ? error.message : String(error);
  }
  return { ...committed, receiptEntryId, receiptWarning };
}
