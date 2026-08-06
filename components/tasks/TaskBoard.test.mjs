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

test("opens a project on its most actionable non-empty task column", () => {
  assert.match(source, /const focusOrder: TaskStatus\[\] = \["in_review", "in_progress", "ready", "backlog", "blocked", "done", "canceled"\]/);
  assert.match(source, /board\.scrollTo\(\{ left, behavior: "smooth" \}\)/);
  assert.match(source, /aria-label="任务状态栏，可横向滚动"/);
});
