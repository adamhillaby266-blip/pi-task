export const TASK_CONTRACT_SCHEMA_VERSION = 1 as const;

export const CONTRACT_ITEM_STATUSES = [
  "confirmed",
  "agent_suggestion",
  "assumption",
] as const;

export type ContractItemStatus = (typeof CONTRACT_ITEM_STATUSES)[number];

export const CONTRACT_EVIDENCE_KINDS = [
  "user_message",
  "project_file",
  "project_rule",
  "task",
  "agent",
] as const;

export type ContractEvidenceKind = (typeof CONTRACT_EVIDENCE_KINDS)[number];

export const CONTRACT_SOURCE_AVAILABILITIES = [
  "available",
  "discover_during_run",
  "not_applicable",
  "missing",
] as const;

export type ContractSourceAvailability = (typeof CONTRACT_SOURCE_AVAILABILITIES)[number];

export const CONTRACT_DELIVERABLE_KINDS = [
  "file",
  "data",
  "page",
  "decision_record",
  "external_action",
  "other",
] as const;

export type ContractDeliverableKind = (typeof CONTRACT_DELIVERABLE_KINDS)[number];

export const CONTRACT_GATE_TIMINGS = [
  "before_run",
  "during_run",
  "before_external_effect",
  "before_review",
] as const;

export type ContractGateTiming = (typeof CONTRACT_GATE_TIMINGS)[number];

export interface ContractEvidenceRef {
  kind: ContractEvidenceKind;
  label: string;
  ref?: string;
}

export interface ContractItem {
  id: string;
  text: string;
  status: ContractItemStatus;
  evidence?: ContractEvidenceRef[];
}

export interface ContractSource extends ContractItem {
  availability: ContractSourceAvailability;
}

export interface ContractDeliverable extends ContractItem {
  kind: ContractDeliverableKind;
  suggestedPath?: string;
}

export interface ContractDecision {
  id: string;
  question: string;
  blocking: boolean;
  status: "open" | "resolved";
  options?: string[];
  resolution?: ContractItem;
}

export interface ContractGate {
  id: string;
  trigger: string;
  requiredAction: string;
  timing: ContractGateTiming;
}

export interface TaskContractV1 {
  schemaVersion: typeof TASK_CONTRACT_SCHEMA_VERSION;
  title: string;
  outcome: ContractItem;
  audience: ContractItem[];
  authoritativeSources: ContractSource[];
  scope: {
    included: ContractItem[];
    excluded: ContractItem[];
  };
  deliverables: ContractDeliverable[];
  acceptanceCriteria: ContractItem[];
  constraints: ContractItem[];
  assumptions: ContractItem[];
  openDecisions: ContractDecision[];
  gates: ContractGate[];
}

export type ContractReadinessCheckId =
  | "title"
  | "outcome"
  | "source_strategy"
  | "deliverables"
  | "acceptance"
  | "blocking_decisions";

export interface ContractReadinessCheck {
  id: ContractReadinessCheckId;
  label: string;
  ready: boolean;
  detail: string;
}

export interface TaskContractReadiness {
  ready: boolean;
  blockerIds: string[];
  checks: ContractReadinessCheck[];
}

export interface LegacyTaskContractProjection {
  goal: string;
  acceptanceCriteria: string;
  expectedOutput: string;
}

export interface LegacyTaskFields {
  id?: string;
  title: string;
  goal?: string;
  acceptanceCriteria?: string;
  expectedOutput?: string;
}

const MAX_CONTRACT_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 240;
const MAX_ITEM_TEXT_LENGTH = 20_000;
const MAX_ID_LENGTH = 128;
const MAX_ARRAY_ITEMS = 100;
const MAX_EVIDENCE_ITEMS = 20;
const MAX_EVIDENCE_LABEL_LENGTH = 1_000;
const MAX_REFERENCE_LENGTH = 4_096;
const MAX_OPTION_LENGTH = 2_000;
const MAX_GATE_TEXT_LENGTH = 10_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const ITEM_STATUS_SET = new Set<string>(CONTRACT_ITEM_STATUSES);
const EVIDENCE_KIND_SET = new Set<string>(CONTRACT_EVIDENCE_KINDS);
const SOURCE_AVAILABILITY_SET = new Set<string>(CONTRACT_SOURCE_AVAILABILITIES);
const DELIVERABLE_KIND_SET = new Set<string>(CONTRACT_DELIVERABLE_KINDS);
const GATE_TIMING_SET = new Set<string>(CONTRACT_GATE_TIMINGS);

export class TaskContractValidationError extends Error {
  public readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "TaskContractValidationError";
    this.issues = issues;
  }
}

type UnknownRecord = Record<string, unknown>;

type ParseContext = {
  issues: string[];
  ids: Set<string>;
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function readText(
  value: unknown,
  path: string,
  ctx: ParseContext,
  maxLength: number,
  options: { optional?: boolean } = {},
): string | undefined {
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") {
    ctx.issues.push(`${path} must be a string`);
    return options.optional ? undefined : "";
  }
  const text = value.trim();
  if (!text && !options.optional) ctx.issues.push(`${path} is required`);
  if (text.length > maxLength) ctx.issues.push(`${path} is too long`);
  if (text.includes("\0")) ctx.issues.push(`${path} contains a null character`);
  return text.slice(0, maxLength);
}

function readId(value: unknown, path: string, ctx: ParseContext): string {
  const id = readText(value, path, ctx, MAX_ID_LENGTH) ?? "";
  if (id && (!ID_PATTERN.test(id) || id.length > MAX_ID_LENGTH)) {
    ctx.issues.push(`${path} has an invalid format`);
  }
  if (id) {
    if (ctx.ids.has(id)) ctx.issues.push(`${path} duplicates id '${id}'`);
    else ctx.ids.add(id);
  }
  return id;
}

function readEnum<T extends string>(value: unknown, path: string, allowed: Set<string>, fallback: T, ctx: ParseContext): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    ctx.issues.push(`${path} has an unsupported value`);
    return fallback;
  }
  return value as T;
}

function readArray(value: unknown, path: string, ctx: ParseContext): unknown[] {
  if (!Array.isArray(value)) {
    ctx.issues.push(`${path} must be an array`);
    return [];
  }
  if (value.length > MAX_ARRAY_ITEMS) ctx.issues.push(`${path} has too many items`);
  return value.slice(0, MAX_ARRAY_ITEMS);
}

function parseEvidence(value: unknown, path: string, ctx: ParseContext): ContractEvidenceRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    ctx.issues.push(`${path} must be an array`);
    return undefined;
  }
  if (value.length > MAX_EVIDENCE_ITEMS) ctx.issues.push(`${path} has too many items`);
  const evidence = value.slice(0, MAX_EVIDENCE_ITEMS).map((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(candidate)) {
      ctx.issues.push(`${itemPath} must be an object`);
      return { kind: "agent" as const, label: "Invalid evidence" };
    }
    const kind = readEnum<ContractEvidenceKind>(candidate.kind, `${itemPath}.kind`, EVIDENCE_KIND_SET, "agent", ctx);
    const label = readText(candidate.label, `${itemPath}.label`, ctx, MAX_EVIDENCE_LABEL_LENGTH) ?? "";
    const ref = readText(candidate.ref, `${itemPath}.ref`, ctx, MAX_REFERENCE_LENGTH, { optional: true });
    return { kind, label, ...(ref ? { ref } : {}) };
  });
  return evidence.length > 0 ? evidence : undefined;
}

function parseContractItem(value: unknown, path: string, ctx: ParseContext): ContractItem {
  if (!isRecord(value)) {
    ctx.issues.push(`${path} must be an object`);
    return { id: "", text: "", status: "agent_suggestion" };
  }
  const id = readId(value.id, `${path}.id`, ctx);
  const text = readText(value.text, `${path}.text`, ctx, MAX_ITEM_TEXT_LENGTH) ?? "";
  const status = readEnum<ContractItemStatus>(value.status, `${path}.status`, ITEM_STATUS_SET, "agent_suggestion", ctx);
  const evidence = parseEvidence(value.evidence, `${path}.evidence`, ctx);
  return { id, text, status, ...(evidence ? { evidence } : {}) };
}

function parseItemArray(value: unknown, path: string, ctx: ParseContext): ContractItem[] {
  return readArray(value, path, ctx).map((item, index) => parseContractItem(item, `${path}[${index}]`, ctx));
}

function parseSource(value: unknown, path: string, ctx: ParseContext): ContractSource {
  const item = parseContractItem(value, path, ctx);
  const record = isRecord(value) ? value : {};
  const availability = readEnum<ContractSourceAvailability>(
    record.availability,
    `${path}.availability`,
    SOURCE_AVAILABILITY_SET,
    "missing",
    ctx,
  );
  return { ...item, availability };
}

function parseDeliverable(value: unknown, path: string, ctx: ParseContext): ContractDeliverable {
  const item = parseContractItem(value, path, ctx);
  const record = isRecord(value) ? value : {};
  const kind = readEnum<ContractDeliverableKind>(record.kind, `${path}.kind`, DELIVERABLE_KIND_SET, "other", ctx);
  const suggestedPath = readText(record.suggestedPath, `${path}.suggestedPath`, ctx, MAX_REFERENCE_LENGTH, { optional: true });
  return { ...item, kind, ...(suggestedPath ? { suggestedPath } : {}) };
}

function parseDecision(value: unknown, path: string, ctx: ParseContext): ContractDecision {
  if (!isRecord(value)) {
    ctx.issues.push(`${path} must be an object`);
    return { id: "", question: "", blocking: true, status: "open" };
  }
  const id = readId(value.id, `${path}.id`, ctx);
  const question = readText(value.question, `${path}.question`, ctx, MAX_ITEM_TEXT_LENGTH) ?? "";
  if (typeof value.blocking !== "boolean") ctx.issues.push(`${path}.blocking must be a boolean`);
  const blocking = typeof value.blocking === "boolean" ? value.blocking : true;
  const status = value.status === "open" || value.status === "resolved"
    ? value.status
    : (ctx.issues.push(`${path}.status must be open or resolved`), "open" as const);
  let options: string[] | undefined;
  if (value.options !== undefined) {
    const parsedOptions = readArray(value.options, `${path}.options`, ctx).map((option, index) => (
      readText(option, `${path}.options[${index}]`, ctx, MAX_OPTION_LENGTH) ?? ""
    ));
    if (parsedOptions.length > 0) options = parsedOptions;
  }
  const resolution = value.resolution === undefined
    ? undefined
    : parseContractItem(value.resolution, `${path}.resolution`, ctx);
  if (status === "resolved" && !resolution?.text) ctx.issues.push(`${path}.resolution is required when resolved`);
  return {
    id,
    question,
    blocking,
    status,
    ...(options ? { options } : {}),
    ...(resolution ? { resolution } : {}),
  };
}

function parseGate(value: unknown, path: string, ctx: ParseContext): ContractGate {
  if (!isRecord(value)) {
    ctx.issues.push(`${path} must be an object`);
    return { id: "", trigger: "", requiredAction: "", timing: "during_run" };
  }
  const id = readId(value.id, `${path}.id`, ctx);
  const trigger = readText(value.trigger, `${path}.trigger`, ctx, MAX_GATE_TEXT_LENGTH) ?? "";
  const requiredAction = readText(value.requiredAction, `${path}.requiredAction`, ctx, MAX_GATE_TEXT_LENGTH) ?? "";
  const timing = readEnum<ContractGateTiming>(value.timing, `${path}.timing`, GATE_TIMING_SET, "during_run", ctx);
  return { id, trigger, requiredAction, timing };
}

export function parseTaskContract(value: unknown): TaskContractV1 {
  const issues: string[] = [];
  const ctx: ParseContext = { issues, ids: new Set<string>() };
  if (serializedBytes(value) > MAX_CONTRACT_BYTES) {
    throw new TaskContractValidationError([`contract exceeds ${MAX_CONTRACT_BYTES} bytes`]);
  }
  if (!isRecord(value)) throw new TaskContractValidationError(["contract must be an object"]);
  if (value.schemaVersion !== TASK_CONTRACT_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${TASK_CONTRACT_SCHEMA_VERSION}`);
  }

  const title = readText(value.title, "title", ctx, MAX_TITLE_LENGTH) ?? "";
  const outcome = parseContractItem(value.outcome, "outcome", ctx);
  const audience = parseItemArray(value.audience, "audience", ctx);
  const authoritativeSources = readArray(value.authoritativeSources, "authoritativeSources", ctx)
    .map((source, index) => parseSource(source, `authoritativeSources[${index}]`, ctx));

  let included: ContractItem[] = [];
  let excluded: ContractItem[] = [];
  if (!isRecord(value.scope)) {
    issues.push("scope must be an object");
  } else {
    included = parseItemArray(value.scope.included, "scope.included", ctx);
    excluded = parseItemArray(value.scope.excluded, "scope.excluded", ctx);
  }

  const deliverables = readArray(value.deliverables, "deliverables", ctx)
    .map((deliverable, index) => parseDeliverable(deliverable, `deliverables[${index}]`, ctx));
  const acceptanceCriteria = parseItemArray(value.acceptanceCriteria, "acceptanceCriteria", ctx);
  const constraints = parseItemArray(value.constraints, "constraints", ctx);
  const assumptions = parseItemArray(value.assumptions, "assumptions", ctx);
  const openDecisions = readArray(value.openDecisions, "openDecisions", ctx)
    .map((decision, index) => parseDecision(decision, `openDecisions[${index}]`, ctx));
  const gates = readArray(value.gates, "gates", ctx)
    .map((gate, index) => parseGate(gate, `gates[${index}]`, ctx));

  if (issues.length > 0) throw new TaskContractValidationError(issues);
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    title,
    outcome,
    audience,
    authoritativeSources,
    scope: { included, excluded },
    deliverables,
    acceptanceCriteria,
    constraints,
    assumptions,
    openDecisions,
    gates,
  };
}

export function checkTaskContractReadiness(contract: TaskContractV1): TaskContractReadiness {
  const blockingDecisions = contract.openDecisions.filter((decision) => decision.blocking && decision.status === "open");
  const hasSourceStrategy = contract.authoritativeSources.some((source) => (
    source.availability === "available"
    || source.availability === "discover_during_run"
    || source.availability === "not_applicable"
  ));
  const checks: ContractReadinessCheck[] = [
    {
      id: "title",
      label: "任务标题",
      ready: contract.title.trim().length > 0,
      detail: contract.title.trim() ? "已明确" : "尚未明确",
    },
    {
      id: "outcome",
      label: "要解决的问题",
      ready: contract.outcome.text.trim().length > 0,
      detail: contract.outcome.text.trim() ? "已明确" : "尚未明确",
    },
    {
      id: "source_strategy",
      label: "权威来源",
      ready: hasSourceStrategy,
      detail: hasSourceStrategy ? "已有来源或可接受的来源策略" : "仍缺权威来源策略",
    },
    {
      id: "deliverables",
      label: "预期交付",
      ready: contract.deliverables.some((item) => item.text.trim().length > 0),
      detail: contract.deliverables.length > 0 ? "已明确" : "尚未明确",
    },
    {
      id: "acceptance",
      label: "验收方法",
      ready: contract.acceptanceCriteria.some((item) => item.text.trim().length > 0),
      detail: contract.acceptanceCriteria.length > 0 ? "已明确" : "尚未明确",
    },
    {
      id: "blocking_decisions",
      label: "阻塞决定",
      ready: blockingDecisions.length === 0,
      detail: blockingDecisions.length === 0 ? "没有未解决的阻塞决定" : `还需决定 ${blockingDecisions.length} 项`,
    },
  ];
  return {
    ready: checks.every((check) => check.ready),
    blockerIds: blockingDecisions.map((decision) => decision.id),
    checks,
  };
}

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function projectTaskContractToLegacyFields(contract: TaskContractV1): LegacyTaskContractProjection {
  const audience = contract.audience.map((item) => item.text).filter(Boolean);
  const goal = [
    contract.outcome.text,
    audience.length > 0 ? `受众与用途：\n${bulletList(audience)}` : "",
  ].filter(Boolean).join("\n\n");
  const acceptanceCriteria = bulletList(contract.acceptanceCriteria.map((item) => item.text).filter(Boolean));
  const expectedOutput = bulletList(contract.deliverables.map((item) => (
    item.suggestedPath ? `${item.text}（建议路径：${item.suggestedPath}）` : item.text
  )).filter(Boolean));
  return {
    goal: truncate(goal, 100_000),
    acceptanceCriteria: truncate(acceptanceCriteria, 100_000),
    expectedOutput: truncate(expectedOutput, 4_096),
  };
}

function legacyItem(id: string, text: string, taskId?: string): ContractItem {
  return {
    id,
    text,
    status: "assumption",
    evidence: [{
      kind: "task",
      label: "从旧版 Task 字段导入，尚未按丰富任务约定重新确认",
      ...(taskId ? { ref: taskId } : {}),
    }],
  };
}

export function createLegacyTaskContractCandidate(fields: LegacyTaskFields): TaskContractV1 {
  const title = fields.title.trim() || "待补全任务约定";
  const goal = fields.goal?.trim() || "待确认要解决的问题";
  const acceptance = fields.acceptanceCriteria?.trim();
  const output = fields.expectedOutput?.trim();
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    title,
    outcome: legacyItem("legacy-outcome", goal, fields.id),
    audience: [],
    authoritativeSources: [{
      ...legacyItem("legacy-source", "尚未记录权威来源策略", fields.id),
      availability: "missing",
    }],
    scope: { included: [], excluded: [] },
    deliverables: output ? [{
      ...legacyItem("legacy-deliverable", output, fields.id),
      kind: "other",
    }] : [],
    acceptanceCriteria: acceptance ? [legacyItem("legacy-acceptance", acceptance, fields.id)] : [],
    constraints: [],
    assumptions: [],
    openDecisions: [{
      id: "legacy-source-decision",
      question: "本任务的事实、数据或规则以什么为准？",
      blocking: true,
      status: "open",
    }],
    gates: [],
  };
}
