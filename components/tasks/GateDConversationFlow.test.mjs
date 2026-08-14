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

test("conversation shell keeps Task Framing primary and starts board Tasks as new conversations", () => {
  assert.match(appShellSource, /resolvedTaskSessionId === selectedSession\.id/);
  assert.match(appShellSource, /const TASK_FRAMING_INTENT = "我想把当前讨论整理成任务约定/);
  assert.match(appShellSource, /chatInputRef\.current\?\.sendIfEmpty\(TASK_FRAMING_INTENT\)/);
  assert.match(appShellSource, /当前已关闭工具；请切换到默认或完整工具后再整理任务约定/);
  assert.match(appShellSource, /onClick=\{handleStartTaskFraming\}/);
  assert.match(appShellSource, />一起把任务聊清楚<\/button>/);
  assert.match(appShellSource, /const handleStartTaskConversation = useCallback/);
  assert.match(appShellSource, /onStartTaskConversation=\{handleStartTaskConversation\}/);
  assert.doesNotMatch(appShellSource, />直接填写<\/button>/);
  assert.doesNotMatch(appShellSource, /TaskFromConversationDialog/);
  assert.match(appShellSource, /onTaskFramingCommitted=\{handleTaskFramingCommitted\}/);
  assert.match(appShellSource, /activeTask\.status === "ready"/);
  assert.match(appShellSource, />\{taskActionPending \? "准备中…" : "继续处理"\}<\/button>/);
  assert.match(appShellSource, /const handleFrameTask = useCallback/);
  assert.match(appShellSource, /setPendingTaskStart\(null\)/);
  assert.match(appShellSource, /setPendingTaskPrompt\(null\)/);
  assert.match(appShellSource, /onFrameTask=\{handleFrameTask\}/);
  assert.match(appShellSource, /const handleTaskStartFailed = useCallback/);
  assert.match(appShellSource, /onTaskStartFailed=\{handleTaskStartFailed\}/);
});

test("a Run started before prompt dispatch is compensated when dispatch cannot begin", () => {
  assert.match(agentHookSource, /taskRunStarted = Boolean\(await startPendingTask/);
  assert.match(agentHookSource, /const taskStartNeedsCompensation = taskRunStarted \|\| Boolean\(activeTaskStartIntentRef\.current\)/);
  assert.match(agentHookSource, /if \(taskStartNeedsCompensation && \(!promptRequestStarted \|\| definitelyRejected\)\) \{\s*await interruptActiveTaskRun/);
  assert.match(agentHookSource, /AgentCommandRejectedError/);
  assert.match(agentHookSource, /onAgentEnd\?\.\(\)/);
});
