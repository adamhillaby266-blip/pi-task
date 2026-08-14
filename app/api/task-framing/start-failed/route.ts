import { appendTaskFramingStartFailureReceipt } from "@/lib/task/framing-commit";
import { TaskDomainError } from "@/lib/task/errors";
import {
  readJsonObject,
  requireBrowserUserMutation,
  taskApiError,
  taskJson,
} from "@/lib/task/http";
import { getTaskStore } from "@/lib/task/store";

const ACTIVE_RUN_STATUSES = new Set(["starting", "running", "waiting_user"]);

export async function POST(request: Request) {
  try {
    requireBrowserUserMutation(request);
    const body = await readJsonObject(request);
    const operationId = typeof body.operationId === "string" ? body.operationId.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    const reason = typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : "Task start could not hand the confirmed contract to Pi";
    if (!operationId || !sessionId || !taskId) {
      throw new TaskDomainError("INVALID_INPUT", "operationId, sessionId, and taskId are required", 400);
    }

    const store = getTaskStore();
    const operation = store.getTaskFramingOperation(operationId);
    if (operation.sessionId !== sessionId || operation.taskId !== taskId || operation.action !== "confirm_and_start") {
      throw new TaskDomainError("START_INTENT_EXPIRED", "The start intent does not match this Task Session", 409);
    }
    if (operation.runId) {
      const run = store.getRun(operation.runId);
      if (ACTIVE_RUN_STATUSES.has(run.status)) {
        store.failRun(run.id, reason, true);
      } else if (run.status === "succeeded") {
        return taskJson({ operation, task: store.getTaskDetail(taskId) });
      }
    }
    const failed = store.markTaskFramingOperationStartFailed(operationId, reason);
    const task = store.getTaskDetail(taskId);
    let receiptWarning: string | null = null;
    try {
      await appendTaskFramingStartFailureReceipt(sessionId, failed, task, reason);
    } catch (error) {
      receiptWarning = error instanceof Error ? error.message : String(error);
    }
    return taskJson({ operation: failed, task, receiptWarning });
  } catch (error) {
    return taskApiError(error);
  }
}
