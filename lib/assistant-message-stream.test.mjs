import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  applyAssistantMessageEvent,
  createAssistantMessageStreamAccumulator,
} = await jiti.import("./assistant-message-stream.ts");

function applyAll(start, events) {
  return events.reduce(applyAssistantMessageEvent, createAssistantMessageStreamAccumulator(start));
}

test("assembles interleaved text and thinking deltas by contentIndex", () => {
  const result = applyAll(
    {
      role: "assistant",
      provider: "faux",
      model: "stream-model",
      content: [],
    },
    [
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "Check" },
      { type: "text_start", contentIndex: 1 },
      { type: "text_delta", contentIndex: 1, delta: "Hel" },
      { type: "thinking_delta", contentIndex: 0, delta: " facts" },
      { type: "text_delta", contentIndex: 1, delta: "lo" },
      { type: "thinking_end", contentIndex: 0, content: "Check facts" },
      { type: "text_end", contentIndex: 1, content: "Hello" },
    ],
  );

  assert.deepEqual(result.message, {
    role: "assistant",
    provider: "faux",
    model: "stream-model",
    content: [
      { type: "thinking", thinking: "Check facts" },
      { type: "text", text: "Hello" },
    ],
  });
});

test("buffers tool arguments and uses toolcall_end as authoritative", () => {
  const result = applyAll(
    { role: "assistant", content: [] },
    [
      { type: "toolcall_start", contentIndex: 0 },
      { type: "toolcall_delta", contentIndex: 0, delta: "{\"path\":" },
      { type: "toolcall_delta", contentIndex: 0, delta: "\"fictional.txt\"}" },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "fictional.txt" },
        },
      },
    ],
  );

  assert.deepEqual(result.message.content, [{
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "read",
    input: { path: "fictional.txt" },
  }]);
  assert.deepEqual(result.toolCallArgumentBuffers, {});
});

test("continues from an SSE reconnect snapshot without losing earlier output", () => {
  const result = applyAll(
    {
      role: "assistant",
      provider: "faux",
      model: "stream-model",
      content: [{ type: "text", text: "Already " }],
    },
    [
      { type: "text_delta", contentIndex: 0, delta: "streamed" },
      { type: "text_end", contentIndex: 0, content: "Already streamed" },
    ],
  );

  assert.equal(result.message.content[0].text, "Already streamed");
});

test("ignores malformed or non-content events", () => {
  const start = createAssistantMessageStreamAccumulator({ role: "assistant", content: [] });
  assert.equal(applyAssistantMessageEvent(start, { type: "done" }), start);
  assert.equal(applyAssistantMessageEvent(start, { type: "text_delta", contentIndex: -1, delta: "x" }), start);
});
