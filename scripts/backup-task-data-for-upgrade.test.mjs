import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TaskStore } from "../lib/task/store.ts";

const projectRoot = process.cwd();
const script = join(projectRoot, "scripts", "backup-task-data-for-upgrade.mjs");

test("Task data backup requires explicit stopped-service confirmation", () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--confirm-stopped/);
});

test("Task data backup preserves v1 and proves a v3 migration on a separate copy", async (t) => {
  const runtimeRoot = resolve(".runtime", "tests");
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, "task-upgrade-backup-"));
  const projectDirectory = join(root, "project");
  const sourceDatabase = join(root, "task-data", "pi-task.sqlite");
  const backupRoot = join(root, "backups");
  const resultFile = join(root, "result", "backup.json");
  await mkdir(projectDirectory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new TaskStore(sourceDatabase);
  const project = store.createProject({ name: "Upgrade backup fixture", rootPath: projectDirectory });
  const task = store.createTask({
    projectId: project.id,
    title: "Preserve fictional Task data",
    goal: "Keep rows unchanged through a copied migration",
    acceptanceCriteria: "The v1 backup and v3 migrated copy each retain one Task",
    expectedOutput: "backup.json",
    status: "ready",
  });
  store.close();

  const legacy = new DatabaseSync(sourceDatabase);
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

  const run = spawnSync(process.execPath, [
    script,
    "--confirm-stopped",
    sourceDatabase,
    backupRoot,
    resultFile,
  ], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /一致性备份并通过副本迁移验证/);

  const result = JSON.parse(await readFile(resultFile, "utf8"));
  assert.equal(result.status, "backed_up_and_verified");
  assert.equal(result.originalSchemaVersion, 1);
  assert.equal(result.migratedSchemaVersion, 3);
  assert.equal(result.countsBefore.tasks, 1);
  assert.deepEqual(result.countsAfter, result.countsBefore);
  assert.equal(result.backupSha256.length, 64);

  const source = new DatabaseSync(sourceDatabase, { readOnly: true });
  assert.equal(source.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(source.prepare("SELECT title FROM tasks WHERE id = ?").get(task.id).title, task.title);
  source.close();

  const preserved = new DatabaseSync(result.backupDatabase, { readOnly: true });
  assert.equal(preserved.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(preserved.prepare("SELECT COUNT(*) AS value FROM tasks").get().value, 1);
  preserved.close();

  const migrated = new DatabaseSync(result.migrationDatabase, { readOnly: true });
  assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 3);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS value FROM tasks").get().value, 1);
  assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_framing_operations'").get());
  migrated.close();
});
