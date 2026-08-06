import {
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
  try {
    requireBrowserUserMutation(request);
    const [{ id }, body] = await Promise.all([params, readJsonObject(request)]);
    const reason = typeof body.reason === "string" && body.reason.trim()
      ? body.reason
      : "Pi prompt failed before the task could be handed off";
    return taskJson(getTaskStore().failRun(id, reason, true));
  } catch (error) {
    return taskApiError(error);
  }
}
