import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./run-macos-local-build.sh", import.meta.url), "utf8");

test("macOS isolated build refuses stale dependencies without installing anything", () => {
  assert.match(source, /npm ls --depth=0 --silent/);
  assert.match(source, /已安装依赖与当前 package\.json 不一致/);
  assert.match(source, /npm ci --include=dev --ignore-scripts/);
  assert.doesNotMatch(source, /^\s*npm (?:install|ci)\b/m);
});
