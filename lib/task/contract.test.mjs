import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  TaskContractValidationError,
  checkTaskContractReadiness,
  createLegacyTaskContractCandidate,
  parseTaskContract,
  projectTaskContractToLegacyFields,
} = await jiti.import("./contract.ts");

function item(id, text, status = "confirmed") {
  return { id, text, status };
}

function validContract() {
  return {
    schemaVersion: 1,
    title: "本财年印制成本变化分析",
    outcome: item("outcome", "判断成本变化的主要原因"),
    audience: [item("audience", "供虚构生产设计负责人调整预算")],
    authoritativeSources: [{
      ...item("source", "虚构生产成本总表"),
      availability: "available",
      evidence: [{ kind: "project_file", label: "成本总表", ref: "fixtures/costs.xlsx" }],
    }],
    scope: {
      included: [item("scope-in", "虚构 FY2025 印制费用")],
      excluded: [item("scope-out", "版税")],
    },
    deliverables: [{
      ...item("deliverable", "异常明细表", "agent_suggestion"),
      kind: "file",
      suggestedPath: "output/analysis.xlsx",
    }],
    acceptanceCriteria: [item("acceptance", "汇总总额与权威原表一致")],
    constraints: [item("constraint", "不修改原始资料")],
    assumptions: [item("assumption", "物流费用单列", "assumption")],
    openDecisions: [],
    gates: [{
      id: "gate",
      trigger: "需要发送管理摘要时",
      requiredAction: "再次取得用户确认",
      timing: "before_external_effect",
    }],
  };
}

test("parses and canonicalizes a rich task contract", () => {
  const source = validContract();
  source.title = `  ${source.title}  `;
  source.outcome.text = ` ${source.outcome.text} `;

  const parsed = parseTaskContract(source);

  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.title, "本财年印制成本变化分析");
  assert.equal(parsed.outcome.text, "判断成本变化的主要原因");
  assert.equal(parsed.authoritativeSources[0].evidence[0].ref, "fixtures/costs.xlsx");
  assert.notEqual(parsed, source);
});

test("computes readiness without a model-generated score", () => {
  const ready = parseTaskContract(validContract());
  assert.deepEqual(checkTaskContractReadiness(ready), {
    ready: true,
    blockerIds: [],
    checks: [
      { id: "title", label: "任务标题", ready: true, detail: "已明确" },
      { id: "outcome", label: "要解决的问题", ready: true, detail: "已明确" },
      { id: "source_strategy", label: "权威来源", ready: true, detail: "已有来源或可接受的来源策略" },
      { id: "deliverables", label: "预期交付", ready: true, detail: "已明确" },
      { id: "acceptance", label: "验收方法", ready: true, detail: "已明确" },
      { id: "blocking_decisions", label: "阻塞决定", ready: true, detail: "没有未解决的阻塞决定" },
    ],
  });

  const blockedSource = validContract();
  blockedSource.authoritativeSources[0].availability = "missing";
  blockedSource.openDecisions = [{
    id: "baseline-decision",
    question: "与预算还是上一财年比较？",
    blocking: true,
    status: "open",
    options: ["预算", "上一财年"],
  }];
  const blocked = checkTaskContractReadiness(parseTaskContract(blockedSource));
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockerIds, ["baseline-decision"]);
  assert.equal(blocked.checks.find((check) => check.id === "source_strategy").ready, false);
  assert.equal(blocked.checks.find((check) => check.id === "blocking_decisions").detail, "还需决定 1 项");
});

test("projects the rich contract into deterministic legacy fields", () => {
  const projected = projectTaskContractToLegacyFields(parseTaskContract(validContract()));

  assert.equal(projected.goal, "判断成本变化的主要原因\n\n受众与用途：\n- 供虚构生产设计负责人调整预算");
  assert.equal(projected.acceptanceCriteria, "- 汇总总额与权威原表一致");
  assert.equal(projected.expectedOutput, "- 异常明细表（建议路径：output/analysis.xlsx）");
});

test("rejects duplicate ids and unsupported trust states", () => {
  const duplicate = validContract();
  duplicate.acceptanceCriteria[0].id = "outcome";
  duplicate.audience[0].status = "certain";

  assert.throws(
    () => parseTaskContract(duplicate),
    (error) => {
      assert.equal(error instanceof TaskContractValidationError, true);
      assert.match(error.message, /duplicates id 'outcome'/);
      assert.match(error.message, /unsupported value/);
      return true;
    },
  );
});

test("rejects oversized contracts before recursively parsing them", () => {
  const oversized = validContract();
  oversized.outcome.text = "x".repeat(300 * 1024);

  assert.throws(
    () => parseTaskContract(oversized),
    (error) => error instanceof TaskContractValidationError && /exceeds 262144 bytes/.test(error.message),
  );
});

test("adapts legacy fields as an unconfirmed and blocked candidate", () => {
  const candidate = createLegacyTaskContractCandidate({
    id: "tsk_legacy",
    title: "旧版任务",
    goal: "整理旧数据",
    acceptanceCriteria: "数字可回读",
    expectedOutput: "output/result.xlsx",
  });
  const readiness = checkTaskContractReadiness(candidate);

  assert.equal(candidate.outcome.status, "assumption");
  assert.equal(candidate.outcome.evidence[0].kind, "task");
  assert.equal(candidate.authoritativeSources[0].availability, "missing");
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockerIds, ["legacy-source-decision"]);
});
