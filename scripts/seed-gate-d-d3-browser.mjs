import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const runtime = process.env.PI_TASK_GATE_D_RUNTIME;
const port = Number(process.env.PI_TASK_GATE_D_PORT);
if (!runtime || !Number.isInteger(port)) throw new Error("Gate D D3 browser runtime and port are required");

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
    if ((await fetch(`${base}/api/projects`)).ok) break;
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
  name: "Gate D D3 合同与队列演示",
});
const stats = (await api(`/api/agent/${encodeURIComponent(sessionId)}`, {
  type: "get_session_stats",
})).data;
if (!stats?.sessionFile) throw new Error("Pi did not assign a Session file path");

const timestamp = new Date().toISOString();
await mkdir(dirname(stats.sessionFile), { recursive: true });
await writeFile(stats.sessionFile, [
  JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd: projectRoot }),
  JSON.stringify({ type: "session_info", id: "gate-d-d3-name", parentId: null, timestamp, name: "Gate D D3 合同与队列演示" }),
  JSON.stringify({
    type: "message",
    id: "gate-d-d3-user",
    parentId: "gate-d-d3-name",
    timestamp,
    message: {
      role: "user",
      content: "这是虚构的 Gate D D3 浏览器验收；只检查合同编辑和任务队列交互。",
      timestamp: Date.now(),
    },
  }),
].join("\n") + "\n", "utf8");

const { project } = await api("/api/projects", {
  name: "Gate D D3 虚构合同与队列",
  rootPath: projectRoot,
});

const taskSpecs = [
  {
    title: "补全虚构交接合同",
    goal: "",
    acceptanceCriteria: "",
    expectedOutput: "",
    status: "backlog",
  },
  {
    title: "同列排序：先整理封面说明",
    goal: "把虚构封面说明排入正确的处理顺序。",
    acceptanceCriteria: "任务顺序可被调整且合同完整。",
    expectedOutput: "cover-note.md",
    status: "backlog",
  },
  {
    title: "同列排序：再整理目录说明",
    goal: "把虚构目录说明排入正确的处理顺序。",
    acceptanceCriteria: "任务顺序可被调整且合同完整。",
    expectedOutput: "contents-note.md",
    status: "backlog",
  },
  {
    title: "完整的虚构待办任务",
    goal: "验证完整合同可见且可以进入 Pi 对话。",
    acceptanceCriteria: "标题、目标、验收条件和预期产物均可检查。",
    expectedOutput: "ready-task.md",
    status: "ready",
  },
];

const tasks = [];
for (const spec of taskSpecs) {
  const { task } = await api("/api/tasks", { projectId: project.id, ...spec });
  tasks.push(task);
}

const result = { sessionId, projectId: project.id, taskIds: tasks.map((task) => task.id), projectRoot, sessionFile: stats.sessionFile };
await writeFile(join(runtime, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
