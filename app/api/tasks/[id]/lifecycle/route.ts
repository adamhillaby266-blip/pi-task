import { getRpcSession } from "@/lib/rpc-manager";
import {
  clearTaskSessionBinding,
  getTaskSessionBinding,
  type TaskSessionBinding,
} from "@/lib/task/binding";
import { TaskDomainError } from "@/lib/task/errors";
import {
  parseVersion,
  readJsonObject,
  requireBrowserUserMutation,
  taskApiError,
  taskJson,
} from "@/lib/task/http";
import { getTaskStore } from "@/lib/task/store";
import type { TaskDetail } from "@/lib/task/types";

type LifecycleAction = "block" | "unblock" | "cancel";

function parseAction(value: unknown): LifecycleAction {
  if (value === "block" || value === "unblock" || value === "cancel") return value;
  throw new TaskDomainError("INVALID_INPUT", "action must be block, unblock, or cancel", 400);
}

type BindingSnapshot = {
  binding: TaskSessionBinding;
  runId: string;
  capability: string;
} | null;

function suspendActiveBinding(task: TaskDetail): BindingSnapshot {
  if (!task.primarySessionId || !task.activeRunId) return null;
  const binding = getTaskSessionBinding(task.primarySessionId);
  if (!binding?.runId || !binding.capability || binding.runId !== task.activeRunId) return null;
  const snapshot = { binding, runId: binding.runId, capability: binding.capability };
  clearTaskSessionBinding(binding);
  return snapshot;
}

function restoreBinding(snapshot: BindingSnapshot): void {
  if (!snapshot) return;
  snapshot.binding.runId = snapshot.runId;
  snapshot.binding.capability = snapshot.capability;
}

async function stopActiveConversation(task: TaskDetail): Promise<void> {
  const snapshot = suspendActiveBinding(task);
  if (!task.activeRunId) return;
  const run = task.runs.find((candidate) => candidate.id === task.activeRunId);
  const sessionId = run?.sessionId ?? task.primarySessionId;
  if (!sessionId) return;
  const session = getRpcSession(sessionId);
  if (!session?.isAlive() || !session.isRunning()) return;
  try {
    await session.send({ type: "abort" });
  } catch (error) {
    restoreBinding(snapshot);
    throw new TaskDomainError(
      "ACTIVE_RUN_EXISTS",
      `Pi conversation could not be stopped; task state was not changed: ${error instanceof Error ? error.message : String(error)}`,
      409,
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    requireBrowserUserMutation(request);
    const [{ id }, body] = await Promise.all([params, readJsonObject(request)]);
    const action = parseAction(body.action);
    const version = parseVersion(body.version);
    const store = getTaskStore();
    const current = store.getTaskDetail(id);
    if (current.version !== version) {
      throw new TaskDomainError("VERSION_CONFLICT", "Task version changed; refresh and try again", 409);
    }

    if (action === "block" || action === "cancel") {
      await stopActiveConversation(current);
    }
    const task = action === "block"
      ? store.blockTask(id, version, body.reason as string)
      : action === "unblock"
        ? store.unblockTask(id, version, body.reason as string)
        : store.cancelTask(id, version, body.reason as string);
    return taskJson({ task });
  } catch (error) {
    return taskApiError(error);
  }
}
