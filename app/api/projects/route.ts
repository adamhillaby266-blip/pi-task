import { getTaskStore } from "@/lib/task/store";
import {
  readJsonObject,
  requireBrowserUserMutation,
  taskApiError,
  taskJson,
} from "@/lib/task/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return taskJson({ projects: getTaskStore().listProjects() });
  } catch (error) {
    return taskApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireBrowserUserMutation(request);
    const body = await readJsonObject(request);
    const project = getTaskStore().createProject({
      name: body.name as string,
      rootPath: body.rootPath as string,
    });
    return taskJson({ project }, 201);
  } catch (error) {
    return taskApiError(error);
  }
}
