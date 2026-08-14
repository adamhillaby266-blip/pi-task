import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../session-reader.ts");
const { commitTaskFramingCandidate } = await jiti.import("./framing-commit.ts");
const { prepareTaskSession } = await jiti.import("./runtime.ts");
const { getTaskStore } = await jiti.import("./store.ts");
const { getRpcSession } = await jiti.import("../rpc-manager.ts");
const startRoute = await jiti.import("../../app/api/tasks/[id]/start/route.ts");

function item(id, text, status = "confirmed") {
  return { id, text, status };
}

function contract() {
  return {
    schemaVersion: 1,
    title: "虚构自动开始交付",
    outcome: item("outcome", "完成一次可验证的虚构自动开始"),
    audience: [item("audience", "虚构负责人")],
    authoritativeSources: [{ ...item("source", "虚构项目文件"), availability: "available" }],
    scope: { included: [item("included", "虚构交付")], excluded: [] },
    deliverables: [{ ...item("deliverable", "虚构交接文件"), kind: "file", suggestedPath: "handoff.md" }],
    acceptanceCriteria: [item("acceptance", "文件存在并回读标题")],
    constraints: [],
    assumptions: [],
    openDecisions: [],
    gates: [],
  };
}

function assistantMessage(text) {
  return {
    ...fauxAssistantMessage(fauxText(text)),
    provider: "faux-task-start",
    model: "runner",
  };
}

function waitForPrompt(session, message) {
  return new Promise((resolvePromise, rejectPromise) => {
    const unsubscribe = session.onEvent((event) => {
      if (event.type === "prompt_error") {
        unsubscribe();
        rejectPromise(new Error(String(event.errorMessage)));
      } else if (event.type === "prompt_done") {
        unsubscribe();
        resolvePromise();
      }
    });
    void session.send({ type: "prompt", message }).catch((error) => {
      unsubscribe();
      rejectPromise(error);
    });
  });
}

test("confirm-and-start creates one Run, sends one visible start message, and reaches Review with faux", async (t) => {
  const runtimeRoot = resolve(".runtime", "tests");
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, "task-framing-start-"));
  const cwd = join(root, "fictional-project");
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const taskData = join(root, "task-data");
  await Promise.all([cwd, home, tmp, agentDir, sessionDir, taskData].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(cwd, "handoff.md"), "# Faux automatic start\n");

  const previous = Object.fromEntries(["HOME", "TMPDIR", "PI_CODING_AGENT_DIR", "PI_TASK_DATA_DIR"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, TMPDIR: tmp, PI_CODING_AGENT_DIR: agentDir, PI_TASK_DATA_DIR: taskData });
  const store = getTaskStore();
  const project = store.createProject({ name: "Faux start", rootPath: cwd });
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendModelChange("faux-task-start", "runner");
  manager.appendMessage({ role: "user", content: "请先形成虚构任务约定", timestamp: Date.now() });
  manager.appendMessage(assistantMessage("我已经形成候选任务约定。"));
  const draftEntryId = manager.appendCustomEntry("pi-task.task-framing", {
    schemaVersion: 1,
    eventType: "draft",
    draftId: "tfd_start",
    revision: 1,
    replacesEntryId: null,
    taskId: null,
    baseTaskVersion: null,
    contract: contract(),
    changeSummary: ["形成可开始的虚构约定"],
    createdBy: "agent",
  });
  const sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  cacheSessionPath(sessionId, sessionFile);

  const faux = fauxProvider({
    provider: "faux-task-start",
    models: [{ id: "runner", reasoning: false }],
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_task", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_task_review", {
      summary: "虚构自动开始已验证",
      changes: "使用预置虚构 handoff.md 作为隔离交付证据",
      verification: "回读文件标题 # Faux automatic start",
      risks: "None",
      artifacts: [{ path: "handoff.md", kind: "markdown", verification: "文件存在且标题已回读" }],
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("已提交给用户验收；不会自行标记完成。")),
  ]);
  const providerExtension = {
    name: "faux-task-start-provider",
    factory(pi) { pi.registerProvider(faux.provider); },
  };

  let wrapper;
  t.after(async () => {
    try { await wrapper?.shutdown(); } catch { /* best effort */ }
    invalidateSessionPathCache(sessionId);
    store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const committed = await commitTaskFramingCandidate({
    operationId: "tfo_faux_start",
    sessionId,
    sourceDraftEntryId: draftEntryId,
    projectId: project.id,
    taskId: null,
    expectedTaskVersion: null,
    action: "confirm_and_start",
  });
  assert.equal(committed.task.status, "ready");
  assert.equal(committed.operation.status, "awaiting_start");
  assert.equal(committed.task.runs.length, 0);

  const prepared = await prepareTaskSession(committed.task.id, committed.task.version, {
    extensionFactories: [providerExtension],
  });
  wrapper = getRpcSession(prepared.sessionId);
  assert.ok(wrapper);
  await wrapper.waitUntilReady();

  const startRequest = (taskId = committed.task.id) => new Request(`http://127.0.0.1/api/tasks/${taskId}/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({
      version: committed.task.version,
      sessionId,
      operationId: committed.operation.id,
    }),
  });
  const startResponse = await startRoute.POST(startRequest(), { params: Promise.resolve({ id: committed.task.id }) });
  assert.equal(startResponse.status, 200);
  const started = await startResponse.json();
  assert.equal(started.run.status, "running");
  assert.equal(started.operation.status, "started");

  const visibleStartMessage = "我已确认任务约定并选择现在开始。请按该约定开始 Run 1。";
  await waitForPrompt(wrapper, visibleStartMessage);

  const detail = store.getTaskDetail(committed.task.id);
  assert.equal(detail.status, "in_review");
  assert.equal(detail.runs.length, 1);
  assert.equal(detail.runs[0].status, "succeeded");
  assert.equal(detail.runs[0].contractSnapshot.title, contract().title);
  assert.equal(detail.reviews.length, 1);
  assert.equal(store.getTaskFramingOperation(committed.operation.id).status, "started");
  assert.equal(faux.state.callCount, 3);

  const restored = SessionManager.open(sessionFile, sessionDir).getEntries();
  const startMessages = restored.filter((entry) => {
    if (entry.type !== "message" || entry.message?.role !== "user") return false;
    const content = entry.message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
        : "";
    return text === visibleStartMessage;
  });
  assert.equal(startMessages.length, 1);

  const mismatchedResponse = await startRoute.POST(startRequest("tsk_other"), {
    params: Promise.resolve({ id: "tsk_other" }),
  });
  assert.equal(mismatchedResponse.status, 409);
  assert.equal(store.getTaskFramingOperation(committed.operation.id).status, "started");

  const retryResponse = await startRoute.POST(startRequest(), { params: Promise.resolve({ id: committed.task.id }) });
  assert.equal(retryResponse.status, 200);
  assert.equal(store.getTaskDetail(committed.task.id).runs.length, 1);
});
