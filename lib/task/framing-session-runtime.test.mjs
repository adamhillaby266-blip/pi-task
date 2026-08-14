import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getRpcSession } = await jiti.import("../rpc-manager.ts");
const { invalidateSessionPathCache } = await jiti.import("../session-reader.ts");
const { getTaskSessionBinding } = await jiti.import("./binding.ts");
const { commitTaskFramingCandidate } = await jiti.import("./framing-commit.ts");
const { parseTaskFramingEntry } = await jiti.import("./framing-session.ts");
const { getTaskStore } = await jiti.import("./store.ts");
const { TaskDomainError } = await jiti.import("./errors.ts");
const framingSessionRoute = await jiti.import("../../app/api/tasks/[id]/framing-session/route.ts");

async function fixture(t, name) {
  const runtimeRoot = resolve(".runtime", "tests");
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, `task-framing-session-${name}-`));
  const paths = {
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    PI_TASK_DATA_DIR: join(root, "task-data"),
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  const previous = Object.fromEntries(Object.keys(paths).map((key) => [key, process.env[key]]));
  Object.assign(process.env, paths);
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  const store = getTaskStore();
  const project = store.createProject({ name: `Framing Session ${name}`, rootPath: projectRoot });
  const sessionIds = [];

  t.after(async () => {
    for (const sessionId of sessionIds) {
      getRpcSession(sessionId)?.destroy();
      invalidateSessionPathCache(sessionId);
    }
    store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, projectRoot, store, project, sessionIds };
}

function browserRequest(taskId, version) {
  return new Request(`http://127.0.0.1/api/tasks/${encodeURIComponent(taskId)}/framing-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({ version }),
  });
}

test("legacy backlog opens one ordinary Framing Session without a Run, capability, or automatic Prompt", async (t) => {
  const f = await fixture(t, "legacy");
  const task = f.store.createTask({
    projectId: f.project.id,
    title: "补全虚构旧任务",
    goal: "整理一份虚构交接",
    acceptanceCriteria: "交接内容可以回读",
    expectedOutput: "docs/fictional-handoff.md",
    status: "backlog",
  });

  const rejected = await framingSessionRoute.POST(new Request("http://127.0.0.1/api/tasks/rejected/framing-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: task.version }),
  }), { params: Promise.resolve({ id: task.id }) });
  assert.equal(rejected.status, 403);
  assert.equal(f.store.getTask(task.id).primarySessionId, null);

  const response = await framingSessionRoute.POST(browserRequest(task.id, task.version), {
    params: Promise.resolve({ id: task.id }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  f.sessionIds.push(result.session.sessionId);
  assert.equal(result.task.status, "backlog");
  assert.equal(result.task.primarySessionId, result.session.sessionId);
  assert.equal(result.task.version, task.version + 1);
  assert.equal(result.task.runs.length, 0);
  assert.equal(result.session.reused, false);
  assert.equal(result.session.candidateCreated, true);
  assert.equal(getRpcSession(result.session.sessionId), undefined);
  assert.equal(getTaskSessionBinding(result.session.sessionId), undefined);

  const manager = SessionManager.open(result.session.sessionFile, undefined);
  const entries = manager.getEntries();
  assert.equal(entries.some((entry) => entry.type === "message"), false);
  assert.equal(manager.getSessionName(), task.title);
  const drafts = entries.map((entry) => parseTaskFramingEntry(entry)).filter((event) => event?.eventType === "draft");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].createdBy, "system_legacy_adapter");
  assert.equal(drafts[0].taskId, task.id);
  assert.equal(drafts[0].baseTaskVersion, result.task.version);
  assert.equal(drafts[0].contract.contract, undefined);
  assert.equal(drafts[0].contract.authoritativeSources[0].availability, "missing");
  assert.ok(drafts[0].contract.openDecisions.some((decision) => decision.blocking && decision.status === "open"));

  const repeated = await framingSessionRoute.POST(browserRequest(task.id, result.task.version), {
    params: Promise.resolve({ id: task.id }),
  });
  assert.equal(repeated.status, 200);
  const repeatedResult = await repeated.json();
  assert.equal(repeatedResult.session.sessionId, result.session.sessionId);
  assert.equal(repeatedResult.session.reused, true);
  assert.equal(repeatedResult.session.candidateCreated, false);
  assert.equal(repeatedResult.session.candidateEntryId, result.session.candidateEntryId);
  assert.equal(SessionManager.open(result.session.sessionFile, undefined).getEntries()
    .map((entry) => parseTaskFramingEntry(entry))
    .filter((event) => event?.eventType === "draft").length, 1);

  const edited = f.store.updateTaskContract(task.id, result.task.version, {
    title: task.title,
    goal: "另一窗口修改后的虚构目标",
    acceptanceCriteria: task.acceptanceCriteria,
    expectedOutput: task.expectedOutput,
  });
  await assert.rejects(
    commitTaskFramingCandidate({
      operationId: "tfo_stale_legacy_adapter",
      sessionId: result.session.sessionId,
      sourceDraftEntryId: result.session.candidateEntryId,
      projectId: f.project.id,
      taskId: task.id,
      expectedTaskVersion: edited.version,
      action: "save_draft",
    }),
    (error) => error instanceof TaskDomainError && error.code === "VERSION_CONFLICT",
  );
  assert.equal(f.store.getTask(task.id).contract, null);
  assert.equal(f.store.getTaskDetail(task.id).runs.length, 0);
});

test("an existing primary Session is resumed for framing without creating another Session or Run", async (t) => {
  const f = await fixture(t, "resume");
  const manager = SessionManager.create(f.projectRoot, undefined);
  manager.appendMessage({ role: "user", content: "这是一段虚构旧对话", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "先保留这段虚构讨论。" }],
    api: "faux",
    provider: "faux",
    model: "framer",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sessionId = manager.getSessionId();
  f.sessionIds.push(sessionId);
  const task = f.store.createTask({
    projectId: f.project.id,
    title: "恢复虚构澄清对话",
    goal: "在原对话补全任务",
    acceptanceCriteria: "只生成候选约定",
    expectedOutput: "docs/fictional.md",
    status: "ready",
    primarySessionId: sessionId,
  });

  const response = await framingSessionRoute.POST(browserRequest(task.id, task.version), {
    params: Promise.resolve({ id: task.id }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.session.sessionId, sessionId);
  assert.equal(result.session.reused, true);
  assert.equal(result.task.version, task.version);
  assert.equal(result.task.runs.length, 0);
  assert.equal(getRpcSession(sessionId), undefined);
  assert.equal(SessionManager.open(result.session.sessionFile, undefined).getEntries()
    .filter((entry) => entry.type === "message").length, 2);
});
