import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";
import type { WorkspaceContextResponse } from "@/lib/api-types";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { listWorkspaceRuleSources } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const value = new URL(request.url).searchParams.get("cwd")?.trim();
  if (!value) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  const cwd = resolve(value);
  try {
    if (!(await stat(cwd)).isDirectory()) {
      return NextResponse.json({ error: "cwd must be a directory" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Directory does not exist" }, { status: 400 });
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const response: WorkspaceContextResponse = {
    cwd,
    ruleSources: listWorkspaceRuleSources(cwd, getAgentDir()),
    builtInDiscipline: true,
    systemSandbox: false,
  };
  return NextResponse.json(response);
}
