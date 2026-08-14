import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("uses the Pi Task product name in the primary sidebar", () => {
  assert.match(source, /function PiTaskTitle\(\)/);
  assert.match(source, /: "Pi Task"/);
  assert.doesNotMatch(source, /: "Pi Web"/);
});

test("only Shift+click bypasses session deletion confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*void performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("presents one working directory with visible rule sources instead of a second Project concept", () => {
  assert.match(source, /sidebar\.currentDirectory/);
  assert.match(source, /directoryLabel\(selectedCwd\)/);
  assert.match(source, /\/api\/workspace-context\?cwd=/);
  assert.match(source, /sidebar\.rulesNotSandbox/);
  assert.doesNotMatch(source, /新建项目/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\("\/api\/agent\/running"/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});
