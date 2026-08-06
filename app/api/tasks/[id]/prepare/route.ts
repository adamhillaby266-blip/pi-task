import { parseVersion, readJsonObject, requireBrowserUserMutation, taskApiError, taskJson } from "@/lib/task/http";
import { prepareTaskSession } from "@/lib/task/runtime";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    requireBrowserUserMutation(request);
    const [{ id }, body] = await Promise.all([params, readJsonObject(request)]);
    const prepared = await prepareTaskSession(id, parseVersion(body.version));
    return taskJson({ session: prepared });
  } catch (error) {
    return taskApiError(error);
  }
}
