"use client";

import { useEffect, useMemo, useState } from "react";
import type { TaskDetail } from "@/lib/task/types";
import styles from "./TaskReviewCard.module.css";

type Props = {
  task: TaskDetail;
  disabled?: boolean;
  onOpenFile?: (path: string) => void;
  onReview: (action: "accept" | "return", reason?: string) => Promise<void>;
};

export function TaskReviewCard({ task, disabled = false, onOpenFile, onReview }: Props) {
  const review = task.reviews.at(-1);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [busyAction, setBusyAction] = useState<"accept" | "return" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReturnOpen(false);
    setReturnReason("");
    setBusyAction(null);
    setError(null);
  }, [review?.id, review?.status]);

  const artifacts = useMemo(
    () => review ? task.artifacts.filter((artifact) => artifact.runId === review.runId) : [],
    [review, task.artifacts],
  );
  if (!review) return null;

  const pending = task.status === "in_review" && review.status === "submitted";
  const accepted = task.status === "done" && review.status === "accepted";
  if (!pending && !accepted) return null;

  async function submit(action: "accept" | "return") {
    if (disabled || busyAction) return;
    const reason = returnReason.trim();
    if (action === "return" && !reason) return;
    setBusyAction(action);
    setError(null);
    try {
      await onReview(action, action === "return" ? reason : undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusyAction(null);
    }
  }

  return (
    <section className={`${styles.card} ${accepted ? styles.accepted : ""}`} aria-label={accepted ? "任务已验收" : "任务待验收"}>
      <header className={styles.header}>
        <div className={styles.stateMark} aria-hidden="true">{accepted ? "✓" : "↗"}</div>
        <div className={styles.heading}>
          <span>{accepted ? "人工验收已记录" : "Pi 已提交验收"}</span>
          <strong>{task.title}</strong>
        </div>
        <span className={styles.runLabel}>Run {Math.max(1, task.runs.findIndex((run) => run.id === review.runId) + 1)}</span>
      </header>

      <div className={styles.body}>
        <p className={styles.summary}>{review.summary}</p>

        {artifacts.length > 0 && (
          <div className={styles.artifacts}>
            {artifacts.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                onClick={() => onOpenFile?.(artifact.path)}
                disabled={!onOpenFile}
                title={artifact.path}
              >
                <span className={styles.fileIcon}>↗</span>
                <span><strong>{artifact.path.split(/[\\/]/).pop()}</strong><small>{artifact.verification}</small></span>
              </button>
            ))}
          </div>
        )}

        <details className={styles.details}>
          <summary>查看变更、验证与风险</summary>
          <dl>
            <div><dt>变更</dt><dd>{review.changes}</dd></div>
            <div><dt>验证</dt><dd>{review.verification}</dd></div>
            {review.unverified && <div><dt>未验证</dt><dd>{review.unverified}</dd></div>}
            {review.risks && <div><dt>风险</dt><dd>{review.risks}</dd></div>}
          </dl>
        </details>

        {error && <div className={styles.error} role="alert">{error}</div>}
      </div>

      {pending && (
        <footer className={styles.actions}>
          {returnOpen ? (
            <div className={styles.returnBox}>
              <label htmlFor={`task-return-${review.id}`}>具体说明需要修改什么</label>
              <textarea
                id={`task-return-${review.id}`}
                value={returnReason}
                onChange={(event) => setReturnReason(event.target.value)}
                placeholder="例如：删去示例段落，只保留结论和验证记录"
                autoFocus
                disabled={disabled || busyAction !== null}
              />
              <div>
                <button type="button" className={styles.quietButton} onClick={() => { setReturnOpen(false); setReturnReason(""); }} disabled={busyAction !== null}>取消</button>
                <button type="button" className={styles.returnButton} onClick={() => void submit("return")} disabled={disabled || !returnReason.trim() || busyAction !== null}>
                  {busyAction === "return" ? "正在退回…" : "退回并回到原对话"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <span>{disabled ? "等待 Pi 完成当前回复" : "只有你可以结束这项任务"}</span>
              <div>
                <button type="button" className={styles.quietButton} onClick={() => setReturnOpen(true)} disabled={disabled || busyAction !== null}>退回修改</button>
                <button type="button" className={styles.acceptButton} onClick={() => void submit("accept")} disabled={disabled || busyAction !== null}>
                  {busyAction === "accept" ? "正在验收…" : "验收并完成任务"}
                </button>
              </div>
            </>
          )}
        </footer>
      )}
    </section>
  );
}
