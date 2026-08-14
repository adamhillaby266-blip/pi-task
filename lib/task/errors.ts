export type TaskErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "INVALID_TRANSITION"
  | "ACTIVE_RUN_EXISTS"
  | "DRAFT_STALE"
  | "SESSION_ALREADY_BOUND"
  | "CONTRACT_NOT_READY"
  | "START_INTENT_EXPIRED"
  | "INVALID_ARTIFACT"
  | "RUN_NOT_ACTIVE"
  | "REVIEW_NOT_PENDING";

const TASK_DOMAIN_ERROR_BRAND = Symbol.for("pi-task.task-domain-error");
const TASK_ERROR_CODES = new Set<TaskErrorCode>([
  "INVALID_INPUT",
  "NOT_FOUND",
  "VERSION_CONFLICT",
  "INVALID_TRANSITION",
  "ACTIVE_RUN_EXISTS",
  "DRAFT_STALE",
  "SESSION_ALREADY_BOUND",
  "CONTRACT_NOT_READY",
  "START_INTENT_EXPIRED",
  "INVALID_ARTIFACT",
  "RUN_NOT_ACTIVE",
  "REVIEW_NOT_PENDING",
]);

export class TaskDomainError extends Error {
  public readonly code: TaskErrorCode;
  public readonly status: number;

  constructor(code: TaskErrorCode, message: string, status: number) {
    super(message);
    this.name = "TaskDomainError";
    this.code = code;
    this.status = status;
    Object.defineProperty(this, TASK_DOMAIN_ERROR_BRAND, { value: true });
  }
}

export function isTaskDomainError(error: unknown): error is TaskDomainError {
  if (error instanceof TaskDomainError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<PropertyKey, unknown>;
  return candidate[TASK_DOMAIN_ERROR_BRAND] === true
    && typeof candidate.message === "string"
    && typeof candidate.status === "number"
    && Number.isInteger(candidate.status)
    && candidate.status >= 400
    && candidate.status <= 599
    && typeof candidate.code === "string"
    && TASK_ERROR_CODES.has(candidate.code as TaskErrorCode);
}

export function invalidInput(message: string): never {
  throw new TaskDomainError("INVALID_INPUT", message, 400);
}

export function notFound(message: string): never {
  throw new TaskDomainError("NOT_FOUND", message, 404);
}

export function versionConflict(message = "Task version changed; refresh and try again"): never {
  throw new TaskDomainError("VERSION_CONFLICT", message, 409);
}

export function invalidTransition(message: string): never {
  throw new TaskDomainError("INVALID_TRANSITION", message, 409);
}
