import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const runtime = process.env.PI_TASK_GATE_D_RUNTIME;
const port = Number(process.env.PI_TASK_GATE_D_PORT);
if (!runtime || !Number.isInteger(port)) throw new Error("Gate D browser runtime and port are required");
const base = `http://127.0.0.1:${port}`;
const headers = { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" };

async function api(path, body) {
  const response = await fetch(`${base}${path}`, body === undefined ? undefined : {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`);
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

const projectRoot = join(runtime, "fictional-project");
await mkdir(projectRoot, { recursive: true });
const ensured = await api("/api/agent/new", { cwd: projectRoot, type: "ensure_session" });
const sessionId = ensured.sessionId;
await api(`/api/agent/${encodeURIComponent(sessionId)}`, {
  type: "set_session_name",
  name: "Gate D 状态恢复演示",
});
const stats = (await api(`/api/agent/${encodeURIComponent(sessionId)}`, {
  type: "get_session_stats",
})).data;
if (!stats?.sessionFile) throw new Error("Pi did not assign a Session file path");

const timestamp = new Date().toISOString();
await mkdir(dirname(stats.sessionFile), { recursive: true });
await writeFile(stats.sessionFile, [
  JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd: projectRoot }),
  JSON.stringify({ type: "session_info", id: "gate-d-lifecycle-name", parentId: null, timestamp, name: "Gate D 状态恢复演示" }),
  JSON.stringify({
    type: "message",
    id: "gate-d-lifecycle-user",
    parentId: "gate-d-lifecycle-name",
    timestamp,
    message: {
      role: "user",
      content: "请整理这份虚构交接说明；若缺条件，要明确记录需要谁补充什么。",
      timestamp: Date.now(),
    },
  }),
].join("\n") + "\n", "utf8");

const { project } = await api("/api/projects", {
  name: "Gate D 状态恢复演示",
  rootPath: projectRoot,
});
const { task } = await api("/api/tasks", {
  projectId: project.id,
  title: "整理虚构交接说明",
  goal: "验证阻塞、解除阻塞和取消都能保留真实原因与执行记录。",
  acceptanceCriteria: "状态变化、原因和下一步都可在任务详情中追溯。",
  expectedOutput: "handoff.md",
  status: "ready",
  primarySessionId: sessionId,
});
await api(`/api/tasks/${encodeURIComponent(task.id)}/prepare`, { version: task.version });

const result = { sessionId, projectId: project.id, taskId: task.id, projectRoot, sessionFile: stats.sessionFile };
await writeFile(join(runtime, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
