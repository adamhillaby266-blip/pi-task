import {
  commitTaskFramingCandidate,
  getTaskFramingStatus,
} from "@/lib/task/framing-commit";
import {
  readJsonObject,
  requireBrowserUserMutation,
  taskApiError,
  taskJson,
} from "@/lib/task/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    return taskJson({ framing: await getTaskFramingStatus(sessionId) });
  } catch (error) {
    return taskApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireBrowserUserMutation(request);
    const body = await readJsonObject(request);
    const result = await commitTaskFramingCandidate({
      operationId: body.operationId as string,
      sessionId: body.sessionId as string,
      sourceDraftEntryId: body.sourceDraftEntryId as string,
      projectId: body.projectId as string,
      taskId: body.taskId as string | null,
      expectedTaskVersion: body.expectedTaskVersion as number | null,
      action: body.action as "save_draft" | "confirm" | "confirm_and_start",
    });
    return taskJson(result);
  } catch (error) {
    return taskApiError(error);
  }
}
