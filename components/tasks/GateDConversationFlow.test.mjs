import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dialogSource = await readFile(new URL("./TaskFromConversationDialog.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../AppShell.tsx", import.meta.url), "utf8");
const agentHookSource = await readFile(new URL("../../hooks/useAgentSession.ts", import.meta.url), "utf8");
const taskRouteSource = await readFile(new URL("../../app/api/tasks/route.ts", import.meta.url), "utf8");

test("conversation conversion binds a persisted idle Session inside the Project root", () => {
  assert.match(taskRouteSource, /resolveSessionPath\(primarySessionId\)/);
  assert.match(taskRouteSource, /header\.id !== primarySessionId/);
  assert.match(taskRouteSource, /isExistingPathWithinRoots\(header\.cwd, new Set\(\[project\.rootPath\]\)\)/);
  assert.match(taskRouteSource, /getRpcSession\(primarySessionId\)\?\.isRunning\(\)/);
  assert.match(taskRouteSource, /primarySessionId/);
});

test("conversation dialog confirms a complete contract and prepares without auto-sending", () => {
  assert.match(dialogSource, /status: "ready"/);
  assert.match(dialogSource, /primarySessionId: conversation\.sessionId/);
  assert.match(dialogSource, /\/prepare`/);
  assert.match(dialogSource, /不会自动发送或调用模型/);
  assert.doesNotMatch(dialogSource, /sendAgentCommand|type:\s*"prompt"/);
  assert.match(dialogSource, /验收条件/);
  assert.match(dialogSource, /预期产物/);
});

test("Agent shell offers conversion only after Task lookup and same-Session recovery for ready Tasks", () => {
  assert.match(appShellSource, /resolvedTaskSessionId === selectedSession\.id/);
  assert.match(appShellSource, />整理为任务<\/button>/);
  assert.match(appShellSource, /activeTask\.status === "ready"/);
  assert.match(appShellSource, />\{taskActionPending \? "准备中…" : "继续处理"\}<\/button>/);
});

test("a Run started before prompt dispatch is compensated when dispatch cannot begin", () => {
  assert.match(agentHookSource, /taskRunStarted = Boolean\(await startPendingTask/);
  assert.match(agentHookSource, /if \(taskRunStarted && !promptRequestStarted\) \{\s*await interruptActiveTaskRun/);
  assert.match(agentHookSource, /onAgentEnd\?\.\(\)/);
});
