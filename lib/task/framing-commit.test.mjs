import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../session-reader.ts");
const { appendTaskFramingPreference, commitTaskFramingCandidate, getTaskFramingStatus } = await jiti.import("./framing-commit.ts");
const { parseTaskFramingEntry, TASK_FRAMING_CUSTOM_TYPE } = await jiti.import("./framing-session.ts");
const { getTaskStore } = await jiti.import("./store.ts");
const { TaskDomainError } = await jiti.import("./errors.ts");
const taskFramingRoute = await jiti.import("../../app/api/task-framing/route.ts");

function item(id, text, status = "confirmed") {
  return { id, text, status };
}

function contract(title = "虚构任务约定", blocked = false) {
  return {
    schemaVersion: 1,
    title,
    outcome: item("outcome", "形成可验证的虚构决策记录"),
    audience: [item("audience", "虚构生产负责人")],
    authoritativeSources: [{ ...item("source", "虚构来源表"), availability: "available" }],
    scope: { included: [item("included", "虚构 FY2025")], excluded: [] },
    deliverables: [{ ...item("deliverable", "虚构决策记录"), kind: "file", suggestedPath: "docs/fictional.md" }],
    acceptanceCriteria: [item("acceptance", "关键结论可从文件回读")],
    constraints: [],
    assumptions: [],
    openDecisions: blocked ? [{
      id: "decision",
      question: "选择哪个虚构基准？",
      blocking: true,
      status: "open",
      options: ["A", "B"],
    }] : [],
    gates: [],
  };
}

function appendDraft(manager, revision, taskId = null, options = {}) {
  return manager.appendCustomEntry(TASK_FRAMING_CUSTOM_TYPE, {
    schemaVersion: 1,
    eventType: "draft",
    draftId: options.draftId ?? "tfd_commit_test",
    revision,
    replacesEntryId: options.replacesEntryId ?? null,
    taskId,
    baseTaskVersion: options.baseTaskVersion ?? null,
    contract: contract(options.title ?? `虚构草案 ${revision}`, options.blocked ?? false),
    changeSummary: options.changeSummary ?? [],
    createdBy: "agent",
  });
}

async function fixture(t, name = "commit") {
  const runtimeRoot = resolve(".runtime", "tests");
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, `task-framing-${name}-`));
  const projectRoot = join(root, "project");
  const sessionDir = join(root, "sessions");
  const taskData = join(root, "task-data");
  await Promise.all([projectRoot, sessionDir, taskData].map((path) => mkdir(path, { recursive: true })));
  const previousTaskData = process.env.PI_TASK_DATA_DIR;
  process.env.PI_TASK_DATA_DIR = taskData;
  const store = getTaskStore();
  const project = store.createProject({ name: `Framing ${name}`, rootPath: projectRoot });
  const manager = SessionManager.create(projectRoot, sessionDir);
  manager.appendMessage({ role: "user", content: "请处理虚构任务", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "我先起草虚构任务约定。" }],
    api: "faux",
    provider: "faux",
    model: "framer",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const draftEntryId = appendDraft(manager, 1);
  const sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile && existsSync(sessionFile));
  cacheSessionPath(sessionId, sessionFile);

  t.after(async () => {
    invalidateSessionPathCache(sessionId);
    store.close();
    if (previousTaskData === undefined) delete process.env.PI_TASK_DATA_DIR;
    else process.env.PI_TASK_DATA_DIR = previousTaskData;
    await rm(root, { recursive: true, force: true });
  });
  return { root, projectRoot, sessionDir, taskData, store, project, manager, sessionId, sessionFile, draftEntryId };
}

test("candidate commit saves backlog, retries idempotently, rejects a stale draft, and confirms ready", async (t) => {
  const f = await fixture(t, "lifecycle");
  const initial = await getTaskFramingStatus(f.sessionId);
  assert.equal(initial.latestDraftEntryId, f.draftEntryId);
  assert.equal(initial.task, null);
  assert.equal(initial.project.id, f.project.id);
  assert.deepEqual(initial.actions, { saveDraft: true, confirm: true, confirmAndStart: true });

  const saved = await commitTaskFramingCandidate({
    operationId: "tfo_save_lifecycle",
    sessionId: f.sessionId,
    sourceDraftEntryId: f.draftEntryId,
    projectId: f.project.id,
    taskId: null,
    expectedTaskVersion: null,
    action: "save_draft",
  });
  assert.equal(saved.task.status, "backlog");
  assert.equal(saved.task.primarySessionId, f.sessionId);
  assert.equal(saved.task.contract.title, "虚构草案 1");
  assert.equal(saved.task.runs.length, 0);
  assert.ok(saved.receiptEntryId);

  const afterSave = await getTaskFramingStatus(f.sessionId);
  assert.equal(afterSave.task.id, saved.task.id);
  assert.deepEqual(afterSave.actions, { saveDraft: false, confirm: true, confirmAndStart: true });

  const retried = await commitTaskFramingCandidate({
    operationId: "tfo_save_lifecycle",
    sessionId: f.sessionId,
    sourceDraftEntryId: f.draftEntryId,
    projectId: f.project.id,
    taskId: null,
    expectedTaskVersion: null,
    action: "save_draft",
  });
  assert.equal(retried.task.id, saved.task.id);
  assert.equal(retried.receiptEntryId, null);
  const afterRetryEntries = SessionManager.open(f.sessionFile, f.sessionDir).getEntries();
  assert.equal(afterRetryEntries.filter((entry) => parseTaskFramingEntry(entry)?.eventType === "commit_receipt").length, 1);
  assert.equal(f.store.listTasks(f.project.id).length, 1);

  const revisedManager = SessionManager.open(f.sessionFile, f.sessionDir);
  const secondDraftEntryId = appendDraft(revisedManager, 2, saved.task.id, {
    replacesEntryId: f.draftEntryId,
    baseTaskVersion: saved.task.version,
    title: "虚构确认稿",
    changeSummary: ["确认虚构范围"],
  });

  await assert.rejects(
    commitTaskFramingCandidate({
      operationId: "tfo_stale_lifecycle",
      sessionId: f.sessionId,
      sourceDraftEntryId: f.draftEntryId,
      projectId: f.project.id,
      taskId: saved.task.id,
      expectedTaskVersion: saved.task.version,
      action: "confirm",
    }),
    (error) => error instanceof TaskDomainError && error.code === "DRAFT_STALE",
  );

  const confirmed = await commitTaskFramingCandidate({
    operationId: "tfo_confirm_lifecycle",
    sessionId: f.sessionId,
    sourceDraftEntryId: secondDraftEntryId,
    projectId: f.project.id,
    taskId: saved.task.id,
    expectedTaskVersion: saved.task.version,
    action: "confirm",
  });
  assert.equal(confirmed.task.status, "ready");
  assert.equal(confirmed.task.contract.title, "虚构确认稿");
  assert.equal(confirmed.task.runs.length, 0);
  assert.equal(confirmed.operation.status, "confirmed");

  const final = await getTaskFramingStatus(f.sessionId);
  assert.deepEqual(final.actions, { saveDraft: false, confirm: false, confirmAndStart: true });
});

test("a failed start stays confirmed and exposes only the retry-start action", async (t) => {
  const f = await fixture(t, "failed-start-actions");
  const committed = await commitTaskFramingCandidate({
    operationId: "tfo_failed_start_actions",
    sessionId: f.sessionId,
    sourceDraftEntryId: f.draftEntryId,
    projectId: f.project.id,
    taskId: null,
    expectedTaskVersion: null,
    action: "confirm_and_start",
  });
  f.store.markTaskFramingOperationStartFailed(committed.operation.id, "Fictional preparation failure");

  const status = await getTaskFramingStatus(f.sessionId);
  assert.equal(status.task.status, "ready");
  assert.deepEqual(status.actions, { saveDraft: false, confirm: false, confirmAndStart: true });
});

test("Session preferences persist decline and reopen without touching SQLite Tasks", async (t) => {
  const f = await fixture(t, "preference");
  const manager = SessionManager.open(f.sessionFile, f.sessionDir);
  manager.appendCustomEntry(TASK_FRAMING_CUSTOM_TYPE, {
    schemaVersion: 1,
    eventType: "suggested",
    suggestionId: "tfs_preference",
    reason: "虚构任务需要跨回合验收",
  });

  const declined = await appendTaskFramingPreference(f.sessionId, "declined", "tfs_preference");
  assert.equal(declined.appended, true);
  const repeated = await appendTaskFramingPreference(f.sessionId, "declined", "tfs_preference");
  assert.equal(repeated.appended, false);
  assert.equal(repeated.entryId, declined.entryId);
  const reopened = await appendTaskFramingPreference(f.sessionId, "reopened", "tfs_preference");
  assert.equal(reopened.appended, true);
  assert.equal(f.store.listTasks().length, 0);
  assert.equal(f.store.listTaskFramingOperations(f.sessionId).length, 0);
});

test("the commit API requires browser authority and ignores a browser-supplied contract body", async (t) => {
  const f = await fixture(t, "route");
  const body = {
    operationId: "tfo_route_save",
    sessionId: f.sessionId,
    sourceDraftEntryId: f.draftEntryId,
    projectId: f.project.id,
    taskId: null,
    expectedTaskVersion: null,
    action: "save_draft",
    contract: contract("浏览器试图替换的正文"),
  };
  const rejected = await taskFramingRoute.POST(new Request("http://127.0.0.1/api/task-framing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  assert.equal(rejected.status, 403);
  assert.equal(f.store.listTasks().length, 0);

  const accepted = await taskFramingRoute.POST(new Request("http://127.0.0.1/api/task-framing", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify(body),
  }));
  assert.equal(accepted.status, 200);
  const result = await accepted.json();
  assert.equal(result.task.contract.title, "虚构草案 1");
  assert.notEqual(result.task.contract.title, body.contract.title);
  assert.equal(result.task.runs.length, 0);
});

test("commit rechecks readiness and Project root without trusting browser contract data", async (t) => {
  const f = await fixture(t, "security");
  const blockedManager = SessionManager.open(f.sessionFile, f.sessionDir);
  const blockedEntryId = appendDraft(blockedManager, 2, null, {
    replacesEntryId: f.draftEntryId,
    blocked: true,
    title: "仍有阻塞决定",
  });

  await assert.rejects(
    commitTaskFramingCandidate({
      operationId: "tfo_blocked_security",
      sessionId: f.sessionId,
      sourceDraftEntryId: blockedEntryId,
      projectId: f.project.id,
      taskId: null,
      expectedTaskVersion: null,
      action: "confirm",
    }),
    (error) => error instanceof TaskDomainError && error.code === "CONTRACT_NOT_READY",
  );
  assert.equal(f.store.listTasks(f.project.id).length, 0);
  assert.equal(f.store.listTaskFramingOperations(f.sessionId).length, 0);

  const outsideRoot = join(f.root, "outside-project");
  await mkdir(outsideRoot);
  const outsideProject = f.store.createProject({ name: "Outside", rootPath: outsideRoot });
  await assert.rejects(
    commitTaskFramingCandidate({
      operationId: "tfo_outside_security",
      sessionId: f.sessionId,
      sourceDraftEntryId: blockedEntryId,
      projectId: outsideProject.id,
      taskId: null,
      expectedTaskVersion: null,
      action: "save_draft",
    }),
    (error) => error instanceof TaskDomainError && error.code === "INVALID_INPUT" && /outside/.test(error.message),
  );
  assert.equal(f.store.listTasks().length, 0);
});
