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
  let binding = undefined as ReturnType<typeof getTaskSessionBinding>;
  try {
    requireBrowserUserMutation(request);
    const [{ id }, body] = await Promise.all([params, readJsonObject(request)]);
    const version = parseVersion(body.version);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) throw new TaskDomainError("INVALID_INPUT", "sessionId is required", 400);

    const session = getRpcSession(sessionId);
    binding = getTaskSessionBinding(sessionId);
    if (!session?.isAlive() || !binding || binding.taskId !== id) {
      throw new TaskDomainError("INVALID_TRANSITION", "Prepare this task conversation before starting", 409);
    }
    if (session.isRunning()) {
      throw new TaskDomainError("ACTIVE_RUN_EXISTS", "The Pi conversation is already running", 409);
    }

    const store = getTaskStore();
    const begun = store.beginRun(id, version, { cwd: session.cwd });
    begunRunId = begun.run.id;
    activateTaskSessionBinding(sessionId, id, begun.run.id, begun.capability);
    const running = store.markRunRunning(begun.run.id, sessionId);
    return taskJson({ task: running.task, run: running.run });
  } catch (error) {
    if (begunRunId) {
      try {
        getTaskStore().failRun(begunRunId, "Task start failed before the prompt was sent");
      } catch {
        // Preserve the original start error; reconciliation handles any orphan.
      }
    }
    if (binding) clearTaskSessionBinding(binding);
    return taskApiError(error);
  }
}
