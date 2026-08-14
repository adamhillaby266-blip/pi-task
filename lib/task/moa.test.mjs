import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { runReadonlyDelegations } from "./moa.ts";
import { validateReadonlyToolPath } from "../../bin/moa-readonly-guard.mjs";

async function fixture(t) {
  const runtimeRoot = resolve(".runtime", "tests");
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, "pi-task-moa-"));
  const projectRoot = join(root, "fictional-project");
  const dataDirectory = join(root, "task-data");
  const captures = join(root, "captures");
  await Promise.all([projectRoot, dataDirectory, captures].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(projectRoot, "evidence.md"), "# Fictional evidence\n", "utf8");
  const fakeCli = join(root, "fake-pi.mjs");
  await writeFile(fakeCli, `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const taskArg = process.argv.find((value) => value.startsWith("@"));
const task = taskArg ? await readFile(taskArg.slice(1), "utf8") : "";
const captureDir = process.env.PI_TASK_MOA_CAPTURE_DIR;
if (captureDir) {
  await mkdir(captureDir, { recursive: true });
  await writeFile(join(captureDir, process.env.PI_TASK_MOA_DELEGATION_ID + ".json"), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), root: process.env.PI_TASK_MOA_ROOT, task }));
}
if (task.includes("WAIT_FOR_ABORT")) {
  setTimeout(() => {}, 30_000);
} else {
  console.log(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Verified delegated output: " + task.split("Delegated focus:").at(-1).trim() }],
      provider: "faux",
      model: "analyst",
      stopReason: "stop",
      usage: { input: 12, output: 8, cacheRead: 2, cacheWrite: 0, totalTokens: 22, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } }
    }
  }));
}
`, { encoding: "utf8", mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, projectRoot, dataDirectory, captures, fakeCli };
}

function options(fixture, requests, signal) {
  return {
    cwd: fixture.projectRoot,
    dataDirectory: fixture.dataDirectory,
    cliPath: fixture.fakeCli,
    guardExtensionPath: resolve("bin/moa-readonly-guard.mjs"),
    model: { provider: "faux", id: "analyst" },
    thinkingLevel: "low",
    requests,
    signal,
  };
}

test("readonly MoA launches isolated ephemeral children with fixed safety flags", async (t) => {
  const f = await fixture(t);
  const previousCapture = process.env.PI_TASK_MOA_CAPTURE_DIR;
  process.env.PI_TASK_MOA_CAPTURE_DIR = f.captures;
  t.after(() => {
    if (previousCapture === undefined) delete process.env.PI_TASK_MOA_CAPTURE_DIR;
    else process.env.PI_TASK_MOA_CAPTURE_DIR = previousCapture;
  });

  const updates = [];
  const requests = [
    { id: "dlg_scout", profile: "scout", prompt: "Task contract\n\nDelegated focus:\nLocate the fictional heading" },
    { id: "dlg_critic", profile: "critic", prompt: "Task contract\n\nDelegated focus:\nChallenge the fictional evidence" },
  ];
  const results = await runReadonlyDelegations({
    ...options(f, requests),
    onResult: (result, completed, total) => updates.push({ id: result.id, completed, total }),
  });

  assert.deepEqual(results.map((result) => result.status), ["succeeded", "succeeded"]);
  assert.match(results[0].output, /Locate the fictional heading/);
  assert.equal(results[0].usage.totalTokens, 22);
  assert.equal(results[0].usage.cost, 0.03);
  assert.deepEqual(updates.map((update) => update.completed).sort(), [1, 2]);

  const canonicalProjectRoot = await realpath(f.projectRoot);
  for (const request of requests) {
    const capture = JSON.parse(await readFile(join(f.captures, `${request.id}.json`), "utf8"));
    assert.equal(capture.cwd, canonicalProjectRoot);
    assert.equal(capture.root, canonicalProjectRoot);
    assert.ok(capture.argv.includes("--no-session"));
    assert.ok(capture.argv.includes("--no-extensions"));
    assert.ok(capture.argv.includes("--no-skills"));
    assert.ok(capture.argv.includes("--no-context-files"));
    assert.ok(capture.argv.includes("--no-approve"));
    assert.equal(capture.argv[capture.argv.indexOf("--tools") + 1], "read,grep,find,ls");
    assert.equal(capture.argv[capture.argv.indexOf("--model") + 1], "faux/analyst");
    assert.ok(!capture.argv.some((value) => value.includes("Locate the fictional heading") || value.includes("Challenge the fictional evidence")));
  }
  assert.deepEqual(await readdir(join(f.dataDirectory, "moa-tmp")), []);
});

test("parent abort cancels every delegated Pi process", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const run = runReadonlyDelegations(options(f, [
    { id: "dlg_wait_1", profile: "scout", prompt: "WAIT_FOR_ABORT" },
    { id: "dlg_wait_2", profile: "analyst", prompt: "WAIT_FOR_ABORT" },
  ], controller.signal));
  setTimeout(() => controller.abort(), 100);
  const results = await run;
  assert.deepEqual(results.map((result) => result.status), ["canceled", "canceled"]);
  assert.ok(results.every((result) => /canceled/.test(result.error)));
  assert.deepEqual(await readdir(join(f.dataDirectory, "moa-tmp")), []);
});

test("readonly child guard blocks unexpected tools and paths outside the project", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside.txt");
  const inside = join(f.projectRoot, "evidence.md");
  const escape = join(f.projectRoot, "escape.txt");
  await writeFile(outside, "outside", "utf8");
  await symlink(outside, escape);

  assert.equal(validateReadonlyToolPath(f.projectRoot, f.projectRoot, { toolName: "read", input: { path: inside } }), null);
  assert.match(validateReadonlyToolPath(f.projectRoot, f.projectRoot, { toolName: "read", input: { path: outside } }), /outside/);
  assert.match(validateReadonlyToolPath(f.projectRoot, f.projectRoot, { toolName: "read", input: { path: escape } }), /outside/);
  assert.match(validateReadonlyToolPath(f.projectRoot, f.projectRoot, { toolName: "bash", input: { command: "pwd" } }), /only use/);
});
