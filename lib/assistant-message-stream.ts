import { normalizeToolCalls } from "./normalize";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, ToolCallContent } from "./types";

type StreamingAssistantMessage = Partial<AssistantMessage> & { role: "assistant" };

export interface AssistantMessageStreamAccumulator {
  message: StreamingAssistantMessage | null;
  toolCallArgumentBuffers: Record<number, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneAssistantMessage(message: Partial<AgentMessage> | null | undefined): StreamingAssistantMessage | null {
  if (!message || message.role !== "assistant") return null;
  const normalized = normalizeToolCalls(message as AgentMessage);
  const content = Array.isArray((normalized as { content?: unknown }).content)
    ? [...((normalized as { content: AssistantContentBlock[] }).content)]
    : [];
  return { ...(normalized as AssistantMessage), content };
}

export function createAssistantMessageStreamAccumulator(
  message?: Partial<AgentMessage> | null,
): AssistantMessageStreamAccumulator {
  return {
    message: cloneAssistantMessage(message),
    toolCallArgumentBuffers: {},
  };
}

function contentFor(message: StreamingAssistantMessage): AssistantContentBlock[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? [...content] as AssistantContentBlock[] : [];
}

function setBlock(
  content: AssistantContentBlock[],
  index: number,
  block: AssistantContentBlock,
): AssistantContentBlock[] {
  const next = [...content];
  while (next.length < index) next.push({ type: "text", text: "" });
  next[index] = block;
  return next;
}

function textBlock(content: AssistantContentBlock[], index: number): Extract<AssistantContentBlock, { type: "text" }> {
  const current = content[index];
  return current?.type === "text" ? current : { type: "text", text: "" };
}

function thinkingBlock(content: AssistantContentBlock[], index: number): Extract<AssistantContentBlock, { type: "thinking" }> {
  const current = content[index];
  return current?.type === "thinking" ? current : { type: "thinking", thinking: "" };
}

function toolCallBlock(content: AssistantContentBlock[], index: number): ToolCallContent {
  const current = content[index];
  return current?.type === "toolCall"
    ? current
    : { type: "toolCall", toolCallId: "", toolName: "", input: {} };
}

function parsedToolArguments(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Assemble Pi 0.84 delta-only message_update events into one live UI message. */
export function applyAssistantMessageEvent(
  accumulator: AssistantMessageStreamAccumulator,
  value: unknown,
): AssistantMessageStreamAccumulator {
  if (!isRecord(value) || typeof value.type !== "string") return accumulator;
  const index = value.contentIndex;
  if (!Number.isInteger(index) || (index as number) < 0) return accumulator;

  const contentIndex = index as number;
  const message = accumulator.message ?? { role: "assistant", content: [] };
  const content = contentFor(message);
  let nextContent = content;
  let nextBuffers = accumulator.toolCallArgumentBuffers;

  switch (value.type) {
    case "text_start":
      nextContent = setBlock(content, contentIndex, textBlock(content, contentIndex));
      break;
    case "text_delta": {
      if (typeof value.delta !== "string") return accumulator;
      const block = textBlock(content, contentIndex);
      nextContent = setBlock(content, contentIndex, { ...block, text: block.text + value.delta });
      break;
    }
    case "text_end": {
      if (typeof value.content !== "string") return accumulator;
      const block = textBlock(content, contentIndex);
      nextContent = setBlock(content, contentIndex, { ...block, text: value.content });
      break;
    }
    case "thinking_start":
      nextContent = setBlock(content, contentIndex, thinkingBlock(content, contentIndex));
      break;
    case "thinking_delta": {
      if (typeof value.delta !== "string") return accumulator;
      const block = thinkingBlock(content, contentIndex);
      nextContent = setBlock(content, contentIndex, { ...block, thinking: block.thinking + value.delta });
      break;
    }
    case "thinking_end": {
      if (typeof value.content !== "string") return accumulator;
      const block = thinkingBlock(content, contentIndex);
      nextContent = setBlock(content, contentIndex, { ...block, thinking: value.content });
      break;
    }
    case "toolcall_start":
      nextContent = setBlock(content, contentIndex, toolCallBlock(content, contentIndex));
      nextBuffers = { ...nextBuffers, [contentIndex]: "" };
      break;
    case "toolcall_delta": {
      if (typeof value.delta !== "string") return accumulator;
      const json = `${nextBuffers[contentIndex] ?? ""}${value.delta}`;
      nextBuffers = { ...nextBuffers, [contentIndex]: json };
      const parsed = parsedToolArguments(json);
      if (parsed) {
        nextContent = setBlock(content, contentIndex, {
          ...toolCallBlock(content, contentIndex),
          input: parsed,
        });
      }
      break;
    }
    case "toolcall_end": {
      if (!isRecord(value.toolCall)) return accumulator;
      const toolCall = value.toolCall;
      nextContent = setBlock(content, contentIndex, {
        type: "toolCall",
        toolCallId: typeof toolCall.id === "string" ? toolCall.id : "",
        toolName: typeof toolCall.name === "string" ? toolCall.name : "",
        input: isRecord(toolCall.arguments) ? toolCall.arguments : {},
      });
      if (contentIndex in nextBuffers) {
        nextBuffers = { ...nextBuffers };
        delete nextBuffers[contentIndex];
      }
      break;
    }
    default:
      return accumulator;
  }

  return {
    message: { ...message, content: nextContent },
    toolCallArgumentBuffers: nextBuffers,
  };
}
