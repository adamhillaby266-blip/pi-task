import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const projectRoot = process.cwd();
const upgradeScript = join(projectRoot, "scripts", "upgrade-macos-background-service.sh");
const commandScript = join(projectRoot, "bin", "upgrade-pi-task-macos.command");

test("macOS background upgrade requires an explicit idle confirmation before any system check", () => {
  const result = spawnSync("bash", [upgradeScript], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--confirm-idle/);
  assert.doesNotMatch(result.stdout, /launchctl|next build/i);
});

test("macOS background upgrade refuses non-macOS hosts without changing a service", () => {
  const result = spawnSync("bash", [upgradeScript, "--confirm-idle"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /只能在 macOS 执行/);
  assert.doesNotMatch(result.stdout, /开始 macOS 隔离构建/);
});

test("upgrade path isolates the build, proves it foreground first, then restores LaunchAgent ownership", async () => {
  const source = await readFile(upgradeScript, "utf8");

  assert.match(source, /git status --porcelain/);
  assert.match(source, /run-macos-local-build\.sh/);
  assert.match(source, /promote-macos-local-build\.sh/);
  assert.match(source, /launchctl bootout/);
  assert.match(source, /launchctl bootstrap/);
  assert.match(source, /scripts\/status-macos-background-service\.sh/);
  assert.match(source, /previousDist/);
  assert.doesNotMatch(source, /PI_CODING_AGENT_DIR|PI_TASK_DATA_DIR|HTTP_PROXY|HTTPS_PROXY/);
});

test("double-clickable upgrade entry point asks for confirmation before invoking the service upgrade", async () => {
  const source = await readFile(commandScript, "utf8");

  assert.match(source, /输入 UPGRADE 继续/);
  assert.match(source, /upgrade-macos-background-service\.sh" --confirm-idle/);
  assert.doesNotMatch(source, /PI_CODING_AGENT_DIR|PI_TASK_DATA_DIR|HTTP_PROXY|HTTPS_PROXY/);
});
