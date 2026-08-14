import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isPathWithinRoots } from "../path-security.ts";
import {
  checkTaskContractReadiness,
  parseTaskContract,
  projectTaskContractToLegacyFields,
  type TaskContractV1,
} from "./contract.ts";
import {
  invalidInput,
  invalidTransition,
  notFound,
  TaskDomainError,
  versionConflict,
} from "./errors.ts";
import {
  DELEGATION_PROFILES,
  type ArtifactRecord,
  type CreateProjectInput,
  type CreateTaskInput,
  type DelegationProfile,
  type DelegationRecord,
  type DelegationStatus,
  type DelegationUsage,
  type EventActor,
  type EventRecord,
  type ProjectRecord,
  type ReviewRecord,
  type ReviewSubmission,
  type RunRecord,
  type TaskDetail,
  type TaskFramingCommitInput,
  type TaskFramingOperationRecord,
  type TaskRecord,
  type TaskStatus,
  type UpdateTaskContractInput,
} from "./types.ts";

type Row = Record<string, unknown>;
type QueueStatus = "backlog" | "ready";
type ActiveRunStatus = "starting" | "running" | "waiting_user";

const ACTIVE_RUN_STATUSES = new Set<ActiveRunStatus>(["starting", "running", "waiting_user"]);
const DELEGATION_PROFILE_SET = new Set<DelegationProfile>(DELEGATION_PROFILES);
const DEFAULT_SORT_GAP = 1024;
const TASK_DATABASE_SCHEMA_VERSION = 3;

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function newCapability(): string {
  return `cap_${randomBytes(32).toString("base64url")}`;
}

function capabilityHash(capability: string): Buffer {
  return createHash("sha256").update(capability, "utf8").digest();
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") invalidInput(`${field} must be a string`);
  const text = value.trim();
  if (!text) invalidInput(`${field} is required`);
  if (text.length > maxLength) invalidInput(`${field} is too long`);
  return text;
}

function optionalText(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") invalidInput(`${field} must be a string`);
  const text = value.trim();
  if (text.length > maxLength) invalidInput(`${field} is too long`);
  return text;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function mapProject(row: Row): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    rootPath: String(row.root_path),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseStoredContract(value: unknown): TaskContractV1 | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Stored Task contract must be JSON text");
  return parseTaskContract(JSON.parse(value) as unknown);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapTask(row: Row): TaskRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    goal: String(row.goal),
    acceptanceCriteria: String(row.acceptance_criteria),
    expectedOutput: String(row.expected_output),
    status: String(row.status) as TaskStatus,
    sortOrder: Number(row.sort_order),
    version: Number(row.version),
    primarySessionId: nullableText(row.primary_session_id),
    activeRunId: nullableText(row.active_run_id),
    recoveryNote: nullableText(row.recovery_note),
    contractSchema: nullableNumber(row.contract_schema),
    contract: parseStoredContract(row.contract_json),
    contractRevision: Number(row.contract_revision ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRun(row: Row): RunRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    sessionId: nullableText(row.session_id),
    status: String(row.status) as RunRecord["status"],
    cwd: String(row.cwd),
    model: nullableText(row.model),
    error: nullableText(row.error),
    stopReason: nullableText(row.stop_reason),
    taskVersionAtStart: nullableNumber(row.task_version_at_start),
    contractRevision: nullableNumber(row.contract_revision),
    contractSnapshot: parseStoredContract(row.contract_snapshot_json),
    createdAt: String(row.created_at),
    startedAt: nullableText(row.started_at),
    endedAt: nullableText(row.ended_at),
    updatedAt: String(row.updated_at),
  };
}

function nonNegativeFinite(value: unknown): number {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
}

function parseDelegationUsage(value: unknown): DelegationUsage {
  const parsed = parsePayload(value);
  const count = (key: keyof DelegationUsage): number => nonNegativeFinite(parsed[key]);
  return {
    input: count("input"),
    output: count("output"),
    cacheRead: count("cacheRead"),
    cacheWrite: count("cacheWrite"),
    totalTokens: count("totalTokens"),
    cost: count("cost"),
  };
}

function mapDelegation(row: Row): DelegationRecord {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    profile: String(row.profile) as DelegationProfile,
    prompt: String(row.prompt),
    status: String(row.status) as DelegationStatus,
    model: String(row.model),
    output: String(row.output),
    error: nullableText(row.error),
    usage: parseDelegationUsage(row.usage),
    createdAt: String(row.created_at),
    startedAt: String(row.started_at),
    endedAt: nullableText(row.ended_at),
    updatedAt: String(row.updated_at),
  };
}

function mapArtifact(row: Row): ArtifactRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    path: String(row.path),
    kind: String(row.kind),
    verification: String(row.verification),
    createdAt: String(row.created_at),
  };
}

function mapReview(row: Row): ReviewRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    status: String(row.status) as ReviewRecord["status"],
    summary: String(row.summary),
    changes: String(row.changes),
    verification: String(row.verification),
    unverified: String(row.unverified),
    risks: String(row.risks),
    rejectionReason: nullableText(row.rejection_reason),
    submittedAt: String(row.submitted_at),
    decidedAt: nullableText(row.decided_at),
  };
}

function mapTaskFramingOperation(row: Row): TaskFramingOperationRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    sourceEntryId: String(row.source_entry_id),
    action: String(row.action) as TaskFramingOperationRecord["action"],
    taskId: nullableText(row.task_id),
    runId: nullableText(row.run_id),
    status: String(row.status) as TaskFramingOperationRecord["status"],
    error: nullableText(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEvent(row: Row): EventRecord {
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    runId: nullableText(row.run_id),
    actor: String(row.actor) as EventRecord["actor"],
    type: String(row.type),
    payload: parsePayload(row.payload),
    taskVersion: Number(row.task_version),
    createdAt: String(row.created_at),
  };
}

export class TaskStore {
  public readonly filename: string;
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.filename = filename;
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(filename);
    try {
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA busy_timeout = 5000");
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private ensureColumn(table: "tasks" | "runs", name: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (columns.some((column) => String(column.name) === name)) return;
    this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }

  private migrate(): void {
    const versionRow = this.database.prepare("PRAGMA user_version").get() as Row;
    const currentVersion = Number(versionRow.user_version ?? 0);
    if (currentVersion > TASK_DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `Task database schema ${currentVersion} is newer than supported schema ${TASK_DATABASE_SCHEMA_VERSION}`,
      );
    }

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT NOT NULL DEFAULT '',
        expected_output TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('backlog','ready','in_progress','in_review','blocked','done','canceled')),
        sort_order REAL NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        primary_session_id TEXT,
        active_run_id TEXT,
        recovery_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('starting','running','waiting_user','succeeded','failed','interrupted','canceled')),
        cwd TEXT NOT NULL,
        model TEXT,
        capability_hash TEXT NOT NULL,
        error TEXT,
        stop_reason TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_task
        ON runs(task_id)
        WHERE status IN ('starting','running','waiting_user');

      CREATE TABLE IF NOT EXISTS delegations (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        profile TEXT NOT NULL CHECK (profile IN ('scout','analyst','critic')),
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','interrupted','canceled')),
        model TEXT NOT NULL,
        output TEXT NOT NULL DEFAULT '',
        error TEXT,
        usage TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        verification TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('submitted','accepted','rejected')),
        summary TEXT NOT NULL,
        changes TEXT NOT NULL,
        verification TEXT NOT NULL,
        unverified TEXT NOT NULL DEFAULT '',
        risks TEXT NOT NULL DEFAULT '',
        rejection_reason TEXT,
        submitted_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        actor TEXT NOT NULL CHECK (actor IN ('user','agent','system')),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        task_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_by_project_status_order
        ON tasks(project_id, status, sort_order, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS one_task_per_primary_session
        ON tasks(primary_session_id)
        WHERE primary_session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS runs_by_task_created
        ON runs(task_id, created_at);
      CREATE INDEX IF NOT EXISTS delegations_by_task_created
        ON delegations(task_id, created_at);
      CREATE INDEX IF NOT EXISTS delegations_by_run_status
        ON delegations(run_id, status);
      CREATE INDEX IF NOT EXISTS events_by_task_id
        ON events(task_id, id);
    `);

    this.ensureColumn("tasks", "contract_schema", "INTEGER");
    this.ensureColumn("tasks", "contract_json", "TEXT");
    this.ensureColumn("tasks", "contract_revision", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "task_version_at_start", "INTEGER");
    this.ensureColumn("runs", "contract_revision", "INTEGER");
    this.ensureColumn("runs", "contract_snapshot_json", "TEXT");

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_framing_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source_entry_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('save_draft','confirm','confirm_and_start')),
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN (
          'applying','saved','confirmed','awaiting_start','started','start_failed'
        )),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS framing_operations_by_session_updated
        ON task_framing_operations(session_id, updated_at);
      CREATE INDEX IF NOT EXISTS framing_operations_by_source
        ON task_framing_operations(session_id, source_entry_id, action);
      PRAGMA user_version = ${TASK_DATABASE_SCHEMA_VERSION};
    `);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private event(
    taskId: string,
    runId: string | null,
    actor: EventActor,
    type: string,
    payload: Record<string, unknown>,
    taskVersion: number,
    timestamp: string,
  ): void {
    this.database.prepare(`
      INSERT INTO events (task_id, run_id, actor, type, payload, task_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, runId, actor, type, JSON.stringify(payload), taskVersion, timestamp);
  }

  createProject(input: CreateProjectInput): ProjectRecord {
    const name = requiredText(input.name, "name", 120);
    const candidate = requiredText(input.rootPath, "rootPath", 2048);
    const rootPath = realpathSync(resolve(candidate));
    if (!statSync(rootPath).isDirectory()) invalidInput("rootPath must be a directory");
    const timestamp = now();
    const projectId = id("prj");
    try {
      this.database.prepare(`
        INSERT INTO projects (id, name, root_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(projectId, name, rootPath, timestamp, timestamp);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new TaskDomainError("INVALID_INPUT", "A project already uses this rootPath", 409);
      }
      throw error;
    }
    return this.getProject(projectId);
  }

  getProject(projectId: string): ProjectRecord {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Row | undefined;
    if (!row) notFound(`Project '${projectId}' does not exist`);
    return mapProject(row);
  }

  listProjects(): ProjectRecord[] {
    return (this.database.prepare("SELECT * FROM projects ORDER BY created_at").all() as Row[]).map(mapProject);
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const project = this.getProject(input.projectId);
    const title = requiredText(input.title, "title", 240);
    const status: QueueStatus = input.status ?? "backlog";
    if (status !== "backlog" && status !== "ready") invalidInput("New tasks must start in backlog or ready");
    const goal = optionalText(input.goal, "goal", 100_000);
    const acceptanceCriteria = optionalText(input.acceptanceCriteria, "acceptanceCriteria", 100_000);
    const expectedOutput = optionalText(input.expectedOutput, "expectedOutput", 4096);
    const primarySessionId = optionalText(input.primarySessionId, "primarySessionId", 256) || null;
    if (status === "ready") this.assertReadyContract(goal, acceptanceCriteria, expectedOutput);
    if (primarySessionId) {
      const claimed = this.database.prepare("SELECT id FROM tasks WHERE primary_session_id = ?").get(primarySessionId) as Row | undefined;
      if (claimed) invalidTransition("This Pi Session is already bound to another task");
    }

    const max = this.database.prepare(
      "SELECT MAX(sort_order) AS value FROM tasks WHERE project_id = ? AND status = ?",
    ).get(project.id, status) as Row;
    const sortOrder = Number.isFinite(Number(max.value)) ? Number(max.value) + DEFAULT_SORT_GAP : DEFAULT_SORT_GAP;
    const timestamp = now();
    const taskId = id("tsk");
    try {
      this.transaction(() => {
        this.database.prepare(`
          INSERT INTO tasks (
            id, project_id, title, goal, acceptance_criteria, expected_output,
            status, sort_order, version, primary_session_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `).run(
          taskId,
          project.id,
          title,
          goal,
          acceptanceCriteria,
          expectedOutput,
          status,
          sortOrder,
          primarySessionId,
          timestamp,
          timestamp,
        );
        this.event(
          taskId,
          null,
          "user",
          "task.created",
          primarySessionId ? { status, source: "conversation", sessionId: primarySessionId } : { status },
          1,
          timestamp,
        );
      });
    } catch (error) {
      if (primarySessionId && error instanceof Error && error.message.includes("tasks.primary_session_id")) {
        invalidTransition("This Pi Session is already bound to another task");
      }
      throw error;
    }
    return this.getTask(taskId);
  }

  private assertReadyContract(goal: string, acceptanceCriteria: string, expectedOutput: string): void {
    if (!goal) invalidInput("goal is required before a task becomes ready");
    if (!acceptanceCriteria) invalidInput("acceptanceCriteria is required before a task becomes ready");
    if (!expectedOutput) invalidInput("expectedOutput is required before a task becomes ready");
  }

  getTask(taskId: string): TaskRecord {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Row | undefined;
    if (!row) notFound(`Task '${taskId}' does not exist`);
    return mapTask(row);
  }

  listTasks(projectId?: string): TaskRecord[] {
    const rows = projectId
      ? this.database.prepare(`
          SELECT * FROM tasks WHERE project_id = ?
          ORDER BY CASE status
            WHEN 'backlog' THEN 0 WHEN 'ready' THEN 1 WHEN 'in_progress' THEN 2
            WHEN 'in_review' THEN 3 WHEN 'blocked' THEN 4 WHEN 'done' THEN 5 ELSE 6 END,
            sort_order, created_at
        `).all(projectId) as Row[]
      : this.database.prepare(`
          SELECT * FROM tasks
          ORDER BY project_id, CASE status
            WHEN 'backlog' THEN 0 WHEN 'ready' THEN 1 WHEN 'in_progress' THEN 2
            WHEN 'in_review' THEN 3 WHEN 'blocked' THEN 4 WHEN 'done' THEN 5 ELSE 6 END,
            sort_order, created_at
        `).all() as Row[];
    return rows.map(mapTask);
  }

  getTaskDetail(taskId: string): TaskDetail {
    const task = this.getTask(taskId);
    return {
      ...task,
      project: this.getProject(task.projectId),
      runs: (this.database.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY created_at").all(taskId) as Row[]).map(mapRun),
      delegations: (this.database.prepare("SELECT * FROM delegations WHERE task_id = ? ORDER BY created_at").all(taskId) as Row[]).map(mapDelegation),
      artifacts: (this.database.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at").all(taskId) as Row[]).map(mapArtifact),
      reviews: (this.database.prepare("SELECT * FROM reviews WHERE task_id = ? ORDER BY submitted_at").all(taskId) as Row[]).map(mapReview),
      events: (this.database.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id").all(taskId) as Row[]).map(mapEvent),
    };
  }

  updateTaskContract(taskId: string, version: number, input: UpdateTaskContractInput): TaskDetail {
    if (!Number.isInteger(version) || version < 1) invalidInput("version must be a positive integer");
    const current = this.getTask(taskId);
    if (current.version !== version) versionConflict();
    if (current.status !== "backlog" && current.status !== "ready") {
      invalidTransition("Only backlog and ready tasks can edit their contract");
    }
    if (current.contract) {
      invalidTransition("Rich Task contracts must be revised from their Task Framing Session");
    }

    const title = requiredText(input.title, "title", 240);
    const goal = optionalText(input.goal, "goal", 100_000);
    const acceptanceCriteria = optionalText(input.acceptanceCriteria, "acceptanceCriteria", 100_000);
    const expectedOutput = optionalText(input.expectedOutput, "expectedOutput", 4096);
    if (current.status === "ready") this.assertReadyContract(goal, acceptanceCriteria, expectedOutput);

    const fields = [
      ...(title !== current.title ? ["title"] : []),
      ...(goal !== current.goal ? ["goal"] : []),
      ...(acceptanceCriteria !== current.acceptanceCriteria ? ["acceptanceCriteria"] : []),
      ...(expectedOutput !== current.expectedOutput ? ["expectedOutput"] : []),
    ];
    if (fields.length === 0) return this.getTaskDetail(taskId);

    const timestamp = now();
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE tasks SET title = ?, goal = ?, acceptance_criteria = ?, expected_output = ?,
          version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status IN ('backlog','ready')
      `).run(title, goal, acceptanceCriteria, expectedOutput, timestamp, taskId, version);
      if (Number(result.changes) !== 1) versionConflict();
      const next = this.getTask(taskId);
      this.event(taskId, null, "user", "task.contract_updated", { fields, status: next.status }, next.version, timestamp);
      return this.getTaskDetail(taskId);
    });
  }

  findTaskByPrimarySessionId(sessionId: string): TaskDetail | null {
    const cleanSessionId = requiredText(sessionId, "sessionId", 256);
    const row = this.database.prepare("SELECT id FROM tasks WHERE primary_session_id = ?").get(cleanSessionId) as Row | undefined;
    return row ? this.getTaskDetail(String(row.id)) : null;
  }

  getTaskFramingOperation(operationId: string): TaskFramingOperationRecord {
    const cleanOperationId = requiredText(operationId, "operationId", 256);
    const row = this.database.prepare("SELECT * FROM task_framing_operations WHERE id = ?").get(cleanOperationId) as Row | undefined;
    if (!row) notFound(`Task Framing operation '${cleanOperationId}' does not exist`);
    return mapTaskFramingOperation(row);
  }

  listTaskFramingOperations(sessionId: string, sourceEntryId?: string): TaskFramingOperationRecord[] {
    const cleanSessionId = requiredText(sessionId, "sessionId", 256);
    const cleanSourceEntryId = sourceEntryId === undefined
      ? undefined
      : requiredText(sourceEntryId, "sourceEntryId", 128);
    const rows = cleanSourceEntryId
      ? this.database.prepare(`
          SELECT * FROM task_framing_operations
          WHERE session_id = ? AND source_entry_id = ?
          ORDER BY created_at
        `).all(cleanSessionId, cleanSourceEntryId) as Row[]
      : this.database.prepare(`
          SELECT * FROM task_framing_operations
          WHERE session_id = ?
          ORDER BY created_at
        `).all(cleanSessionId) as Row[];
    return rows.map(mapTaskFramingOperation);
  }

  prepareTaskFramingStart(operationId: string, taskId: string, sessionId?: string): TaskFramingOperationRecord {
    const operation = this.getTaskFramingOperation(operationId);
    if (operation.taskId !== taskId || operation.action !== "confirm_and_start") {
      throw new TaskDomainError("START_INTENT_EXPIRED", "The start intent does not belong to this Task", 409);
    }
    if (sessionId && operation.sessionId !== sessionId) {
      throw new TaskDomainError("START_INTENT_EXPIRED", "The start intent does not belong to this Task", 409);
    }
    if (operation.status !== "awaiting_start" && operation.status !== "started") {
      throw new TaskDomainError("START_INTENT_EXPIRED", "The start intent is no longer active", 409);
    }
    return operation;
  }

  markTaskFramingOperationStarted(operationId: string, taskId: string, runId: string): TaskFramingOperationRecord {
    const operation = this.prepareTaskFramingStart(operationId, taskId);
    if (operation.status === "started") {
      if (operation.runId !== runId) {
        throw new TaskDomainError("START_INTENT_EXPIRED", "The start intent already created a different Run", 409);
      }
      return operation;
    }
    const run = this.getRun(runId);
    if (run.taskId !== taskId || run.status !== "running") {
      throw new TaskDomainError("RUN_NOT_ACTIVE", "The Run is not active for this start intent", 409);
    }
    const timestamp = now();
    const update = this.database.prepare(`
      UPDATE task_framing_operations
      SET run_id = ?, status = 'started', error = NULL, updated_at = ?
      WHERE id = ? AND task_id = ? AND action = 'confirm_and_start' AND status = 'awaiting_start'
    `).run(runId, timestamp, operationId, taskId);
    if (Number(update.changes) !== 1) {
      throw new TaskDomainError("START_INTENT_EXPIRED", "The start intent changed before the Run was linked", 409);
    }
    return this.getTaskFramingOperation(operationId);
  }

  markTaskFramingOperationStartFailed(operationId: string, reason: string): TaskFramingOperationRecord {
    const operation = this.getTaskFramingOperation(operationId);
    if (operation.action !== "confirm_and_start") {
      throw new TaskDomainError("START_INTENT_EXPIRED", "The operation is not a start intent", 409);
    }
    if (operation.status === "start_failed") return operation;
    if (operation.status !== "awaiting_start" && operation.status !== "started") {
      throw new TaskDomainError("START_INTENT_EXPIRED", "The start intent cannot be failed from its current state", 409);
    }
    const message = requiredText(reason, "reason", 10_000);
    const timestamp = now();
    this.database.prepare(`
      UPDATE task_framing_operations
      SET status = 'start_failed', error = ?, updated_at = ?
      WHERE id = ? AND status IN ('awaiting_start','started')
    `).run(message, timestamp, operationId);
    return this.getTaskFramingOperation(operationId);
  }

  commitTaskFraming(input: TaskFramingCommitInput): { task: TaskDetail; operation: TaskFramingOperationRecord } {
    const operationId = requiredText(input.operationId, "operationId", 256);
    const sessionId = requiredText(input.sessionId, "sessionId", 256);
    const sourceEntryId = requiredText(input.sourceEntryId, "sourceEntryId", 128);
    const projectId = requiredText(input.projectId, "projectId", 256);
    const taskId = input.taskId === null ? null : requiredText(input.taskId, "taskId", 256);
    const expectedTaskVersion = input.expectedTaskVersion;
    if (expectedTaskVersion !== null && (!Number.isInteger(expectedTaskVersion) || expectedTaskVersion < 1)) {
      invalidInput("expectedTaskVersion must be null or a positive integer");
    }
    const action = input.action;
    if (action !== "save_draft" && action !== "confirm" && action !== "confirm_and_start") {
      invalidInput("Unsupported Task Framing action");
    }
    const contract = parseTaskContract(input.contract);
    const readiness = checkTaskContractReadiness(contract);
    if (action !== "save_draft" && !readiness.ready) {
      throw new TaskDomainError("CONTRACT_NOT_READY", "Resolve every blocking Task contract check before confirming", 409);
    }
    const projection = projectTaskContractToLegacyFields(contract);
    const contractJson = JSON.stringify(contract);
    this.getProject(projectId);

    const existingRow = this.database.prepare("SELECT * FROM task_framing_operations WHERE id = ?").get(operationId) as Row | undefined;
    if (existingRow) {
      const existing = mapTaskFramingOperation(existingRow);
      if (
        existing.sessionId !== sessionId
        || existing.sourceEntryId !== sourceEntryId
        || existing.action !== action
        || (taskId !== null && existing.taskId !== taskId)
      ) {
        throw new TaskDomainError("INVALID_INPUT", "operationId was already used for a different Task Framing request", 409);
      }
      if (!existing.taskId) {
        throw new TaskDomainError("INVALID_TRANSITION", "The existing Task Framing operation has no Task result", 409);
      }
      if (action === "confirm_and_start" && existing.status === "start_failed") {
        const timestamp = now();
        this.database.prepare(`
          UPDATE task_framing_operations
          SET status = 'awaiting_start', run_id = NULL, error = NULL, updated_at = ?
          WHERE id = ? AND status = 'start_failed'
        `).run(timestamp, operationId);
        return { task: this.getTaskDetail(existing.taskId), operation: this.getTaskFramingOperation(operationId) };
      }
      return { task: this.getTaskDetail(existing.taskId), operation: existing };
    }

    const bound = this.findTaskByPrimarySessionId(sessionId);
    if (bound && taskId && bound.id !== taskId) {
      throw new TaskDomainError("SESSION_ALREADY_BOUND", `This Session is already bound to Task ${bound.id}`, 409);
    }
    let current = taskId ? this.getTask(taskId) : bound;
    if (current && current.projectId !== projectId) {
      throw new TaskDomainError("INVALID_INPUT", "The selected Task belongs to a different Project", 409);
    }
    if (current && current.primarySessionId && current.primarySessionId !== sessionId) {
      throw new TaskDomainError("SESSION_ALREADY_BOUND", "The selected Task is bound to another Session", 409);
    }
    if (current) {
      if (expectedTaskVersion === null) invalidInput("expectedTaskVersion is required for an existing Task");
      if (current.version !== expectedTaskVersion) versionConflict();
      if (current.status !== "backlog" && current.status !== "ready") {
        invalidTransition("Only backlog and ready Tasks can commit a candidate contract");
      }
      if (current.activeRunId) {
        throw new TaskDomainError("ACTIVE_RUN_EXISTS", "The Task has an active Run and cannot change its contract", 409);
      }
    } else if (expectedTaskVersion !== null) {
      invalidInput("expectedTaskVersion must be null when creating a Task");
    }

    const targetStatus: QueueStatus = action === "save_draft" ? "backlog" : "ready";
    const timestamp = now();
    try {
      const result = this.transaction(() => {
        this.database.prepare(`
          INSERT INTO task_framing_operations (
            id, session_id, source_entry_id, action, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'applying', ?, ?)
        `).run(operationId, sessionId, sourceEntryId, action, timestamp, timestamp);

        let nextTask: TaskRecord;
        if (!current) {
          const nextTaskId = id("tsk");
          const max = this.database.prepare(
            "SELECT MAX(sort_order) AS value FROM tasks WHERE project_id = ? AND status = ?",
          ).get(projectId, targetStatus) as Row;
          const sortOrder = Number.isFinite(Number(max.value)) ? Number(max.value) + DEFAULT_SORT_GAP : DEFAULT_SORT_GAP;
          this.database.prepare(`
            INSERT INTO tasks (
              id, project_id, title, goal, acceptance_criteria, expected_output,
              status, sort_order, version, primary_session_id,
              contract_schema, contract_json, contract_revision,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, 1, ?, ?)
          `).run(
            nextTaskId,
            projectId,
            contract.title,
            projection.goal,
            projection.acceptanceCriteria,
            projection.expectedOutput,
            targetStatus,
            sortOrder,
            sessionId,
            contractJson,
            timestamp,
            timestamp,
          );
          nextTask = this.getTask(nextTaskId);
          this.event(nextTaskId, null, "user", "task.created", {
            status: targetStatus,
            source: "task_framing",
            sessionId,
            operationId,
          }, nextTask.version, timestamp);
          this.event(nextTaskId, null, "user", "task.primary_session_bound", {
            sessionId,
            sourceDraftEntryId: sourceEntryId,
          }, nextTask.version, timestamp);
        } else {
          const previous = current;
          const bodyChanged = previous.contract === null || JSON.stringify(previous.contract) !== contractJson;
          const bindingChanged = previous.primarySessionId !== sessionId;
          const fieldsChanged = bodyChanged
            || previous.title !== contract.title
            || previous.goal !== projection.goal
            || previous.acceptanceCriteria !== projection.acceptanceCriteria
            || previous.expectedOutput !== projection.expectedOutput;
          const statusChanged = previous.status !== targetStatus;
          const changed = fieldsChanged || statusChanged || bindingChanged;
          const nextVersion = changed ? previous.version + 1 : previous.version;
          const nextContractRevision = bodyChanged ? previous.contractRevision + 1 : previous.contractRevision;
          const update = this.database.prepare(`
            UPDATE tasks SET
              title = ?, goal = ?, acceptance_criteria = ?, expected_output = ?,
              status = ?, primary_session_id = ?, recovery_note = NULL,
              contract_schema = 1, contract_json = ?, contract_revision = ?,
              version = ?, updated_at = ?
            WHERE id = ? AND version = ? AND status IN ('backlog','ready') AND active_run_id IS NULL
          `).run(
            contract.title,
            projection.goal,
            projection.acceptanceCriteria,
            projection.expectedOutput,
            targetStatus,
            sessionId,
            contractJson,
            nextContractRevision,
            nextVersion,
            timestamp,
            previous.id,
            previous.version,
          );
          if (Number(update.changes) !== 1) versionConflict();
          nextTask = this.getTask(previous.id);
          if (bindingChanged) {
            this.event(previous.id, null, "user", "task.primary_session_bound", {
              sessionId,
              sourceDraftEntryId: sourceEntryId,
            }, nextTask.version, timestamp);
          }
        }

        const contractEvent = action === "save_draft" ? "task.contract_saved" : "task.contract_confirmed";
        this.event(nextTask.id, null, "user", contractEvent, {
          operationId,
          sourceDraftEntryId: sourceEntryId,
          contractRevision: nextTask.contractRevision,
          status: targetStatus,
        }, nextTask.version, timestamp);
        if (action === "confirm_and_start") {
          this.event(nextTask.id, null, "user", "run.start_requested", {
            operationId,
            sourceDraftEntryId: sourceEntryId,
            contractRevision: nextTask.contractRevision,
          }, nextTask.version, timestamp);
        }
        const operationStatus = action === "save_draft"
          ? "saved"
          : action === "confirm"
            ? "confirmed"
            : "awaiting_start";
        this.database.prepare(`
          UPDATE task_framing_operations
          SET task_id = ?, status = ?, updated_at = ?
          WHERE id = ? AND status = 'applying'
        `).run(nextTask.id, operationStatus, timestamp, operationId);
        return {
          task: this.getTaskDetail(nextTask.id),
          operation: this.getTaskFramingOperation(operationId),
        };
      });
      current = result.task;
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.includes("tasks.primary_session_id")) {
        throw new TaskDomainError("SESSION_ALREADY_BOUND", "This Session is already bound to another Task", 409);
      }
      throw error;
    }
  }

  bindTaskPrimarySession(taskId: string, version: number, sessionId: string): TaskDetail {
    if (!Number.isInteger(version) || version < 1) invalidInput("version must be a positive integer");
    const cleanSessionId = requiredText(sessionId, "sessionId", 256);
    const task = this.getTask(taskId);
    if (task.version !== version) versionConflict();
    if (task.status !== "backlog" && task.status !== "ready") {
      invalidTransition("Only backlog and ready Tasks can bind a Framing Session");
    }
    if (task.activeRunId) throw new TaskDomainError("ACTIVE_RUN_EXISTS", "The Task has an active Run", 409);
    if (task.primarySessionId === cleanSessionId) return this.getTaskDetail(taskId);
    if (task.primarySessionId) {
      throw new TaskDomainError("SESSION_ALREADY_BOUND", "The Task is already bound to another Session", 409);
    }
    const claimed = this.database.prepare("SELECT id FROM tasks WHERE primary_session_id = ?").get(cleanSessionId) as Row | undefined;
    if (claimed) throw new TaskDomainError("SESSION_ALREADY_BOUND", "The Session is already bound to another Task", 409);
    const timestamp = now();
    try {
      return this.transaction(() => {
        const result = this.database.prepare(`
          UPDATE tasks SET primary_session_id = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND primary_session_id IS NULL
            AND status IN ('backlog','ready') AND active_run_id IS NULL
        `).run(cleanSessionId, timestamp, taskId, version);
        if (Number(result.changes) !== 1) versionConflict();
        const next = this.getTask(taskId);
        this.event(taskId, null, "user", "task.primary_session_bound", {
          sessionId: cleanSessionId,
          source: "framing_session",
        }, next.version, timestamp);
        return this.getTaskDetail(taskId);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("tasks.primary_session_id")) {
        throw new TaskDomainError("SESSION_ALREADY_BOUND", "The Session is already bound to another Task", 409);
      }
      throw error;
    }
  }

  moveQueuedTask(taskId: string, version: number, status: QueueStatus, sortOrder?: number): TaskRecord {
    if (!Number.isInteger(version) || version < 1) invalidInput("version must be a positive integer");
    if (status !== "backlog" && status !== "ready") invalidInput("Queue moves support only backlog and ready");
    const task = this.getTask(taskId);
    if (task.version !== version) versionConflict();
    if (task.status !== "backlog" && task.status !== "ready") {
      invalidTransition("Only backlog and ready tasks can be moved without a business action");
    }
    if (status === "ready") {
      this.assertReadyContract(task.goal, task.acceptanceCriteria, task.expectedOutput);
      if (task.contract && !checkTaskContractReadiness(task.contract).ready) {
        throw new TaskDomainError("CONTRACT_NOT_READY", "Resolve every blocking rich contract check before moving this Task to ready", 409);
      }
    }
    const targetOrder = sortOrder === undefined
      ? this.nextSortOrder(task.projectId, status, task.id)
      : Number(sortOrder);
    if (!Number.isFinite(targetOrder) || Math.abs(targetOrder) > 1_000_000_000_000) {
      invalidInput("sortOrder must be a finite number within range");
    }

    const timestamp = now();
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE tasks SET status = ?, sort_order = ?, version = version + 1,
          recovery_note = NULL, updated_at = ?
        WHERE id = ? AND version = ? AND status IN ('backlog','ready')
      `).run(status, targetOrder, timestamp, taskId, version);
      if (Number(result.changes) !== 1) versionConflict();
      this.event(taskId, null, "user", "task.queued", { from: task.status, to: status, sortOrder: targetOrder }, version + 1, timestamp);
      return this.getTask(taskId);
    });
  }

  private nextSortOrder(projectId: string, status: QueueStatus, excludedTaskId?: string): number {
    const row = excludedTaskId
      ? this.database.prepare(
          "SELECT MAX(sort_order) AS value FROM tasks WHERE project_id = ? AND status = ? AND id <> ?",
        ).get(projectId, status, excludedTaskId) as Row
      : this.database.prepare(
          "SELECT MAX(sort_order) AS value FROM tasks WHERE project_id = ? AND status = ?",
        ).get(projectId, status) as Row;
    return Number.isFinite(Number(row.value)) ? Number(row.value) + DEFAULT_SORT_GAP : DEFAULT_SORT_GAP;
  }

  beginRun(taskId: string, version: number, options: { cwd?: string; model?: string | null } = {}): { task: TaskRecord; run: RunRecord; capability: string } {
    if (!Number.isInteger(version) || version < 1) invalidInput("version must be a positive integer");
    const task = this.getTask(taskId);
    if (task.version !== version) versionConflict();
    if (task.status !== "ready") invalidTransition("Only a ready task can start");
    if (task.activeRunId) throw new TaskDomainError("ACTIVE_RUN_EXISTS", "Task already has an active run", 409);
    this.assertReadyContract(task.goal, task.acceptanceCriteria, task.expectedOutput);
    if (task.contract && !checkTaskContractReadiness(task.contract).ready) {
      throw new TaskDomainError("CONTRACT_NOT_READY", "The rich Task contract is not ready to start", 409);
    }
    const project = this.getProject(task.projectId);
    const cwd = options.cwd ? realpathSync(resolve(options.cwd)) : project.rootPath;
    if (!statSync(cwd).isDirectory() || !isPathWithinRoots(cwd, new Set([project.rootPath]))) {
      invalidInput("Run cwd must be inside the project root");
    }

    const runId = id("run");
    const capability = newCapability();
    const timestamp = now();
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO runs (
          id, task_id, status, cwd, model, capability_hash,
          task_version_at_start, contract_revision, contract_snapshot_json,
          created_at, updated_at
        ) VALUES (?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        taskId,
        cwd,
        options.model ?? null,
        capabilityHash(capability).toString("hex"),
        task.version,
        task.contract ? task.contractRevision : null,
        task.contract ? JSON.stringify(task.contract) : null,
        timestamp,
        timestamp,
      );
      const result = this.database.prepare(`
        UPDATE tasks SET status = 'in_progress', active_run_id = ?,
          recovery_note = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'ready' AND active_run_id IS NULL
      `).run(runId, timestamp, taskId, version);
      if (Number(result.changes) !== 1) versionConflict();
      this.event(taskId, runId, "system", "run.starting", { cwd }, version + 1, timestamp);
      return { task: this.getTask(taskId), run: this.getRun(runId), capability };
    });
  }

  assertRunCapability(runId: string, capability: string): RunRecord {
    if (typeof capability !== "string" || !capability.startsWith("cap_")) {
      throw new TaskDomainError("RUN_NOT_ACTIVE", "Invalid run capability", 403);
    }
    const row = this.database.prepare(
      "SELECT capability_hash FROM runs WHERE id = ?",
    ).get(runId) as Row | undefined;
    if (!row) notFound(`Run '${runId}' does not exist`);
    const expected = Buffer.from(String(row.capability_hash), "hex");
    const actual = capabilityHash(capability);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new TaskDomainError("RUN_NOT_ACTIVE", "Invalid run capability", 403);
    }
    return this.getRun(runId);
  }

  getRun(runId: string): RunRecord {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Row | undefined;
    if (!row) notFound(`Run '${runId}' does not exist`);
    return mapRun(row);
  }

  beginDelegationBatch(
    runId: string,
    capability: string,
    requests: Array<{ profile: DelegationProfile; prompt: string }>,
    model: string,
  ): DelegationRecord[] {
    const run = this.assertRunCapability(runId, capability);
    if (run.status !== "running") invalidTransition("Only a running task run can delegate analysis");
    const task = this.getTask(run.taskId);
    if (task.activeRunId !== runId || task.status !== "in_progress") {
      throw new TaskDomainError("RUN_NOT_ACTIVE", "Run is no longer active for this task", 409);
    }
    if (!Array.isArray(requests) || requests.length < 2 || requests.length > 4) {
      invalidInput("A delegation batch requires 2 to 4 read-only agents");
    }
    const active = this.database.prepare(
      "SELECT COUNT(*) AS value FROM delegations WHERE run_id = ? AND status = 'running'",
    ).get(runId) as Row;
    if (Number(active.value) > 0) invalidTransition("A delegation batch is already running");

    const cleanModel = requiredText(model, "model", 512);
    const cleanRequests = requests.map((request) => {
      if (!DELEGATION_PROFILE_SET.has(request.profile)) invalidInput("Unknown delegation profile");
      return {
        profile: request.profile,
        prompt: requiredText(request.prompt, "delegation.prompt", 100_000),
      };
    });
    const batchId = id("dlg_batch");
    const timestamp = now();
    const delegationIds = cleanRequests.map(() => id("dlg"));

    this.transaction(() => {
      for (let index = 0; index < cleanRequests.length; index += 1) {
        const request = cleanRequests[index];
        this.database.prepare(`
          INSERT INTO delegations (
            id, batch_id, task_id, run_id, profile, prompt, status, model,
            output, usage, created_at, started_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, '', '{}', ?, ?, ?)
        `).run(
          delegationIds[index],
          batchId,
          task.id,
          runId,
          request.profile,
          request.prompt,
          cleanModel,
          timestamp,
          timestamp,
          timestamp,
        );
      }
      this.event(task.id, runId, "agent", "delegation.started", {
        batchId,
        count: cleanRequests.length,
        profiles: cleanRequests.map((request) => request.profile),
        model: cleanModel,
      }, task.version, timestamp);
    });

    return delegationIds.map((delegationId) => this.getDelegation(delegationId));
  }

  getDelegation(delegationId: string): DelegationRecord {
    const row = this.database.prepare("SELECT * FROM delegations WHERE id = ?").get(delegationId) as Row | undefined;
    if (!row) notFound(`Delegation '${delegationId}' does not exist`);
    return mapDelegation(row);
  }

  finishDelegation(
    delegationId: string,
    capability: string,
    result: {
      status: "succeeded" | "failed" | "canceled";
      output?: string;
      error?: string;
      usage?: Partial<DelegationUsage>;
    },
  ): DelegationRecord {
    const delegation = this.getDelegation(delegationId);
    const run = this.assertRunCapability(delegation.runId, capability);
    if (run.status !== "running") throw new TaskDomainError("RUN_NOT_ACTIVE", "Parent run is no longer running", 409);
    const task = this.getTask(run.taskId);
    if (task.activeRunId !== run.id || task.status !== "in_progress") {
      throw new TaskDomainError("RUN_NOT_ACTIVE", "Parent run is no longer active", 409);
    }
    const output = optionalText(result.output, "delegation.output", 200_000);
    const error = optionalText(result.error, "delegation.error", 10_000) || null;
    const usage: DelegationUsage = {
      input: nonNegativeFinite(result.usage?.input),
      output: nonNegativeFinite(result.usage?.output),
      cacheRead: nonNegativeFinite(result.usage?.cacheRead),
      cacheWrite: nonNegativeFinite(result.usage?.cacheWrite),
      totalTokens: nonNegativeFinite(result.usage?.totalTokens),
      cost: nonNegativeFinite(result.usage?.cost),
    };
    const timestamp = now();
    this.transaction(() => {
      const update = this.database.prepare(`
        UPDATE delegations SET status = ?, output = ?, error = ?, usage = ?,
          ended_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(result.status, output, error, JSON.stringify(usage), timestamp, timestamp, delegationId);
      if (Number(update.changes) !== 1) {
        throw new TaskDomainError("RUN_NOT_ACTIVE", "Delegation is no longer active", 409);
      }
      this.event(task.id, run.id, "system", `delegation.${result.status}`, {
        batchId: delegation.batchId,
        delegationId,
        profile: delegation.profile,
        outputBytes: Buffer.byteLength(output, "utf8"),
        ...(error ? { error } : {}),
      }, task.version, timestamp);
    });
    return this.getDelegation(delegationId);
  }

  private failStartedFramingOperation(runId: string, reason: string, timestamp: string): void {
    this.database.prepare(`
      UPDATE task_framing_operations
      SET status = 'start_failed', error = ?, updated_at = ?
      WHERE run_id = ? AND action = 'confirm_and_start' AND status = 'started'
    `).run(reason, timestamp, runId);
  }

  private settleActiveDelegations(
    runId: string,
    status: "failed" | "interrupted" | "canceled",
    reason: string,
    timestamp: string,
  ): number {
    const result = this.database.prepare(`
      UPDATE delegations SET status = ?, error = ?, ended_at = ?, updated_at = ?
      WHERE run_id = ? AND status = 'running'
    `).run(status, reason, timestamp, timestamp, runId);
    return Number(result.changes);
  }

  markRunRunning(runId: string, sessionId: string): { task: TaskRecord; run: RunRecord } {
    const cleanSessionId = requiredText(sessionId, "sessionId", 256);
    const run = this.getRun(runId);
    if (run.status !== "starting") invalidTransition("Only a starting run can become running");
    const task = this.getTask(run.taskId);
    if (task.activeRunId !== runId || task.status !== "in_progress") {
      throw new TaskDomainError("RUN_NOT_ACTIVE", "Run is no longer active for this task", 409);
    }
    const claimed = this.database.prepare(
      "SELECT id FROM tasks WHERE primary_session_id = ? AND id <> ?",
    ).get(cleanSessionId, task.id) as Row | undefined;
    if (claimed) invalidTransition("This Pi Session is already bound to another task");
    const timestamp = now();
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE runs SET status = 'running', session_id = ?, started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'starting'
      `).run(cleanSessionId, timestamp, timestamp, runId);
      if (Number(result.changes) !== 1) invalidTransition("Run changed before it could start");
      this.database.prepare(`
        UPDATE tasks SET primary_session_id = ?, updated_at = ?
        WHERE id = ? AND active_run_id = ?
      `).run(cleanSessionId, timestamp, task.id, runId);
      this.event(task.id, runId, "system", "run.running", { sessionId: cleanSessionId }, task.version, timestamp);
      return { task: this.getTask(task.id), run: this.getRun(runId) };
    });
  }

  markRunWaitingUser(runId: string, capability: string, question: string): { task: TaskRecord; run: RunRecord } {
    const prompt = requiredText(question, "question", 10_000);
    const run = this.assertRunCapability(runId, capability);
    if (run.status !== "running") invalidTransition("Only a running run can wait for the user");
    const task = this.getTask(run.taskId);
    if (task.activeRunId !== runId) throw new TaskDomainError("RUN_NOT_ACTIVE", "Run is no longer active", 409);
    const timestamp = now();
    return this.transaction(() => {
      this.database.prepare("UPDATE runs SET status = 'waiting_user', updated_at = ? WHERE id = ? AND status = 'running'")
        .run(timestamp, runId);
      this.event(task.id, runId, "agent", "run.waiting_user", { question: prompt }, task.version, timestamp);
      return { task: this.getTask(task.id), run: this.getRun(runId) };
    });
  }

  resumeRun(runId: string, answer?: string): { task: TaskRecord; run: RunRecord } {
    const cleanAnswer = optionalText(answer, "answer", 100_000);
    const run = this.getRun(runId);
    if (run.status !== "waiting_user") invalidTransition("Only a run waiting for the user can resume");
    const task = this.getTask(run.taskId);
    if (task.activeRunId !== runId) throw new TaskDomainError("RUN_NOT_ACTIVE", "Run is no longer active", 409);
    const timestamp = now();
    return this.transaction(() => {
      this.database.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'waiting_user'")
        .run(timestamp, runId);
      this.event(task.id, runId, "user", "run.resumed", cleanAnswer ? { answer: cleanAnswer } : {}, task.version, timestamp);
      return { task: this.getTask(task.id), run: this.getRun(runId) };
    });
  }

  blockTask(taskId: string, version: number, reason: string): TaskDetail {
    const blockReason = requiredText(reason, "reason", 100_000);
    if (!Number.isInteger(version) || version < 1) invalidInput("version must be a positive integer");
    const task = this.getTask(taskId);
    if (task.version !== version) versionConflict();
    if (task.status !== "ready" && task.status !== "in_progress") {
      invalidTransition("Only a ready or in-progress task can be blocked");
    }

    const timestamp = now();
    return this.transaction(() => {
      let stoppedRunId: string | null = null;
      let stoppedDelegationCount = 0;
      if (task.status === "in_progress") {
        if (!task.activeRunId) throw new TaskDomainError("RUN_NOT_ACTIVE", "In-progress task has no active run", 409);
        const run = this.getRun(task.activeRunId);
        if (!ACTIVE_RUN_STATUSES.has(run.status as ActiveRunStatus)) {
          throw new TaskDomainError("RUN_NOT_ACTIVE", "Task run is no longer active", 409);
        }
        const stopped = this.database.prepare(`
          UPDATE runs SET status = 'interrupted', error = NULL, stop_reason = ?, ended_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('starting','running','waiting_user')
        `).run(blockReason, timestamp, timestamp, run.id);
        if (Number(stopped.changes) !== 1) throw new TaskDomainError("RUN_NOT_ACTIVE", "Task run changed before it could be blocked", 409);
        stoppedRunId = run.id;
        stoppedDelegationCount = this.settleActiveDelegations(run.id, "interrupted", blockReason, timestamp);
      }

      const result = this.database.prepare(`
        UPDATE tasks SET status = 'blocked', active_run_id = NULL, recovery_note = ?,
          version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status IN ('ready','in_progress')
      `).run(blockReason, timestamp, taskId, version);
      if (Number(result.changes) !== 1) versionConflict();
      const nextTask = this.getTask(taskId);
      if (stoppedRunId) {
        this.event(taskId, stoppedRunId, "user", "run.interrupted", {
          reason: blockReason,
          recovery: "blocked",
          stoppedDelegationCount,
        }, nextTask.version, timestamp);
      }
      this.event(taskId, stoppedRunId, "user", "task.blocked", { reason: blockReason }, nextTask.version, timestamp);
      return this.getTaskDetail(taskId);
    });
  }

  unblockTask(taskId: string, version: number, resolution: string): TaskDetail {
    const note = requiredText(resolution, "resolution", 100_000);
    if (!Number.isInteger(version) || version < 1) invalidInput("version must be a positive integer");
    const task = this.getTask(taskId);
    if (task.version !== version) versionConflict();
    if (task.status !== "blocked") invalidTransition("Only a blocked task can be unblocked");
    this.assertReadyContract(task.goal, task.acceptanceCriteria, task.expectedOutput);

    const timestamp = now();
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE tasks SET status = 'ready', recovery_note = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'blocked' AND active_run_id IS NULL
      `).run(note, timestamp, taskId, version);
      if (Number(result.changes) !== 1) versionConflict();
      const nextTask = this.getTask(taskId);
      this.event(taskId, null, "user", "task.unblocked", { resolution: note }, nextTask.version, timestamp);
      return this.getTaskDetail(taskId);
    });
  }

  cancelTask(taskId: string, version: number, reason: string): TaskDetail {
    const cancelReason = requiredText(reason, "reason", 100_000);
    if (!Number.isInteger(version) || version < 1) invalidInput("version must be a positive integer");
    const task = this.getTask(taskId);
    if (task.version !== version) versionConflict();
    if (task.status === "done" || task.status === "canceled") {
      invalidTransition("A completed or canceled task cannot be canceled again");
    }

    const timestamp = now();
    return this.transaction(() => {
      let stoppedRunId: string | null = null;
      let stoppedDelegationCount = 0;
      if (task.status === "in_progress") {
        if (!task.activeRunId) throw new TaskDomainError("RUN_NOT_ACTIVE", "In-progress task has no active run", 409);
        const run = this.getRun(task.activeRunId);
        if (!ACTIVE_RUN_STATUSES.has(run.status as ActiveRunStatus)) {
          throw new TaskDomainError("RUN_NOT_ACTIVE", "Task run is no longer active", 409);
        }
        const stopped = this.database.prepare(`
          UPDATE runs SET status = 'canceled', error = NULL, stop_reason = ?, ended_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('starting','running','waiting_user')
        `).run(cancelReason, timestamp, timestamp, run.id);
        if (Number(stopped.changes) !== 1) throw new TaskDomainError("RUN_NOT_ACTIVE", "Task run changed before it could be canceled", 409);
        stoppedRunId = run.id;
        stoppedDelegationCount = this.settleActiveDelegations(run.id, "canceled", cancelReason, timestamp);
      }

      const result = this.database.prepare(`
        UPDATE tasks SET status = 'canceled', active_run_id = NULL, recovery_note = NULL,
          version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status NOT IN ('done','canceled')
      `).run(timestamp, taskId, version);
      if (Number(result.changes) !== 1) versionConflict();
      const nextTask = this.getTask(taskId);
      if (stoppedRunId) {
        this.event(taskId, stoppedRunId, "user", "run.canceled", {
          reason: cancelReason,
          stoppedDelegationCount,
        }, nextTask.version, timestamp);
      }
      this.event(taskId, stoppedRunId, "user", "task.canceled", { reason: cancelReason }, nextTask.version, timestamp);
      return this.getTaskDetail(taskId);
    });
  }

  failRun(runId: string, reason: string, interrupted = false): { task: TaskRecord; run: RunRecord } {
    const message = requiredText(reason, "reason", 10_000);
    const run = this.getRun(runId);
    if (!ACTIVE_RUN_STATUSES.has(run.status as ActiveRunStatus)) {
      invalidTransition("Only an active run can fail or be interrupted");
    }
    const task = this.getTask(run.taskId);
    const status = interrupted ? "interrupted" : "failed";
    const timestamp = now();
    return this.transaction(() => {
      const stoppedDelegationCount = this.settleActiveDelegations(runId, status, message, timestamp);
      this.failStartedFramingOperation(runId, message, timestamp);
      this.database.prepare(`
        UPDATE runs SET status = ?, error = ?, stop_reason = ?, ended_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('starting','running','waiting_user')
      `).run(status, interrupted ? null : message, message, timestamp, timestamp, runId);
      const result = this.database.prepare(`
        UPDATE tasks SET status = 'ready', active_run_id = NULL, recovery_note = ?,
          version = version + 1, updated_at = ?
        WHERE id = ? AND active_run_id = ? AND status = 'in_progress'
      `).run(message, timestamp, task.id, runId);
      if (Number(result.changes) !== 1) throw new TaskDomainError("RUN_NOT_ACTIVE", "Run is no longer active", 409);
      const nextTask = this.getTask(task.id);
      this.event(task.id, runId, "system", `run.${status}`, {
        reason: message,
        stoppedDelegationCount,
      }, nextTask.version, timestamp);
      return { task: nextTask, run: this.getRun(runId) };
    });
  }

  submitReview(runId: string, capability: string, submission: ReviewSubmission): TaskDetail {
    const run = this.assertRunCapability(runId, capability);
    if (run.status !== "running" && run.status !== "waiting_user") {
      invalidTransition("Only an active run can submit a review");
    }
    const task = this.getTask(run.taskId);
    if (task.activeRunId !== runId || task.status !== "in_progress") {
      throw new TaskDomainError("RUN_NOT_ACTIVE", "Run is no longer active for this task", 409);
    }
    const project = this.getProject(task.projectId);
    const activeDelegations = this.database.prepare(
      "SELECT COUNT(*) AS value FROM delegations WHERE run_id = ? AND status = 'running'",
    ).get(runId) as Row;
    if (Number(activeDelegations.value) > 0) {
      invalidTransition("Wait for delegated agents to finish before submitting a review");
    }
    const summary = requiredText(submission.summary, "summary", 100_000);
    const changes = requiredText(submission.changes, "changes", 100_000);
    const verification = requiredText(submission.verification, "verification", 100_000);
    const unverified = optionalText(submission.unverified, "unverified", 100_000);
    const risks = optionalText(submission.risks, "risks", 100_000);
    if (!Array.isArray(submission.artifacts) || submission.artifacts.length === 0) {
      throw new TaskDomainError("INVALID_ARTIFACT", "At least one artifact is required for Gate C", 400);
    }
    if (submission.artifacts.length > 20) invalidInput("Too many artifacts");
    const artifacts = submission.artifacts.map((artifact) => {
      const requestedPath = requiredText(artifact.path, "artifact.path", 4096);
      const candidate = isAbsolute(requestedPath) ? requestedPath : resolve(project.rootPath, requestedPath);
      let realPath: string;
      try {
        realPath = realpathSync(candidate);
      } catch {
        throw new TaskDomainError("INVALID_ARTIFACT", `Artifact does not exist: ${requestedPath}`, 400);
      }
      if (!isPathWithinRoots(realPath, new Set([project.rootPath])) || !statSync(realPath).isFile()) {
        throw new TaskDomainError("INVALID_ARTIFACT", `Artifact is outside the project or not a file: ${requestedPath}`, 400);
      }
      return {
        path: realPath,
        kind: optionalText(artifact.kind, "artifact.kind", 80) || "file",
        verification: requiredText(artifact.verification, "artifact.verification", 100_000),
      };
    });

    const timestamp = now();
    const reviewId = id("rev");
    this.transaction(() => {
      for (const artifact of artifacts) {
        this.database.prepare(`
          INSERT INTO artifacts (id, task_id, run_id, path, kind, verification, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id("art"), task.id, runId, artifact.path, artifact.kind, artifact.verification, timestamp);
      }
      this.database.prepare(`
        INSERT INTO reviews (
          id, task_id, run_id, status, summary, changes, verification,
          unverified, risks, submitted_at
        ) VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?)
      `).run(reviewId, task.id, runId, summary, changes, verification, unverified, risks, timestamp);
      const runResult = this.database.prepare(`
        UPDATE runs SET status = 'succeeded', ended_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('running','waiting_user')
      `).run(timestamp, timestamp, runId);
      if (Number(runResult.changes) !== 1) invalidTransition("Run changed before review submission");
      const taskResult = this.database.prepare(`
        UPDATE tasks SET status = 'in_review', active_run_id = NULL,
          recovery_note = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND active_run_id = ? AND status = 'in_progress'
      `).run(timestamp, task.id, runId);
      if (Number(taskResult.changes) !== 1) throw new TaskDomainError("RUN_NOT_ACTIVE", "Run is no longer active", 409);
      const nextTask = this.getTask(task.id);
      this.event(task.id, runId, "agent", "review.submitted", { reviewId, artifactCount: artifacts.length }, nextTask.version, timestamp);
    });
    return this.getTaskDetail(task.id);
  }

  returnReview(taskId: string, version: number, reason: string): TaskDetail {
    const feedback = requiredText(reason, "reason", 100_000);
    const task = this.getTask(taskId);
    if (task.version !== version) versionConflict();
    if (task.status !== "in_review") invalidTransition("Only a task in review can be returned");
    const review = this.database.prepare(`
      SELECT * FROM reviews WHERE task_id = ? AND status = 'submitted'
      ORDER BY submitted_at DESC LIMIT 1
    `).get(taskId) as Row | undefined;
    if (!review) throw new TaskDomainError("REVIEW_NOT_PENDING", "No submitted review is waiting", 409);
    const reviewId = String(review.id);
    const timestamp = now();
    this.transaction(() => {
      this.database.prepare(`
        UPDATE reviews SET status = 'rejected', rejection_reason = ?, decided_at = ?
        WHERE id = ? AND status = 'submitted'
      `).run(feedback, timestamp, reviewId);
      const result = this.database.prepare(`
        UPDATE tasks SET status = 'ready', recovery_note = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'in_review'
      `).run(feedback, timestamp, taskId, version);
      if (Number(result.changes) !== 1) versionConflict();
      this.event(taskId, String(review.run_id), "user", "review.rejected", { reviewId, reason: feedback }, version + 1, timestamp);
    });
    return this.getTaskDetail(taskId);
  }

  acceptReview(taskId: string, version: number): TaskDetail {
    const task = this.getTask(taskId);
    if (task.version !== version) versionConflict();
    if (task.status !== "in_review") invalidTransition("Only a task in review can be accepted");
    const review = this.database.prepare(`
      SELECT * FROM reviews WHERE task_id = ? AND status = 'submitted'
      ORDER BY submitted_at DESC LIMIT 1
    `).get(taskId) as Row | undefined;
    if (!review) throw new TaskDomainError("REVIEW_NOT_PENDING", "No submitted review is waiting", 409);
    const reviewId = String(review.id);
    const timestamp = now();
    this.transaction(() => {
      this.database.prepare(`
        UPDATE reviews SET status = 'accepted', decided_at = ?
        WHERE id = ? AND status = 'submitted'
      `).run(timestamp, reviewId);
      const result = this.database.prepare(`
        UPDATE tasks SET status = 'done', recovery_note = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'in_review'
      `).run(timestamp, taskId, version);
      if (Number(result.changes) !== 1) versionConflict();
      this.event(taskId, String(review.run_id), "user", "review.accepted", { reviewId }, version + 1, timestamp);
    });
    return this.getTaskDetail(taskId);
  }

  reconcileActiveRuns(reason = "Pi Task restarted before the run finished"): number {
    const activeRuns = this.database.prepare(`
      SELECT * FROM runs WHERE status IN ('starting','running','waiting_user') ORDER BY created_at
    `).all() as Row[];
    if (activeRuns.length === 0) return 0;
    const message = requiredText(reason, "reason", 10_000);
    const timestamp = now();
    return this.transaction(() => {
      let reconciled = 0;
      for (const row of activeRuns) {
        const run = mapRun(row);
        const task = this.getTask(run.taskId);
        const stoppedDelegationCount = this.settleActiveDelegations(run.id, "interrupted", message, timestamp);
        this.failStartedFramingOperation(run.id, message, timestamp);
        this.database.prepare(`
          UPDATE runs SET status = 'interrupted', stop_reason = ?, ended_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('starting','running','waiting_user')
        `).run(message, timestamp, timestamp, run.id);
        const result = this.database.prepare(`
          UPDATE tasks SET status = 'ready', active_run_id = NULL, recovery_note = ?,
            version = version + 1, updated_at = ?
          WHERE id = ? AND active_run_id = ? AND status = 'in_progress'
        `).run(message, timestamp, task.id, run.id);
        if (Number(result.changes) === 1) {
          const nextTask = this.getTask(task.id);
          this.event(task.id, run.id, "system", "run.interrupted", {
            reason: message,
            recovery: "restart",
            stoppedDelegationCount,
          }, nextTask.version, timestamp);
          reconciled += 1;
        }
      }
      return reconciled;
    });
  }
}

export function getTaskDataDirectory(): string {
  const configured = process.env.PI_TASK_DATA_DIR?.trim();
  return resolve(configured || join(homedir(), ".pi-task"));
}

export function getTaskDatabasePath(): string {
  return join(getTaskDataDirectory(), "pi-task.sqlite");
}

type TaskStoreGlobal = typeof globalThis & {
  __piTaskStores?: Map<string, TaskStore>;
};

export function getTaskStore(): TaskStore {
  const filename = getTaskDatabasePath();
  const globals = globalThis as TaskStoreGlobal;
  globals.__piTaskStores ??= new Map<string, TaskStore>();
  const existing = globals.__piTaskStores.get(filename);
  if (existing) return existing;
  const store = new TaskStore(filename);
  globals.__piTaskStores.set(filename, store);
  return store;
}

export function taskStoreExists(): boolean {
  return existsSync(getTaskDatabasePath());
}
