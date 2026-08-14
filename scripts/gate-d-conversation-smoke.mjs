import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const runtime = process.env.PI_TASK_GATE_D_RUNTIME;
const port = Number(process.env.PI_TASK_GATE_D_PORT);
if (!runtime || !Number.isInteger(port)) throw new Error("Gate D runtime and port are required");

const base = `http://127.0.0.1:${port}`;
const mutationHeaders = {
  "content-type": "application/json",
  origin: base,
  "sec-fetch-site": "same-origin",
};

async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function mutation(path, body) {
  return api(path, { method: "POST", headers: mutationHeaders, body: JSON.stringify(body) });
}

async function rejectedMutation(path, body, expectedStatus) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (response.status !== expectedStatus) {
    throw new Error(`${path}: expected ${expectedStatus}, received ${response.status} ${JSON.stringify(result)}`);
  }
  return result;
}

for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    const response = await fetch(`${base}/api/projects`);
    if (response.ok) break;
  } catch {}
  if (attempt === 119) throw new Error("Pi Task did not become ready within 120 seconds");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

const projectRoot = join(runtime, "project");
const outsideRoot = join(runtime, "outside-project");
await mkdir(projectRoot, { recursive: true });
await mkdir(outsideRoot, { recursive: true });

const ensured = await mutation("/api/agent/new", { cwd: projectRoot, type: "ensure_session" });
const sessionId = ensured.sessionId;
await mutation(`/api/agent/${encodeURIComponent(sessionId)}`, {
  type: "set_session_name",
  name: "讨论季度交接说明",
});
const stats = (await mutation(`/api/agent/${encodeURIComponent(sessionId)}`, {
  type: "get_session_stats",
})).data;
if (!stats?.sessionFile) throw new Error("Pi did not assign a Session file path");

const timestamp = new Date().toISOString();
await mkdir(dirname(stats.sessionFile), { recursive: true });
await writeFile(stats.sessionFile, [
  JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd: projectRoot }),
  JSON.stringify({ type: "session_info", id: "gate-d-name", parentId: null, timestamp, name: "讨论季度交接说明" }),
  JSON.stringify({
    type: "message",
    id: "gate-d-user",
    parentId: "gate-d-name",
    timestamp,
    message: {
      role: "user",
      content: "请把季度交接要求整理成可验收的 Markdown 文件",
      timestamp: Date.now(),
    },
  }),
].join("\n") + "\n", "utf8");

const { project } = await mutation("/api/projects", {
  name: "Gate D conversation project",
  rootPath: projectRoot,
});
const { project: outsideProject } = await mutation("/api/projects", {
  name: "Gate D outside project",
  rootPath: outsideRoot,
});
const contract = {
  title: "整理季度交接说明",
  goal: "把当前讨论沉淀为可复用交接文件",
  acceptanceCriteria: "Markdown 文件存在并包含责任人与下一步",
  expectedOutput: "handoff.md",
  status: "ready",
};
const { task } = await mutation("/api/tasks", {
  ...contract,
  projectId: project.id,
  primarySessionId: sessionId,
});

const outsideError = await rejectedMutation("/api/tasks", {
  ...contract,
  projectId: outsideProject.id,
  primarySessionId: sessionId,
}, 400);
const missingError = await rejectedMutation("/api/tasks", {
  ...contract,
  projectId: project.id,
  primarySessionId: "session-does-not-exist",
}, 400);
const duplicateError = await rejectedMutation("/api/tasks", {
  ...contract,
  projectId: project.id,
  primarySessionId: sessionId,
}, 409);

const lookup = (await api(`/api/tasks?sessionId=${encodeURIComponent(sessionId)}`)).task;
if (lookup?.id !== task.id || lookup.primarySessionId !== sessionId || lookup.runs.length !== 0) {
  throw new Error(`Immediate Session lookup failed: ${JSON.stringify(lookup)}`);
}

const prepared = (await mutation(`/api/tasks/${encodeURIComponent(task.id)}/prepare`, {
  version: task.version,
})).session;
if (prepared.sessionId !== sessionId || prepared.reused !== true) {
  throw new Error(`The existing Session was not reused: ${JSON.stringify(prepared)}`);
}
const tools = (await mutation(`/api/agent/${encodeURIComponent(sessionId)}`, {
  type: "get_tools",
})).data.map((tool) => tool.name);
const requiredTools = [
  "read_task",
  ...(process.env.PI_TASK_ENABLE_READONLY_MOA === "1" ? ["delegate_readonly_agents"] : []),
  "request_task_input",
  "submit_task_review",
];
for (const required of requiredTools) {
  if (!tools.includes(required)) throw new Error(`Prepared Session is missing ${required}`);
}

const beforeStart = (await api(`/api/tasks/${encodeURIComponent(task.id)}`)).task;
if (beforeStart.status !== "ready" || beforeStart.activeRunId !== null || beforeStart.runs.length !== 0) {
  throw new Error("Preparing the conversation started work without a user send");
}
const started = await mutation(`/api/tasks/${encodeURIComponent(task.id)}/start`, {
  version: beforeStart.version,
  sessionId,
});
const interrupted = await mutation(`/api/task-runs/${encodeURIComponent(started.run.id)}/interrupt`, {
  reason: "Browser could not begin the Pi prompt request",
});
if (
  interrupted.task.status !== "ready"
  || interrupted.task.activeRunId !== null
  || interrupted.run.status !== "interrupted"
) {
  throw new Error(`Run compensation failed: ${JSON.stringify(interrupted)}`);
}
const resumedAfterInterrupt = (await mutation(`/api/tasks/${encodeURIComponent(task.id)}/prepare`, {
  version: interrupted.task.version,
})).session;
const afterInterrupt = (await api(`/api/tasks/${encodeURIComponent(task.id)}`)).task;
if (
  resumedAfterInterrupt.sessionId !== sessionId
  || afterInterrupt.status !== "ready"
  || afterInterrupt.runs.length !== 1
  || afterInterrupt.runs[0].status !== "interrupted"
  || !afterInterrupt.recoveryNote?.includes("could not begin")
) {
  throw new Error(`Same-Session recovery failed: ${JSON.stringify({ resumedAfterInterrupt, afterInterrupt })}`);
}

const secondStarted = await mutation(`/api/tasks/${encodeURIComponent(task.id)}/start`, {
  version: afterInterrupt.version,
  sessionId,
});
const blocked = await mutation(`/api/tasks/${encodeURIComponent(task.id)}/lifecycle`, {
  action: "block",
  version: secondStarted.task.version,
  reason: "Waiting for the approved owner list",
});
if (
  blocked.task.status !== "blocked"
  || blocked.task.activeRunId !== null
  || blocked.task.runs.at(-1)?.status !== "interrupted"
  || blocked.task.recoveryNote !== "Waiting for the approved owner list"
) {
  throw new Error(`Blocking an active Run failed: ${JSON.stringify(blocked)}`);
}

const unblocked = await mutation(`/api/tasks/${encodeURIComponent(task.id)}/lifecycle`, {
  action: "unblock",
  version: blocked.task.version,
  reason: "The approved owner list is now attached.",
});
if (unblocked.task.status !== "ready" || unblocked.task.recoveryNote !== "The approved owner list is now attached.") {
  throw new Error(`Unblocking failed: ${JSON.stringify(unblocked)}`);
}
const resumedAfterBlock = (await mutation(`/api/tasks/${encodeURIComponent(task.id)}/prepare`, {
  version: unblocked.task.version,
})).session;
if (resumedAfterBlock.sessionId !== sessionId) {
  throw new Error(`Unblocked Task did not reuse its Session: ${JSON.stringify(resumedAfterBlock)}`);
}

const thirdStarted = await mutation(`/api/tasks/${encodeURIComponent(task.id)}/start`, {
  version: unblocked.task.version,
  sessionId,
});
const canceled = await mutation(`/api/tasks/${encodeURIComponent(task.id)}/lifecycle`, {
  action: "cancel",
  version: thirdStarted.task.version,
  reason: "The fictional project is no longer needed",
});
const finalTask = canceled.task;
if (
  finalTask.status !== "canceled"
  || finalTask.activeRunId !== null
  || finalTask.runs.length !== 3
  || finalTask.runs.at(-1)?.status !== "canceled"
) {
  throw new Error(`Canceling an active Run failed: ${JSON.stringify(canceled)}`);
}

let authFile = null;
try {
  authFile = await readFile(join(process.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8");
} catch {}
const result = {
  projectId: project.id,
  taskId: task.id,
  sessionId,
  reusedSession: prepared.reused,
  taskStatusBeforeSend: beforeStart.status,
  runCountBeforeSend: beforeStart.runs.length,
  taskTools: requiredTools,
  invalidSessionRootStatus: outsideError.error?.code,
  missingSessionStatus: missingError.error?.code,
  duplicateBindingStatus: duplicateError.error?.code,
  interruptedRunId: started.run.id,
  recoveryStatusAfterInterrupt: afterInterrupt.status,
  recoveryNoteAfterInterrupt: afterInterrupt.recoveryNote,
  reusedAfterInterrupt: resumedAfterInterrupt.sessionId === sessionId,
  blockedRunId: secondStarted.run.id,
  reusedAfterBlock: resumedAfterBlock.sessionId === sessionId,
  canceledRunId: thirdStarted.run.id,
  finalStatus: finalTask.status,
  runStatuses: finalTask.runs.map((run) => run.status),
  eventTypes: finalTask.events.map((event) => event.type),
  authFile: authFile?.trim() || null,
};
await writeFile(join(runtime, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
