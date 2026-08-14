import type { TaskContractV1 } from "./contract";

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

export const DELEGATION_PROFILES = ["scout", "analyst", "critic"] as const;
export type DelegationProfile = (typeof DELEGATION_PROFILES)[number];

export const DELEGATION_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "canceled",
] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

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
  contractSchema: number | null;
  contract: TaskContractV1 | null;
  contractRevision: number;
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
  taskVersionAtStart: number | null;
  contractRevision: number | null;
  contractSnapshot: TaskContractV1 | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export interface DelegationUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface DelegationRecord {
  id: string;
  batchId: string;
  taskId: string;
  runId: string;
  profile: DelegationProfile;
  prompt: string;
  status: DelegationStatus;
  model: string;
  output: string;
  error: string | null;
  usage: DelegationUsage;
  createdAt: string;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
}

export type TaskFramingCommitAction = "save_draft" | "confirm" | "confirm_and_start";
export type TaskFramingOperationStatus = "applying" | "saved" | "confirmed" | "awaiting_start" | "started" | "start_failed";

export interface TaskFramingOperationRecord {
  id: string;
  sessionId: string;
  sourceEntryId: string;
  action: TaskFramingCommitAction;
  taskId: string | null;
  runId: string | null;
  status: TaskFramingOperationStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskFramingCommitInput {
  operationId: string;
  sessionId: string;
  sourceEntryId: string;
  projectId: string;
  taskId: string | null;
  expectedTaskVersion: number | null;
  action: TaskFramingCommitAction;
  contract: TaskContractV1;
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
  delegations: DelegationRecord[];
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
