import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sessionReaderSource = await readFile(new URL("../../lib/session-reader.ts", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../ChatWindow.tsx", import.meta.url), "utf8");
const messageViewSource = await readFile(new URL("../MessageView.tsx", import.meta.url), "utf8");
const cardSource = await readFile(new URL("./TaskContractCard.tsx", import.meta.url), "utf8");

test("Task Framing state is projected for the Web UI without becoming a normal Pi message", () => {
  assert.match(sessionReaderSource, /projectTaskFramingForUi\(entries, leafId, selectedEntryIds\)/);
  assert.match(sessionReaderSource, /projectedFraming\?\.message \?\? entryToUiMessage/);
  assert.match(messageViewSource, /customType === TASK_FRAMING_CUSTOM_TYPE/);
  assert.match(messageViewSource, /<TaskContractCard message=/);
  assert.match(messageViewSource, /onCommitted=\{onTaskFramingCommitted\}/);
  assert.match(chatWindowSource, /taskProjectRoot=\{messageCwd\}/);
  assert.doesNotMatch(chatWindowSource, /taskProjectRoot=\{session\?\.projectRoot/);
  assert.match(chatWindowSource, /sendIfEmpty\(buildTaskDecisionOptionMessage\(selection\)\)/);
  assert.match(messageViewSource, /onDecisionOption=\{onTaskDecisionOption\}/);
});

test("Task Framing cards stay outside collapsed Agent process details", () => {
  assert.match(chatWindowSource, /message\.role === "custom" && !isTaskFramingCustomMessage\(message\)/);
  assert.match(chatWindowSource, /const framingIndices = processIndices\.filter/);
  assert.match(chatWindowSource, /for \(const framingIdx of framingIndices\) \{\s*rendered\.push\(renderMessage\(framingIdx\)\)/);
});

test("Task Framing cards submit only Session references and delegate confirm-and-start orchestration", () => {
  assert.match(cardSource, /fetch\("\/api\/task-framing"/);
  assert.match(cardSource, /sourceDraftEntryId: draftEntryId/);
  assert.match(cardSource, /expectedTaskVersion: current\.task\?\.version \?\? null,\s*action,/);
  assert.doesNotMatch(cardSource, /contract:\s*event\.contract|prepareTaskSession|\/prepare|\/start|sendAgentCommand/);
  assert.match(cardSource, /onCommit\("save_draft"\)/);
  assert.match(cardSource, /onCommit\("confirm"\)/);
  assert.match(cardSource, /onCommit\("confirm_and_start"\)/);
  assert.match(cardSource, /!status\?\.actions\.confirmAndStart/);
  assert.match(cardSource, /fetch\("\/api\/projects"/);
  assert.match(cardSource, /body: JSON\.stringify\(\{ name: projectName\(projectRoot\), rootPath: projectRoot \}\)/);
  assert.match(cardSource, /候选草案 · 尚未写入 Task/);
  assert.match(cardSource, /aria-label=\{`选择：\$\{option\}`\}/);
  assert.match(cardSource, /onDecisionOption\?\.\(\{ decisionId: decision\.id, question: decision\.question, option \}\)/);
});
