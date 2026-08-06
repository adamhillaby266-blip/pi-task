import { getTaskStore } from "@/lib/task/store";
import {
  parseVersion,
  readJsonObject,
  requireBrowserUserMutation,
  taskApiError,
  taskJson,
} from "@/lib/task/http";
import { TaskDomainError } from "@/lib/task/errors";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    requireBrowserUserMutation(request);
    const [{ id }, body] = await Promise.all([params, readJsonObject(request)]);
    const version = parseVersion(body.version);
    const store = getTaskStore();
    if (body.action === "accept") {
      return taskJson({ task: store.acceptReview(id, version) });
    }
    if (body.action === "return") {
      return taskJson({ task: store.returnReview(id, version, body.reason as string) });
    }
    throw new TaskDomainError("INVALID_INPUT", "action must be accept or return", 400);
  } catch (error) {
    return taskApiError(error);
  }
}
