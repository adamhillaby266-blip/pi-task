export type ModelLoadIssue = "cwd_unavailable" | "access_denied" | "unavailable";

/**
 * Turn the intentionally small error surface of /api/models into a UI state.
 * Never pass server error text through here: model/runtime failures can contain
 * local paths or provider diagnostics that belong in the local service log.
 */
export function resolveModelLoadIssue(status: number, errorCode?: unknown): ModelLoadIssue {
  if (errorCode === "cwd_unavailable" || errorCode === "cwd_not_directory" || status === 400) {
    return "cwd_unavailable";
  }
  if (errorCode === "access_denied" || status === 403) return "access_denied";
  return "unavailable";
}
