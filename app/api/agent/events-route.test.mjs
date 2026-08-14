import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentEventsSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const runningEventsSource = await readFile(new URL("./running/events/route.ts", import.meta.url), "utf8");

test("agent SSE forwards Pi 0.84 delta events and seeds reconnecting clients", () => {
  assert.match(agentEventsSource, /toClientAgentEvent\(event\)/);
  assert.match(agentEventsSource, /session\.getStreamingMessageSnapshot\(\)/);
  assert.match(agentEventsSource, /type: "message_start", message: streamingMessage, snapshot: true/);
  assert.doesNotMatch(agentEventsSource, /delete clientEvent\.assistantMessageEvent/);
});

test("SSE routes reuse one TextEncoder per stream", () => {
  for (const source of [agentEventsSource, runningEventsSource]) {
    assert.equal((source.match(/new TextEncoder\(\)/g) ?? []).length, 1);
    assert.match(source, /controller\.enqueue\(encoder\.encode\(text\)\)/);
    assert.match(source, /controller\.enqueue\(encoder\.encode\(":\\n\\n"\)\)/);
  }
});
