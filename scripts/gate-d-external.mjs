import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const base = process.env.PI_TASK_GATE_D_EXTERNAL_BASE_URL;
const runtimeDir = process.env.PI_TASK_GATE_D_EXTERNAL_RUNTIME;
const expectedProvider = process.env.PI_TASK_GATE_D_EXTERNAL_PROVIDER;
const expectedModel = "MiniMax-M3";
const mainAnswerPrompt = "请输入一个完全虚构的方案决定（不要输入公司资料、密码或 API Key）：";

if (!base || !runtimeDir || !expectedProvider) {
  throw new Error("PI_TASK_GATE_D_EXTERNAL_BASE_URL, PI_TASK_GATE_D_EXTERNAL_RUNTIME, and PI_TASK_GATE_D_EXTERNAL_PROVIDER are required");
}
if (!stdin.isTTY) throw new Error("Gate D external validation requires an interactive terminal for the user decision and acceptance");

const projectRoot = join(runtimeDir, "fictional-project");
const resultPath = join(runtimeDir, "result.json");
const mutationHeaders = {
  "content-type": "application/json",
  origin: base,
  "sec-fetch-site": "same-origin",
};
const progress = {
  generatedAt: new Date().toISOString(),
  outcome: "running",
  provider: null,
  model: null,
  mainFlow: null,
  abortFlow: null,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function mutation(path, body) {
  return api(path, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify(body),
  });
}

async function waitFor(label, probe, timeoutMs = 180_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} did not complete within ${Math.round(timeoutMs / 1_000)} seconds${lastError ? `: ${lastError}` : ""}`);
}

async function getTask(taskId) {
  return (await api(`/api/tasks/${encodeURIComponent(taskId)}`)).task;
}

async function getAgentState(sessionId) {
  return api(`/api/agent/${encodeURIComponent(sessionId)}`);
}

async function waitForAgentIdle(sessionId, timeoutMs = 90_000) {
  return waitFor("Agent idle", async () => {
    const response = await getAgentState(sessionId);
    if (!response.running || !response.state) return { stopped: true };
    const state = response.state;
    if (!state.isPromptRunning && !state.isStreaming && !state.isBashRunning && !state.isCompacting) {
      return { stopped: false, state };
    }
    return null;
  }, timeoutMs);
}

async function waitForRunStatus(taskId, runId, status, timeoutMs = 240_000) {
  return waitFor(`Run ${runId} to become ${status}`, async () => {
    const task = await getTask(taskId);
    const run = task.runs.find((candidate) => candidate.id === runId);
    return run?.status === status ? task : null;
  }, timeoutMs);
}

async function waitForInputRequest(sessionId, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/api/agent/${encodeURIComponent(sessionId)}/events`, {
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Could not open Agent event stream: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Agent event stream closed before request_task_input");
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice("data: ".length))
          .join("\n");
        if (!data) continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event?.type === "extension_ui_request" && event.method === "input" && typeof event.id === "string") {
          return event;
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out waiting for request_task_input after ${Math.round(timeoutMs / 1_000)} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function usageSummary(sessionFile) {
  try {
    const entries = (await readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    const summary = {
      providerRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      reportedCostUsd: 0,
      toolCalls: [],
    };
    for (const entry of entries) {
      const message = entry.message;
      if (entry.type !== "message" || message?.role !== "assistant") continue;
      summary.providerRequests += 1;
      summary.inputTokens += message.usage?.input ?? 0;
      summary.outputTokens += message.usage?.output ?? 0;
      summary.cacheReadTokens += message.usage?.cacheRead ?? 0;
      summary.totalTokens += message.usage?.totalTokens ?? 0;
      summary.reportedCostUsd += message.usage?.cost?.total ?? 0;
      for (const part of message.content ?? []) {
        if (part.type === "toolCall") summary.toolCalls.push(part.name);
      }
    }
    summary.reportedCostUsd = Number(summary.reportedCostUsd.toFixed(8));
    return summary;
  } catch {
    return null;
  }
}

async function hasEmptyAuthStore() {
  try {
    const raw = await readFile(join(process.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0);
  } catch (error) {
    return (error && typeof error === "object" && "code" in error && error.code === "ENOENT");
  }
}

async function waitForPendingAbortBash(sessionFile) {
  const markerPath = join(projectRoot, ".gate-d-abort-running");
  return waitFor("pending bash operation for the abort test", async () => {
    let marker;
    try {
      marker = (await readFile(markerPath, "utf8")).trim();
    } catch {
      return null;
    }
    if (marker !== "running") return null;

    const entries = (await readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    const completedToolCalls = new Set(
      entries
        .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
        .map((entry) => entry.message.toolCallId),
    );
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
      for (const part of entry.message.content ?? []) {
        const command = part?.arguments?.command;
        if (
          part?.type === "toolCall"
          && part.name === "bash"
          && typeof part.id === "string"
          && typeof command === "string"
          && command.includes("sleep 120")
          && !completedToolCalls.has(part.id)
        ) {
          return { toolCallId: part.id, command };
        }
      }
    }
    return null;
  }, 180_000);
}

async function createFreeConversation(label, prompt) {
  const created = await mutation("/api/agent/new", {
    cwd: projectRoot,
    type: "prompt",
    toolNames: [],
    message: prompt,
  });
  const sessionId = created.sessionId;
  assert(typeof sessionId === "string" && sessionId.length > 0, `${label} did not create a Pi Session`);
  assert(
    created.model?.provider === expectedProvider && created.model?.modelId === expectedModel,
    `${label} selected an unexpected model: ${JSON.stringify(created.model)}`,
  );
  await waitForAgentIdle(sessionId);
  const stats = (await mutation(`/api/agent/${encodeURIComponent(sessionId)}`, {
    type: "get_session_stats",
  })).data;
  assert(typeof stats?.sessionFile === "string" && stats.sessionFile.length > 0, `${label} did not persist its Session`);
  const entries = (await readFile(stats.sessionFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert(
    entries.some((entry) => entry.type === "message" && entry.message?.role === "user")
      && entries.some((entry) => entry.type === "message" && entry.message?.role === "assistant"),
    `${label} Session is missing the real free-conversation turn`,
  );
  return { sessionId, sessionFile: stats.sessionFile, model: created.model };
}

async function createBoundTask(projectId, primarySessionId, fields) {
  const created = await mutation("/api/tasks", {
    projectId,
    primarySessionId,
    status: "ready",
    ...fields,
  });
  assert(created.task?.primarySessionId === primarySessionId, "Task did not preserve its free-conversation Session binding");
  return created.task;
}

async function prepareAndStart(task, expectedSessionId) {
  const prepared = await mutation(`/api/tasks/${encodeURIComponent(task.id)}/prepare`, {
    version: task.version,
  });
  assert(
    prepared.session?.sessionId === expectedSessionId && prepared.session?.reused === true,
    `Task did not reuse its free-conversation Session: ${JSON.stringify(prepared.session)}`,
  );
  const beforeStart = await getTask(task.id);
  assert(
    beforeStart.status === "ready" && beforeStart.activeRunId === null && beforeStart.runs.length === 0,
    "Preparing the converted conversation started work before the user send",
  );
  const started = await mutation(`/api/tasks/${encodeURIComponent(task.id)}/start`, {
    version: beforeStart.version,
    sessionId: expectedSessionId,
  });
  assert(started.task?.status === "in_progress" && started.run?.status === "running", "Task Run did not start correctly");
  return { prepared: prepared.session, started, beforeStart };
}

async function main() {
  await mkdir(projectRoot, { recursive: true });
  const { project } = await mutation("/api/projects", {
    name: "Gate D 外部模型隔离测试",
    rootPath: projectRoot,
  });

  const conversation = await createFreeConversation(
    "Gate D conversion conversation",
    "这是完全虚构的 Gate D 隔离测试对话。请只回复“Gate D 虚构对话已准备”，不要使用工具，不要创建文件，也不要提及任何真实资料。",
  );
  const task = await createBoundTask(project.id, conversation.sessionId, {
    title: "根据人工决定生成虚构 Gate D 记录",
    goal: "验证自由对话转任务后，Agent 能请求人工决定、在同一 Session 中继续、提交 Review，并由用户验收。",
    acceptanceCriteria: "先调用 read_task；必须调用一次 request_task_input；在项目根目录创建并回读 decision.md，文件包含人工决定；随后调用 submit_task_review。",
    expectedOutput: "decision.md，仅包含虚构 Gate D 测试记录",
  });

  const mainRun = await prepareAndStart(task, conversation.sessionId);
  await mutation(`/api/agent/${encodeURIComponent(conversation.sessionId)}`, {
    type: "prompt",
    message: [
      "这是完全虚构的隔离 Gate D 测试。严格按以下顺序执行：",
      "1. 先调用 read_task。",
      "2. 在创建任何文件前，必须且只能调用一次 request_task_input，问题写为“虚构交接采用方案 A 还是方案 B？”。",
      "3. 获得用户回复后，只在项目根目录创建 decision.md；文件必须含标题“# Gate D 人工决定记录”、一行“状态：仅用于虚构测试”、以及逐字包含用户回复的一行“人工决定：<用户回复>”。",
      "4. 回读 decision.md，确认内容真实存在后调用 submit_task_review；artifact 使用 decision.md。",
      "5. 不读取项目根目录外的任何文件，不创建其他文件，不使用网络，不声称任务已完成。",
    ].join("\n"),
  });

  const inputRequestPromise = waitForInputRequest(conversation.sessionId);
  const waitingTask = await waitForRunStatus(task.id, mainRun.started.run.id, "waiting_user");
  assert(waitingTask.status === "in_progress", "Task changed out of in_progress while waiting for the user");
  const inputRequest = await inputRequestPromise;
  const waitingEvent = waitingTask.events.find((event) => event.type === "run.waiting_user" && event.runId === mainRun.started.run.id);
  assert(waitingEvent?.payload?.question, "run.waiting_user evidence is missing its question");

  const rl = createInterface({ input: stdin, output: stdout });
  let answer;
  try {
    console.log(`\nAgent 的问题：${inputRequest.title ?? waitingEvent.payload.question}`);
    answer = (await rl.question(mainAnswerPrompt)).trim();
    assert(answer, "A non-empty fictional user decision is required");
    await mutation(`/api/agent/${encodeURIComponent(conversation.sessionId)}`, {
      type: "extension_ui_response",
      id: inputRequest.id,
      value: answer,
    });

    const submittedTask = await waitForRunStatus(task.id, mainRun.started.run.id, "succeeded");
    assert(submittedTask.status === "in_review", "Agent submitted a Run without putting the Task into human review");
    await waitForAgentIdle(conversation.sessionId);
    const decisionContent = await readFile(join(projectRoot, "decision.md"), "utf8");
    assert(
      decisionContent.includes("# Gate D 人工决定记录")
        && decisionContent.includes("状态：仅用于虚构测试")
        && decisionContent.includes(answer),
      "decision.md does not contain the required fictional evidence and the user decision",
    );
    const review = submittedTask.reviews.find((candidate) => candidate.runId === mainRun.started.run.id);
    assert(review?.status === "submitted", "Agent did not submit a Review for the successful Run");
    assert(
      submittedTask.artifacts.some((artifact) => artifact.runId === mainRun.started.run.id && artifact.path.endsWith("/decision.md")),
      "Review does not contain the decision.md Artifact",
    );
    const waitingIndex = submittedTask.events.findIndex((event) => event.type === "run.waiting_user" && event.runId === mainRun.started.run.id);
    const resumedIndex = submittedTask.events.findIndex((event) => event.type === "run.resumed" && event.runId === mainRun.started.run.id);
    assert(waitingIndex !== -1 && resumedIndex > waitingIndex, "run.waiting_user / run.resumed Event order is invalid");
    const resumedEvent = submittedTask.events[resumedIndex];
    assert(resumedEvent.payload?.answer === answer, "run.resumed does not preserve the user's answer");

    console.log("\nAgent 已提交虚构产物供人工验收：decision.md");
    const acceptAnswer = await rl.question("输入 y 验收该虚构 Review；其他输入将使测试停止在待验收：");
    assert(acceptAnswer.trim().toLowerCase() === "y", "User did not accept the submitted fictional Review");
    const accepted = await mutation(`/api/tasks/${encodeURIComponent(task.id)}/review`, {
      action: "accept",
      version: submittedTask.version,
    });
    assert(accepted.task?.status === "done", "User acceptance did not complete the Task");
    progress.provider = conversation.model.provider;
    progress.model = conversation.model.modelId;
    progress.mainFlow = {
      taskId: accepted.task.id,
      sessionId: conversation.sessionId,
      sessionReused: mainRun.prepared.sessionId === conversation.sessionId,
      runId: mainRun.started.run.id,
      runStatus: accepted.task.runs.find((run) => run.id === mainRun.started.run.id)?.status ?? null,
      taskStatus: accepted.task.status,
      inputQuestionHash: shortHash(String(waitingEvent.payload.question)),
      userAnswerLength: answer.length,
      userAnswerHash: shortHash(answer),
      decisionArtifactVerified: true,
      reviewStatus: accepted.task.reviews.find((candidate) => candidate.runId === mainRun.started.run.id)?.status ?? null,
      eventTypes: accepted.task.events.map((event) => event.type),
      usage: await usageSummary(conversation.sessionFile),
    };

    const abortConversation = await createFreeConversation(
      "Gate D abort conversation",
      "这是完全虚构的 Gate D 中断测试对话。请只回复“Gate D 中断测试已准备”，不要使用工具，不要创建文件。",
    );
    const abortTask = await createBoundTask(project.id, abortConversation.sessionId, {
      title: "中断虚构 Gate D 运行",
      goal: "验证真实运行中的 Pi abort 会先终止 Agent，再安全写入取消状态。",
      acceptanceCriteria: "本轮仅用于真实运行中的取消测试；可临时写入 .gate-d-abort-running 作为运行中信号，但不应提交 Review 或注册 Artifact。",
      expectedOutput: "无注册产物；仅保留取消事件证据",
    });
    const abortRun = await prepareAndStart(abortTask, abortConversation.sessionId);
    await mutation(`/api/agent/${encodeURIComponent(abortConversation.sessionId)}`, {
      type: "prompt",
      message: [
        "这是完全虚构的受控中断测试。必须先调用 read_task；不要把 read_task 和 bash 放在同一个 assistant 回合。",
        "收到 read_task 的工具结果后，在下一回合只调用一次 bash，命令为 `printf running > .gate-d-abort-running && sleep 120`。",
        "不要创建其他文件，不要调用 submit_task_review，也不要在 sleep 完成前给出最终回答；系统会在 sleep 运行时取消本轮。",
      ].join("\n"),
    });

    const abortObservation = await waitForPendingAbortBash(abortConversation.sessionFile);
    const activeBeforeCancel = await getTask(abortTask.id);
    const agentBeforeCancel = await getAgentState(abortConversation.sessionId);
    assert(
      activeBeforeCancel.status === "in_progress" && activeBeforeCancel.activeRunId === abortRun.started.run.id,
      "Abort test Task was not active when the pending bash operation was observed",
    );
    assert(
      agentBeforeCancel.running
        && (agentBeforeCancel.state?.isPromptRunning || agentBeforeCancel.state?.isStreaming || agentBeforeCancel.state?.isBashRunning),
      "Agent did not report an active prompt when the pending bash operation was observed",
    );
    const cancelReason = "Gate D 隔离测试：在真实运行中取消";
    const canceled = await mutation(`/api/tasks/${encodeURIComponent(abortTask.id)}/lifecycle`, {
      action: "cancel",
      version: abortRun.started.task.version,
      reason: cancelReason,
    });
    assert(
      canceled.task?.status === "canceled"
        && canceled.task.activeRunId === null
        && canceled.task.runs.find((run) => run.id === abortRun.started.run.id)?.status === "canceled",
      "Cancel did not converge the active real Run to canceled",
    );
    await waitForAgentIdle(abortConversation.sessionId);
    await sleep(1_000);
    const finalAbortTask = await getTask(abortTask.id);
    assert(
      finalAbortTask.status === "canceled"
        && finalAbortTask.activeRunId === null
        && finalAbortTask.runs.find((run) => run.id === abortRun.started.run.id)?.status === "canceled"
        && finalAbortTask.events.some((event) => event.type === "task.canceled" && event.payload?.reason === cancelReason)
        && finalAbortTask.reviews.length === 0,
      "Canceled Task changed after Agent abort or accepted a late Review",
    );

    progress.abortFlow = {
      taskId: finalAbortTask.id,
      sessionId: abortConversation.sessionId,
      sessionReused: abortRun.prepared.sessionId === abortConversation.sessionId,
      runId: abortRun.started.run.id,
      pendingBashToolObserved: true,
      bashToolCallHash: shortHash(abortObservation.toolCallId),
      agentReportedActiveBeforeCancel: true,
      runStatus: finalAbortTask.runs.find((run) => run.id === abortRun.started.run.id)?.status ?? null,
      taskStatus: finalAbortTask.status,
      reviewCount: finalAbortTask.reviews.length,
      eventTypes: finalAbortTask.events.map((event) => event.type),
      usage: await usageSummary(abortConversation.sessionFile),
    };
    progress.authStoreEmpty = await hasEmptyAuthStore();
    progress.outcome = "passed";
    await writeFile(resultPath, `${JSON.stringify(progress, null, 2)}\n`, { mode: 0o600 });
    console.log(`\nGate D 真实模型验收通过。非敏感结果：${resultPath}`);
  } finally {
    rl.close();
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await writeFile(resultPath, `${JSON.stringify({
      ...progress,
      outcome: "failed",
      error: message.slice(0, 2_000),
    }, null, 2)}\n`, { mode: 0o600 });
  } catch {}
  console.error(`Gate D external validation failed: ${message}`);
  process.exitCode = 1;
});
