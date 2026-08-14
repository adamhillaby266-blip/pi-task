import { dirname, resolve } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

export type WorkspaceRuleScope = "personal" | "current" | "parent";

export interface WorkspaceRuleSource {
  path: string;
  scope: WorkspaceRuleScope;
}

export function listWorkspaceRuleSources(cwd: string, agentDir: string): WorkspaceRuleSource[] {
  const resolvedCwd = resolve(cwd);
  const personalPath = resolve(agentDir, "AGENTS.md");
  return loadProjectContextFiles({ cwd: resolvedCwd, agentDir })
    .map((file) => {
      const path = resolve(file.path);
      const scope: WorkspaceRuleScope = path === personalPath
        ? "personal"
        : dirname(path) === resolvedCwd
          ? "current"
          : "parent";
      return { path, scope };
    });
}
