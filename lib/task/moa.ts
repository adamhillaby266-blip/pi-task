import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { DelegationProfile, DelegationUsage } from "./types.ts";
import { getTaskDataDirectory } from "./store.ts";

const MAX_CONCURRENCY = 3;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_EVENT_LINE_BYTES = 1024 * 1024;
const MAX_STORED_OUTPUT_BYTES = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const PROFILE_PROMPTS: Record<DelegationProfile, string> = {
  scout: [
    "Act as a fast evidence scout.",
    "Locate the most relevant project files and facts, cite exact paths, and separate verified facts from inference.",
    "Do not propose edits unless the delegated question explicitly asks for options.",
  ].join(" "),
  analyst: [
    "Act as an independent analyst.",
    "Compare evidence, identify assumptions and trade-offs, and return a concise recommendation grounded in project files.",
    "Call out missing evidence instead of filling gaps with guesses.",
  ].join(" "),
  critic: [
    "Act as a skeptical reviewer.",
    "Look for contradictions, safety problems, untested paths, and reasons the parent agent's likely approach could fail.",
    "Return actionable findings ordered by severity.",
  ].join(" "),
};

export interface ReadonlyDelegationRequest {
  id: string;
  profile: DelegationProfile;
  prompt: string;
}

export interface ReadonlyDelegationResult {
  id: string;
  profile: DelegationProfile;
  status: "succeeded" | "failed" | "canceled";
  output: string;
  error: string | null;
  usage: DelegationUsage;
  model: string;
  stopReason: string | null;
}

export interface RunReadonlyDelegationsOptions {
  cwd: string;
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  requests: ReadonlyDelegationRequest[];
  signal?: AbortSignal;
  dataDirectory?: string;
  cliPath?: string;
  guardExtensionPath?: string;
  timeoutMs?: number;
  onResult?: (result: ReadonlyDelegationResult, completed: number, total: number) => void;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(target: Usage, candidate: unknown): void {
  if (!candidate || typeof candidate !== "object") return;
  const usage = candidate as Partial<Usage>;
  const cost = usage.cost;
  const number = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };
  target.input += number(usage.input);
  target.output += number(usage.output);
  target.cacheRead += number(usage.cacheRead);
  target.cacheWrite += number(usage.cacheWrite);
  target.totalTokens += number(usage.totalTokens);
  target.cost.input += number(cost?.input);
  target.cost.output += number(cost?.output);
  target.cost.cacheRead += number(cost?.cacheRead);
  target.cost.cacheWrite += number(cost?.cacheWrite);
  target.cost.total += number(cost?.total);
}

function storedUsage(usage: Usage): DelegationUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: usage.cost.total,
  };
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  let kept = combined.slice(-maxBytes);
  while (Buffer.byteLength(kept, "utf8") > maxBytes) kept = kept.slice(1);
  return kept;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const total = Buffer.byteLength(value, "utf8");
  if (total <= maxBytes) return value;
  let kept = value.slice(0, maxBytes);
  while (Buffer.byteLength(kept, "utf8") > maxBytes) kept = kept.slice(0, -1);
  return `${kept}\n\n[Delegated output truncated: ${total - Buffer.byteLength(kept, "utf8")} bytes omitted.]`;
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((block): block is { type: "text"; text: string } => (
      Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join("\n");
}

export function resolveMoaCliPath(): string {
  const candidate = resolve(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  if (!existsSync(candidate)) throw new Error("Pi CLI entry point is unavailable for delegated agents");
  return candidate;
}

export function resolveMoaGuardPath(): string {
  const candidate = resolve(process.cwd(), "bin", "moa-readonly-guard.mjs");
  if (!existsSync(candidate)) throw new Error("Pi Task read-only delegation guard is unavailable");
  return candidate;
}

async function runOne(
  options: RunReadonlyDelegationsOptions,
  request: ReadonlyDelegationRequest,
): Promise<ReadonlyDelegationResult> {
  const usage = emptyUsage();
  const model = `${options.model.provider}/${options.model.id}`;
  const projectRoot = realpathSync(options.cwd);
  const runtimeRoot = join(options.dataDirectory ?? getTaskDataDirectory(), "moa-tmp");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const tempDirectory = await mkdtemp(join(runtimeRoot, "delegate-"));
  const systemPromptPath = join(tempDirectory, "system.md");
  const taskPath = join(tempDirectory, "task.md");
  const systemPrompt = [
    "You are a read-only specialist delegated by a parent Pi Task agent.",
    PROFILE_PROMPTS[request.profile],
    "Use only read, grep, find, and ls. Never attempt to mutate files, run commands, or access paths outside the registered project root.",
    "You cannot change Task or Run state and cannot submit or accept a Review.",
    "Return: verified findings with exact file paths, important uncertainty, and a short handoff to the parent agent.",
  ].join("\n\n");
  await Promise.all([
    writeFile(systemPromptPath, systemPrompt, { encoding: "utf8", mode: 0o600 }),
    writeFile(taskPath, request.prompt, { encoding: "utf8", mode: 0o600 }),
  ]);

  let finalOutput = "";
  let stderr = "";
  let stopReason: string | null = null;
  let errorMessage: string | null = null;
  let lineBuffer = "";
  let canceled = false;
  let timedOut = false;

  try {
    const cliPath = options.cliPath ?? resolveMoaCliPath();
    const guardPath = options.guardExtensionPath ?? resolveMoaGuardPath();
    const args = [
      cliPath,
      "--mode", "json",
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--tools", "read,grep,find,ls",
      "--extension", guardPath,
      "--model", model,
      "--thinking", options.thinkingLevel,
      "--system-prompt", systemPromptPath,
      `@${taskPath}`,
    ];

    const exitCode = await new Promise<number>((resolveExit) => {
      const child = spawn(process.execPath, args, {
        cwd: projectRoot,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_TASK_MOA_ROOT: projectRoot,
          PI_TASK_MOA_DELEGATION_ID: request.id,
          PI_SESSION_ID: undefined,
          PI_SESSION_FILE: undefined,
          PI_PROVIDER: undefined,
          PI_MODEL: undefined,
          PI_REASONING_LEVEL: undefined,
        },
      });
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        killTimer.unref();
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timeout.unref();

      const abort = () => {
        canceled = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        killTimer.unref();
      };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });

      const processLine = (line: string) => {
        if (!line.trim() || Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "message_end") return;
        const message = (event as { message?: unknown }).message;
        if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return;
        const text = assistantText(message);
        if (text) finalOutput = text;
        addUsage(usage, (message as { usage?: unknown }).usage);
        const reason = (message as { stopReason?: unknown }).stopReason;
        if (typeof reason === "string") stopReason = reason;
        const messageError = (message as { errorMessage?: unknown }).errorMessage;
        if (typeof messageError === "string" && messageError.trim()) errorMessage = messageError.trim();
      };

      child.stdout.on("data", (data: Buffer) => {
        lineBuffer += data.toString("utf8");
        if (Buffer.byteLength(lineBuffer, "utf8") > MAX_EVENT_LINE_BYTES) {
          lineBuffer = "";
          errorMessage = "Delegated agent emitted an oversized JSON event";
          child.kill("SIGTERM");
          return;
        }
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr = appendBounded(stderr, data.toString("utf8"), MAX_STDERR_BYTES);
      });
      child.on("error", (error) => {
        errorMessage = error.message;
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
        if (lineBuffer.trim()) processLine(lineBuffer);
        resolveExit(code ?? 1);
      });
    });

    finalOutput = truncateUtf8(finalOutput, MAX_STORED_OUTPUT_BYTES);
    if (canceled || stopReason === "aborted") {
      return {
        id: request.id,
        profile: request.profile,
        status: "canceled",
        output: finalOutput,
        error: "Delegated agent was canceled",
        usage: storedUsage(usage),
        model,
        stopReason,
      };
    }
    if (timedOut) errorMessage = `Delegated agent exceeded ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`;
    if (exitCode !== 0 || stopReason === "error" || errorMessage) {
      return {
        id: request.id,
        profile: request.profile,
        status: "failed",
        output: finalOutput,
        error: errorMessage || stderr.trim() || `Delegated Pi process exited with code ${exitCode}`,
        usage: storedUsage(usage),
        model,
        stopReason,
      };
    }
    if (!finalOutput.trim()) {
      return {
        id: request.id,
        profile: request.profile,
        status: "failed",
        output: "",
        error: stderr.trim() || "Delegated agent returned no textual output",
        usage: storedUsage(usage),
        model,
        stopReason,
      };
    }
    return {
      id: request.id,
      profile: request.profile,
      status: "succeeded",
      output: finalOutput,
      error: null,
      usage: storedUsage(usage),
      model,
      stopReason,
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function runReadonlyDelegations(
  options: RunReadonlyDelegationsOptions,
): Promise<ReadonlyDelegationResult[]> {
  if (options.requests.length < 2 || options.requests.length > 4) {
    throw new Error("Readonly MoA requires 2 to 4 delegated requests");
  }
  const results: ReadonlyDelegationResult[] = new Array(options.requests.length);
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(MAX_CONCURRENCY, options.requests.length);
  await Promise.all(new Array(workerCount).fill(null).map(async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= options.requests.length) return;
      const result = await runOne(options, options.requests[index]);
      results[index] = result;
      completed += 1;
      options.onResult?.(result, completed, options.requests.length);
    }
  }));
  return results;
}

export function aggregateDelegationUsage(results: ReadonlyDelegationResult[]): Usage {
  const usage = emptyUsage();
  for (const result of results) {
    usage.input += result.usage.input;
    usage.output += result.usage.output;
    usage.cacheRead += result.usage.cacheRead;
    usage.cacheWrite += result.usage.cacheWrite;
    usage.totalTokens += result.usage.totalTokens;
    usage.cost.total += result.usage.cost;
  }
  return usage;
}
