"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProjectRecord, TaskDetail } from "@/lib/task/types";
import type { PreparedSession } from "./TaskBoard";
import styles from "./TaskFromConversationDialog.module.css";

type ConversationSeed = {
  sessionId: string;
  cwd: string;
  name?: string;
  firstMessage?: string;
};

type Props = {
  conversation: ConversationSeed;
  onClose: () => void;
  onTaskSaved: (task: TaskDetail) => void;
  onPrepared: (task: TaskDetail, session: PreparedSession) => void;
};

type ApiErrorBody = { error?: { message?: string } | string };

async function readApi<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & ApiErrorBody;
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(message || `HTTP ${response.status}`);
  }
  return body;
}

function isInsideRoot(cwd: string, root: string): boolean {
  const normalizedCwd = cwd.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
  return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(`${normalizedRoot}/`);
}

function defaultTitle(conversation: ConversationSeed): string {
  const candidate = conversation.name?.trim()
    || (conversation.firstMessage && conversation.firstMessage !== "(no messages)" ? conversation.firstMessage.trim() : "")
    || "从当前对话整理任务";
  return candidate.split(/\r?\n/, 1)[0].slice(0, 120);
}

function defaultGoal(conversation: ConversationSeed): string {
  const firstMessage = conversation.firstMessage?.trim();
  return firstMessage && firstMessage !== "(no messages)" ? firstMessage : "";
}

function pathName(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) || "当前项目";
}

export function TaskFromConversationDialog({ conversation, onClose, onTaskSaved, onPrepared }: Props) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectChoice, setProjectChoice] = useState("__new__");
  const initialRoot = conversation.cwd;
  const [projectName, setProjectName] = useState(pathName(initialRoot));
  const [projectRoot, setProjectRoot] = useState(initialRoot);
  const [title, setTitle] = useState(() => defaultTitle(conversation));
  const [goal, setGoal] = useState(() => defaultGoal(conversation));
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [expectedOutput, setExpectedOutput] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedTaskId, setSavedTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/projects", { cache: "no-store", signal: controller.signal })
      .then((response) => readApi<{ projects: ProjectRecord[] }>(response))
      .then(({ projects: loaded }) => {
        setProjects(loaded);
        const match = loaded
          .filter((project) => isInsideRoot(conversation.cwd, project.rootPath))
          .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
        if (match) setProjectChoice(match.id);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setProjectsLoading(false);
      });
    return () => controller.abort();
  }, [conversation.cwd]);

  const compatibleProjects = useMemo(
    () => projects.filter((project) => isInsideRoot(conversation.cwd, project.rootPath)),
    [conversation.cwd, projects],
  );
  const selectedProject = useMemo(
    () => compatibleProjects.find((project) => project.id === projectChoice) ?? null,
    [compatibleProjects, projectChoice],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving || savedTaskId) return;
    setSaving(true);
    setError(null);
    let createdDetail: TaskDetail | null = null;
    try {
      let projectId = selectedProject?.id;
      if (!projectId) {
        const { project } = await readApi<{ project: ProjectRecord }>(await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: projectName, rootPath: projectRoot }),
        }));
        projectId = project.id;
      }

      const { task } = await readApi<{ task: TaskDetail }>(await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          title,
          goal,
          acceptanceCriteria,
          expectedOutput,
          status: "ready",
          primarySessionId: conversation.sessionId,
        }),
      }));
      setSavedTaskId(task.id);
      createdDetail = task;
      onTaskSaved(task);

      const { session } = await readApi<{ session: PreparedSession }>(await fetch(`/api/tasks/${encodeURIComponent(task.id)}/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: task.version }),
      }));
      onPrepared(createdDetail, session);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(createdDetail
        ? `任务已经保存，但当前对话暂时无法准备：${message}。关闭后可从对话顶部继续。`
        : message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <form className={styles.dialog} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="conversation-task-title">
        <header>
          <div>
            <span>FROM CONVERSATION</span>
            <h2 id="conversation-task-title">把当前对话整理为任务</h2>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="关闭">×</button>
        </header>

        <p className={styles.intro}>确认任务合同后，Pi Task 会继续使用当前对话并预填任务说明，但不会自动发送或调用模型。</p>

        {error && <div className={styles.error} role="alert">{error}</div>}

        <label>
          所属项目
          <select value={projectChoice} onChange={(event) => setProjectChoice(event.target.value)} disabled={projectsLoading || Boolean(savedTaskId)}>
            {compatibleProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            <option value="__new__">登记当前目录为新项目</option>
          </select>
        </label>

        {!selectedProject && (
          <div className={styles.projectFields}>
            <label>项目名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} required disabled={Boolean(savedTaskId)} /></label>
            <label>允许工作目录<input value={projectRoot} onChange={(event) => setProjectRoot(event.target.value)} required disabled={Boolean(savedTaskId)} /></label>
          </div>
        )}

        <label>任务标题<input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={240} disabled={Boolean(savedTaskId)} autoFocus /></label>
        <label>目标<textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="最终要解决什么问题" required disabled={Boolean(savedTaskId)} /></label>
        <label>验收条件<textarea value={acceptanceCriteria} onChange={(event) => setAcceptanceCriteria(event.target.value)} placeholder="怎样判断结果合格" required disabled={Boolean(savedTaskId)} /></label>
        <label>预期产物<input value={expectedOutput} onChange={(event) => setExpectedOutput(event.target.value)} placeholder="例如：docs/交接说明.md" required maxLength={4096} disabled={Boolean(savedTaskId)} /></label>

        <footer>
          <button type="button" className={styles.quietButton} onClick={onClose} disabled={saving}>{savedTaskId ? "关闭，稍后继续" : "取消"}</button>
          {!savedTaskId && <button type="submit" className={styles.primaryButton} disabled={saving || projectsLoading}>{saving ? "正在整理…" : "创建并回到当前对话"}</button>}
        </footer>
      </form>
    </div>
  );
}
