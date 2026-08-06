import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const boardSource = await readFile(new URL("./TaskBoard.tsx", import.meta.url), "utf8");
const chatSource = await readFile(new URL("../ChatWindow.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../AppShell.tsx", import.meta.url), "utf8");
const lifecycleRouteSource = await readFile(new URL("../../app/api/tasks/[id]/lifecycle/route.ts", import.meta.url), "utf8");

test("renders waiting-user state and human decision evidence in both Agent and task detail views", () => {
  assert.match(boardSource, /selectedActiveRun\?\.status === "waiting_user"/);
  assert.match(boardSource, />Pi 正在等待你的决定<\/strong>/);
  assert.match(boardSource, />人工决定记录<\/h3>/);
  assert.match(boardSource, /run\.waiting_user/);
  assert.match(boardSource, /run\.resumed/);
  assert.match(appShellSource, /activeTaskRun\?\.status === "waiting_user"/);
  assert.match(appShellSource, /"等待你决定"/);
  assert.match(chatSource, /taskUiRequestKey/);
  assert.match(chatSource, /onTaskStateChange/);
});

test("makes block, unblock, and cancel explicit reasoned lifecycle actions", () => {
  assert.match(boardSource, /setLifecycleAction\("block"\)/);
  assert.match(boardSource, /setLifecycleAction\("unblock"\)/);
  assert.match(boardSource, /setLifecycleAction\("cancel"\)/);
  assert.match(boardSource, /停止并阻塞/);
  assert.match(boardSource, /解除阻塞/);
  assert.match(boardSource, /停止并取消/);
  assert.match(boardSource, /LIFECYCLE_COPY\[lifecycleAction\]\.prompt/);
});

test("aborts an active in-process conversation before committing a block or cancel", () => {
  assert.match(lifecycleRouteSource, /await session\.send\(\{ type: "abort" \}\)/);
  assert.match(lifecycleRouteSource, /suspendActiveBinding\(task\)/);
  assert.match(lifecycleRouteSource, /restoreBinding\(snapshot\)/);
  assert.match(lifecycleRouteSource, /store\.blockTask/);
  assert.match(lifecycleRouteSource, /store\.unblockTask/);
  assert.match(lifecycleRouteSource, /store\.cancelTask/);
});
