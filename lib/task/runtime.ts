import { randomUUID } from "node:crypto";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { allowFileRoot } from "@/lib/file-access";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import {
  createTaskSessionBinding,
  getTaskSessionBinding,
  registerTaskSessionBinding,
} from "./binding";
import { TaskDomainError } from "./errors";
import { createTaskExtension } from "./extension";
import { getTaskStore } from "./store";

export interface PreparedTaskSession {
  taskId: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  reused: boolean;
}

export async function prepareTaskSession(
  taskId: string,
  version: number,
  options: { extensionFactories?: InlineExtension[] } = {},
): Promise<PreparedTaskSession> {
  const store = getTaskStore();
  const detail = store.getTaskDetail(taskId);
  if (detail.version !== version) {
    throw new TaskDomainError("VERSION_CONFLICT", "Task version changed; refresh and try again", 409);
  }
  if (detail.status !== "ready") {
    throw new TaskDomainError("INVALID_TRANSITION", "Only a ready task can be prepared in Pi", 409);
  }

  const preferredSessionId = detail.primarySessionId;
  if (preferredSessionId) {
    const current = getRpcSession(preferredSessionId);
    const currentBinding = getTaskSessionBinding(preferredSessionId);
    if (current?.isAlive() && currentBinding?.taskId === taskId) {
      if (current.isRunning()) {
        throw new TaskDomainError("ACTIVE_RUN_EXISTS", "The task conversation is currently busy", 409);
      }
      return {
        taskId,
        sessionId: preferredSessionId,
        sessionFile: current.sessionFile,
        cwd: current.cwd,
        reused: true,
      };
    }
  }

  let sessionFile = preferredSessionId ? await resolveSessionPath(preferredSessionId) : null;
  let sessionId = preferredSessionId;
  let reused = Boolean(sessionFile && sessionId);

  if (sessionId) {
    const current = getRpcSession(sessionId);
    if (current?.isRunning()) {
      throw new TaskDomainError("ACTIVE_RUN_EXISTS", "The task conversation is currently busy", 409);
    }
    current?.destroy();
  }

  const binding = createTaskSessionBinding(taskId);
  const extensionFactories = [createTaskExtension(binding), ...(options.extensionFactories ?? [])];
  const started = sessionFile && sessionId
    ? await startRpcSession(sessionId, sessionFile, undefined, { extensionFactories })
    : await startRpcSession(`__pi_task__${randomUUID()}`, "", detail.project.rootPath, { extensionFactories });

  sessionId = started.realSessionId;
  sessionFile = started.session.sessionFile;
  reused = reused && sessionId === preferredSessionId;
  await started.session.waitUntilReady();
  await started.session.send({ type: "set_session_name", name: detail.title });
  registerTaskSessionBinding(sessionId, binding);
  allowFileRoot(detail.project.rootPath);
  invalidateSessionListCache();

  return {
    taskId,
    sessionId,
    sessionFile,
    cwd: started.session.cwd,
    reused,
  };
}
