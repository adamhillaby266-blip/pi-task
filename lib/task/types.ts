export const TASK_STATUSES = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_STATUSES = [
  "starting",
  "running",
  "waiting_user",
  "succeeded",
  "failed",
  "interrupted",
  "canceled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type ReviewStatus = "submitted" | "accepted" | "rejected";
export type EventActor = "user" | "agent" | "system";

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  acceptanceCriteria: string;
  expectedOutput: string;
  status: TaskStatus;
  sortOrder: number;
  version: number;
  primarySessionId: string | null;
  activeRunId: string | null;
  recoveryNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  taskId: string;
  sessionId: string | null;
  status: RunStatus;
  cwd: string;
  model: string | null;
  error: string | null;
  stopReason: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  runId: string;
  path: string;
  kind: string;
  verification: string;
  createdAt: string;
}

export interface ReviewRecord {
  id: string;
  taskId: string;
  runId: string;
  status: ReviewStatus;
  summary: string;
  changes: string;
  verification: string;
  unverified: string;
  risks: string;
  rejectionReason: string | null;
  submittedAt: string;
  decidedAt: string | null;
}

export interface EventRecord {
  id: number;
  taskId: string;
  runId: string | null;
  actor: EventActor;
  type: string;
  payload: Record<string, unknown>;
  taskVersion: number;
  createdAt: string;
}

export interface TaskDetail extends TaskRecord {
  project: ProjectRecord;
  runs: RunRecord[];
  artifacts: ArtifactRecord[];
  reviews: ReviewRecord[];
  events: EventRecord[];
}

export interface CreateProjectInput {
  name: string;
  rootPath: string;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  goal: string;
  acceptanceCriteria: string;
  expectedOutput: string;
  status?: "backlog" | "ready";
  primarySessionId?: string;
}

export interface UpdateTaskContractInput {
  title: string;
  goal: string;
  acceptanceCriteria: string;
  expectedOutput: string;
}

export interface ReviewSubmission {
  summary: string;
  changes: string;
  verification: string;
  unverified?: string;
  risks?: string;
  artifacts: Array<{
    path: string;
    kind?: string;
    verification: string;
  }>;
}
