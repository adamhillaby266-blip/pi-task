import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("reports invalid model cwd states instead of silently returning an empty list", () => {
  assert.match(source, /function modelErrorResponse\(/);
  assert.match(source, /modelErrorResponse\("cwd_unavailable", 400\)/);
  assert.match(source, /modelErrorResponse\("cwd_not_directory", 400\)/);
  assert.match(source, /modelErrorResponse\("access_denied", 403\)/);
  assert.doesNotMatch(source, /catch \{\s*return Response\.json\(EMPTY_MODELS\);\s*\}/);
});

test("honors only an explicit refresh request when bypassing the local models cache", () => {
  assert.match(source, /url\.searchParams\.get\("refresh"\) === "1"/);
  assert.match(source, /invalidateModelsCache\(\)/);
  assert.match(source, /does not invoke a model/);
});
