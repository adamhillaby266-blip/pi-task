import assert from "node:assert/strict";
import test from "node:test";

import { resolveModelLoadIssue } from "./model-load-state.ts";

test("maps a stale or non-directory session cwd to an actionable model load state", () => {
  assert.equal(resolveModelLoadIssue(400, "cwd_unavailable"), "cwd_unavailable");
  assert.equal(resolveModelLoadIssue(400, "cwd_not_directory"), "cwd_unavailable");
  assert.equal(resolveModelLoadIssue(400), "cwd_unavailable");
});

test("keeps forbidden and unknown model loading failures distinct", () => {
  assert.equal(resolveModelLoadIssue(403, "access_denied"), "access_denied");
  assert.equal(resolveModelLoadIssue(500), "unavailable");
  assert.equal(resolveModelLoadIssue(502, "unexpected"), "unavailable");
});
