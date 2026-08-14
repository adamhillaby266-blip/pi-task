import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

function framingMessage({ latest = true, blocked = false, restored = false, missingSource = false } = {}) {
  const item = (id, text, status = "confirmed") => ({ id, text, status });
  const event = {
    schemaVersion: 1,
    eventType: "draft",
    draftId: "tfd_render",
    revision: latest ? 2 : 1,
    replacesEntryId: latest ? "old-draft" : null,
    taskId: null,
    baseTaskVersion: null,
    contract: {
      schemaVersion: 1,
      title: "本财年印制成本变化分析",
      outcome: item("outcome", "判断成本变化的主要原因"),
      audience: [item("audience", "供虚构负责人调整预算")],
      authoritativeSources: [{ ...item("source", "虚构成本总表"), availability: missingSource ? "missing" : "available" }],
      scope: { included: [item("included", "虚构 FY2025")], excluded: [item("excluded", "版税")] },
      deliverables: [{ ...item("deliverable", "异常明细表", "agent_suggestion"), kind: "file" }],
      acceptanceCriteria: [item("acceptance", "总额与权威表一致")],
      constraints: [item("constraint", "不修改原始资料")],
      assumptions: [],
      openDecisions: blocked ? [{
        id: "decision",
        question: "是否包含物流？",
        blocking: true,
        status: "open",
        options: ["包含", "不包含"],
      }] : [],
      gates: [],
    },
    changeSummary: ["补充比较口径"],
    createdBy: "agent",
  };
  return {
    role: "custom",
    customType: "pi-task.task-framing",
    content: "fallback",
    display: true,
    details: {
      kind: "task_framing",
      entryId: latest ? "new-draft" : "old-draft",
      event,
      readiness: null,
      isLatestDraft: latest,
      supersededByEntryId: latest ? null : "new-draft",
      restoredAfterCompaction: restored,
    },
  };
}

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("renders a Pi Task framing draft as a native contract card", () => {
  const html = renderMessage(framingMessage({ blocked: true, restored: true }), {
    taskProjectRoot: "/fictional/workspaces/print-cost-review",
    onTaskDecisionOption: () => "sent",
  });

  assert.match(html, /任务约定 · 待决定/);
  assert.match(html, /本财年印制成本变化分析/);
  assert.match(html, /是否包含物流/);
  assert.match(html, /从完整 Session 恢复/);
  assert.match(html, /工作范围/);
  assert.match(html, /print-cost-review/);
  assert.match(html, /Agent 建议/);
  assert.match(html, /aria-label="选择：包含"/);
  assert.match(html, /aria-label="选择：不包含"/);
  assert.match(html, /task-contract-card__option/);
  assert.match(html, /确认并放入待办/);
  assert.match(html, /确认并开始/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /&quot;schemaVersion&quot;/);
});

test("shows structural readiness gaps even when there is no open blocking decision", () => {
  const html = renderMessage(framingMessage({ missingSource: true }));

  assert.match(html, /1<\/strong><span>项待补全/);
  assert.match(html, /仍缺权威来源策略/);
  assert.doesNotMatch(html, /已足够安全地开始/);
});

test("folds superseded task framing drafts instead of rendering another full card", () => {
  const html = renderMessage(framingMessage({ latest: false }));

  assert.match(html, /草案 1/);
  assert.match(html, /已取代 · 查看/);
  assert.match(html, /本财年印制成本变化分析/);
  assert.doesNotMatch(html, /确认并开始/);
});
