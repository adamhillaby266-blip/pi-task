import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TaskDomainError } from "./errors.ts";
import { TaskStore } from "./store.ts";

async function fixture(t) {
  const runtimeRoot = resolve(".runtime", "tests");
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, "pi-task-store-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const store = new TaskStore(join(root, "data", "pi-task.sqlite"));
  t.after(() => {
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  return { root, projectRoot, store };
}

function contract(title = "Fictional rich contract", blocked = false) {
  const item = (id, text, status = "confirmed") => ({ id, text, status });
  return {
    schemaVersion: 1,
    title,
    outcome: item("outcome", "Produce a verifiable fictional decision record"),
    audience: [item("audience", "Fictional production lead")],
    authoritativeSources: [{ ...item("source", "Fictional source register"), availability: "available" }],
    scope: { included: [item("included", "Fictional FY2025")], excluded: [] },
    deliverables: [{ ...item("deliverable", "Decision record"), kind: "file", suggestedPath: "docs/fictional-decision.md" }],
    acceptanceCriteria: [item("acceptance", "The decision can be read back from the artifact")],
    constraints: [],
    assumptions: [],
    openDecisions: blocked ? [{
      id: "decision",
      question: "Which fictional baseline applies?",
      blocking: true,
      status: "open",
      options: ["A", "B"],
    }] : [],
    gates: [],
  };
}

function createReadyTask(store, projectRoot) {
  const project = store.createProject({ name: "Gate C fixture", rootPath: projectRoot });
  const task = store.createTask({
    projectId: project.id,
    title: "Create a verified handoff",
    goal: "Create a durable Markdown handoff",
    acceptanceCriteria: "The file contains the approved heading",
    expectedOutput: "handoff.md",
    status: "ready",
  });
  return { project, task };
}

test("schema v1 upgrades to v3 without changing existing task data", async (t) => {
  const runtimeRoot = resolve(".runtime", "tests");
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, "pi-task-migration-"));
  const projectRoot = join(root, "project");
  const databasePath = join(root, "data", "pi-task.sqlite");
  await mkdir(projectRoot, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const original = new TaskStore(databasePath);
  const { task } = createReadyTask(original, projectRoot);
  original.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    DROP TABLE task_framing_operations;
    DROP TABLE delegations;
    ALTER TABLE tasks DROP COLUMN contract_schema;
    ALTER TABLE tasks DROP COLUMN contract_json;
    ALTER TABLE tasks DROP COLUMN contract_revision;
    ALTER TABLE runs DROP COLUMN task_version_at_start;
    ALTER TABLE runs DROP COLUMN contract_revision;
    ALTER TABLE runs DROP COLUMN contract_snapshot_json;
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const upgraded = new TaskStore(databasePath);
  assert.equal(upgraded.getTask(task.id).title, task.title);
  assert.deepEqual(upgraded.getTaskDetail(task.id).delegations, []);
  upgraded.close();

  const verified = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verified.prepare("PRAGMA user_version").get().user_version, 3);
  assert.ok(verified.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delegations'").get());
  assert.ok(verified.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_framing_operations'").get());
  const taskColumns = verified.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name);
  const runColumns = verified.prepare("PRAGMA table_info(runs)").all().map((column) => column.name);
  assert.ok(taskColumns.includes("contract_json") && taskColumns.includes("contract_revision"));
  assert.ok(runColumns.includes("contract_snapshot_json") && runColumns.includes("task_version_at_start"));
  verified.close();
});

test("a database from a newer Pi Task version is rejected without changing its schema marker", async (t) => {
  const runtimeRoot = resolve(".runtime", "tests");
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, "pi-task-future-schema-"));
  const databasePath = join(root, "pi-task.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));

  const future = new DatabaseSync(databasePath);
  future.exec("PRAGMA user_version = 4");
  future.close();

  assert.throws(() => new TaskStore(databasePath), /schema 4 is newer than supported schema 3/);
  const verified = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(verified.prepare("PRAGMA user_version").get().user_version, 4);
  verified.close();
});

test("Task Framing saves backlog, confirms ready, remains idempotent, and snapshots the Run contract", async (t) => {
  const { projectRoot, store } = await fixture(t);
  const project = store.createProject({ name: "Task Framing", rootPath: projectRoot });

  const saved = store.commitTaskFraming({
    operationId: "tfo_save",
    sessionId: "session-framing",
    sourceEntryId: "draft-1",
    projectId: project.id,
    taskId: null,
    expectedTaskVersion: null,
    action: "save_draft",
    contract: contract("Fictional draft", true),
  });
  assert.equal(saved.task.status, "backlog");
  assert.equal(saved.task.primarySessionId, "session-framing");
  assert.equal(saved.task.contractRevision, 1);
  assert.equal(saved.task.contract.title, "Fictional draft");
  assert.equal(saved.operation.status, "saved");
  assert.equal(saved.task.runs.length, 0);
  assert.match(saved.task.expectedOutput, /docs\/fictional-decision\.md/);

  const retried = store.commitTaskFraming({
    operationId: "tfo_save",
    sessionId: "session-framing",
    sourceEntryId: "draft-1",
    projectId: project.id,
    taskId: null,
    expectedTaskVersion: null,
    action: "save_draft",
    contract: contract("A browser body that must be ignored by operation idempotency"),
  });
  assert.equal(retried.task.id, saved.task.id);
  assert.equal(store.listTasks(project.id).length, 1);
  assert.equal(store.listTaskFramingOperations("session-framing").length, 1);

  assert.throws(
    () => store.commitTaskFraming({
      operationId: "tfo_blocked_confirm",
      sessionId: "session-framing",
      sourceEntryId: "draft-1",
      projectId: project.id,
      taskId: saved.task.id,
      expectedTaskVersion: saved.task.version,
      action: "confirm",
      contract: contract("Still blocked", true),
    }),
    (error) => error instanceof TaskDomainError && error.code === "CONTRACT_NOT_READY",
  );

  const confirmed = store.commitTaskFraming({
    operationId: "tfo_confirm",
    sessionId: "session-framing",
    sourceEntryId: "draft-2",
    projectId: project.id,
    taskId: saved.task.id,
    expectedTaskVersion: saved.task.version,
    action: "confirm",
    contract: contract("Fictional confirmed contract"),
  });
  assert.equal(confirmed.task.status, "ready");
  assert.equal(confirmed.task.version, saved.task.version + 1);
  assert.equal(confirmed.task.contractRevision, 2);
  assert.equal(confirmed.operation.status, "confirmed");
  assert.equal(confirmed.task.runs.length, 0);
  assert.ok(confirmed.task.events.some((event) => event.type === "task.contract_saved"));
  assert.ok(confirmed.task.events.some((event) => event.type === "task.contract_confirmed"));
  assert.ok(confirmed.task.events.some((event) => event.type === "task.primary_session_bound"));

  assert.throws(
    () => store.commitTaskFraming({
      operationId: "tfo_stale",
      sessionId: "session-framing",
      sourceEntryId: "draft-3",
      projectId: project.id,
      taskId: confirmed.task.id,
      expectedTaskVersion: saved.task.version,
      action: "confirm",
      contract: contract("Stale overwrite"),
    }),
    (error) => error instanceof TaskDomainError && error.code === "VERSION_CONFLICT",
  );

  const started = store.beginRun(confirmed.task.id, confirmed.task.version);
  assert.equal(started.run.taskVersionAtStart, confirmed.task.version);
  assert.equal(started.run.contractRevision, confirmed.task.contractRevision);
  assert.equal(started.run.contractSnapshot.title, "Fictional confirmed contract");
});

test("confirm-and-start uses one recoverable operation and links at most one active Run", async (t) => {
  const { projectRoot, store } = await fixture(t);
  const project = store.createProject({ name: "Task Framing start", rootPath: projectRoot });
  const input = {
    operationId: "tfo_start",
    sessionId: "session-start",
    sourceEntryId: "draft-start",
    projectId: project.id,
    taskId: null,
    expectedTaskVersion: null,
    action: "confirm_and_start",
    contract: contract("Start contract"),
  };
  const committed = store.commitTaskFraming(input);
  assert.equal(committed.task.status, "ready");
  assert.equal(committed.operation.status, "awaiting_start");
  assert.equal(committed.task.runs.length, 0);

  const failedBeforeRun = store.markTaskFramingOperationStartFailed(input.operationId, "Preparation failed");
  assert.equal(failedBeforeRun.status, "start_failed");
  const retried = store.commitTaskFraming(input);
  assert.equal(retried.operation.status, "awaiting_start");
  assert.equal(retried.task.id, committed.task.id);

  const started = store.beginRun(retried.task.id, retried.task.version);
  const running = store.markRunRunning(started.run.id, input.sessionId);
  const linked = store.markTaskFramingOperationStarted(input.operationId, retried.task.id, running.run.id);
  assert.equal(linked.status, "started");
  assert.equal(linked.runId, running.run.id);
  assert.equal(store.markTaskFramingOperationStarted(input.operationId, retried.task.id, running.run.id).runId, running.run.id);
  assert.throws(
    () => store.beginRun(retried.task.id, running.task.version),
    (error) => error instanceof TaskDomainError && error.code === "INVALID_TRANSITION",
  );

  const recovered = store.failRun(running.run.id, "Prompt was rejected", true);
  assert.equal(recovered.task.status, "ready");
  assert.equal(store.getTaskFramingOperation(input.operationId).status, "start_failed");
  const failed = store.markTaskFramingOperationStartFailed(input.operationId, "Prompt was rejected");
  assert.equal(failed.status, "start_failed");
  assert.equal(store.commitTaskFraming(input).operation.status, "awaiting_start");
});

test("Task Framing prevents one Session from claiming a second Task", async (t) => {
  const { projectRoot, store } = await fixture(t);
  const project = store.createProject({ name: "Task Framing conflict", rootPath: projectRoot });
  const first = store.commitTaskFraming({
    operationId: "tfo_first",
    sessionId: "session-one-task",
    sourceEntryId: "draft-first",
    projectId: project.id,
    taskId: null,
    expectedTaskVersion: null,
    action: "save_draft",
    contract: contract("First Task"),
  });
  const secondTask = store.createTask({
    projectId: project.id,
    title: "Second Task",
    goal: "Must not take the same Session",
    acceptanceCriteria: "Conflict is rejected",
    expectedOutput: "second.md",
    status: "backlog",
  });

  assert.throws(
    () => store.commitTaskFraming({
      operationId: "tfo_conflict",
      sessionId: "session-one-task",
      sourceEntryId: "draft-conflict",
      projectId: project.id,
      taskId: secondTask.id,
      expectedTaskVersion: secondTask.version,
      action: "save_draft",
      contract: contract("Conflicting Task"),
    }),
    (error) => error instanceof TaskDomainError && error.code === "SESSION_ALREADY_BOUND",
  );
  assert.equal(store.findTaskByPrimarySessionId("session-one-task").id, first.task.id);
});

test("Framing Session binding uses optimistic locking and keeps Sessions exclusive", async (t) => {
  const { projectRoot, store } = await fixture(t);
  const project = store.createProject({ name: "Framing binding", rootPath: projectRoot });
  const backlog = store.createTask({
    projectId: project.id,
    title: "Bind a fictional backlog Task",
    goal: "",
    acceptanceCriteria: "",
    expectedOutput: "",
    status: "backlog",
  });

  const bound = store.bindTaskPrimarySession(backlog.id, backlog.version, "session-framing-binding");
  assert.equal(bound.primarySessionId, "session-framing-binding");
  assert.equal(bound.version, backlog.version + 1);
  assert.equal(bound.activeRunId, null);
  assert.equal(bound.runs.length, 0);
  assert.ok(bound.events.some((event) => (
    event.type === "task.primary_session_bound"
    && event.payload.source === "framing_session"
  )));

  assert.throws(
    () => store.bindTaskPrimarySession(backlog.id, backlog.version, "session-stale-binding"),
    (error) => error instanceof TaskDomainError && error.code === "VERSION_CONFLICT",
  );
  const second = store.createTask({
    projectId: project.id,
    title: "Second fictional backlog Task",
    goal: "",
    acceptanceCriteria: "",
    expectedOutput: "",
    status: "backlog",
  });
  assert.throws(
    () => store.bindTaskPrimarySession(second.id, second.version, "session-framing-binding"),
    (error) => error instanceof TaskDomainError && error.code === "SESSION_ALREADY_BOUND",
  );
});

test("a task supports two runs in one session, return, and human acceptance", async (t) => {
  const { projectRoot, store } = await fixture(t);
  const { task } = createReadyTask(store, projectRoot);

  const first = store.beginRun(task.id, task.version);
  assert.equal(first.task.status, "in_progress");
  assert.equal(first.run.status, "starting");
  assert.match(first.capability, /^cap_/);

  assert.throws(
    () => store.beginRun(task.id, first.task.version),
    (error) => error instanceof TaskDomainError && error.code === "INVALID_TRANSITION",
  );

  const running = store.markRunRunning(first.run.id, "session-gate-c");
  assert.equal(running.run.status, "running");
  assert.equal(running.task.primarySessionId, "session-gate-c");
  assert.equal(store.findTaskByPrimarySessionId("session-gate-c")?.id, task.id);
  assert.equal(store.findTaskByPrimarySessionId("session-not-bound"), null);

  await writeFile(join(projectRoot, "handoff.md"), "# First draft\n");
  assert.throws(
    () => store.submitReview(first.run.id, "cap_wrong", {
      summary: "First draft",
      changes: "Created handoff.md",
      verification: "Read the file",
      artifacts: [{ path: "handoff.md", verification: "Exists" }],
    }),
    (error) => error instanceof TaskDomainError && error.status === 403,
  );

  const submitted = store.submitReview(first.run.id, first.capability, {
    summary: "First draft",
    changes: "Created handoff.md",
    verification: "Read the file and checked its heading",
    unverified: "Final wording needs user review",
    risks: "None",
    artifacts: [{ path: "handoff.md", kind: "markdown", verification: "File exists and was read back" }],
  });
  assert.equal(submitted.status, "in_review");
  assert.equal(submitted.runs[0].status, "succeeded");
  assert.equal(submitted.reviews[0].status, "submitted");
  assert.equal(submitted.artifacts.length, 1);

  const returned = store.returnReview(task.id, submitted.version, "Use the approved heading");
  assert.equal(returned.status, "ready");
  assert.equal(returned.reviews[0].status, "rejected");
  assert.equal(returned.primarySessionId, "session-gate-c");

  const second = store.beginRun(task.id, returned.version);
  store.markRunRunning(second.run.id, "session-gate-c");
  await writeFile(join(projectRoot, "handoff.md"), "# Approved handoff\n");
  const resubmitted = store.submitReview(second.run.id, second.capability, {
    summary: "Updated draft",
    changes: "Changed the heading requested by the user",
    verification: "Read back the final file",
    artifacts: [{ path: "handoff.md", kind: "markdown", verification: "Approved heading is present" }],
  });
  assert.equal(resubmitted.runs.length, 2);
  assert.equal(resubmitted.reviews.length, 2);

  const accepted = store.acceptReview(task.id, resubmitted.version);
  assert.equal(accepted.status, "done");
  assert.equal(accepted.reviews.at(-1).status, "accepted");
  assert.equal(await readFile(join(projectRoot, "handoff.md"), "utf8"), "# Approved handoff\n");
  assert.ok(accepted.events.some((event) => event.type === "review.rejected"));
  assert.ok(accepted.events.some((event) => event.type === "review.accepted"));
});

test("a task can bind an existing conversation at creation without starting a Run", async (t) => {
  const { projectRoot, store } = await fixture(t);
  const project = store.createProject({ name: "Conversation", rootPath: projectRoot });
  const task = store.createTask({
    projectId: project.id,
    title: "Formalize the current discussion",
    goal: "Continue from the existing conversation",
    acceptanceCriteria: "The agreed artifact is reviewed",
    expectedOutput: "handoff.md",
    status: "ready",
    primarySessionId: "session-existing-conversation",
  });

  assert.equal(task.status, "ready");
  assert.equal(task.primarySessionId, "session-existing-conversation");
  assert.equal(task.activeRunId, null);
  assert.equal(store.findTaskByPrimarySessionId("session-existing-conversation")?.id, task.id);
  assert.equal(store.getTaskDetail(task.id).runs.length, 0);
  assert.deepEqual(store.getTaskDetail(task.id).events[0].payload, {
    status: "ready",
    source: "conversation",
    sessionId: "session-existing-conversation",
  });

  assert.throws(
    () => store.createTask({
      projectId: project.id,
      title: "Conflicting task",
      goal: "Must not claim the same conversation",
      acceptanceCriteria: "Creation is rejected",
      expectedOutput: "none.md",
      status: "ready",
      primarySessionId: "session-existing-conversation",
    }),
    (error) => error instanceof TaskDomainError && error.code === "INVALID_TRANSITION",
  );
});

test("readonly delegations stay subordinate to one active Run and persist evidence", async (t) => {
  const { projectRoot, store } = await fixture(t);
  const { task } = createReadyTask(store, projectRoot);
  const started = store.beginRun(task.id, task.version);
  store.markRunRunning(started.run.id, "session-moa");

  assert.throws(
    () => store.beginDelegationBatch(started.run.id, "cap_wrong", [
      { profile: "scout", prompt: "Locate fictional evidence" },
      { profile: "critic", prompt: "Challenge the fictional evidence" },
    ], "faux/analyst"),
    (error) => error instanceof TaskDomainError && error.status === 403,
  );

  const delegations = store.beginDelegationBatch(started.run.id, started.capability, [
    { profile: "scout", prompt: "Locate fictional evidence" },
    { profile: "critic", prompt: "Challenge the fictional evidence" },
  ], "faux/analyst");
  assert.equal(delegations.length, 2);
  assert.ok(delegations.every((delegation) => delegation.status === "running"));
  assert.equal(new Set(delegations.map((delegation) => delegation.batchId)).size, 1);

  assert.throws(
    () => store.beginDelegationBatch(started.run.id, started.capability, [
      { profile: "analyst", prompt: "Duplicate batch" },
      { profile: "critic", prompt: "Duplicate batch critic" },
    ], "faux/analyst"),
    (error) => error instanceof TaskDomainError && error.code === "INVALID_TRANSITION",
  );
  assert.throws(
    () => store.submitReview(started.run.id, started.capability, {
      summary: "Too early",
      changes: "No changes",
      verification: "Delegates are still running",
      artifacts: [{ path: "handoff.md", verification: "Not created" }],
    }),
    (error) => error instanceof TaskDomainError && error.code === "INVALID_TRANSITION",
  );

  const succeeded = store.finishDelegation(delegations[0].id, started.capability, {
    status: "succeeded",
    output: "Verified fictional evidence in docs/source.md",
    usage: { input: 120, output: 40, totalTokens: 160, cost: 0.001 },
  });
  const failed = store.finishDelegation(delegations[1].id, started.capability, {
    status: "failed",
    error: "The fictional critic provider stopped",
  });
  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.usage.totalTokens, 160);
  assert.equal(failed.status, "failed");

  const detail = store.getTaskDetail(task.id);
  assert.equal(detail.runs.length, 1);
  assert.equal(detail.delegations.length, 2);
  assert.ok(detail.events.some((event) => event.type === "delegation.started"));
  assert.ok(detail.events.some((event) => event.type === "delegation.succeeded"));
  assert.ok(detail.events.some((event) => event.type === "delegation.failed"));

  await writeFile(join(projectRoot, "handoff.md"), "# Delegated evidence\n");
  const submitted = store.submitReview(started.run.id, started.capability, {
    summary: "Parent synthesized the evidence",
    changes: "Created handoff.md in the parent Run",
    verification: "Parent read back the file",
    artifacts: [{ path: "handoff.md", verification: "Parent verified the heading" }],
  });
  assert.equal(submitted.status, "in_review");
  assert.equal(submitted.delegations.length, 2);
});

test("restart reconciliation interrupts running delegations with their parent Run", async (t) => {
  const { projectRoot, store } = await fixture(t);
  const { task } = createReadyTask(store, projectRoot);
  const started = store.beginRun(task.id, task.version);
  store.markRunRunning(started.run.id, "session-moa-restart");
  const [delegation] = store.beginDelegationBatch(started.run.id, started.capability, [
    { profile: "scout", prompt: "Read fictional files" },
    { profile: "analyst", prompt: "Analyze fictional files" },
  ], "faux/analyst");

  assert.equal(store.reconcileActiveRuns("Fictional restart during delegation"), 1);
  const detail = store.getTaskDetail(task.id);
  assert.equal(detail.status, "ready");
  assert.ok(detail.delegations.every((candidate) => candidate.status === "interrupted"));
  assert.match(store.getDelegation(delegation.id).error, /Fictional restart/);
  assert.equal(detail.events.find((event) => event.type === "run.interrupted")?.payload.stoppedDelegationCount, 2);
});

test("review submission rejects artifacts outside the project root", async (t) => {
  const { root, projectRoot, store } = await fixture(t);
  const { task } = createReadyTask(store, projectRoot);
  const started = store.beginRun(task.id, task.version);
  store.markRunRunning(started.run.id, "session-artifact-boundary");
  const outside = join(root, "outside.md");
  await writeFile(outside, "outside");

  assert.throws(
    () => store.submitReview(started.run.id, started.capability, {
      summary: "Invalid handoff",
      changes: "Created a file outside the project",
      verification: "File exists",
      artifacts: [{ path: outside, verification: "Exists" }],
    }),
    (error) => error instanceof TaskDomainError && error.code === "INVALID_ARTIFACT",
  );
  assert.equal(store.getTask(task.id).status, "in_progress");
});

test("waiting input, blocking, unblocking, and canceling preserve Run evidence", async (t) => {
  const { projectRoot, store } = await fixture(t);
  const { task } = createReadyTask(store, projectRoot);

  const first = store.beginRun(task.id, task.version);
  store.markRunRunning(first.run.id, "session-lifecycle");
  const waiting = store.markRunWaitingUser(first.run.id, first.capability, "Which owner should receive the handoff?");
  assert.equal(waiting.run.status, "waiting_user");
  const resumed = store.resumeRun(first.run.id, "Assign it to the production lead.");
  assert.equal(resumed.run.status, "running");
  store.beginDelegationBatch(first.run.id, first.capability, [
    { profile: "scout", prompt: "Locate the fictional owner list" },
    { profile: "critic", prompt: "Check the fictional owner list risk" },
  ], "faux/analyst");

  const blocked = store.blockTask(task.id, resumed.task.version, "Waiting for the approved owner list");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.activeRunId, null);
  assert.equal(blocked.recoveryNote, "Waiting for the approved owner list");
  assert.equal(blocked.runs[0].status, "interrupted");
  assert.ok(blocked.delegations.every((delegation) => delegation.status === "interrupted"));
  assert.ok(blocked.events.some((event) => event.type === "run.waiting_user" && event.payload.question === "Which owner should receive the handoff?"));
  assert.ok(blocked.events.some((event) => event.type === "run.resumed" && event.payload.answer === "Assign it to the production lead."));
  assert.ok(blocked.events.some((event) => event.type === "task.blocked" && event.payload.reason === "Waiting for the approved owner list"));

  const unblocked = store.unblockTask(task.id, blocked.version, "The approved owner list is now attached.");
  assert.equal(unblocked.status, "ready");
  assert.equal(unblocked.recoveryNote, "The approved owner list is now attached.");
  assert.ok(unblocked.events.some((event) => event.type === "task.unblocked" && event.payload.resolution === "The approved owner list is now attached."));

  const second = store.beginRun(task.id, unblocked.version);
  store.markRunRunning(second.run.id, "session-lifecycle");
  store.beginDelegationBatch(second.run.id, second.capability, [
    { profile: "scout", prompt: "Read cancellation evidence" },
    { profile: "analyst", prompt: "Analyze cancellation evidence" },
  ], "faux/analyst");
  const canceled = store.cancelTask(task.id, store.getTask(task.id).version, "The project is no longer needed");
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.activeRunId, null);
  assert.equal(canceled.runs.at(-1).status, "canceled");
  assert.ok(canceled.delegations.filter((delegation) => delegation.runId === second.run.id).every((delegation) => delegation.status === "canceled"));
  assert.ok(canceled.events.some((event) => event.type === "run.canceled" && event.payload.reason === "The project is no longer needed"));
  assert.ok(canceled.events.some((event) => event.type === "task.canceled" && event.payload.reason === "The project is no longer needed"));

  assert.throws(
    () => store.unblockTask(task.id, canceled.version, "Cannot reopen a canceled task through unblock"),
    (error) => error instanceof TaskDomainError && error.code === "INVALID_TRANSITION",
  );
});

test("restart reconciliation removes phantom running state", async (t) => {
  const { root, projectRoot, store } = await fixture(t);
  const { task } = createReadyTask(store, projectRoot);
  const started = store.beginRun(task.id, task.version);
  store.markRunRunning(started.run.id, "session-interrupted");

  const count = store.reconcileActiveRuns();
  assert.equal(count, 1);
  const detail = store.getTaskDetail(task.id);
  assert.equal(detail.status, "ready");
  assert.equal(detail.activeRunId, null);
  assert.equal(detail.runs[0].status, "interrupted");
  assert.match(detail.recoveryNote, /restarted/);
  assert.equal(store.reconcileActiveRuns(), 0);
  assert.ok(root);
});

test("queue moves require the latest version and a complete ready contract", async (t) => {
  const { projectRoot, store } = await fixture(t);
  const project = store.createProject({ name: "Queue", rootPath: projectRoot });
  const draft = store.createTask({
    projectId: project.id,
    title: "Incomplete draft",
    goal: "",
    acceptanceCriteria: "",
    expectedOutput: "",
  });

  assert.throws(
    () => store.moveQueuedTask(draft.id, draft.version, "ready"),
    (error) => error instanceof TaskDomainError && error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => store.moveQueuedTask(draft.id, draft.version + 1, "backlog"),
    (error) => error instanceof TaskDomainError && error.code === "VERSION_CONFLICT",
  );

  const first = store.createTask({
    projectId: project.id,
    title: "First queued task",
    goal: "Keep a verifiable queue order",
    acceptanceCriteria: "Its relative position can change",
    expectedOutput: "first.md",
    status: "backlog",
  });
  const second = store.createTask({
    projectId: project.id,
    title: "Second queued task",
    goal: "Keep a verifiable queue order",
    acceptanceCriteria: "Its relative position can change",
    expectedOutput: "second.md",
    status: "backlog",
  });
  const third = store.createTask({
    projectId: project.id,
    title: "Third queued task",
    goal: "Keep a verifiable queue order",
    acceptanceCriteria: "Its relative position can change",
    expectedOutput: "third.md",
    status: "backlog",
  });
  store.moveQueuedTask(third.id, third.version, "backlog", first.sortOrder - 512);
  assert.deepEqual(
    store.listTasks(project.id).filter((task) => task.status === "backlog").map((task) => task.id),
    [draft.id, third.id, first.id, second.id],
  );
});

test("backlog and ready contracts edit with optimistic versions and retain an audit event", async (t) => {
  const { projectRoot, store } = await fixture(t);
  const project = store.createProject({ name: "Contract maintenance", rootPath: projectRoot });
  const draft = store.createTask({
    projectId: project.id,
    title: "Incomplete contract",
    goal: "",
    acceptanceCriteria: "",
    expectedOutput: "",
    status: "backlog",
  });

  const completed = store.updateTaskContract(draft.id, draft.version, {
    title: "Verified contract",
    goal: "Clarify the fictional handoff",
    acceptanceCriteria: "The documented decision can be checked",
    expectedOutput: "handoff.md",
  });
  assert.equal(completed.status, "backlog");
  assert.equal(completed.version, draft.version + 1);
  assert.equal(completed.goal, "Clarify the fictional handoff");
  assert.deepEqual(completed.events.at(-1)?.payload, {
    fields: ["title", "goal", "acceptanceCriteria", "expectedOutput"],
    status: "backlog",
  });

  assert.throws(
    () => store.updateTaskContract(draft.id, draft.version, {
      title: "Stale contract",
      goal: "Stale goal",
      acceptanceCriteria: "Stale criteria",
      expectedOutput: "stale.md",
    }),
    (error) => error instanceof TaskDomainError && error.code === "VERSION_CONFLICT",
  );

  const ready = store.moveQueuedTask(completed.id, completed.version, "ready");
  const revised = store.updateTaskContract(ready.id, ready.version, {
    title: "Verified contract, revised",
    goal: "Clarify the fictional handoff and owner",
    acceptanceCriteria: "The documented decision and owner can be checked",
    expectedOutput: "handoff.md",
  });
  assert.equal(revised.status, "ready");
  assert.equal(revised.version, ready.version + 1);
  assert.equal(revised.title, "Verified contract, revised");

  assert.throws(
    () => store.updateTaskContract(revised.id, revised.version, {
      title: revised.title,
      goal: "",
      acceptanceCriteria: revised.acceptanceCriteria,
      expectedOutput: revised.expectedOutput,
    }),
    (error) => error instanceof TaskDomainError && error.code === "INVALID_INPUT",
  );
  assert.equal(store.getTask(revised.id).goal, revised.goal);

  const started = store.beginRun(revised.id, revised.version);
  assert.throws(
    () => store.updateTaskContract(revised.id, started.task.version, {
      title: "No active edit",
      goal: "No active edit",
      acceptanceCriteria: "No active edit",
      expectedOutput: "none.md",
    }),
    (error) => error instanceof TaskDomainError && error.code === "INVALID_TRANSITION",
  );
});
