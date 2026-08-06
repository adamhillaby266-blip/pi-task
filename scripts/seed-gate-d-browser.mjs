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
  name: "讨论季度交接说明",
});
const stats = (await api(`/api/agent/${encodeURIComponent(sessionId)}`, {
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
      content: "请把季度交接要求整理成一份后续可以验收和继续修改的 Markdown 文件。",
      timestamp: Date.now(),
    },
  }),
].join("\n") + "\n", "utf8");

const result = { sessionId, projectRoot, sessionFile: stats.sessionFile };
await writeFile(join(runtime, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
