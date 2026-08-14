import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function validateReadonlyToolPath(root, cwd, event) {
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    return "Pi Task delegation root is unavailable";
  }
  if (!READ_ONLY_TOOLS.has(event?.toolName)) {
    return `Delegated agents may only use: ${[...READ_ONLY_TOOLS].join(", ")}`;
  }
  const input = event.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "Delegated tool input must be an object";
  }
  const rawPath = input.path ?? input.file_path ?? ".";
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return "Delegated tool path must be a non-empty string";
  }

  let actual;
  try {
    const normalized = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
    actual = realpathSync(resolve(cwd, normalized));
  } catch {
    return `Delegated path does not exist: ${rawPath}`;
  }
  if (!isInside(canonicalRoot, actual)) {
    return "Delegated agents cannot read outside the registered project root";
  }
  return null;
}

export default function readonlyDelegationGuard(pi) {
  let root = null;
  try {
    const configured = process.env.PI_TASK_MOA_ROOT;
    if (configured) root = realpathSync(configured);
  } catch {
    root = null;
  }

  pi.on("tool_call", (event, ctx) => {
    if (!root) {
      return { block: true, reason: "Pi Task delegation root is unavailable", terminate: true };
    }
    const reason = validateReadonlyToolPath(root, ctx.cwd, event);
    return reason ? { block: true, reason, terminate: true } : undefined;
  });
}
