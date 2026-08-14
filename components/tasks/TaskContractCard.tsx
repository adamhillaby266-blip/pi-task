"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CustomMessage } from "@/lib/types";
import {
  readTaskFramingMessageDetails,
  type TaskFramingCommitReceiptEvent,
  type TaskFramingDraftEvent,
  type TaskFramingPreferenceEvent,
  type TaskFramingSuggestedEvent,
} from "@/lib/task/framing-session";
import { checkTaskContractReadiness, type ContractItem, type TaskContractV1 } from "@/lib/task/contract";
import type { TaskDecisionOptionSelection, TaskDecisionOptionSendResult } from "@/lib/task/framing-decision";
import type { ProjectRecord, TaskDetail, TaskFramingOperationRecord } from "@/lib/task/types";
import { taskContractCardClasses as styles } from "./TaskContractCard.classes";

type CommitAction = "save_draft" | "confirm" | "confirm_and_start";

type TaskFramingStatus = {
  sessionId: string;
  latestDraftEntryId: string | null;
  task: TaskDetail | null;
  project: ProjectRecord | null;
  busy: boolean;
  operations: TaskFramingOperationRecord[];
  actions: {
    saveDraft: boolean;
    confirm: boolean;
    confirmAndStart: boolean;
  };
};

type ApiErrorBody = { error?: { message?: string } | string };
type DecisionFeedback = { decisionId: string; tone: "status" | "error"; message: string };

async function readApi<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & ApiErrorBody;
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(message || `HTTP ${response.status}`);
  }
  return body;
}

function projectName(rootPath: string): string {
  return rootPath.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || "当前项目";
}

function newOperationId(): string {
  return `tfo_${crypto.randomUUID()}`;
}

const STATUS_LABELS: Record<ContractItem["status"], string> = {
  confirmed: "已确认",
  agent_suggestion: "Agent 建议",
  assumption: "假设",
};

function ItemStatus({ item }: { item: ContractItem }) {
  return <span className={styles.status} data-status={item.status}>{STATUS_LABELS[item.status]}</span>;
}

function ItemLines({ items, empty = "尚未记录" }: { items: ContractItem[]; empty?: string }) {
  if (items.length === 0) return <span>{empty}</span>;
  return <>{items.map((item) => <span className={styles.itemLine} key={item.id}><ItemStatus item={item} />{item.text}</span>)}</>;
}

function DetailList({ items, empty = "无" }: { items: ContractItem[]; empty?: string }) {
  if (items.length === 0) return <p className={styles.detailText}>{empty}</p>;
  return <ul className={styles.detailList}>{items.map((item) => <li key={item.id}><ItemStatus item={item} />{item.text}</li>)}</ul>;
}

function FullContract({ contract }: { contract: TaskContractV1 }) {
  return (
    <details className={styles.fullContract}>
      <summary className={styles.fullContractSummary}>查看完整任务约定</summary>
      <div className={styles.detailsGrid}>
        <section className={styles.detailSection}>
          <h3>验收方法</h3>
          <DetailList items={contract.acceptanceCriteria} empty="尚未形成可执行验收方法" />
        </section>
        <section className={styles.detailSection}>
          <h3>约束与确认点</h3>
          <DetailList items={contract.constraints} />
          {contract.gates.length > 0 && (
            <ul className={styles.detailList}>
              {contract.gates.map((gate) => <li key={gate.id}>{gate.trigger}：{gate.requiredAction}</li>)}
            </ul>
          )}
        </section>
        <section className={styles.detailSection}>
          <h3>范围与非范围</h3>
          <p className={styles.detailText}><strong>包含：</strong></p>
          <DetailList items={contract.scope.included} />
          <p className={styles.detailText}><strong>不包含：</strong></p>
          <DetailList items={contract.scope.excluded} />
        </section>
        <section className={styles.detailSection}>
          <h3>假设与非阻塞问题</h3>
          <DetailList items={contract.assumptions} />
          {contract.openDecisions.filter((decision) => !decision.blocking).map((decision) => (
            <p className={styles.detailText} key={decision.id}>{decision.question}</p>
          ))}
        </section>
      </div>
    </details>
  );
}

function DraftCard({
  event,
  isLatestDraft,
  restoredAfterCompaction,
  status,
  statusLoading,
  pendingAction,
  operationMessage,
  operationError,
  decisionFeedback,
  decisionOptionsDisabled,
  projectRoot,
  onCommit,
  onDecisionOption,
}: {
  event: TaskFramingDraftEvent;
  isLatestDraft: boolean;
  restoredAfterCompaction: boolean;
  status: TaskFramingStatus | null;
  statusLoading: boolean;
  pendingAction: CommitAction | null;
  operationMessage: string | null;
  operationError: string | null;
  decisionFeedback: DecisionFeedback | null;
  decisionOptionsDisabled: boolean;
  projectRoot?: string;
  onCommit: (action: CommitAction) => void;
  onDecisionOption?: (selection: TaskDecisionOptionSelection) => void;
}) {
  const contract = event.contract;
  const readiness = checkTaskContractReadiness(contract);

  if (!isLatestDraft) {
    return (
      <details className={styles.superseded}>
        <summary className={styles.supersededSummary}>
          <strong>草案 {event.revision}</strong>
          <span>{contract.title}</span>
          <span>已取代 · 查看</span>
        </summary>
        <div className={styles.supersededBody}>
          <p>{contract.outcome.text}</p>
          {event.changeSummary.length > 0 && <p>当时的变化：{event.changeSummary.join("；")}</p>}
        </div>
      </details>
    );
  }

  const blocking = contract.openDecisions.filter((decision) => decision.blocking && decision.status === "open");
  const missingChecks = readiness.checks.filter((check) => !check.ready);
  const availableSources = contract.authoritativeSources.filter((source) => source.availability !== "missing");
  return (
    <article className={styles.card} aria-label={`任务约定草案 ${event.revision}`}>
      <header className={styles.cardHeader}>
        <div className={styles.cardHeaderCopy}>
          <div className={styles.kicker}>
            <span>任务约定 · {readiness.ready ? "待用户确认" : "待决定"}</span>
            <span className={styles.version}>草案 {event.revision}</span>
            {restoredAfterCompaction && <span className={styles.restored}>从完整 Session 恢复</span>}
          </div>
          <h2 className={styles.cardTitle}>{contract.title}</h2>
        </div>
        <div className={styles.readiness} data-ready={readiness.ready}>
          <strong>{readiness.ready ? "0" : missingChecks.length}</strong>
          <span>{readiness.ready ? "项阻塞决定" : "项待补全"}</span>
        </div>
      </header>

      {projectRoot && (
        <div className={styles.workScope}>
          <span>工作范围</span>
          <strong>{projectName(projectRoot)}</strong>
          <code title={projectRoot}>{projectRoot}</code>
        </div>
      )}

      <div className={styles.cardBody}>
        <section className={styles.decisionPane} data-ready={readiness.ready}>
          <div className={styles.paneLabel}>{readiness.ready ? "当前状态" : blocking.length > 0 ? "需要你决定" : "需要继续补全"}</div>
          {blocking.length > 0 ? blocking.map((decision, index) => (
            <div className={styles.question} key={decision.id}>
              <div className={styles.questionCode}>{String(index + 1).padStart(2, "0")} · 阻塞决定</div>
              <p className={styles.questionText}>{decision.question}</p>
              {decision.options && decision.options.length > 0 && (
                <ul className={styles.optionList} aria-label={`“${decision.question}”的可选回答`}>
                  {decision.options.map((option) => (
                    <li key={option}>
                      <button
                        className={styles.option}
                        type="button"
                        disabled={decisionOptionsDisabled || !onDecisionOption}
                        aria-label={`选择：${option}`}
                        title={decisionOptionsDisabled ? "当前对话仍在回复" : "把这个选择作为可见用户消息发送"}
                        onClick={() => onDecisionOption?.({ decisionId: decision.id, question: decision.question, option })}
                      >{option}</button>
                    </li>
                  ))}
                </ul>
              )}
              {decisionFeedback?.decisionId === decision.id && (
                <div className={styles.decisionFeedback} data-error={decisionFeedback.tone === "error"} role={decisionFeedback.tone === "error" ? "alert" : "status"}>
                  {decisionFeedback.message}
                </div>
              )}
            </div>
          )) : missingChecks.length > 0 ? (
            <div className={styles.question}>
              <div className={styles.questionCode}>任务约定尚未完整</div>
              <p className={styles.questionText}>{missingChecks.map((check) => check.detail).join("；")}</p>
            </div>
          ) : (
            <p className={styles.readyCopy}><strong>已足够安全地开始</strong>没有未解决的阻塞决定；仍需由用户检查并确认任务约定。</p>
          )}
        </section>

        <section className={styles.summaryPane}>
          <div className={styles.paneLabel}>约定摘要</div>
          <dl className={styles.summaryGrid}>
            <dt className={styles.summaryLabel}>目标</dt>
            <dd className={styles.summaryValue}><ItemStatus item={contract.outcome} />{contract.outcome.text}</dd>
            <dt className={styles.summaryLabel}>受众与用途</dt>
            <dd className={styles.summaryValue}><ItemLines items={contract.audience} /></dd>
            <dt className={styles.summaryLabel}>权威来源</dt>
            <dd className={styles.summaryValue}><ItemLines items={availableSources} empty="待确认来源策略" /></dd>
            <dt className={styles.summaryLabel}>建议交付</dt>
            <dd className={styles.summaryValue}><ItemLines items={contract.deliverables} /></dd>
          </dl>
        </section>
      </div>

      <FullContract contract={contract} />
      {event.changeSummary.length > 0 && <div className={styles.changeSummary}><strong>本版变化：</strong>{event.changeSummary.join("；")}</div>}
      {(operationMessage || operationError) && (
        <div className={styles.operationMessage} data-error={Boolean(operationError)} role={operationError ? "alert" : "status"}>
          {operationError || operationMessage}
        </div>
      )}
      <footer className={styles.actions}>
        <span className={styles.draftNote}>
          {status?.task?.status === "ready"
            ? `已确认 · ${status.task.id}`
            : status?.task?.status === "backlog"
              ? `草稿已保存 · ${status.task.id}`
              : "候选草案 · 尚未写入 Task"}
        </span>
        <button
          className={styles.action}
          type="button"
          disabled={statusLoading || Boolean(pendingAction) || !status?.actions.saveDraft}
          onClick={() => onCommit("save_draft")}
          title={!status ? "正在读取任务状态" : status.actions.saveDraft ? "保存为 backlog，不会开始执行" : "当前草案已保存或暂不可保存"}
        >{pendingAction === "save_draft" ? "正在保存…" : "保存草稿"}</button>
        <button
          className={styles.action}
          type="button"
          disabled={statusLoading || Boolean(pendingAction) || !status?.actions.confirm}
          onClick={() => onCommit("confirm")}
          title={!readiness.ready ? "仍有阻塞决定" : "确认后进入待办，但不会开始执行"}
        >{pendingAction === "confirm" ? "正在确认…" : "确认并放入待办"}</button>
        <button
          className={`${styles.action} ${styles.actionPrimary}`}
          type="button"
          disabled={statusLoading || Boolean(pendingAction) || !status?.actions.confirmAndStart}
          onClick={() => onCommit("confirm_and_start")}
          title={!readiness.ready ? "仍有阻塞决定" : "确认后自动发送一条可见开始消息；失败时保持待办"}
        >{pendingAction === "confirm_and_start" ? "正在准备…" : "确认并开始"}</button>
      </footer>
    </article>
  );
}

function SuggestedEvent({
  event,
  pending,
  message,
  error,
  onDecline,
}: {
  event: TaskFramingSuggestedEvent;
  pending: boolean;
  message: string | null;
  error: string | null;
  onDecline: () => void;
}) {
  return <div className={styles.compactEvent}>
    <span className={styles.eventDot} />
    <strong>可以整理为任务约定</strong>
    <span>{error || message || event.reason}</span>
    <button className={styles.compactAction} type="button" disabled={pending || Boolean(message)} onClick={onDecline}>{pending ? "正在记录…" : "继续自由讨论"}</button>
  </div>;
}

function PreferenceEvent({
  event,
  pending,
  message,
  error,
  onReopen,
}: {
  event: TaskFramingPreferenceEvent;
  pending: boolean;
  message: string | null;
  error: string | null;
  onReopen: () => void;
}) {
  return <div className={styles.compactEvent}>
    <span className={styles.eventDot} />
    <strong>{event.eventType === "declined" ? "本次不整理为任务" : "重新整理任务约定"}</strong>
    <span>{error || message || (event.eventType === "declined" ? "继续自由讨论，本 Session 不再主动提示。" : "可以继续生成新的候选草案。")}</span>
    {event.eventType === "declined" && <button className={styles.compactAction} type="button" disabled={pending || Boolean(message)} onClick={onReopen}>{pending ? "正在打开…" : "重新打开"}</button>}
  </div>;
}

function ReceiptEvent({ event }: { event: TaskFramingCommitReceiptEvent }) {
  const action = event.status === "start_failed"
    ? "启动失败，Task 保持待办"
    : event.action === "save_draft"
      ? "草稿已保存"
      : event.action === "confirm"
        ? "任务约定已确认"
        : "已确认并请求开始";
  return <div className={styles.compactEvent}><span className={styles.eventDot} /><strong>{action}</strong><span>{event.status === "start_failed" ? event.message || "启动失败，Task 保持待办。" : `${event.taskId} · v${event.taskVersion}`}</span></div>;
}

export function TaskContractCard({
  message,
  sessionId,
  projectRoot,
  decisionOptionsDisabled = false,
  onDecisionOption,
  onCommitted,
}: {
  message: CustomMessage;
  sessionId?: string;
  projectRoot?: string;
  decisionOptionsDisabled?: boolean;
  onDecisionOption?: (selection: TaskDecisionOptionSelection) => TaskDecisionOptionSendResult;
  onCommitted?: (task: TaskDetail, action: CommitAction, operation: TaskFramingOperationRecord) => void | Promise<void>;
}) {
  const details = readTaskFramingMessageDetails(message.details);
  const draftEntryId = details?.event.eventType === "draft" && details.isLatestDraft ? details.entryId : null;
  const [status, setStatus] = useState<TaskFramingStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(Boolean(draftEntryId && sessionId));
  const [pendingAction, setPendingAction] = useState<CommitAction | null>(null);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [preferencePending, setPreferencePending] = useState(false);
  const [preferenceMessage, setPreferenceMessage] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [decisionFeedback, setDecisionFeedback] = useState<DecisionFeedback | null>(null);
  const operationIds = useRef<Partial<Record<CommitAction, string>>>({});

  const refreshStatus = useCallback(async (): Promise<TaskFramingStatus> => {
    if (!sessionId) throw new Error("当前卡片没有可提交的 Session");
    const result = await readApi<{ framing: TaskFramingStatus }>(await fetch(
      `/api/task-framing?sessionId=${encodeURIComponent(sessionId)}`,
      { cache: "no-store" },
    ));
    setStatus(result.framing);
    return result.framing;
  }, [sessionId]);

  useEffect(() => {
    if (!draftEntryId || !sessionId) {
      setStatusLoading(false);
      return;
    }
    const controller = new AbortController();
    setStatusLoading(true);
    void fetch(`/api/task-framing?sessionId=${encodeURIComponent(sessionId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => readApi<{ framing: TaskFramingStatus }>(response))
      .then(({ framing }) => {
        setStatus(framing);
        setOperationError(null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setOperationError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setStatusLoading(false);
      });
    return () => controller.abort();
  }, [draftEntryId, sessionId]);

  const commit = useCallback(async (action: CommitAction) => {
    if (!sessionId || !draftEntryId || pendingAction) return;
    setPendingAction(action);
    setOperationError(null);
    setOperationMessage(null);
    try {
      let current = await refreshStatus();
      if (current.latestDraftEntryId !== draftEntryId) {
        throw new Error("当前草案已被新版本取代，请刷新后重试");
      }
      let project = current.project;
      if (!project) {
        if (!projectRoot) throw new Error("当前对话尚未关联可登记的工作目录");
        try {
          const created = await readApi<{ project: ProjectRecord }>(await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: projectName(projectRoot), rootPath: projectRoot }),
          }));
          project = created.project;
        } catch {
          current = await refreshStatus();
          project = current.project;
          if (!project) throw new Error("无法登记当前工作目录，请确认左侧选择的目录仍然存在");
        }
      }
      const retryOperation = action === "confirm_and_start"
        ? current.operations.find((operation) => (
            operation.action === "confirm_and_start"
            && (operation.status === "awaiting_start" || operation.status === "start_failed")
          ))
        : null;
      const operationId = retryOperation?.id ?? operationIds.current[action] ?? newOperationId();
      operationIds.current[action] = operationId;
      const result = await readApi<{ task: TaskDetail; operation: TaskFramingOperationRecord; receiptWarning: string | null }>(await fetch("/api/task-framing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId,
          sessionId,
          sourceDraftEntryId: draftEntryId,
          projectId: project.id,
          taskId: current.task?.id ?? null,
          expectedTaskVersion: current.task?.version ?? null,
          action,
        }),
      }));
      delete operationIds.current[action];
      const successMessage = action === "save_draft"
        ? `草稿已保存到 ${result.task.id}；不会自动执行。`
        : action === "confirm"
          ? `任务约定已确认并放入待办 ${result.task.id}；尚未开始执行。`
          : `任务约定已确认，正在准备 ${result.task.id} 的执行对话。`;
      setOperationMessage(result.receiptWarning
        ? `${successMessage} Session 回执稍后可从 SQLite 状态恢复。`
        : successMessage);
      await onCommitted?.(result.task, action, result.operation);
      await refreshStatus();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
      try { await refreshStatus(); } catch { /* preserve the primary mutation error */ }
    } finally {
      setPendingAction(null);
    }
  }, [draftEntryId, onCommitted, pendingAction, projectRoot, refreshStatus, sessionId]);

  const selectDecisionOption = useCallback((selection: TaskDecisionOptionSelection) => {
    if (!onDecisionOption) return;
    const result = onDecisionOption(selection);
    const feedback: Record<TaskDecisionOptionSendResult, Omit<DecisionFeedback, "decisionId">> = {
      sent: { tone: "status", message: "已把选择作为可见消息发送，等待 Agent 更新任务约定。" },
      busy: { tone: "error", message: "当前对话仍在回复，请结束后再选择。" },
      draft_present: { tone: "error", message: "输入框已有未发送内容，请先发送或清空后再选择。" },
      tools_disabled: { tone: "error", message: "当前已关闭工具；请切换到默认或完整工具后再选择。" },
      invalid: { tone: "error", message: "暂时无法发送这个选择，请稍后重试。" },
    };
    setDecisionFeedback({ decisionId: selection.decisionId, ...feedback[result] });
  }, [onDecisionOption]);

  const changePreference = useCallback(async (eventType: "declined" | "reopened", suggestionId?: string) => {
    if (!sessionId || preferencePending) return;
    setPreferencePending(true);
    setPreferenceError(null);
    try {
      await readApi(await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/task-framing/preference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType, ...(suggestionId ? { suggestionId } : {}) }),
      }));
      setPreferenceMessage(eventType === "declined"
        ? "已记录：继续自由讨论，本分支不再主动提示。"
        : "已重新打开；可以使用顶部入口继续整理。" );
    } catch (error) {
      setPreferenceError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreferencePending(false);
    }
  }, [preferencePending, sessionId]);

  if (!details) return null;
  const event = details.event;
  if (event.eventType === "draft") {
    return <DraftCard
      event={event}
      isLatestDraft={details.isLatestDraft}
      restoredAfterCompaction={details.restoredAfterCompaction}
      status={status}
      statusLoading={statusLoading}
      pendingAction={pendingAction}
      operationMessage={operationMessage}
      operationError={operationError}
      decisionFeedback={decisionFeedback}
      decisionOptionsDisabled={decisionOptionsDisabled}
      projectRoot={projectRoot}
      onCommit={(action) => void commit(action)}
      onDecisionOption={onDecisionOption ? selectDecisionOption : undefined}
    />;
  }
  if (event.eventType === "suggested") return <SuggestedEvent event={event} pending={preferencePending} message={preferenceMessage} error={preferenceError} onDecline={() => void changePreference("declined", event.suggestionId)} />;
  if (event.eventType === "declined" || event.eventType === "reopened") return <PreferenceEvent event={event} pending={preferencePending} message={preferenceMessage} error={preferenceError} onReopen={() => void changePreference("reopened", event.suggestionId)} />;
  if (event.eventType === "commit_receipt") return <ReceiptEvent event={event} />;
  return null;
}
