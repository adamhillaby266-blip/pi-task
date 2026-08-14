import { getRpcSession } from "@/lib/rpc-manager";
import {
  activateTaskSessionBinding,
  clearTaskSessionBinding,
  getTaskSessionBinding,
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let begunRunId: string | null = null;
  let framingOperationId: string | null = null;
  let framingIntentValidated = false;
  let binding = undefined as ReturnType<typeof getTaskSessionBinding>;
  try {
    requireBrowserUserMutation(request);
    const [{ id }, body] = await Promise.all([params, readJsonObject(request)]);
    const version = parseVersion(body.version);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) throw new TaskDomainError("INVALID_INPUT", "sessionId is required", 400);
    framingOperationId = typeof body.operationId === "string" && body.operationId.trim() ? body.operationId.trim() : null;

    const store = getTaskStore();
    if (framingOperationId) {
      const intent = store.prepareTaskFramingStart(framingOperationId, id, sessionId);
      framingIntentValidated = true;
      if (intent.status === "started" && intent.runId) {
        return taskJson({ task: store.getTask(id), run: store.getRun(intent.runId), operation: intent });
      }
    }

    const session = getRpcSession(sessionId);
    binding = getTaskSessionBinding(sessionId);
    if (!session?.isAlive() || !binding || binding.taskId !== id) {
      throw new TaskDomainError("INVALID_TRANSITION", "Prepare this task conversation before starting", 409);
    }
    if (session.isRunning()) {
      throw new TaskDomainError("ACTIVE_RUN_EXISTS", "The Pi conversation is already running", 409);
    }
    const begun = store.beginRun(id, version, { cwd: session.cwd });
    begunRunId = begun.run.id;
    activateTaskSessionBinding(sessionId, id, begun.run.id, begun.capability);
    const running = store.markRunRunning(begun.run.id, sessionId);
    const operation = framingOperationId
      ? store.markTaskFramingOperationStarted(framingOperationId, id, running.run.id)
      : null;
    return taskJson({ task: running.task, run: running.run, ...(operation ? { operation } : {}) });
  } catch (error) {
    if (begunRunId) {
      try {
        getTaskStore().failRun(begunRunId, "Task start failed before the prompt was sent");
      } catch {
        // Preserve the original start error; reconciliation handles any orphan.
      }
    }
    if (framingOperationId && framingIntentValidated) {
      try {
        getTaskStore().markTaskFramingOperationStartFailed(
          framingOperationId,
          error instanceof Error ? error.message : String(error),
        );
      } catch {
        // Preserve the original start error; the operation remains inspectable.
      }
    }
    if (binding) clearTaskSessionBinding(binding);
    return taskApiError(error);
  }
}
