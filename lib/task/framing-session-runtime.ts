import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { allowFileRoot } from "../file-access";
import { isExistingPathWithinRoots } from "../path-security";
import { getRpcSession } from "../rpc-manager";
import {
  cacheSessionPath,
  invalidateSessionListCache,
  readSessionHeader,
  resolveSessionPath,
} from "../session-reader";
import type { SessionEntry } from "../types";
import { clearTaskSessionBinding, getTaskSessionBinding } from "./binding";
import { createLegacyTaskContractCandidate } from "./contract";
import { TaskDomainError, isTaskDomainError } from "./errors";
import {
  getTaskFramingBranchState,
  TASK_FRAMING_CUSTOM_TYPE,
  TASK_FRAMING_EVENT_SCHEMA_VERSION,
  type TaskFramingDraftEvent,
} from "./framing-session";
import { getTaskStore } from "./store";
import type { TaskDetail } from "./types";

export interface PreparedTaskFramingSession {
  taskId: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  reused: boolean;
  candidateEntryId: string;
  candidateCreated: boolean;
}

export interface PrepareTaskFramingSessionResult {
  task: TaskDetail;
  session: PreparedTaskFramingSession;
}

function assertFramingTask(task: TaskDetail, version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new TaskDomainError("INVALID_INPUT", "version must be a positive integer", 400);
  }
  if (task.version !== version) {
    throw new TaskDomainError("VERSION_CONFLICT", "Task version changed; refresh and try again", 409);
  }
  if (task.status !== "backlog" && task.status !== "ready") {
    throw new TaskDomainError("INVALID_TRANSITION", "Only backlog and ready Tasks can open a Framing Session", 409);
  }
  if (task.activeRunId) {
    throw new TaskDomainError("ACTIVE_RUN_EXISTS", "The Task has an active Run and cannot revise its agreement", 409);
  }
}

function persistManagerWithoutAssistant(manager: SessionManager): SessionManager {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile || existsSync(sessionFile)) return manager;
  const header = manager.getHeader();
  if (!header) throw new Error("New Pi Session has no header");
  const content = [header, ...manager.getEntries()]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
  writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });

  // Pi normally defers the first flush until an assistant message exists. A
  // Framing Session intentionally starts with no Prompt, so persist its
  // header/state explicitly, then reopen it through the public SDK API so
  // later custom entries remain append-only.
  return SessionManager.open(sessionFile, undefined);
}

function assertPersistedManager(
  manager: SessionManager,
  task: TaskDetail,
): { sessionId: string; sessionFile: string } {
  const sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();
  const header = sessionFile ? readSessionHeader(sessionFile) : null;
  if (!sessionFile || !header || header.id !== sessionId) {
    throw new TaskDomainError("INVALID_INPUT", "The Pi Session is not durably persisted", 400);
  }
  if (!isExistingPathWithinRoots(header.cwd, new Set([task.project.rootPath]))) {
    throw new TaskDomainError("INVALID_INPUT", "The Pi Session is outside the Task Project root", 400);
  }
  return { sessionId, sessionFile };
}

async function openExistingFramingManager(task: TaskDetail): Promise<SessionManager> {
  const sessionId = task.primarySessionId;
  if (!sessionId) throw new Error("Task has no primary Session");
  const sessionPath = await resolveSessionPath(sessionId);
  const header = sessionPath ? readSessionHeader(sessionPath) : null;
  if (!sessionPath || !header || header.id !== sessionId) {
    throw new TaskDomainError("INVALID_INPUT", "The Task primary Pi Session no longer exists", 409);
  }
  if (!isExistingPathWithinRoots(header.cwd, new Set([task.project.rootPath]))) {
    throw new TaskDomainError("INVALID_INPUT", "The Task primary Pi Session is outside its Project root", 409);
  }

  const live = getRpcSession(sessionId);
  if (live?.isAlive()) {
    if (live.isRunning()) {
      throw new TaskDomainError("ACTIVE_RUN_EXISTS", "Wait for the Pi conversation to become idle before revising the Task agreement", 409);
    }
    const runBinding = getTaskSessionBinding(sessionId);
    if (!runBinding) return live.inner.sessionManager as SessionManager;

    // A previous execution Session may still have the Run extension loaded even
    // after its Run ended. Shut it down before reopening this as an ordinary
    // Framing Session; no capability or execution tool is carried across.
    clearTaskSessionBinding(runBinding);
    await live.shutdown();
  }

  return SessionManager.open(sessionPath, undefined);
}

function appendOrReuseCandidate(
  manager: SessionManager,
  task: TaskDetail,
): { entryId: string; created: boolean } {
  const entries = manager.getEntries() as unknown as SessionEntry[];
  const state = getTaskFramingBranchState(entries, manager.getLeafId());
  const latest = state.latestDraft;
  if (latest?.event.taskId === task.id) {
    return { entryId: latest.entry.id, created: false };
  }
  if (latest?.event.taskId && latest.event.taskId !== task.id) {
    throw new TaskDomainError("SESSION_ALREADY_BOUND", `The Session candidate belongs to Task ${latest.event.taskId}`, 409);
  }

  const legacy = task.contract === null;
  const event: TaskFramingDraftEvent = {
    schemaVersion: TASK_FRAMING_EVENT_SCHEMA_VERSION,
    eventType: "draft",
    draftId: latest?.event.draftId ?? `tfd_${randomUUID().replaceAll("-", "")}`,
    revision: (latest?.event.revision ?? 0) + 1,
    replacesEntryId: latest?.entry.id ?? null,
    taskId: task.id,
    baseTaskVersion: task.version,
    contract: task.contract ?? createLegacyTaskContractCandidate(task),
    changeSummary: legacy
      ? ["从旧版 Task 字段导入；权威来源、范围和关键决定仍需在对话中补全并重新确认"]
      : ["从已保存的任务约定恢复"],
    createdBy: legacy ? "system_legacy_adapter" : "agent",
  };
  const entryId = manager.appendCustomEntry(TASK_FRAMING_CUSTOM_TYPE, event);
  return { entryId, created: true };
}

export async function prepareTaskFramingSession(
  taskId: string,
  version: number,
): Promise<PrepareTaskFramingSessionResult> {
  const store = getTaskStore();
  let task = store.getTaskDetail(taskId);
  assertFramingTask(task, version);

  let manager: SessionManager;
  const reused = Boolean(task.primarySessionId);
  if (task.primarySessionId) {
    manager = await openExistingFramingManager(task);
  } else {
    manager = SessionManager.create(task.project.rootPath, undefined);
    manager.appendSessionInfo(task.title);
    manager = persistManagerWithoutAssistant(manager);
    const orphan = assertPersistedManager(manager, task);
    cacheSessionPath(orphan.sessionId, orphan.sessionFile);
    invalidateSessionListCache();
    try {
      task = store.bindTaskPrimarySession(task.id, version, orphan.sessionId);
    } catch (error) {
      if (isTaskDomainError(error) && (error.code === "VERSION_CONFLICT" || error.code === "SESSION_ALREADY_BOUND")) {
        throw new TaskDomainError(
          error.code,
          `${error.message}. 新建的普通 Pi 对话 ${orphan.sessionId} 已保留，但未绑定 Task，也未开始 Run。`,
          error.status,
        );
      }
      throw error;
    }
  }

  const latestTask = store.getTaskDetail(task.id);
  assertFramingTask(latestTask, task.version);
  task = latestTask;
  const candidate = appendOrReuseCandidate(manager, task);
  const persisted = assertPersistedManager(manager, task);
  cacheSessionPath(persisted.sessionId, persisted.sessionFile);
  allowFileRoot(task.project.rootPath);
  invalidateSessionListCache();

  return {
    task,
    session: {
      taskId: task.id,
      sessionId: persisted.sessionId,
      sessionFile: persisted.sessionFile,
      cwd: manager.getCwd(),
      reused,
      candidateEntryId: candidate.entryId,
      candidateCreated: candidate.created,
    },
  };
}
