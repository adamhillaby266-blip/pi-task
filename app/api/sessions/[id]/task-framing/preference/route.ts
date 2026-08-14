import { appendTaskFramingPreference } from "@/lib/task/framing-commit";
import {
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
    const preference = await appendTaskFramingPreference(id, body.eventType, body.suggestionId);
    return taskJson({ preference });
  } catch (error) {
    return taskApiError(error);
  }
}
