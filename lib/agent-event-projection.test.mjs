import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { toClientAgentEvent } = await jiti.import("./agent-event-projection.ts");

test("projects message_update as a delta-only Pi 0.84 wire event", () => {
  const event = {
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: " world",
      partial: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    },
  };

  assert.deepEqual(toClientAgentEvent(event), {
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: " world",
    },
  });
  assert.ok("message" in event, "the in-process SDK event must not be mutated");
  assert.ok("partial" in event.assistantMessageEvent, "the provider delta must not be mutated");
});

test("omits noisy lifecycle fields and keeps message_end authoritative", () => {
  assert.equal(toClientAgentEvent({ type: "turn_start" }), null);
  assert.deepEqual(
    toClientAgentEvent({ type: "agent_end", messages: [{ role: "assistant" }], willRetry: false }),
    { type: "agent_end" },
  );
  const end = { type: "message_end", message: { role: "assistant", content: [] } };
  assert.equal(toClientAgentEvent(end), end);
});
