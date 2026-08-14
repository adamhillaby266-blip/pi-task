import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { buildSessionContext as buildPiModelContext } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const {
  TASK_FRAMING_CUSTOM_TYPE,
  getActiveSessionBranch,
  getTaskFramingBranchState,
  isTaskFramingCustomMessage,
  parseTaskFramingSessionEvent,
  projectTaskFramingForUi,
  readTaskFramingMessageDetails,
} = await jiti.import("./framing-session.ts");

function item(id, text, status = "confirmed") {
  return { id, text, status };
}

function contract(title = "虚构成本分析", blocked = false) {
  return {
    schemaVersion: 1,
    title,
    outcome: item("outcome", "判断成本变化原因"),
    audience: [item("audience", "供虚构负责人决策")],
    authoritativeSources: [{ ...item("source", "虚构成本表"), availability: "available" }],
    scope: { included: [item("included", "FY2025")], excluded: [] },
    deliverables: [{ ...item("deliverable", "分析表"), kind: "file" }],
    acceptanceCriteria: [item("acceptance", "总额可回读")],
    constraints: [],
    assumptions: [],
    openDecisions: blocked ? [{
      id: "decision",
      question: "是否包含物流？",
      blocking: true,
      status: "open",
      options: ["包含", "不包含"],
    }] : [],
    gates: [],
  };
}

function userEntry(id, parentId, content = "message") {
  return { type: "message", id, parentId, timestamp: "2026-08-14T00:00:00.000Z", message: { role: "user", content } };
}

function draftEntry(id, parentId, revision, options = {}) {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: `2026-08-14T00:00:0${revision}.000Z`,
    customType: TASK_FRAMING_CUSTOM_TYPE,
    data: {
      schemaVersion: 1,
      eventType: "draft",
      draftId: "tfd_test",
      revision,
      replacesEntryId: options.replacesEntryId ?? null,
      taskId: options.taskId ?? null,
      baseTaskVersion: options.baseTaskVersion ?? null,
      contract: contract(options.title ?? `草案 ${revision}`, options.blocked ?? false),
      changeSummary: options.changeSummary ?? [],
      createdBy: options.createdBy ?? "agent",
    },
  };
}

test("parses a versioned framing draft and rejects malformed entries", () => {
  const parsed = parseTaskFramingSessionEvent(draftEntry("d1", null, 1).data);
  assert.equal(parsed.eventType, "draft");
  assert.equal(parsed.revision, 1);
  assert.equal(parsed.contract.title, "草案 1");

  assert.equal(parseTaskFramingSessionEvent({ ...draftEntry("d1", null, 1).data, schemaVersion: 2 }), null);
  assert.equal(parseTaskFramingSessionEvent({ ...draftEntry("d1", null, 1).data, contract: { bad: true } }), null);
  assert.equal(parseTaskFramingSessionEvent({ ...draftEntry("d1", null, 1).data, revision: 0 }), null);
});

test("keeps framing custom entries out of the Pi model context", () => {
  const entries = [
    userEntry("u1", null, "start"),
    draftEntry("d1", "u1", 1),
    userEntry("u2", "d1", "continue"),
  ];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const modelContext = buildPiModelContext(entries, "u2", byId);

  assert.equal(modelContext.messages.some((message) => message.role === "custom" && message.customType === TASK_FRAMING_CUSTOM_TYPE), false);
  assert.deepEqual(modelContext.messages.map((message) => message.content), ["start", "continue"]);
});

test("projects the active branch and folds superseded drafts", () => {
  const entries = [
    userEntry("u1", null),
    draftEntry("d1", "u1", 1, { blocked: true }),
    userEntry("u2", "d1"),
    draftEntry("d2", "u2", 2, { replacesEntryId: "d1", changeSummary: ["解决物流范围"] }),
  ];
  const projection = projectTaskFramingForUi(entries, "d2", ["u1", "d1", "u2", "d2"]);
  const first = readTaskFramingMessageDetails(projection.byEntryId.get("d1").message.details);
  const second = readTaskFramingMessageDetails(projection.byEntryId.get("d2").message.details);

  assert.equal(projection.latestDraftEntryId, "d2");
  assert.equal(projection.restored, null);
  assert.equal(first.isLatestDraft, false);
  assert.equal(first.supersededByEntryId, "d2");
  assert.equal(first.readiness.ready, false);
  assert.equal(second.isLatestDraft, true);
  assert.equal(second.supersededByEntryId, null);
  assert.equal(second.readiness.ready, true);
  assert.equal(second.event.changeSummary[0], "解决物流范围");
});

test("restores only the latest draft when compaction omits framing state", () => {
  const entries = [
    userEntry("u1", null),
    draftEntry("d1", "u1", 1),
    userEntry("u2", "d1"),
    draftEntry("d2", "u2", 2, { replacesEntryId: "d1" }),
    userEntry("u3", "d2"),
  ];
  const projection = projectTaskFramingForUi(entries, "u3", ["u3"]);
  const restored = readTaskFramingMessageDetails(projection.restored.message.details);

  assert.equal(projection.restored.entryId, "d2");
  assert.equal(restored.isLatestDraft, true);
  assert.equal(restored.restoredAfterCompaction, true);
  assert.equal(restored.event.revision, 2);
});

test("does not leak drafts from a sibling Session branch", () => {
  const entries = [
    userEntry("root", null),
    draftEntry("shared", "root", 1),
    userEntry("main", "shared", "main branch"),
    draftEntry("main-draft", "main", 2, { replacesEntryId: "shared", title: "主分支草案" }),
    userEntry("alternate", "shared", "alternate branch"),
  ];
  const branch = getActiveSessionBranch(entries, "alternate");
  const projection = projectTaskFramingForUi(entries, "alternate", branch.map((entry) => entry.id));

  assert.deepEqual(branch.map((entry) => entry.id), ["root", "shared", "alternate"]);
  assert.equal(projection.latestDraftEntryId, "shared");
  assert.equal(projection.byEntryId.has("main-draft"), false);
});

test("derives pending, declined, and reopened preference state on the active branch", () => {
  const suggested = {
    type: "custom",
    id: "suggested",
    parentId: "u1",
    timestamp: "2026-08-14T00:00:01.000Z",
    customType: TASK_FRAMING_CUSTOM_TYPE,
    data: { schemaVersion: 1, eventType: "suggested", suggestionId: "tfs_test", reason: "跨回合交付" },
  };
  const declined = {
    type: "custom",
    id: "declined",
    parentId: "suggested",
    timestamp: "2026-08-14T00:00:02.000Z",
    customType: TASK_FRAMING_CUSTOM_TYPE,
    data: { schemaVersion: 1, eventType: "declined", suggestionId: "tfs_test" },
  };
  const reopened = {
    type: "custom",
    id: "reopened",
    parentId: "declined",
    timestamp: "2026-08-14T00:00:03.000Z",
    customType: TASK_FRAMING_CUSTOM_TYPE,
    data: { schemaVersion: 1, eventType: "reopened", suggestionId: "tfs_test" },
  };
  const entries = [userEntry("u1", null), suggested, declined, reopened];

  const pending = getTaskFramingBranchState(entries, "suggested");
  assert.equal(pending.pendingSuggestion.entry.id, "suggested");
  assert.equal(pending.declined, false);

  const refused = getTaskFramingBranchState(entries, "declined");
  assert.equal(refused.pendingSuggestion, null);
  assert.equal(refused.declined, true);

  const active = getTaskFramingBranchState(entries, "reopened");
  assert.equal(active.pendingSuggestion, null);
  assert.equal(active.declined, false);
  assert.equal(active.latestPreference.event.eventType, "reopened");
});

test("returns no framing state before the first entry and identifies projected messages", () => {
  const entries = [userEntry("u1", null), draftEntry("d1", "u1", 1)];
  const projection = projectTaskFramingForUi(entries, null, []);

  assert.equal(projection.latestDraftEntryId, null);
  assert.equal(projection.byEntryId.size, 0);
  assert.equal(projection.restored, null);
  assert.equal(isTaskFramingCustomMessage({ role: "custom", customType: TASK_FRAMING_CUSTOM_TYPE }), true);
  assert.equal(isTaskFramingCustomMessage({ role: "custom", customType: "other" }), false);
});
