import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isPathWithinRoots } from "../path-security.ts";
import {
  invalidInput,
  invalidTransition,
  notFound,
  TaskDomainError,
  versionConflict,
} from "./errors.ts";
import type {
  ArtifactRecord,
  CreateProjectInput,
  CreateTaskInput,
  EventActor,
  EventRecord,
  ProjectRecord,
  ReviewRecord,
  ReviewSubmission,
  RunRecord,
  TaskDetail,
  TaskRecord,
  TaskStatus,
  UpdateTaskContractInput,
} from "./types.ts";

type Row = Record<string, unknown>;
type QueueStatus = "backlog" | "ready";
type ActiveRunStatus = "starting" | "running" | "waiting_user";

const ACTIVE_RUN_STATUSES = new Set<ActiveRunStatus>(["starting", "running", "waiting_user"]);
const DEFAULT_SORT_GAP = 1024;

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
    createdAt: String(row.created_at),
    startedAt: nullableText(row.started_at),
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
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
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
      CREATE INDEX IF NOT EXISTS events_by_task_id
        ON events(task_id, id);
      PRAGMA user_version = 1;
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

  moveQueuedTask(taskId: string, version: number, status: QueueStatus, sortOrder?: number): TaskRecord {
    if (!Number.isInteger(version) || version < 1) invalidInput("version must be a positive integer");
    if (status !== "backlog" && status !== "ready") invalidInput("Queue moves support only backlog and ready");
    const task = this.getTask(taskId);
    if (task.version !== version) versionConflict();
    if (task.status !== "backlog" && task.status !== "ready") {
      invalidTransition("Only backlog and ready tasks can be moved without a business action");
    }
    if (status === "ready") this.assertReadyContract(task.goal, task.acceptanceCriteria, task.expectedOutput);
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
          id, task_id, status, cwd, model, capability_hash, created_at, updated_at
        ) VALUES (?, ?, 'starting', ?, ?, ?, ?, ?)
      `).run(runId, taskId, cwd, options.model ?? null, capabilityHash(capability).toString("hex"), timestamp, timestamp);
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
      }

      const result = this.database.prepare(`
        UPDATE tasks SET status = 'blocked', active_run_id = NULL, recovery_note = ?,
          version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status IN ('ready','in_progress')
      `).run(blockReason, timestamp, taskId, version);
      if (Number(result.changes) !== 1) versionConflict();
      const nextTask = this.getTask(taskId);
      if (stoppedRunId) {
        this.event(taskId, stoppedRunId, "user", "run.interrupted", { reason: blockReason, recovery: "blocked" }, nextTask.version, timestamp);
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
      }

      const result = this.database.prepare(`
        UPDATE tasks SET status = 'canceled', active_run_id = NULL, recovery_note = NULL,
          version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status NOT IN ('done','canceled')
      `).run(timestamp, taskId, version);
      if (Number(result.changes) !== 1) versionConflict();
      const nextTask = this.getTask(taskId);
      if (stoppedRunId) {
        this.event(taskId, stoppedRunId, "user", "run.canceled", { reason: cancelReason }, nextTask.version, timestamp);
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
      this.event(task.id, runId, "system", `run.${status}`, { reason: message }, nextTask.version, timestamp);
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
          this.event(task.id, run.id, "system", "run.interrupted", { reason: message, recovery: "restart" }, nextTask.version, timestamp);
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
