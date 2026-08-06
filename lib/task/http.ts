import { NextResponse } from "next/server";
import { isTaskDomainError, TaskDomainError } from "./errors";

const MAX_JSON_BYTES = 1_000_000;

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new TaskDomainError("INVALID_INPUT", "Request body is too large", 413);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    throw new TaskDomainError("INVALID_INPUT", "Request body is too large", 413);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TaskDomainError("INVALID_INPUT", "Request body must be valid JSON", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskDomainError("INVALID_INPUT", "Request body must be an object", 400);
  }
  return value as Record<string, unknown>;
}

export function parseVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new TaskDomainError("INVALID_INPUT", "version must be a positive integer", 400);
  }
  return Number(value);
}

export function requireBrowserUserMutation(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) {
    throw new TaskDomainError("INVALID_INPUT", "User mutations require a browser Origin", 403);
  }
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") throw new Error("invalid protocol");
  } catch {
    throw new TaskDomainError("INVALID_INPUT", "User mutation Origin is invalid", 403);
  }
  // proxy.ts has already compared Origin against the external Host. Repeating
  // that comparison here would use Next's internal localhost URL and reject
  // valid requests made through 127.0.0.1 or a trusted reverse proxy.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    throw new TaskDomainError("INVALID_INPUT", "Cross-site user mutation rejected", 403);
  }
}

export function readRunCapability(request: Request): string {
  const authorization = request.headers.get("authorization");
  const match = /^Bearer\s+(cap_[A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!match) throw new TaskDomainError("RUN_NOT_ACTIVE", "Run capability required", 403);
  return match[1];
}

export function taskApiError(error: unknown): NextResponse {
  if (isTaskDomainError(error)) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  console.error("[pi-task] task API error", error);
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: "Task operation failed" } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

export function taskJson(value: unknown, status = 200): NextResponse {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
