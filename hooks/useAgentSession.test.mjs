import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");

test("keeps the session event stream open through the idle grace window", () => {
  const finishSource = source.slice(
    source.indexOf("const finishPromptWithoutStream"),
    source.indexOf("const waitForPromptSettlement"),
  );
  const graceSource = source.slice(
    source.indexOf("const scheduleEventStreamClose"),
    source.indexOf("const finishPromptWithoutStream"),
  );
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "agent_settled"'),
  );
  const agentStartSource = source.slice(
    source.indexOf('case "agent_start"'),
    source.indexOf('case "agent_end"'),
  );
  const agentSettledSource = source.slice(
    source.indexOf('case "agent_settled"'),
    source.indexOf('case "prompt_done"'),
  );
  const promptDoneSource = source.slice(
    source.indexOf('case "prompt_done"'),
    source.indexOf('case "prompt_error"'),
  );
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(source, /const EVENT_STREAM_IDLE_GRACE_MS = 30_000/);
  assert.match(graceSource, /setTimeout\(\(\) => void checkServerIdle\(\), EVENT_STREAM_IDLE_GRACE_MS\)/);
  assert.match(graceSource, /fetch\(`\/api\/agent\/\$\{encodeURIComponent\(sid\)\}`\)/);
  assert.match(graceSource, /closeEvents\(\)/);
  assert.match(finishSource, /scheduleEventStreamClose\(sid\)/);
  assert.doesNotMatch(finishSource, /closeEvents\(\)/);
  assert.doesNotMatch(agentEndSource, /closeEvents\(\)/);
  assert.match(agentStartSource, /cancelEventStreamGrace\(\)/);
  assert.match(agentSettledSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(agentSettledSource, /onAgentEnd\?\.\(\)/);
  assert.match(promptDoneSource, /notifyPromptStage\(runId\)/);
  assert.match(promptDoneSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(sendSource, /if \(promptRequestStarted && sentSessionId && !definitelyRejected\) \{[\s\S]*?waitForPromptSettlement/);
  assert.match(sendSource, /if \(promptRequestStarted && sentSessionId && !definitelyRejected\) \{[\s\S]*?return;[\s\S]*?\}[\s\S]*?closeEvents\(\)/);
  assert.match(sendSource, /e instanceof AgentCommandRejectedError/);
  assert.match(source, /activeTaskStartIntentRef\.current = startIntent/);
  assert.match(sendSource, /taskRunStarted \|\| Boolean\(activeTaskStartIntentRef\.current\)/);
  assert.match(sendSource, /if \(pendingTaskStart\) onTaskStartFailed\?\.\(/);
  assert.match(chatWindowSource, /pendingTaskStart, onTaskStarted, onTaskStartFailed/);
  assert.match(sendSource, /if \(message && !options\?\.programmatic\) opts\.chatInputRef\?\.current\?\.insertIfEmpty\(message\)/);
});

test("keeps failed model loads actionable and supports an explicit local retry", () => {
  const loadModelsSource = source.slice(
    source.indexOf("const loadModels = useCallback"),
    source.indexOf("const handleBuiltinSlashCommand"),
  );

  assert.match(loadModelsSource, /params\.set\("refresh", "1"\)/);
  assert.match(loadModelsSource, /if \(!res\.ok\)/);
  assert.match(loadModelsSource, /resolveModelLoadIssue\(res\.status, d\.errorCode\)/);
  assert.match(loadModelsSource, /setModelLoadIssue\("unavailable"\)/);
  assert.match(source, /const refreshModels = useCallback\(\(\) => loadModels\(undefined, true\), \[loadModels\]\)/);
});

test("assembles Pi 0.84 delta-only assistant updates until authoritative message_end", () => {
  const messageUpdateSource = source.slice(
    source.indexOf('case "message_update"'),
    source.indexOf('case "message_end"'),
  );

  assert.match(source, /applyAssistantMessageEvent/);
  assert.match(messageUpdateSource, /event\.assistantMessageEvent/);
  assert.match(messageUpdateSource, /assistantMessageStreamRef\.current\.message/);
  assert.match(source, /assistantMessageStreamRef\.current = createAssistantMessageStreamAccumulator\(\)/);
});

test("reuses an open event stream and hides an empty agent phase", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureEventsConnected"),
    source.indexOf("const respondToExtensionUi"),
  );

  assert.match(ensureSource, /eventSourceSessionIdRef\.current === sid/);
  assert.match(ensureSource, /current\.readyState === EventSource\.OPEN/);
  assert.match(ensureSource, /attempt\?\.source === current && attempt\.pending/);
  assert.match(chatWindowSource, /agentRunning && !streamState\.streamingMessage && agentPhase/);
  assert.match(chatWindowSource, /return null;/);
});

test("plays the enabled sound once for each extension dialog", () => {
  assert.match(chatWindowSource, /soundedExtensionDialogIdRef = useRef<string \| null>\(null\)/);
  assert.match(
    chatWindowSource,
    /soundedExtensionDialogIdRef\.current === extensionDialog\.id/,
  );
  assert.match(chatWindowSource, /soundedExtensionDialogIdRef\.current = extensionDialog\.id/);
  assert.match(chatWindowSource, /playDoneSoundRef\.current\(\)/);
});
