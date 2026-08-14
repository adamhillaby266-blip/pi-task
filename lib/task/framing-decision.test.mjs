import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildTaskDecisionOptionMessage } = await jiti.import("./framing-decision.ts");

test("a decision option becomes an auditable user message without authorizing execution", () => {
  const message = buildTaskDecisionOptionMessage({
    decisionId: "dependency-upgrade",
    question: "是否重建依赖？",
    option: "只授权依赖重建与核验",
  });

  assert.match(message, /是否重建依赖/);
  assert.match(message, /我的选择：“只授权依赖重建与核验”/);
  assert.match(message, /更新当前任务约定并解决这项决定/);
  assert.match(message, /不直接开始执行/);
  assert.match(message, /不替代约定中的后续确认门/);
  assert.doesNotMatch(message, /npm ci|git push/);
});
