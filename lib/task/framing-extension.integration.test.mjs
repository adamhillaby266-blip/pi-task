import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getRpcSession, startRpcSession } = await jiti.import("../rpc-manager.ts");
const { getTaskDatabasePath } = await jiti.import("./store.ts");
const { parseTaskFramingEntry, TASK_FRAMING_CUSTOM_TYPE } = await jiti.import("./framing-session.ts");

function item(id, text, status = "confirmed") {
  return { id, text, status };
}

function contract(title) {
  return {
    schemaVersion: 1,
    title,
    outcome: item("outcome", "形成一份可验证的虚构交付说明"),
    audience: [item("audience", "虚构项目负责人", "agent_suggestion")],
    authoritativeSources: [{
      ...item("source", "在执行阶段检查虚构项目文件", "agent_suggestion"),
      availability: "discover_during_run",
    }],
    scope: {
      included: [item("included", "只处理虚构内容")],
      excluded: [item("excluded", "真实公司与个人资料")],
    },
    deliverables: [{
      ...item("deliverable", "虚构交付说明", "agent_suggestion"),
      kind: "file",
      suggestedPath: "docs/fictional-delivery.md",
    }],
    acceptanceCriteria: [item("acceptance", "文件存在且关键内容可回读")],
    constraints: [item("constraint", "不得触发外部发送")],
    assumptions: [],
    openDecisions: [],
    gates: [],
  };
}

async function waitForPrompt(session, message) {
  await new Promise((resolvePromise, rejectPromise) => {
    const unsubscribe = session.onEvent((event) => {
      if (event.type === "prompt_error") {
        unsubscribe();
        rejectPromise(new Error(String(event.errorMessage)));
      } else if (event.type === "prompt_done") {
        unsubscribe();
        resolvePromise();
      }
    });
    void session.send({ type: "prompt", message }).catch((error) => {
      unsubscribe();
      rejectPromise(error);
    });
  });
}

test("the default RPC Framing Extension uses the main faux Agent and only appends a Session candidate", async (t) => {
  const runtimeRoot = resolve(".runtime", "tests");
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, "task-framing-faux-"));
  const cwd = join(root, "fictional-project");
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const agentDir = join(root, "pi-agent");
  const taskData = join(root, "task-data");
  await Promise.all([cwd, home, tmp, agentDir, taskData].map((path) => mkdir(path, { recursive: true })));

  const previous = Object.fromEntries(["HOME", "TMPDIR", "PI_CODING_AGENT_DIR", "PI_TASK_DATA_DIR"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: home,
    TMPDIR: tmp,
    PI_CODING_AGENT_DIR: agentDir,
    PI_TASK_DATA_DIR: taskData,
  });

  const faux = fauxProvider({
    provider: "faux-task-framing",
    models: [{ id: "main-framer", reasoning: false }],
  });
  const observedSystemPrompts = [];
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("propose_task_contract", {
      contract: contract("主 Agent 起草的虚构任务约定"),
      replacesEntryId: null,
      changeSummary: ["主 Agent 形成第一版候选"],
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("候选任务约定已在当前对话中展示，尚未保存为 Task。")),
    (context) => {
      observedSystemPrompts.push(context.systemPrompt || "");
      return fauxAssistantMessage(fauxText("我会继续以最新候选约定为准讨论。"));
    },
  ]);

  const providerExtension = {
    name: "faux-task-framing-provider",
    factory(pi) { pi.registerProvider(faux.provider); },
  };
  const temporaryId = `__task_framing_faux__${Date.now()}`;
  let session;
  let realSessionId;
  t.after(async () => {
    try { await session?.shutdown(); } catch { /* best effort */ }
    if (realSessionId) getRpcSession(realSessionId)?.destroy();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const started = await startRpcSession(temporaryId, "", cwd, {
    initialModel: { provider: "faux-task-framing", modelId: "main-framer" },
    thinkingLevel: "off",
    extensionFactories: [providerExtension],
  });
  session = started.session;
  realSessionId = started.realSessionId;
  await session.waitUntilReady();

  const toolNames = session.inner.getAllTools().map((tool) => tool.name);
  assert.ok(toolNames.includes("suggest_task_framing"));
  assert.ok(toolNames.includes("propose_task_contract"));

  await waitForPrompt(session, "请主 Agent 把这项虚构交付整理成任务约定。不要创建 Task 或开始执行。");
  await waitForPrompt(session, "继续讨论，但不要保存或开始。只使用当前最新候选。" );

  const entries = session.inner.sessionManager.getEntries();
  const framingEntries = entries.filter((entry) => entry.type === "custom" && entry.customType === TASK_FRAMING_CUSTOM_TYPE);
  assert.equal(framingEntries.length, 1);
  const event = parseTaskFramingEntry(framingEntries[0]);
  assert.equal(event.eventType, "draft");
  assert.equal(event.revision, 1);
  assert.equal(event.contract.title, "主 Agent 起草的虚构任务约定");
  assert.equal(event.taskId, null);
  assert.equal(event.baseTaskVersion, null);

  assert.equal(faux.state.callCount, 3, "one main Agent tool loop plus one later main-Agent turn was expected");
  assert.equal(faux.getPendingResponseCount(), 0);
  assert.equal(observedSystemPrompts.length, 1);
  assert.match(observedSystemPrompts[0], new RegExp(`Current candidate entry: ${framingEntries[0].id}`));
  assert.match(observedSystemPrompts[0], /主 Agent 起草的虚构任务约定/);
  assert.doesNotMatch(observedSystemPrompts[0], /Task .* was created|Run .* started/);

  assert.equal(existsSync(getTaskDatabasePath()), false, "Framing must not initialize or write SQLite");
  assert.equal(entries.some((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "delegate_readonly_agents"), false);
});
