import assert from "node:assert/strict";
import test from "node:test";
import { isTaskDomainError, TaskDomainError } from "./errors.ts";

test("recognizes branded task errors without trusting lookalike objects", () => {
  const error = new TaskDomainError("INVALID_TRANSITION", "not allowed", 409);
  assert.equal(isTaskDomainError(error), true);
  assert.equal(isTaskDomainError({ name: "TaskDomainError", code: "INVALID_TRANSITION", message: "forged", status: 409 }), false);
  assert.equal(isTaskDomainError(new Error("ordinary failure")), false);
});
