import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { toClientAgentEvent } = await jiti.import("./agent-event-projection.ts");
const {
  applyAssistantMessageEvent,
  createAssistantMessageStreamAccumulator,
} = await jiti.import("./assistant-message-stream.ts");

async function createFixture(t, name) {
  const root = await mkdtemp(join(tmpdir(), `pi-task-sdk-${name}-`));
  const cwd = join(root, "fictional-project");
  const agentDir = join(root, "pi-agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([cwd, agentDir, sessionDir].map((path) => mkdir(path, { recursive: true })));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd, agentDir, sessionDir };
}

async function createFauxRuntime(provider) {
  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  return { credentials, modelRuntime };
}

function contentText(message, type) {
  return message?.content?.find((block) => block.type === type)?.[type === "text" ? "text" : "thinking"];
}

test("Pi 0.84 restores sessions, switches faux models, streams deltas, and compacts without credentials", async (t) => {
  const { cwd, agentDir, sessionDir } = await createFixture(t, "lifecycle");
  const faux = fauxProvider({
    provider: "faux-upgrade",
    models: [
      { id: "analyst", reasoning: false },
      { id: "auditor", reasoning: true },
    ],
  });
  const { credentials, modelRuntime } = await createFauxRuntime(faux);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
  });
  const sessionManager = SessionManager.create(cwd, sessionDir);
  const analyst = faux.getModel("analyst");
  const auditor = faux.getModel("auditor");
  assert.ok(analyst && auditor);

  faux.setResponses([
    fauxAssistantMessage([
      fauxThinking("Inspect only fictional facts."),
      fauxText(`analysis:${"A".repeat(5_000)}`),
    ]),
  ]);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: analyst,
    sessionManager,
    settingsManager,
    tools: [],
  });
  t.after(() => session.dispose());

  let accumulator = createAssistantMessageStreamAccumulator();
  let finalMessage;
  const wireUpdates = [];
  session.subscribe((event) => {
    const projected = toClientAgentEvent(event);
    if (!projected) return;
    if (projected.type === "message_start" && projected.message?.role === "assistant") {
      accumulator = createAssistantMessageStreamAccumulator(projected.message);
    } else if (projected.type === "message_update") {
      wireUpdates.push(projected);
      accumulator = applyAssistantMessageEvent(accumulator, projected.assistantMessageEvent);
    } else if (projected.type === "message_end" && projected.message?.role === "assistant") {
      finalMessage = projected.message;
    }
  });

  await session.prompt("Analyze the fictional record.");

  assert.ok(wireUpdates.length > 0);
  assert.ok(wireUpdates.every((event) => !("message" in event)));
  assert.ok(wireUpdates.every((event) => !("partial" in event.assistantMessageEvent)));
  assert.equal(contentText(accumulator.message, "thinking"), contentText(finalMessage, "thinking"));
  assert.equal(contentText(accumulator.message, "text"), contentText(finalMessage, "text"));

  await session.setModel(auditor);
  assert.equal(session.model?.id, "auditor");
  faux.setResponses([fauxAssistantMessage(fauxText(`audit:${"B".repeat(5_000)}`))]);
  await session.prompt("Audit the same fictional record independently.");

  faux.setResponses([
    fauxAssistantMessage(fauxText("## Goal\nPreserve fictional history")),
    fauxAssistantMessage(fauxText("## Goal\nPreserve the latest fictional turn")),
  ]);
  const compacted = await session.compact("Retain only fictional validation facts.");
  assert.match(compacted.summary, /fictional/i);

  const sessionFile = session.sessionFile;
  const sessionId = session.sessionId;
  assert.ok(sessionFile);
  const entries = sessionManager.getEntries();
  assert.equal(entries.filter((entry) => entry.type === "message").length, 4);
  assert.equal(entries.at(-1)?.type, "compaction");
  assert.deepEqual(await credentials.list(), []);

  session.dispose();
  const restoredManager = SessionManager.open(sessionFile, sessionDir);
  const { session: restored } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    sessionManager: restoredManager,
    settingsManager,
    tools: [],
  });
  try {
    assert.equal(restored.sessionId, sessionId);
    assert.equal(restored.model?.id, "auditor");
    assert.ok(restored.messages.length > 0);
    assert.equal(restoredManager.getEntries().at(-1)?.type, "compaction");
  } finally {
    restored.dispose();
  }
});

test("Pi 0.84 aborts an in-flight faux stream and preserves an aborted final message", async (t) => {
  const { cwd, agentDir } = await createFixture(t, "abort");
  const faux = fauxProvider({
    provider: "faux-abort",
    tokensPerSecond: 100,
    models: [{ id: "slow-fictional", reasoning: false }],
  });
  const { modelRuntime } = await createFauxRuntime(faux);
  faux.setResponses([fauxAssistantMessage(fauxText("X".repeat(1_000)))]);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    tools: [],
  });
  t.after(() => session.dispose());

  let resolveFirstDelta;
  const firstDelta = new Promise((resolve) => { resolveFirstDelta = resolve; });
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      resolveFirstDelta();
    }
  });

  const prompt = session.prompt("Produce a long fictional response.");
  await firstDelta;
  await session.abort();
  await prompt;

  const final = session.messages.at(-1);
  assert.equal(final?.role, "assistant");
  assert.equal(final?.stopReason, "aborted");
  assert.ok((final?.content?.[0]?.text?.length ?? 0) < 1_000);
});
