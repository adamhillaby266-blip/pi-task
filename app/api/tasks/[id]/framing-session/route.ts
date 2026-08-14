import { prepareTaskFramingSession } from "@/lib/task/framing-session-runtime";
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
    return taskJson(await prepareTaskFramingSession(id, parseVersion(body.version)));
  } catch (error) {
    return taskApiError(error);
  }
}
