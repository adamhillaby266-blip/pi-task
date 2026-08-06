import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const base = process.env.PI_TASK_TEST_BASE_URL ?? "http://127.0.0.1:30142";
const runtimeDir = process.env.PI_TASK_TEST_RUNTIME;
const expectedProvider = process.env.PI_TASK_TEST_PROVIDER;
const expectedModel = "MiniMax-M3";
const requiredStrings = [
  "# Pi Task Gate C 虚构交接",
  "状态：等待人工验收",
  "数据：仅用于虚构测试",
];
const returnReason = "在主标题后新增二级标题“## 人工退回修订”，将全文压缩为不超过 20 个非空行；保留三个必需字符串并回读验证。";

if (!runtimeDir || !expectedProvider) {
  throw new Error("PI_TASK_TEST_RUNTIME and PI_TASK_TEST_PROVIDER are required");
}

const projectRoot = join(runtimeDir, "fictional-project");
const artifactPath = join(projectRoot, "handoff.md");
const resultPath = join(runtimeDir, "result.json");
await mkdir(projectRoot, { recursive: true });

const mutationHeaders = {
  "content-type": "application/json",
  origin: base,
  "sec-fetch-site": "same-origin",
};

async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    throw new Error(`${path}: ${JSON.stringify(body)}`);
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

async function waitForTask(taskId) {
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const detail = (await api(`/api/tasks/${encodeURIComponent(taskId)}`)).task;
    if (detail.status !== "in_progress") return detail;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Agent did not settle the Task within six minutes");
}

async function waitForAgentIdle(sessionId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await api(`/api/agent/${encodeURIComponent(sessionId)}`);
    if (!state.state?.isPromptRunning && !state.state?.isStreaming && !state.state?.isBashRunning) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Agent submitted Review but did not finish its final response within one minute");
}

async function executeRun(task, prompt, expectedSessionId = null) {
  const { session } = await mutation(`/api/tasks/${encodeURIComponent(task.id)}/prepare`, {
    version: task.version,
  });
  if (expectedSessionId && session.sessionId !== expectedSessionId) {
    throw new Error(`Task did not reuse its Pi Session: ${expectedSessionId} -> ${session.sessionId}`);
  }
  const agentState = await api(`/api/agent/${encodeURIComponent(session.sessionId)}`);
  const model = agentState.state?.model;
  if (model?.provider !== expectedProvider || model?.id !== expectedModel) {
    throw new Error(`Unexpected model: ${JSON.stringify(model)}`);
  }
  const started = await mutation(`/api/tasks/${encodeURIComponent(task.id)}/start`, {
    version: task.version,
    sessionId: session.sessionId,
  });
  if (started.task.status !== "in_progress" || started.run.status !== "running") {
    throw new Error(`Run did not start: ${JSON.stringify(started)}`);
  }
  await mutation(`/api/agent/${encodeURIComponent(session.sessionId)}`, {
    type: "prompt",
    message: prompt,
  });
  const detail = await waitForTask(task.id);
  await waitForAgentIdle(session.sessionId);
  return { detail, model, run: started.run, session };
}

function latestReview(detail) {
  return detail.reviews.at(-1) ?? null;
}

function reviewArtifacts(detail, review) {
  return review ? detail.artifacts.filter((artifact) => artifact.runId === review.runId) : [];
}

async function artifactContent() {
  try {
    return await readFile(artifactPath, "utf8");
  } catch {
    return null;
  }
}

function containsRequired(content) {
  return Boolean(content && requiredStrings.every((required) => content.includes(required)));
}

function printReview(label, detail, content) {
  const review = latestReview(detail);
  console.log(`\n=== ${label} ===`);
  console.log(`任务状态：${detail.status}`);
  console.log(`Run 状态：${detail.runs.at(-1)?.status ?? "unknown"}`);
  console.log(`产物数量：${reviewArtifacts(detail, review).length}`);
  console.log("\n--- handoff.md ---");
  console.log(content ?? "（未生成）");
  console.log("--- Agent 验收说明 ---");
  console.log(review?.summary ?? "（未提交验收）");
  console.log(review?.verification ?? "");
}

async function usageSummary(sessionFile) {
  try {
    const entries = (await readFile(sessionFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    const summary = { providerRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, reportedCostUsd: 0, toolCalls: [] };
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

const { project } = await mutation("/api/projects", {
  name: "Gate C 双 Run 虚构模型测试",
  rootPath: projectRoot,
});
const { task } = await mutation("/api/tasks", {
  projectId: project.id,
  title: "生成并按退回要求精简虚构交接文件",
  goal: "验证 Pi Task 能在同一个 Pi 对话中完成首次交付、人工退回、第二个 Run 修改和最终验收。",
  acceptanceCriteria: [
    "创建项目根目录下的 handoff.md",
    "文件包含标题“# Pi Task Gate C 虚构交接”",
    "文件包含“状态：等待人工验收”和“数据：仅用于虚构测试”",
    "每个 Run 都回读真实文件并通过 submit_task_review 提交验收",
  ].join("；"),
  expectedOutput: "handoff.md，一份只包含虚构测试信息的 Markdown 文件",
  status: "ready",
});

const first = await executeRun(
  task,
  "请执行已绑定的 Pi Task。先调用 read_task，按验收标准创建并回读 handoff.md；确认真实内容后调用 submit_task_review。不要创建其他文件，不要使用任何真实资料。",
);
const firstContent = await artifactContent();
const firstReview = latestReview(first.detail);
const firstVerified = first.detail.status === "in_review"
  && firstReview?.status === "submitted"
  && containsRequired(firstContent)
  && reviewArtifacts(first.detail, firstReview).length === 1;
printReview("第一轮交付", first.detail, firstContent);
if (!firstVerified) {
  throw new Error("First Run did not produce a valid submitted Review");
}

const rl = createInterface({ input: stdin, output: stdout });
console.log(`\n预设退回要求：${returnReason}`);
const returnAnswer = await rl.question("输入 r 退回并启动同一对话的第二个 Run；其他键停止在待验收：");
if (returnAnswer.trim().toLowerCase() !== "r") {
  const partial = {
    generatedAt: new Date().toISOString(),
    provider: first.model.provider,
    model: first.model.id,
    taskId: first.detail.id,
    sessionId: first.session.sessionId,
    phase: "first_review",
    firstRun: { id: first.run.id, status: first.detail.runs.at(-1)?.status, contentVerified: firstVerified },
    humanAccepted: false,
  };
  await writeFile(resultPath, `${JSON.stringify(partial, null, 2)}\n`, { mode: 0o600 });
  rl.close();
  console.log(`测试停在第一轮待验收。非敏感结果：${resultPath}`);
  process.exit(0);
}

const returned = await mutation(`/api/tasks/${encodeURIComponent(task.id)}/review`, {
  action: "return",
  version: first.detail.version,
  reason: returnReason,
});
if (returned.task.status !== "ready" || latestReview(returned.task)?.status !== "rejected") {
  throw new Error(`Review return did not restore ready state: ${JSON.stringify(returned.task)}`);
}

const second = await executeRun(
  returned.task,
  "请继续处理同一个 Pi Task。先调用 read_task 读取最新退回要求，直接修改现有 handoff.md，回读验证修改确实发生后，再调用 submit_task_review。不要创建其他文件。",
  first.session.sessionId,
);
const secondContent = await artifactContent();
const secondReview = latestReview(second.detail);
const nonEmptyLineCount = secondContent?.split("\n").filter((line) => line.trim()).length ?? 0;
const returnRequirementsVerified = Boolean(secondContent
  && secondContent.includes("## 人工退回修订")
  && nonEmptyLineCount <= 20);
const secondVerified = second.detail.status === "in_review"
  && secondReview?.status === "submitted"
  && containsRequired(secondContent)
  && returnRequirementsVerified
  && firstContent !== secondContent
  && reviewArtifacts(second.detail, secondReview).length === 1;
printReview("第二轮返工交付", second.detail, secondContent);
console.log(`同一 Session：${second.session.sessionId === first.session.sessionId ? "是" : "否"}`);
console.log(`退回要求验证：${returnRequirementsVerified ? "通过" : "未通过"}（非空行 ${nonEmptyLineCount}）`);

let finalDetail = second.detail;
let humanAccepted = false;
if (secondVerified) {
  const acceptAnswer = await rl.question("\n你是否验收第二轮虚构产物？输入 y 验收，其他键保留待验收：");
  if (acceptAnswer.trim().toLowerCase() === "y") {
    finalDetail = (await mutation(`/api/tasks/${encodeURIComponent(task.id)}/review`, {
      action: "accept",
      version: second.detail.version,
    })).task;
    humanAccepted = finalDetail.status === "done";
    console.log(`人工验收已记录，任务状态：${finalDetail.status}`);
  }
}
rl.close();

const result = {
  generatedAt: new Date().toISOString(),
  provider: second.model.provider,
  model: second.model.id,
  taskId: finalDetail.id,
  sessionId: first.session.sessionId,
  sessionReused: second.session.sessionId === first.session.sessionId,
  returnReason,
  firstRun: {
    id: first.run.id,
    status: finalDetail.runs.find((run) => run.id === first.run.id)?.status ?? null,
    reviewStatus: finalDetail.reviews.find((review) => review.runId === first.run.id)?.status ?? null,
    contentVerified: firstVerified,
    artifactContent: firstContent,
  },
  secondRun: {
    id: second.run.id,
    status: finalDetail.runs.find((run) => run.id === second.run.id)?.status ?? null,
    reviewStatus: finalDetail.reviews.find((review) => review.runId === second.run.id)?.status ?? null,
    contentVerified: secondVerified,
    returnRequirementsVerified,
    nonEmptyLineCount,
    artifactContent: secondContent,
  },
  finalTaskStatus: finalDetail.status,
  finalTaskVersion: finalDetail.version,
  artifactCount: finalDetail.artifacts.length,
  reviewCount: finalDetail.reviews.length,
  eventTypes: finalDetail.events.map((event) => event.type),
  humanAccepted,
  usage: await usageSummary(second.session.sessionFile),
};
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(`\n非敏感测试结果：${resultPath}`);

if (!secondVerified || !humanAccepted || !result.sessionReused) {
  process.exitCode = 1;
}
