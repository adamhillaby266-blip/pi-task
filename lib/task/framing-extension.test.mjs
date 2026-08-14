import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildPiTaskWorkDiscipline,
  buildTaskFramingSystemPrompt,
  createTaskFramingExtension,
  summarizeTaskContractForAgent,
} = await jiti.import("./framing-extension.ts");
const { getTaskFramingBranchState, TASK_FRAMING_CUSTOM_TYPE } = await jiti.import("./framing-session.ts");

function item(id, text, status = "confirmed") {
  return { id, text, status };
}

function contract(title = "虚构季度成本复盘", options = {}) {
  return {
    schemaVersion: 1,
    title,
    outcome: item("outcome", "解释虚构成本变化并形成决策依据"),
    audience: [item("audience", "虚构生产负责人", "agent_suggestion")],
    authoritativeSources: [{
      ...item("source", "虚构成本明细表"),
      availability: "available",
    }],
    scope: {
      included: [item("included", "FY2025 虚构数据")],
      excluded: [item("excluded", "真实财务数据")],
    },
    deliverables: [{
      ...item("deliverable", "可回读的复盘文档", "agent_suggestion"),
      kind: "file",
      suggestedPath: "docs/fictional-review.md",
    }],
    acceptanceCriteria: [item("acceptance", "关键汇总可从虚构来源回读")],
    constraints: [item("constraint", "不得使用真实公司数据")],
    assumptions: [item("assumption", "虚构字段定义稳定", "assumption")],
    openDecisions: options.blocked ? [{
      id: "decision",
      question: "是否单列虚构物流费用？",
      blocking: true,
      status: "open",
      options: ["单列", "合并"],
    }] : [],
    gates: [{
      id: "gate",
      trigger: "对外发送前",
      requiredAction: "再次取得用户确认",
      timing: "before_external_effect",
    }],
  };
}

function userEntry(id = "u1", parentId = null) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-14T00:00:00.000Z",
    message: { role: "user", content: "请整理虚构交付" },
  };
}

function framingEntry(id, parentId, data) {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: "2026-08-14T00:00:01.000Z",
    customType: TASK_FRAMING_CUSTOM_TYPE,
    data,
  };
}

function harness({ entries = [userEntry()], task = null, activeTools = ["suggest_task_framing", "propose_task_contract"] } = {}) {
  const tools = new Map();
  const events = new Map();
  let nextEntry = 1;
  let leafId = entries.at(-1)?.id ?? null;
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { events.set(name, handler); },
    getActiveTools() { return [...activeTools]; },
    appendEntry(customType, data) {
      const id = `entry-${nextEntry++}`;
      entries.push(framingEntry(id, leafId, data));
      leafId = id;
    },
  };
  const extension = createTaskFramingExtension({
    resolveTaskForSession: () => task,
    createId: (prefix) => `${prefix}_fixed`,
  });
  extension.factory(pi);
  const ctx = {
    sessionManager: {
      getEntries: () => entries,
      getLeafId: () => leafId,
      getSessionId: () => "session-framing-test",
    },
  };
  return {
    tools,
    events,
    entries,
    ctx,
    appendRaw(id, data) {
      entries.push(framingEntry(id, leafId, data));
      leafId = id;
    },
    get leafId() { return leafId; },
  };
}

async function execute(tool, params, ctx) {
  return tool.execute("tool-test", params, new AbortController().signal, undefined, ctx);
}

test("suggest_task_framing records one low-pressure Session event and never creates a draft", async () => {
  const f = harness();
  const tool = f.tools.get("suggest_task_framing");
  assert.ok(tool);

  const first = await execute(tool, { reason: "需要跨回合核对虚构交付" }, f.ctx);
  assert.equal(first.details.recorded, true);
  assert.equal(first.details.entryId, "entry-1");
  assert.equal(f.entries.at(-1).data.eventType, "suggested");
  assert.equal(f.entries.at(-1).data.suggestionId, "tfs_fixed");
  assert.equal(f.entries.some((entry) => entry.data?.eventType === "draft"), false);

  const second = await execute(tool, { reason: "不应重复" }, f.ctx);
  assert.equal(second.details.recorded, false);
  assert.match(second.details.reason, /still pending/);
  assert.equal(f.entries.length, 2);
});

test("propose_task_contract appends canonical revisions and rejects stale replacement ids", async () => {
  const f = harness();
  const tool = f.tools.get("propose_task_contract");
  assert.ok(tool);

  const first = await execute(tool, {
    contract: contract("虚构初稿", { blocked: true }),
    replacesEntryId: null,
    changeSummary: ["形成初版边界"],
  }, f.ctx);
  assert.equal(first.details.entryId, "entry-1");
  assert.equal(first.details.revision, 1);
  assert.equal(first.details.readiness.ready, false);
  assert.equal(f.entries.at(-1).data.draftId, "tfd_fixed");
  assert.equal(f.entries.at(-1).data.taskId, null);

  await assert.rejects(
    execute(tool, {
      contract: contract("过期改稿"),
      replacesEntryId: "not-latest",
      changeSummary: ["错误覆盖"],
    }, f.ctx),
    /\[DRAFT_STALE\].*entry-1/,
  );
  assert.equal(f.entries.length, 2);

  const second = await execute(tool, {
    contract: contract("虚构确认稿"),
    replacesEntryId: "entry-1",
    changeSummary: ["解决虚构物流口径"],
  }, f.ctx);
  assert.equal(second.details.entryId, "entry-2");
  assert.equal(second.details.revision, 2);
  assert.equal(second.details.readiness.ready, true);
  assert.equal(f.entries.at(-1).data.draftId, "tfd_fixed");
  assert.equal(f.entries.at(-1).data.replacesEntryId, "entry-1");
  assert.match(second.content[0].text, /has not created or changed a Task or Run/);
});

test("proposal permissions honor declined branches, reopened state, bound Tasks, and active Runs", async () => {
  const declinedEntries = [
    userEntry(),
    framingEntry("declined", "u1", {
      schemaVersion: 1,
      eventType: "declined",
      suggestionId: "tfs_old",
    }),
  ];
  const declined = harness({ entries: declinedEntries });
  await assert.rejects(
    execute(declined.tools.get("propose_task_contract"), {
      contract: contract(),
      replacesEntryId: null,
      changeSummary: [],
    }, declined.ctx),
    /\[FRAMING_DECLINED\]/,
  );

  declined.appendRaw("reopened", {
    schemaVersion: 1,
    eventType: "reopened",
    suggestionId: "tfs_old",
  });
  const reopened = await execute(declined.tools.get("propose_task_contract"), {
    contract: contract(),
    replacesEntryId: null,
    changeSummary: ["用户重新打开"],
  }, declined.ctx);
  assert.equal(reopened.details.recorded, true);

  const active = harness({
    task: {
      id: "tsk_bound",
      title: "已有虚构 Task",
      goal: "检查权限",
      acceptanceCriteria: "活动 Run 不改合同",
      expectedOutput: "decision.md",
      status: "in_progress",
      version: 4,
      activeRunId: "run_active",
    },
  });
  const suggestion = await execute(active.tools.get("suggest_task_framing"), { reason: "不应建议" }, active.ctx);
  assert.equal(suggestion.details.recorded, false);
  assert.match(suggestion.details.reason, /already bound/);
  await assert.rejects(
    execute(active.tools.get("propose_task_contract"), {
      contract: contract(),
      replacesEntryId: null,
      changeSummary: [],
    }, active.ctx),
    /\[ACTIVE_RUN_EXISTS\]/,
  );
  assert.equal(active.entries.length, 1);
});

test("before_agent_start injects only the latest compact candidate and preserves Task authority", async () => {
  const f = harness({
    task: {
      id: "tsk_authority",
      title: "SQLite 权威任务",
      goal: "保留权威边界",
      acceptanceCriteria: "只注入最新候选",
      expectedOutput: "contract.md",
      status: "ready",
      version: 7,
      activeRunId: null,
    },
  });
  const tool = f.tools.get("propose_task_contract");
  await execute(tool, {
    contract: contract("不应再次注入的旧草案"),
    replacesEntryId: null,
    changeSummary: ["初版"],
  }, f.ctx);
  await execute(tool, {
    contract: contract("只注入这个最新草案"),
    replacesEntryId: "entry-1",
    changeSummary: ["第二版"],
  }, f.ctx);

  const result = f.events.get("before_agent_start")({ systemPrompt: "BASE" }, f.ctx);
  assert.match(result.systemPrompt, /^BASE/);
  assert.match(result.systemPrompt, /Authoritative SQLite Task: tsk_authority · v7 · ready/);
  assert.match(result.systemPrompt, /只注入这个最新草案/);
  assert.match(result.systemPrompt, /replacesEntryId exactly "entry-2"/);
  assert.doesNotMatch(result.systemPrompt, /不应再次注入的旧草案/);
  assert.ok(result.systemPrompt.length < 40_000);

  const state = getTaskFramingBranchState(f.entries, f.leafId);
  const direct = buildTaskFramingSystemPrompt(state, null);
  assert.match(direct, /Current candidate entry: entry-2/);
  assert.match(summarizeTaskContractForAgent(contract()), /before_external_effect/);

  assert.match(buildPiTaskWorkDiscipline(), /smallest effective deliverable/);
  assert.match(buildPiTaskWorkDiscipline(), /not an operating-system sandbox/);

  const writeOnly = harness({ activeTools: ["write"] });
  const disciplined = writeOnly.events.get("before_agent_start")({ systemPrompt: "WRITE" }, writeOnly.ctx);
  assert.match(disciplined.systemPrompt, /^WRITE/);
  assert.match(disciplined.systemPrompt, /Pi Task — Work discipline/);
  assert.doesNotMatch(disciplined.systemPrompt, /Task Framing/);

  const inactive = harness({ activeTools: [] });
  assert.equal(inactive.events.get("before_agent_start")({ systemPrompt: "EMPTY" }, inactive.ctx), undefined);
});
