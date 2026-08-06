import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { renderMacosLaunchAgent } from "../lib/macos-launch-agent.mjs";

const [output, nodePath, projectRoot, homeDirectory, logDirectory, pathValue] = process.argv.slice(2);
if (![output, nodePath, projectRoot, homeDirectory, logDirectory, pathValue].every((value) => typeof value === "string" && value)) {
  throw new Error("Usage: write-macos-launch-agent.mjs <output> <node> <project-root> <home> <logs> <PATH>");
}

const plist = renderMacosLaunchAgent({ nodePath, projectRoot, homeDirectory, logDirectory, pathValue });
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, plist, { encoding: "utf8", mode: 0o600 });
