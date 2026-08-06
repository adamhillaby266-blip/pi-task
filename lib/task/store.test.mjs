import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskDomainError } from "./errors.ts";
import { TaskStore } from "./store.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-task-store-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const store = new TaskStore(join(root, "data", "pi-task.sqlite"));
  t.after(() => {
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  return { root, projectRoot, store };
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

  const blocked = store.blockTask(task.id, resumed.task.version, "Waiting for the approved owner list");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.activeRunId, null);
  assert.equal(blocked.recoveryNote, "Waiting for the approved owner list");
  assert.equal(blocked.runs[0].status, "interrupted");
  assert.ok(blocked.events.some((event) => event.type === "run.waiting_user" && event.payload.question === "Which owner should receive the handoff?"));
  assert.ok(blocked.events.some((event) => event.type === "run.resumed" && event.payload.answer === "Assign it to the production lead."));
  assert.ok(blocked.events.some((event) => event.type === "task.blocked" && event.payload.reason === "Waiting for the approved owner list"));

  const unblocked = store.unblockTask(task.id, blocked.version, "The approved owner list is now attached.");
  assert.equal(unblocked.status, "ready");
  assert.equal(unblocked.recoveryNote, "The approved owner list is now attached.");
  assert.ok(unblocked.events.some((event) => event.type === "task.unblocked" && event.payload.resolution === "The approved owner list is now attached."));

  const second = store.beginRun(task.id, unblocked.version);
  store.markRunRunning(second.run.id, "session-lifecycle");
  const canceled = store.cancelTask(task.id, store.getTask(task.id).version, "The project is no longer needed");
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.activeRunId, null);
  assert.equal(canceled.runs.at(-1).status, "canceled");
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
