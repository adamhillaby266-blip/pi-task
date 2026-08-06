import { getTaskStore } from "@/lib/task/store";
import {
  parseVersion,
  readJsonObject,
  requireBrowserUserMutation,
  taskApiError,
  taskJson,
} from "@/lib/task/http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    requireBrowserUserMutation(request);
    const [{ id }, body] = await Promise.all([params, readJsonObject(request)]);
    const task = getTaskStore().moveQueuedTask(
      id,
      parseVersion(body.version),
      body.status as "backlog" | "ready",
      body.sortOrder as number | undefined,
    );
    return taskJson({ task });
  } catch (error) {
    return taskApiError(error);
  }
}
