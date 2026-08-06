import { getTaskStore } from "@/lib/task/store";
import {
  parseVersion,
  readJsonObject,
  requireBrowserUserMutation,
  taskApiError,
  taskJson,
} from "@/lib/task/http";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return taskJson({ task: getTaskStore().getTaskDetail(id) });
  } catch (error) {
    return taskApiError(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    requireBrowserUserMutation(request);
    const [{ id }, body] = await Promise.all([params, readJsonObject(request)]);
    const task = getTaskStore().updateTaskContract(id, parseVersion(body.version), {
      title: body.title as string,
      goal: body.goal as string,
      acceptanceCriteria: body.acceptanceCriteria as string,
      expectedOutput: body.expectedOutput as string,
    });
    return taskJson({ task });
  } catch (error) {
    return taskApiError(error);
  }
}
