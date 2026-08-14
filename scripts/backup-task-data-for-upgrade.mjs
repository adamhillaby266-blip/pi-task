import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { TaskStore } from "../lib/task/store.ts";

const [confirmation, sourceValue, backupRootValue, resultValue] = process.argv.slice(2);
if (confirmation !== "--confirm-stopped" || !sourceValue || !backupRootValue || !resultValue) {
  console.error("Usage: backup-task-data-for-upgrade.mjs --confirm-stopped <source-db> <backup-root> <result-json>");
  process.exit(1);
}

const sourceDatabase = resolve(sourceValue);
const backupRoot = resolve(backupRootValue);
const resultFile = resolve(resultValue);
const TABLES = ["projects", "tasks", "runs", "artifacts", "reviews", "events"];

function schemaVersion(database) {
  return Number(database.prepare("PRAGMA user_version").get().user_version ?? 0);
}

function tableExists(database, table) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function rowCounts(database) {
  return Object.fromEntries(TABLES.map((table) => [
    table,
    tableExists(database, table)
      ? Number(database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get().value ?? 0)
      : 0,
  ]));
}

function integrity(database) {
  const rows = database.prepare("PRAGMA integrity_check").all();
  return rows.map((row) => String(row.integrity_check ?? "")).filter(Boolean);
}

function hashFile(path) {
  return readFile(path).then((content) => createHash("sha256").update(content).digest("hex"));
}

async function writeResult(value) {
  await mkdir(dirname(resultFile), { recursive: true, mode: 0o700 });
  await writeFile(resultFile, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

let sourceStat;
try {
  sourceStat = await stat(sourceDatabase);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  await writeResult({
    status: "source_absent",
    sourceDatabase,
    backupDirectory: null,
    backupDatabase: null,
    originalSchemaVersion: 0,
    migratedSchemaVersion: 3,
    countsBefore: Object.fromEntries(TABLES.map((table) => [table, 0])),
    countsAfter: Object.fromEntries(TABLES.map((table) => [table, 0])),
  });
  console.log("Pi Task 数据库尚不存在；首次启动将创建 schema v3。");
  process.exit(0);
}
if (!sourceStat.isFile()) throw new Error(`Task database is not a regular file: ${sourceDatabase}`);

await mkdir(backupRoot, { recursive: true, mode: 0o700 });
await chmod(backupRoot, 0o700);
const backupDirectory = await mkdtemp(join(backupRoot, "upgrade-"));
await chmod(backupDirectory, 0o700);
const backupDatabase = join(backupDirectory, "pi-task.sqlite");
const migrationDirectory = join(backupDirectory, "migration-check");
const migrationDatabase = join(migrationDirectory, "pi-task.sqlite");

const source = new DatabaseSync(sourceDatabase, { readOnly: true });
let pages;
try {
  const sourceIntegrity = integrity(source);
  if (sourceIntegrity.length !== 1 || sourceIntegrity[0] !== "ok") {
    throw new Error(`Source Task database failed integrity_check: ${sourceIntegrity.join(", ")}`);
  }
  pages = await backup(source, backupDatabase);
} finally {
  source.close();
}
await chmod(backupDatabase, 0o600);

const preserved = new DatabaseSync(backupDatabase, { readOnly: true });
let originalSchemaVersion;
let countsBefore;
try {
  originalSchemaVersion = schemaVersion(preserved);
  countsBefore = rowCounts(preserved);
  const backupIntegrity = integrity(preserved);
  if (backupIntegrity.length !== 1 || backupIntegrity[0] !== "ok") {
    throw new Error(`Backup Task database failed integrity_check: ${backupIntegrity.join(", ")}`);
  }
} finally {
  preserved.close();
}

await mkdir(migrationDirectory, { recursive: false, mode: 0o700 });
await copyFile(backupDatabase, migrationDatabase);
await chmod(migrationDatabase, 0o600);
const migratedStore = new TaskStore(migrationDatabase);
migratedStore.close();

const migrated = new DatabaseSync(migrationDatabase, { readOnly: true });
let migratedSchemaVersion;
let countsAfter;
try {
  migratedSchemaVersion = schemaVersion(migrated);
  countsAfter = rowCounts(migrated);
  const migratedIntegrity = integrity(migrated);
  if (migratedIntegrity.length !== 1 || migratedIntegrity[0] !== "ok") {
    throw new Error(`Migrated Task database failed integrity_check: ${migratedIntegrity.join(", ")}`);
  }
} finally {
  migrated.close();
}

if (migratedSchemaVersion !== 3) {
  throw new Error(`Task database migration ended at schema ${migratedSchemaVersion}, expected 3`);
}
if (JSON.stringify(countsBefore) !== JSON.stringify(countsAfter)) {
  throw new Error("Task database migration changed authoritative row counts");
}

const backupSha256 = await hashFile(backupDatabase);
await writeResult({
  status: "backed_up_and_verified",
  sourceDatabase,
  backupDirectory,
  backupDatabase,
  migrationDatabase,
  backupSha256,
  pages,
  originalSchemaVersion,
  migratedSchemaVersion,
  countsBefore,
  countsAfter,
});
console.log(`Task 数据已一致性备份并通过副本迁移验证：${backupDirectory}`);
