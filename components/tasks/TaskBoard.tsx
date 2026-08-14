"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkTaskContractReadiness, type TaskContractV1 } from "@/lib/task/contract";
import type { DelegationProfile, DelegationStatus, EventRecord, ProjectRecord, ReviewStatus, RunStatus, TaskDetail, TaskRecord, TaskStatus } from "@/lib/task/types";
import { findMostSpecificWorkspace, workspaceDisplayName } from "@/lib/workspace-path";
import styles from "./TaskBoard.module.css";

const COLUMNS: Array<{ status: TaskStatus; label: string; hint: string }> = [
  { status: "backlog", label: "积压事项", hint: "尚未准备执行" },
  { status: "ready", label: "待办事项", hint: "可以交给 Pi" },
  { status: "in_progress", label: "进行中", hint: "Pi 正在处理" },
  { status: "in_review", label: "待验收", hint: "等待你的判断" },
  { status: "blocked", label: "已阻塞", hint: "缺少条件" },
  { status: "done", label: "完成", hint: "已由用户验收" },
  { status: "canceled", label: "已取消", hint: "不再继续" },
];

const STATUS_LABEL = Object.fromEntries(COLUMNS.map((column) => [column.status, column.label])) as Record<TaskStatus, string>;
const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  starting: "准备中",
  running: "执行中",
  waiting_user: "等待用户",
  succeeded: "执行成功",
  failed: "执行失败",
  interrupted: "已中断",
  canceled: "已取消",
};
const DELEGATION_PROFILE_LABELS: Record<DelegationProfile, string> = {
  scout: "资料侦察",
  analyst: "独立分析",
  critic: "反向审查",
};
const DELEGATION_STATUS_LABELS: Record<DelegationStatus, string> = {
  running: "分析中",
  succeeded: "已完成",
  failed: "失败",
  interrupted: "已中断",
  canceled: "已取消",
};
const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  submitted: "待验收",
  accepted: "已验收",
  rejected: "已退回",
};
const LIFECYCLE_COPY: Record<LifecycleAction, { label: string; prompt: string; confirm: string }> = {
  block: { label: "阻塞原因", prompt: "具体说明缺少什么条件或需要谁决定", confirm: "确认标记阻塞" },
  unblock: { label: "解除说明", prompt: "说明条件已如何解决，以及下一轮需要注意什么", confirm: "解除阻塞并回到待办" },
  cancel: { label: "取消原因", prompt: "说明为什么不再继续，记录会保留", confirm: "确认取消任务" },
};

type PreparedSession = {
  taskId: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  reused: boolean;
};

type LifecycleAction = "block" | "unblock" | "cancel";
type QueueStatus = "backlog" | "ready";
type ContractFields = {
  title: string;
  goal: string;
  acceptanceCriteria: string;
  expectedOutput: string;
};
type ContractEditor = ContractFields & { taskId: string; version: number; status: QueueStatus };

const CONTRACT_FIELD_LABELS: Record<keyof ContractFields, string> = {
  title: "任务标题",
  goal: "目标",
  acceptanceCriteria: "验收条件",
  expectedOutput: "预期产物",
};

function missingContractFields(contract: ContractFields & { contract?: TaskContractV1 | null }): string[] {
  if (contract.contract) {
    return checkTaskContractReadiness(contract.contract).checks
      .filter((check) => !check.ready)
      .map((check) => check.label);
  }
  return (Object.keys(CONTRACT_FIELD_LABELS) as Array<keyof ContractFields>)
    .filter((field) => !contract[field].trim())
    .map((field) => CONTRACT_FIELD_LABELS[field]);
}

function contractEventSummary(event: EventRecord): string {
  if (event.type === "task.contract_saved") return `任务约定草稿已保存 · revision ${String(event.payload.contractRevision ?? "-")}`;
  if (event.type === "task.contract_confirmed") return `任务约定已由用户确认 · revision ${String(event.payload.contractRevision ?? "-")}`;
  const fields = Array.isArray(event.payload.fields) ? event.payload.fields : [];
  const labels = fields
    .filter((field): field is keyof ContractFields => typeof field === "string" && field in CONTRACT_FIELD_LABELS)
    .map((field) => CONTRACT_FIELD_LABELS[field]);
  return labels.length > 0 ? `已更新：${labels.join("、")}` : "已更新任务合同";
}

type Props = {
  activeCwd: string | null;
  workspaceRoot: string | null;
  onStartTaskConversation: () => void;
  onProcessTask: (task: TaskDetail, session: PreparedSession) => void;
  onFrameTask: (task: TaskDetail, session: PreparedSession) => void;
  onOpenFile: (filePath: string) => void;
  onTaskChanged?: (task: TaskDetail) => void;
};

type ApiErrorBody = { error?: { message?: string } | string };

async function readApi<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & ApiErrorBody;
  if (!response.ok) {
    const error = typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(error || `HTTP ${response.status}`);
  }
  return body;
}

function eventText(event: EventRecord, key: string): string | null {
  const value = event.payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function taskPrompt(task: TaskDetail): string {
  return [
    `请处理 Pi Task：${task.title}`,
    `任务 ID：${task.id}`,
    "",
    `目标：${task.goal}`,
    `验收条件：${task.acceptanceCriteria}`,
    `预期产物：${task.expectedOutput}`,
    task.recoveryNote ? `本轮补充要求：${task.recoveryNote}` : "",
    "",
    "开始前请先读取任务；完成并验证真实产物后，使用 submit_task_review 提交给我验收，不要自行标记完成。",
  ].filter(Boolean).join("\n");
}

function contractItems(items: ReadonlyArray<{ text: string }>, fallback = "尚未记录"): string {
  const values = items.map((item) => item.text.trim()).filter(Boolean);
  return values.length > 0 ? values.join("；") : fallback;
}

function RichTaskContractSummary({ task }: { task: TaskDetail }) {
  const contract = task.contract;
  if (!contract) return null;
  const readiness = checkTaskContractReadiness(contract);
  const missingChecks = readiness.checks.filter((check) => !check.ready);
  const blocking = contract.openDecisions.filter((decision) => decision.blocking && decision.status === "open");
  const boundary = [
    ...contract.scope.excluded.map((item) => `不包含：${item.text}`),
    ...contract.constraints.map((item) => `约束：${item.text}`),
    ...contract.gates.map((gate) => `确认门：${gate.trigger} → ${gate.requiredAction}`),
  ];
  return (
    <section className={styles.richContractSummary}>
      <header className={styles.richContractHeader}>
        <div><span>TASK AGREEMENT</span><strong>任务约定 · R{task.contractRevision}</strong></div>
        <span data-ready={readiness.ready}>{readiness.ready ? "足够开始" : `还需补全 ${missingChecks.length} 项`}</span>
      </header>
      <p className={styles.richContractOutcome}>{contract.outcome.text}</p>
      <dl className={styles.richContractGrid}>
        <div><dt>受众与用途</dt><dd>{contractItems(contract.audience)}</dd></div>
        <div><dt>权威来源</dt><dd>{contractItems(contract.authoritativeSources)}</dd></div>
        <div><dt>预期交付</dt><dd>{contractItems(contract.deliverables)}</dd></div>
        <div><dt>验收方法</dt><dd>{contractItems(contract.acceptanceCriteria)}</dd></div>
      </dl>
      {blocking.length > 0 && <div className={styles.richContractDecision}><strong>待决定</strong><span>{blocking.map((decision) => decision.question).join("；")}</span></div>}
      {boundary.length > 0 && <details className={styles.richContractBoundary}><summary>查看范围、约束与确认门</summary><ul>{boundary.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></details>}
    </section>
  );
}

export function TaskBoard({ activeCwd, workspaceRoot, onStartTaskConversation, onProcessTask, onFrameTask, onOpenFile, onTaskChanged }: Props) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contractEditor, setContractEditor] = useState<ContractEditor | null>(null);
  const [saving, setSaving] = useState(false);
  const [processingTaskId, setProcessingTaskId] = useState<string | null>(null);
  const [framingTaskId, setFramingTaskId] = useState<string | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState("");
  const [returnOpen, setReturnOpen] = useState(false);
  const [lifecycleAction, setLifecycleAction] = useState<LifecycleAction | null>(null);
  const [lifecycleReason, setLifecycleReason] = useState("");
  const draggedTaskIdRef = useRef<string | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const autoFocusedProjectRef = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ status: TaskStatus; beforeTaskId: string | null } | null>(null);

  const loadProjects = useCallback(async () => {
    const { projects: loaded } = await readApi<{ projects: ProjectRecord[] }>(await fetch("/api/projects", { cache: "no-store" }));
    setProjects(loaded);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadProjects()
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadProjects]);

  const activeProject = useMemo(
    () => findMostSpecificWorkspace(projects, activeCwd)
      ?? findMostSpecificWorkspace(projects, workspaceRoot),
    [activeCwd, projects, workspaceRoot],
  );
  const projectId = activeProject?.id ?? null;

  const loadTasks = useCallback(async (selectedProjectId: string) => {
    const { tasks: loaded } = await readApi<{ tasks: TaskRecord[] }>(
      await fetch(`/api/tasks?projectId=${encodeURIComponent(selectedProjectId)}`, { cache: "no-store" }),
    );
    setTasks(loaded);
    setSelectedTask((current) => current && loaded.some((task) => task.id === current.id) ? current : null);
  }, []);

  useEffect(() => {
    setSelectedTask(null);
    if (!projectId) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadTasks(projectId)
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadTasks, projectId]);

  const groupedTasks = useMemo(() => {
    const groups: Record<TaskStatus, TaskRecord[]> = {
      backlog: [],
      ready: [],
      in_progress: [],
      in_review: [],
      blocked: [],
      done: [],
      canceled: [],
    };
    for (const task of tasks) groups[task.status].push(task);
    for (const list of Object.values(groups)) list.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
    return groups;
  }, [tasks]);

  useEffect(() => {
    if (!projectId || loading || tasks.length === 0 || autoFocusedProjectRef.current === projectId) return;
    const focusOrder: TaskStatus[] = ["in_review", "in_progress", "ready", "backlog", "blocked", "done", "canceled"];
    const status = focusOrder.find((candidate) => groupedTasks[candidate].length > 0);
    if (!status) return;
    autoFocusedProjectRef.current = projectId;
    const frame = window.requestAnimationFrame(() => {
      const board = boardRef.current;
      const column = board?.querySelector<HTMLElement>(`[data-status="${status}"]`);
      if (!board || !column) return;
      const left = Math.max(0, column.offsetLeft - Math.max(10, (board.clientWidth - column.clientWidth) / 2));
      board.scrollTo({ left, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [groupedTasks, loading, projectId, tasks.length]);

  async function openTask(taskId: string) {
    setError(null);
    try {
      const { task } = await readApi<{ task: TaskDetail }>(await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { cache: "no-store" }));
      setSelectedTask(task);
      setReturnOpen(false);
      setReturnReason("");
      setLifecycleAction(null);
      setLifecycleReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const refreshSelectedTask = useCallback(async (taskId: string) => {
    try {
      const { task } = await readApi<{ task: TaskDetail }>(await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { cache: "no-store" }));
      setSelectedTask((current) => current?.id === taskId ? task : current);
      onTaskChanged?.(task);
    } catch {
      // Keep the last known detail visible while a temporary refresh fails.
    }
  }, [onTaskChanged]);

  useEffect(() => {
    const taskId = selectedTask?.id;
    if (!taskId || !selectedTask.activeRunId) return;
    void refreshSelectedTask(taskId);
    const interval = window.setInterval(() => void refreshSelectedTask(taskId), 1_500);
    return () => window.clearInterval(interval);
  }, [refreshSelectedTask, selectedTask?.activeRunId, selectedTask?.id]);

  function openContractEditor(task: TaskDetail) {
    if (task.status !== "backlog" && task.status !== "ready") return;
    setError(null);
    setContractEditor({
      taskId: task.id,
      version: task.version,
      status: task.status,
      title: task.title,
      goal: task.goal,
      acceptanceCriteria: task.acceptanceCriteria,
      expectedOutput: task.expectedOutput,
    });
  }

  async function saveContract(event: React.FormEvent) {
    event.preventDefault();
    if (!contractEditor || saving) return;
    const missing = missingContractFields(contractEditor);
    if (contractEditor.status === "ready" && missing.length > 0) {
      setError(`待办事项必须完整；还缺${missing.join("、")}`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { task } = await readApi<{ task: TaskDetail }>(await fetch(`/api/tasks/${encodeURIComponent(contractEditor.taskId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(contractEditor),
      }));
      setContractEditor(null);
      setSelectedTask(task);
      onTaskChanged?.(task);
      if (projectId) await loadTasks(projectId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function frameTask(task: TaskRecord | TaskDetail) {
    if ((task.status !== "backlog" && task.status !== "ready") || task.activeRunId || framingTaskId) return;
    setFramingTaskId(task.id);
    setError(null);
    try {
      const result = await readApi<{ task: TaskDetail; session: PreparedSession }>(await fetch(`/api/tasks/${encodeURIComponent(task.id)}/framing-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: task.version }),
      }));
      onTaskChanged?.(result.task);
      onFrameTask(result.task, result.session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (projectId) void loadTasks(projectId);
    } finally {
      setFramingTaskId(null);
    }
  }

  async function processTask(task: TaskRecord | TaskDetail) {
    if (task.status !== "ready" || processingTaskId) return;
    const missing = missingContractFields(task);
    if (missing.length > 0) {
      setError(`任务合同还缺${missing.join("、")}，补全前不能交给 Pi`);
      return;
    }
    setProcessingTaskId(task.id);
    setError(null);
    try {
      const detail = "project" in task
        ? task
        : (await readApi<{ task: TaskDetail }>(await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { cache: "no-store" }))).task;
      const { session } = await readApi<{ session: PreparedSession }>(await fetch(`/api/tasks/${encodeURIComponent(task.id)}/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: task.version }),
      }));
      onProcessTask(detail, session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProcessingTaskId(null);
    }
  }

  async function reviewAction(action: "accept" | "return") {
    if (!selectedTask || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { task } = await readApi<{ task: TaskDetail }>(await fetch(`/api/tasks/${encodeURIComponent(selectedTask.id)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: selectedTask.version, action, ...(action === "return" ? { reason: returnReason } : {}) }),
      }));
      setSelectedTask(task);
      onTaskChanged?.(task);
      setReturnOpen(false);
      setReturnReason("");
      if (projectId) await loadTasks(projectId);
      if (action === "return") await processTask(task);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function runLifecycleAction() {
    if (!selectedTask || !lifecycleAction || !lifecycleReason.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { task } = await readApi<{ task: TaskDetail }>(await fetch(`/api/tasks/${encodeURIComponent(selectedTask.id)}/lifecycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: lifecycleAction, version: selectedTask.version, reason: lifecycleReason }),
      }));
      setSelectedTask(task);
      onTaskChanged?.(task);
      setLifecycleAction(null);
      setLifecycleReason("");
      if (projectId) await loadTasks(projectId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  function orderForDrop(status: "backlog" | "ready", beforeTaskId: string | null, sourceTaskId: string): number {
    const target = groupedTasks[status].filter((task) => task.id !== sourceTaskId);
    const index = beforeTaskId ? target.findIndex((task) => task.id === beforeTaskId) : target.length;
    const insertionIndex = index < 0 ? target.length : index;
    const previous = target[insertionIndex - 1];
    const next = target[insertionIndex];
    if (previous && next) return (previous.sortOrder + next.sortOrder) / 2;
    if (previous) return previous.sortOrder + 1024;
    if (next) return next.sortOrder - 1024;
    return 1024;
  }

  async function moveQueuedTask(sourceTask: TaskRecord | TaskDetail, status: QueueStatus, beforeTaskId: string | null = null) {
    const source = tasks.find((task) => task.id === sourceTask.id) ?? sourceTask;
    if (source.status !== "backlog" && source.status !== "ready") {
      setError("只有积压事项和待办事项可以调整队列");
      return;
    }
    const missing = missingContractFields(source);
    if (status === "ready" && missing.length > 0) {
      setError(`还缺${missing.join("、")}；补全合同后才能移到待办事项`);
      return;
    }
    const sortOrder = orderForDrop(status, beforeTaskId, source.id);
    const previous = tasks;
    setMovingTaskId(source.id);
    setTasks((current) => current.map((task) => task.id === source.id ? { ...task, status, sortOrder } : task));
    try {
      const { task } = await readApi<{ task: TaskRecord }>(await fetch(`/api/tasks/${encodeURIComponent(source.id)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: source.version, status, sortOrder }),
      }));
      setTasks((current) => current.map((candidate) => candidate.id === task.id ? task : candidate));
      setSelectedTask((current) => current?.id === task.id ? { ...current, ...task } : current);
      if (selectedTask?.id === task.id) await refreshSelectedTask(task.id);
    } catch (cause) {
      setTasks(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
      if (projectId) void loadTasks(projectId);
    } finally {
      setMovingTaskId(null);
    }
  }

  async function finishDrop(status: TaskStatus, beforeTaskId: string | null) {
    const sourceTaskId = draggedTaskIdRef.current;
    draggedTaskIdRef.current = null;
    setDropTarget(null);
    if (!sourceTaskId) return;
    const source = tasks.find((task) => task.id === sourceTaskId);
    if (!source) return;
    if (status === "in_progress" && source.status === "ready") {
      await processTask(source);
      return;
    }
    if ((status !== "backlog" && status !== "ready") || (source.status !== "backlog" && source.status !== "ready")) {
      setError("这个移动包含业务动作，不能只改看板状态");
      return;
    }
    await moveQueuedTask(source, status, beforeTaskId);
  }

  const activeWorkspaceName = activeCwd ? workspaceDisplayName(activeCwd) : null;
  const selectedActiveRun = selectedTask?.activeRunId
    ? selectedTask.runs.find((run) => run.id === selectedTask.activeRunId) ?? null
    : null;
  const selectedStatusLabel = selectedActiveRun?.status === "waiting_user"
    ? "等待你的决定"
    : selectedTask
      ? STATUS_LABEL[selectedTask.status]
      : "";
  const decisionEvents = selectedTask?.events.filter((event) => (
    event.type === "run.waiting_user" || event.type === "run.resumed"
  )) ?? [];
  const lifecycleEvents = selectedTask?.events.filter((event) => (
    event.type === "task.blocked" || event.type === "task.unblocked" || event.type === "task.canceled"
  )) ?? [];
  const contractEvents = selectedTask?.events.filter((event) => (
    event.type === "task.contract_updated"
    || event.type === "task.contract_saved"
    || event.type === "task.contract_confirmed"
  )) ?? [];
  const waitingQuestion = selectedActiveRun?.status === "waiting_user"
    ? [...decisionEvents].reverse().find((event) => event.type === "run.waiting_user" && event.runId === selectedActiveRun.id)
    : null;
  const contractEditorMissing = contractEditor ? missingContractFields(contractEditor) : [];
  const selectedContractMissing = selectedTask ? missingContractFields(selectedTask) : [];
  const selectedQueueStatus: QueueStatus | null = selectedTask?.status === "backlog" || selectedTask?.status === "ready"
    ? selectedTask.status
    : null;
  const selectedQueueTasks = selectedQueueStatus ? groupedTasks[selectedQueueStatus] : [];
  const selectedQueueIndex = selectedTask ? selectedQueueTasks.findIndex((task) => task.id === selectedTask.id) : -1;

  return (
    <section className={styles.shell} aria-label="Pi Task 任务面板">
      <header className={styles.toolbar}>
        <div className={styles.productTitle}>
          <span className={styles.piMark}>π</span>
          <div>
            <strong>Pi Task</strong>
            <span title={activeCwd ?? undefined}>{activeWorkspaceName ? `当前工作目录 · ${activeWorkspaceName}` : "先从左侧选择工作目录"}</span>
          </div>
        </div>
        <div className={styles.toolbarActions}>
          <button className={styles.primaryButton} disabled={!activeCwd} onClick={onStartTaskConversation}>开始聊一个任务</button>
        </div>
      </header>

      {error && <div className={styles.errorBanner} role="alert"><span>{error}</span><button onClick={() => setError(null)}>关闭</button></div>}

      <div className={styles.content}>
        {!loading && activeCwd && !activeProject ? (
          <div className={styles.workspaceEmpty}>
            <span>当前工作目录</span>
            <strong>{activeWorkspaceName}</strong>
            <p>这里还没有正式任务。先在对话里把事情聊清楚；只有你保存或确认任务约定后，任务才会出现在看板中。</p>
            <button className={styles.primaryButton} onClick={onStartTaskConversation}>开始聊一个任务</button>
          </div>
        ) : !activeCwd ? (
          <div className={styles.workspaceEmpty}>
            <strong>先选择工作目录</strong>
            <p>对话、文件和任务看板会共同使用这一处工作范围。</p>
          </div>
        ) : (
        <div ref={boardRef} className={styles.board} aria-label="任务状态栏，可横向滚动">
          {COLUMNS.map((column) => {
            const canReceiveQueue = column.status === "backlog" || column.status === "ready";
            const canReceiveStart = column.status === "in_progress";
            const targeted = dropTarget?.status === column.status;
            return (
              <section
                className={`${styles.column} ${targeted ? styles.dropColumn : ""}`}
                key={column.status}
                data-status={column.status}
                onDragOver={(event) => {
                  const source = tasks.find((task) => task.id === draggedTaskIdRef.current);
                  if (!source) return;
                  const complete = missingContractFields(source).length === 0;
                  const valid = (canReceiveQueue && (source.status === "backlog" || source.status === "ready") && (column.status !== "ready" || complete))
                    || (canReceiveStart && source.status === "ready" && complete);
                  if (!valid) return;
                  event.preventDefault();
                  if (event.target === event.currentTarget || !(event.target as HTMLElement).closest(`.${styles.card}`)) {
                    setDropTarget({ status: column.status, beforeTaskId: null });
                  }
                }}
                onDrop={(event) => { event.preventDefault(); void finishDrop(column.status, dropTarget?.status === column.status ? dropTarget.beforeTaskId : null); }}
              >
                <header className={styles.columnHeader}>
                  <span className={`${styles.statusDot} ${styles[column.status]}`} />
                  <div><strong>{column.label}</strong><small>{column.hint}</small></div>
                  <span className={styles.count}>{groupedTasks[column.status].length}</span>
                </header>
                <div className={styles.cardList}>
                  {groupedTasks[column.status].map((task) => {
                    const draggable = task.status === "backlog" || task.status === "ready";
                    const contractMissing = missingContractFields(task);
                    const contractComplete = contractMissing.length === 0;
                    const before = targeted && dropTarget?.beforeTaskId === task.id;
                    return (
                      <article
                        key={task.id}
                        className={`${styles.card} ${before ? styles.beforeCard : ""}`}
                        draggable={draggable}
                        onDragStart={(event) => {
                          draggedTaskIdRef.current = task.id;
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", task.id);
                          event.currentTarget.classList.add(styles.dragging);
                        }}
                        onDragEnd={(event) => {
                          event.currentTarget.classList.remove(styles.dragging);
                          draggedTaskIdRef.current = null;
                          setDropTarget(null);
                        }}
                        onDragOver={(event) => {
                          const source = tasks.find((candidate) => candidate.id === draggedTaskIdRef.current);
                          if (!source) return;
                          const complete = missingContractFields(source).length === 0;
                          if (canReceiveStart && source.status === "ready" && complete) {
                            event.preventDefault();
                            event.stopPropagation();
                            setDropTarget({ status: column.status, beforeTaskId: null });
                            return;
                          }
                          if (!canReceiveQueue || (source.status !== "backlog" && source.status !== "ready") || (column.status === "ready" && !complete)) return;
                          event.preventDefault();
                          event.stopPropagation();
                          const rect = event.currentTarget.getBoundingClientRect();
                          const beforeTaskId = event.clientY < rect.top + rect.height / 2 ? task.id : null;
                          setDropTarget({ status: column.status, beforeTaskId });
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void finishDrop(column.status, dropTarget?.beforeTaskId ?? null);
                        }}
                        onClick={() => void openTask(task.id)}
                      >
                        <div className={styles.cardTop}><span>{task.id.slice(0, 12)}</span>{task.primarySessionId && <span title="已绑定 Pi 对话">对话 ↗</span>}</div>
                        <h3>{task.title}</h3>
                        <p>{task.contract?.outcome.text || task.goal || "尚未补充目标"}</p>
                        {task.contract && <div className={styles.richContractBadge}>任务约定 R{task.contractRevision} · {contractComplete ? "足够开始" : "仍有阻塞项"}</div>}
                        {contractMissing.length > 0 && <div className={styles.contractGap}>还缺：{contractMissing.join("、")}</div>}
                        {task.recoveryNote && <div className={styles.recovery}>需继续：{task.recoveryNote}</div>}
                        <footer>
                          <span>{STATUS_LABEL[task.status]}</span>
                          {task.status === "backlog" && <button disabled={framingTaskId === task.id} onClick={(event) => { event.stopPropagation(); void frameTask(task); }}>{framingTaskId === task.id ? "准备中…" : "和 Pi 一起补全"}</button>}
                          {task.status === "ready" && (contractComplete
                            ? <button disabled={processingTaskId === task.id} title="在对话中处理" onClick={(event) => { event.stopPropagation(); void processTask(task); }}>{processingTaskId === task.id ? "准备中…" : "在对话中处理"}</button>
                            : <button disabled={framingTaskId === task.id} title={`还缺${contractMissing.join("、")}`} onClick={(event) => { event.stopPropagation(); void frameTask(task); }}>{framingTaskId === task.id ? "准备中…" : "和 Pi 一起补全"}</button>)}
                        </footer>
                      </article>
                    );
                  })}
                  {groupedTasks[column.status].length === 0 && <div className={styles.emptyColumn}>{column.status === "in_progress" ? "把待办拖到这里，可进入 Pi 对话" : "暂无任务"}</div>}
                </div>
              </section>
            );
          })}
        </div>
        )}

        {selectedTask && (
          <aside className={styles.detail} aria-label="任务详情">
            <header><div><span>{selectedTask.id}</span><h2>{selectedTask.title}</h2></div><button onClick={() => setSelectedTask(null)} aria-label="关闭详情">×</button></header>
            <div className={styles.detailBody}>
              <div className={styles.detailStatus}><span className={`${styles.statusDot} ${styles[selectedTask.status]}`} /><span className={selectedActiveRun?.status === "waiting_user" ? styles.waitingStatus : undefined}>{selectedStatusLabel}</span><small>v{selectedTask.version}</small></div>
              {selectedTask.recoveryNote && <section className={`${styles.callout} ${selectedTask.status === "blocked" ? styles.blockedCallout : ""}`}><strong>{selectedTask.status === "blocked" ? "阻塞原因" : "最新补充/恢复要求"}</strong><p>{selectedTask.recoveryNote}</p></section>}
              {selectedActiveRun?.status === "waiting_user" && <section className={`${styles.callout} ${styles.waitingCallout}`}><strong>Pi 正在等待你的决定</strong><p>{waitingQuestion ? eventText(waitingQuestion, "question") : "请回到当前对话补充必要信息；收到后 Pi 会继续本轮工作。"}</p></section>}
              {selectedQueueStatus && selectedContractMissing.length > 0 && <section className={`${styles.callout} ${styles.contractCallout}`}><strong>合同待补全</strong><p>还缺：{selectedContractMissing.join("、")}。回到主对话补全并重新确认前，不能移入待办事项或交给 Pi。</p></section>}
              {selectedTask.contract ? <RichTaskContractSummary task={selectedTask} /> : <>
                <section><h3>目标</h3><p>{selectedTask.goal || "尚未填写"}</p></section>
                <section><h3>验收条件</h3><p>{selectedTask.acceptanceCriteria || "尚未填写"}</p></section>
                <section><h3>预期产物</h3><p>{selectedTask.expectedOutput || "尚未填写"}</p></section>
              </>}
              {selectedQueueStatus && <section className={styles.queueControls}><h3>合同与队列</h3><div className={styles.queueControlRow}><button className={styles.primaryButton} disabled={saving || movingTaskId === selectedTask.id || framingTaskId === selectedTask.id} onClick={() => void frameTask(selectedTask)}>{framingTaskId === selectedTask.id ? "准备对话中…" : selectedTask.contract ? "回到对话修改" : "和 Pi 一起补全"}</button>{!selectedTask.contract && <button className={styles.secondaryButton} disabled={saving || movingTaskId === selectedTask.id} title="临时保留的旧字段回退入口" onClick={() => openContractEditor(selectedTask)}>直接编辑旧字段</button>}{selectedQueueStatus === "backlog" ? <button className={styles.secondaryButton} disabled={saving || movingTaskId === selectedTask.id || selectedContractMissing.length > 0} title={selectedContractMissing.length > 0 ? `还缺${selectedContractMissing.join("、")}` : "移到待办事项"} onClick={() => void moveQueuedTask(selectedTask, "ready")}>移到待办</button> : <button className={styles.secondaryButton} disabled={saving || movingTaskId === selectedTask.id} onClick={() => void moveQueuedTask(selectedTask, "backlog")}>移回积压</button>}</div><div className={styles.queueControlRow}><button className={styles.secondaryButton} disabled={saving || movingTaskId === selectedTask.id || selectedQueueIndex <= 0} onClick={() => void moveQueuedTask(selectedTask, selectedQueueStatus, selectedQueueTasks[selectedQueueIndex - 1]?.id ?? null)}>上移</button><button className={styles.secondaryButton} disabled={saving || movingTaskId === selectedTask.id || selectedQueueIndex < 0 || selectedQueueIndex >= selectedQueueTasks.length - 1} onClick={() => void moveQueuedTask(selectedTask, selectedQueueStatus, selectedQueueTasks[selectedQueueIndex + 2]?.id ?? null)}>下移</button></div><p className={styles.queueControlNote}>触屏或无法拖拽时，可用这些按钮调整状态和同列顺序。旧字段编辑暂作回退，不会替代任务约定。</p></section>}
              {contractEvents.length > 0 && <section><h3>合同记录</h3><div className={styles.decisionList}>{contractEvents.map((event) => <div key={event.id}><strong>已更新合同</strong><p>{contractEventSummary(event)}</p><small>v{event.taskVersion}</small></div>)}</div></section>}
              {selectedTask.runs.length > 0 && <section><h3>执行记录</h3><div className={styles.recordList}>{selectedTask.runs.map((run, index) => <div key={run.id}><strong>第 {index + 1} 次执行</strong><span className={styles.recordStatus} data-status={run.status}>{RUN_STATUS_LABELS[run.status]}</span><small>{run.sessionId ? `对话 ${run.sessionId.slice(0, 8)}` : "尚未绑定对话"}</small></div>)}</div></section>}
              {selectedTask.delegations.length > 0 && <section><h3>多 Agent 协作记录</h3><div className={styles.delegationList}>{selectedTask.delegations.map((delegation) => <details key={delegation.id}><summary><span><strong>{DELEGATION_PROFILE_LABELS[delegation.profile]}</strong><small>{delegation.model}</small></span><span className={styles.recordStatus} data-status={delegation.status}>{DELEGATION_STATUS_LABELS[delegation.status]}</span></summary><p>{delegation.prompt.split("Delegated focus:\n").at(-1)}</p>{delegation.output && <pre>{delegation.output}</pre>}{delegation.error && <small className={styles.delegationError}>{delegation.error}</small>}<footer><span>{delegation.usage.totalTokens.toLocaleString()} tokens</span>{delegation.usage.cost > 0 && <span>${delegation.usage.cost.toFixed(4)}</span>}</footer></details>)}</div></section>}
              {decisionEvents.length > 0 && <section><h3>人工决定记录</h3><div className={styles.decisionList}>{decisionEvents.map((event) => <div key={event.id}><strong>{event.type === "run.waiting_user" ? "Pi 请求补充" : "已提供决定"}</strong><p>{event.type === "run.waiting_user" ? eventText(event, "question") : eventText(event, "answer") || "用户确认继续，但未填写额外说明"}</p><small>{event.runId ? `Run ${event.runId.slice(4, 12)}` : ""}</small></div>)}</div></section>}
              {lifecycleEvents.length > 0 && <section><h3>状态记录</h3><div className={styles.decisionList}>{lifecycleEvents.map((event) => <div key={event.id}><strong>{event.type === "task.blocked" ? "已标记阻塞" : event.type === "task.unblocked" ? "已解除阻塞" : "已取消任务"}</strong><p>{eventText(event, event.type === "task.unblocked" ? "resolution" : "reason")}</p></div>)}</div></section>}
              {selectedTask.artifacts.length > 0 && <section><h3>交付物</h3><div className={styles.artifactList}>{selectedTask.artifacts.map((artifact) => <button key={artifact.id} onClick={() => onOpenFile(artifact.path)}><span>{artifact.path.split(/[\\/]/).pop()}</span><small>{artifact.verification}</small></button>)}</div></section>}
              {selectedTask.reviews.length > 0 && <section><h3>验收记录</h3><div className={styles.reviewList}>{selectedTask.reviews.map((review) => <div key={review.id}><div><strong>{review.summary}</strong><span className={styles.recordStatus} data-status={review.status}>{REVIEW_STATUS_LABELS[review.status]}</span></div><p>{review.verification}</p>{review.risks && <small>风险：{review.risks}</small>}{review.rejectionReason && <small>退回：{review.rejectionReason}</small>}</div>)}</div></section>}
            </div>
            <footer className={styles.detailActions}>
              {!returnOpen && !lifecycleAction && <>
                {selectedQueueStatus && <button className={styles.secondaryButton} disabled={framingTaskId === selectedTask.id} onClick={() => void frameTask(selectedTask)}>{framingTaskId === selectedTask.id ? "准备对话中…" : selectedTask.contract ? "回到对话修改" : "和 Pi 一起补全"}</button>}
                {selectedTask.status === "ready" && selectedContractMissing.length === 0 && <button className={styles.primaryButton} disabled={processingTaskId === selectedTask.id} title="在对话中处理" onClick={() => void processTask(selectedTask)}>{processingTaskId === selectedTask.id ? "准备对话中…" : "在对话中处理"}</button>}
                {selectedTask.status === "in_review" && <><button className={styles.secondaryButton} onClick={() => { setLifecycleAction(null); setReturnOpen(true); }}>退回修改</button><button className={styles.primaryButton} disabled={saving} onClick={() => void reviewAction("accept")}>验收通过</button></>}
                {(selectedTask.status === "ready" || selectedTask.status === "in_progress") && <button className={styles.secondaryButton} disabled={saving} onClick={() => { setReturnOpen(false); setLifecycleReason(""); setLifecycleAction("block"); }}>{selectedTask.status === "in_progress" ? "停止并阻塞" : "标记阻塞"}</button>}
                {selectedTask.status === "blocked" && <button className={styles.primaryButton} disabled={saving} onClick={() => { setReturnOpen(false); setLifecycleReason(""); setLifecycleAction("unblock"); }}>解除阻塞</button>}
                {selectedTask.status !== "done" && selectedTask.status !== "canceled" && <button className={styles.quietButton} disabled={saving} onClick={() => { setReturnOpen(false); setLifecycleReason(""); setLifecycleAction("cancel"); }}>{selectedTask.status === "in_progress" ? "停止并取消" : "取消任务"}</button>}
              </>}
              {returnOpen && <div className={styles.returnBox}><textarea value={returnReason} onChange={(event) => setReturnReason(event.target.value)} placeholder="具体说明需要修改什么" autoFocus /><div><button onClick={() => setReturnOpen(false)}>取消</button><button disabled={!returnReason.trim() || saving} onClick={() => void reviewAction("return")}>退回并回到原对话</button></div></div>}
              {lifecycleAction && <div className={styles.returnBox}><label>{LIFECYCLE_COPY[lifecycleAction].label}<textarea value={lifecycleReason} onChange={(event) => setLifecycleReason(event.target.value)} placeholder={LIFECYCLE_COPY[lifecycleAction].prompt} autoFocus /></label><div><button onClick={() => { setLifecycleAction(null); setLifecycleReason(""); }}>取消</button><button className={lifecycleAction === "cancel" ? styles.dangerButton : undefined} disabled={!lifecycleReason.trim() || saving} onClick={() => void runLifecycleAction()}>{saving ? "正在处理…" : LIFECYCLE_COPY[lifecycleAction].confirm}</button></div></div>}
            </footer>
          </aside>
        )}
      </div>

      {loading && <div className={styles.loading}>正在读取任务…</div>}

      {contractEditor && <div className={styles.modalBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setContractEditor(null); }}>
        <form className={`${styles.modal} ${styles.taskModal}`} onSubmit={saveContract}><header><div><span>EDIT CONTRACT</span><h2>编辑旧版任务字段</h2></div><button type="button" onClick={() => setContractEditor(null)}>×</button></header><p>这是历史任务的回退入口。当前位于{contractEditor.status === "ready" ? "待办事项" : "积压事项"}，版本 v{contractEditor.version}；新任务请回到对话中整理任务约定。</p><label>任务标题<input value={contractEditor.title} onChange={(event) => setContractEditor((draft) => draft ? { ...draft, title: event.target.value } : draft)} required /></label><label>目标<textarea value={contractEditor.goal} onChange={(event) => setContractEditor((draft) => draft ? { ...draft, goal: event.target.value } : draft)} required={contractEditor.status === "ready"} /></label><label>验收条件<textarea value={contractEditor.acceptanceCriteria} onChange={(event) => setContractEditor((draft) => draft ? { ...draft, acceptanceCriteria: event.target.value } : draft)} required={contractEditor.status === "ready"} /></label><label>预期产物<input value={contractEditor.expectedOutput} onChange={(event) => setContractEditor((draft) => draft ? { ...draft, expectedOutput: event.target.value } : draft)} required={contractEditor.status === "ready"} /></label><div className={styles.contractHint} data-complete={contractEditorMissing.length === 0}>{contractEditorMissing.length === 0 ? "字段完整，保存后可继续安排。" : `还缺：${contractEditorMissing.join("、")}。`}</div><footer><button type="button" onClick={() => setContractEditor(null)}>取消</button><button className={styles.primaryButton} disabled={saving || (contractEditor.status === "ready" && contractEditorMissing.length > 0)}>{saving ? "保存中…" : "保存字段"}</button></footer></form>
      </div>}

      <span className={styles.srOnly} aria-live="polite">{framingTaskId ? "正在准备任务澄清对话" : processingTaskId ? "正在准备任务执行对话" : ""}</span>
    </section>
  );
}

export { taskPrompt };
export type { PreparedSession };
