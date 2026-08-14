export type WorkspaceRootRecord = { rootPath: string };

function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//");
}

export function normalizeWorkspacePath(value: string): string {
  let normalized = value.trim().replaceAll("\\", "/");
  if (normalized === "/") return normalized;
  if (/^[a-zA-Z]:\/$/.test(normalized)) return normalized.toLowerCase();
  normalized = normalized.replace(/\/+$/, "");
  return isWindowsPath(value) ? normalized.toLowerCase() : normalized;
}

export function workspaceContainsPath(rootPath: string, candidatePath: string): boolean {
  const root = normalizeWorkspacePath(rootPath);
  const candidate = normalizeWorkspacePath(candidatePath);
  if (!root || !candidate) return false;
  if (root === candidate) return true;
  if (root === "/") return candidate.startsWith("/");
  return candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export function findMostSpecificWorkspace<T extends WorkspaceRootRecord>(
  records: readonly T[],
  activePath: string | null,
): T | null {
  if (!activePath) return null;
  return records
    .filter((record) => workspaceContainsPath(record.rootPath, activePath))
    .sort((left, right) => (
      normalizeWorkspacePath(right.rootPath).length - normalizeWorkspacePath(left.rootPath).length
    ))[0] ?? null;
}

export function workspaceDisplayName(value: string): string {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized || normalized === "/" || /^[a-z]:\/$/.test(normalized)) return normalized || value;
  return normalized.split("/").filter(Boolean).at(-1) ?? value;
}
