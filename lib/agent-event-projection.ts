import type { AgentEvent } from "./rpc-manager";

const OMITTED_EVENT_TYPES = new Set(["turn_start", "turn_end", "tool_execution_update"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project in-process SDK events onto Pi Task's SSE wire contract.
 *
 * Pi 0.84 JSON/RPC message updates are delta-only. Keep the browser stream on
 * that contract too: cumulative messages and provider-owned `partial` snapshots
 * make a long response grow quadratically on the wire.
 */
export function toClientAgentEvent(event: AgentEvent): AgentEvent | null {
  if (OMITTED_EVENT_TYPES.has(event.type)) return null;

  if (event.type === "message_update") {
    if (!isRecord(event.assistantMessageEvent)) return null;
    const assistantMessageEvent = { ...event.assistantMessageEvent };
    delete assistantMessageEvent.partial;
    return { type: "message_update", assistantMessageEvent };
  }

  if (event.type === "agent_end") return { type: "agent_end" };
  return event;
}
