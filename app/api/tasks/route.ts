import { getRpcSession } from "@/lib/rpc-manager";
import { isExistingPathWithinRoots } from "@/lib/path-security";
import { readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { TaskDomainError } from "@/lib/task/errors";
import { getTaskStore } from "@/lib/task/store";
import {
  readJsonObject,
  requireBrowserUserMutation,
  taskApiError,
  taskJson,
} from "@/lib/task/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const projectId = searchParams.get("projectId")?.trim() || undefined;
    const sessionId = searchParams.get("sessionId")?.trim() || undefined;
    const store = getTaskStore();
    if (sessionId) return taskJson({ task: store.findTaskByPrimarySessionId(sessionId) });
    if (projectId) store.getProject(projectId);
    return taskJson({ tasks: store.listTasks(projectId) });
  } catch (error) {
    return taskApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireBrowserUserMutation(request);
    const body = await readJsonObject(request);
    const store = getTaskStore();
    const primarySessionId = typeof body.primarySessionId === "string" ? body.primarySessionId.trim() : "";
    if (primarySessionId) {
      if (typeof body.projectId !== "string" || !body.projectId.trim()) {
        throw new TaskDomainError("INVALID_INPUT", "projectId is required", 400);
      }
      const project = store.getProject(body.projectId);
      const sessionPath = await resolveSessionPath(primarySessionId);
      const header = sessionPath ? readSessionHeader(sessionPath) : null;
      if (!sessionPath || !header || header.id !== primarySessionId) {
        throw new TaskDomainError("INVALID_INPUT", "The Pi Session does not exist or is not persisted", 400);
      }
      if (!isExistingPathWithinRoots(header.cwd, new Set([project.rootPath]))) {
        throw new TaskDomainError("INVALID_INPUT", "The Pi Session is outside the selected Project root", 400);
      }
      if (getRpcSession(primarySessionId)?.isRunning()) {
        throw new TaskDomainError("ACTIVE_RUN_EXISTS", "Wait for the Pi conversation to become idle before creating a task", 409);
      }
    }
    const createdTask = store.createTask({
      projectId: body.projectId as string,
      title: body.title as string,
      goal: body.goal as string,
      acceptanceCriteria: body.acceptanceCriteria as string,
      expectedOutput: body.expectedOutput as string,
      status: body.status as "backlog" | "ready" | undefined,
      ...(primarySessionId ? { primarySessionId } : {}),
    });
    return taskJson({ task: store.getTaskDetail(createdTask.id) }, 201);
  } catch (error) {
    return taskApiError(error);
  }
}
