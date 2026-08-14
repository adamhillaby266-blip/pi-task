import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./TaskBoard.tsx", import.meta.url), "utf8");

test("renders localized Run and Review statuses in task details", () => {
  assert.match(source, /succeeded: "执行成功"/);
  assert.match(source, /accepted: "已验收"/);
  assert.match(source, /rejected: "已退回"/);
  assert.doesNotMatch(source, />\{run\.status\}<\/span>/);
  assert.doesNotMatch(source, />\{review\.status\}<\/span>/);
});

test("shows persistent readonly multi-Agent evidence under the parent Run", () => {
  assert.match(source, /多 Agent 协作记录/);
  assert.match(source, /DELEGATION_PROFILE_LABELS\[delegation\.profile\]/);
  assert.match(source, /DELEGATION_STATUS_LABELS\[delegation\.status\]/);
  assert.match(source, /delegation\.usage\.totalTokens/);
});

test("opens the active working directory on its most actionable non-empty task column", () => {
  assert.match(source, /const focusOrder: TaskStatus\[\] = \["in_review", "in_progress", "ready", "backlog", "blocked", "done", "canceled"\]/);
  assert.match(source, /board\.scrollTo\(\{ left, behavior: "smooth" \}\)/);
  assert.match(source, /aria-label="任务状态栏，可横向滚动"/);
});

test("follows one working directory and starts new Tasks in conversation", () => {
  assert.match(source, /findMostSpecificWorkspace\(projects, activeCwd\)/);
  assert.match(source, /findMostSpecificWorkspace\(projects, workspaceRoot\)/);
  assert.match(source, /onStartTaskConversation/);
  assert.match(source, />开始聊一个任务<\/button>/);
  assert.match(source, /只有你保存或确认任务约定后，任务才会出现在看板中/);
  assert.doesNotMatch(source, /选择项目|新建项目|新建任务|setProjectId|createProject|createTask/);
});

test("opens backlog and incomplete ready Tasks in an ordinary Framing Session", () => {
  assert.match(source, /\/framing-session`/);
  assert.match(source, /onFrameTask\(result\.task, result\.session\)/);
  assert.match(source, /"和 Pi 一起补全"/);
  assert.match(source, /临时保留的旧字段回退入口/);
  assert.doesNotMatch(source, /frameTask[\s\S]{0,1200}type:\s*"prompt"/);
});

test("summarizes rich Task agreements without replacing readiness checks", () => {
  assert.match(source, /任务约定 · R\{task\.contractRevision\}/);
  assert.match(source, /受众与用途/);
  assert.match(source, /权威来源/);
  assert.match(source, /预期交付/);
  assert.match(source, /验收方法/);
  assert.match(source, /checkTaskContractReadiness\(contract\)/);
  assert.match(source, /const missingChecks = readiness\.checks\.filter\(\(check\) => !check\.ready\)/);
  assert.match(source, /`还需补全 \$\{missingChecks\.length\} 项`/);
});
