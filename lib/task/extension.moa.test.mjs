import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTaskExtension } = await jiti.import("./extension.ts");
const { getTaskStore } = await jiti.import("./store.ts");

async function fixture(t) {
  const runtimeRoot = resolve(".runtime", "tests");
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, "pi-task-extension-moa-"));
  const projectRoot = join(root, "fictional-project");
  await mkdir(projectRoot, { recursive: true });
  const previousDataDirectory = process.env.PI_TASK_DATA_DIR;
  process.env.PI_TASK_DATA_DIR = join(root, "task-data");
  const store = getTaskStore();
  const project = store.createProject({ name: "MoA extension fixture", rootPath: projectRoot });
  const task = store.createTask({
    projectId: project.id,
    title: "Compare fictional evidence",
    goal: "Obtain independent read-only findings",
    acceptanceCriteria: "The parent records and synthesizes two delegated findings",
    expectedOutput: "handoff.md",
    status: "ready",
  });
  const started = store.beginRun(task.id, task.version);
  store.markRunRunning(started.run.id, "session-extension-moa");
  t.after(async () => {
    store.close();
    if (previousDataDirectory === undefined) delete process.env.PI_TASK_DATA_DIR;
    else process.env.PI_TASK_DATA_DIR = previousDataDirectory;
    await rm(root, { recursive: true, force: true });
  });
  return { root, projectRoot, store, task, started };
}

function captureExtension(extension) {
  const tools = new Map();
  const events = new Map();
  extension.factory({
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { events.set(name, handler); },
  });
  return { tools, events };
}

test("task extension confirms, records, and returns subordinate readonly agents", async (t) => {
  const f = await fixture(t);
  const binding = { taskId: f.task.id, runId: f.started.run.id, capability: f.started.capability };
  const runnerCalls = [];
  const runner = async (options) => {
    runnerCalls.push(options);
    const results = options.requests.map((request, index) => ({
      id: request.id,
      profile: request.profile,
      status: index === 0 ? "succeeded" : "failed",
      output: index === 0 ? "Verified fictional evidence" : "",
      error: index === 0 ? null : "Fictional critic failed",
      usage: { input: 10 + index, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 + index, cost: 0.01 },
      model: "faux/analyst",
      stopReason: index === 0 ? "stop" : "error",
    }));
    results.forEach((result, index) => options.onResult?.(result, index + 1, results.length));
    return results;
  };
  const disabled = captureExtension(createTaskExtension(binding, {
    runReadonlyDelegations: runner,
    enableReadonlyDelegation: false,
  }));
  assert.equal(disabled.tools.has("delegate_readonly_agents"), false);

  const { tools } = captureExtension(createTaskExtension(binding, {
    runReadonlyDelegations: runner,
    enableReadonlyDelegation: true,
  }));
  const tool = tools.get("delegate_readonly_agents");
  assert.ok(tool);

  const confirmations = [];
  const updates = [];
  const result = await tool.execute(
    "tool-moa",
    { tasks: [
      { profile: "scout", prompt: "Locate fictional evidence" },
      { profile: "critic", prompt: "Challenge fictional evidence" },
    ] },
    new AbortController().signal,
    (update) => updates.push(update),
    {
      hasUI: true,
      model: { provider: "faux", id: "analyst" },
      thinkingLevel: "low",
      ui: { async confirm(title, message) { confirmations.push({ title, message }); return true; } },
    },
  );

  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].message, /额外模型调用/);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].cwd, f.projectRoot);
  assert.deepEqual(runnerCalls[0].model, { provider: "faux", id: "analyst" });
  assert.equal(updates.length, 3);
  assert.match(result.content[0].text, /1\/2 succeeded/);
  assert.equal(result.usage.cost.total, 0.02);

  const detail = f.store.getTaskDetail(f.task.id);
  assert.equal(detail.status, "in_progress");
  assert.equal(detail.runs[0].status, "running");
  assert.deepEqual(detail.delegations.map((delegation) => delegation.status), ["succeeded", "failed"]);
  assert.equal(detail.reviews.length, 0);
  assert.ok(detail.events.some((event) => event.type === "delegation.started"));

  const declined = await tool.execute(
    "tool-moa-declined",
    { tasks: [
      { profile: "scout", prompt: "A second scout" },
      { profile: "analyst", prompt: "A second analyst" },
    ] },
    new AbortController().signal,
    undefined,
    {
      hasUI: true,
      model: { provider: "faux", id: "analyst" },
      thinkingLevel: "off",
      ui: { async confirm() { return false; } },
    },
  );
  assert.match(declined.content[0].text, /declined/);
  assert.equal(f.store.getTaskDetail(f.task.id).delegations.length, 2);
});
