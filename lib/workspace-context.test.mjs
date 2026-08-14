import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { listWorkspaceRuleSources } = await jiti.import("./workspace-context.ts");

test("workspace context exposes loaded rule paths and scopes without file contents", async (t) => {
  const runtimeRoot = resolve(".runtime", "tests");
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, "workspace-context-"));
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  const cwd = join(workspace, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const personal = join(agentDir, "AGENTS.md");
  const parent = join(workspace, "AGENTS.md");
  const current = join(cwd, "AGENTS.md");
  await writeFile(personal, "PRIVATE PERSONAL FIXTURE");
  await writeFile(parent, "PRIVATE PARENT FIXTURE");
  await writeFile(current, "PRIVATE CURRENT FIXTURE");

  const sources = listWorkspaceRuleSources(cwd, agentDir);
  assert.deepEqual(sources.find((source) => source.path === personal), { path: personal, scope: "personal" });
  assert.deepEqual(sources.find((source) => source.path === parent), { path: parent, scope: "parent" });
  assert.deepEqual(sources.find((source) => source.path === current), { path: current, scope: "current" });
  assert.equal(JSON.stringify(sources).includes("PRIVATE"), false);
});
