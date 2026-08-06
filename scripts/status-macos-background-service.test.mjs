import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const projectRoot = process.cwd();
const scriptPath = join(projectRoot, "scripts", "status-macos-background-service.sh");

async function writeExecutable(path, content) {
  await writeFile(path, content, { mode: 0o700 });
  await chmod(path, 0o700);
}

test("macOS service status uses its loopback base URL under nounset", async (t) => {
  const runtimeRoot = join(projectRoot, ".runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(runtimeRoot, "macos-status-test-"));
  const binDirectory = join(temporaryDirectory, "bin");
  const homeDirectory = join(temporaryDirectory, "home");
  await mkdir(binDirectory, { recursive: true });
  await mkdir(join(homeDirectory, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(join(homeDirectory, "Library", "LaunchAgents", "com.pi-task.local.plist"), "test");
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  await writeExecutable(join(binDirectory, "uname"), "#!/usr/bin/env bash\necho Darwin\n");
  await writeExecutable(join(binDirectory, "launchctl"), "#!/usr/bin/env bash\nexit 0\n");
  await writeExecutable(join(binDirectory, "node"), `#!/usr/bin/env bash
cat >/dev/null
if [[ "$2" == */api/network/status ]]; then
  echo "网络：HTTP macOS 系统代理；HTTPS macOS 系统代理"
else
  printf '200'
fi
`);

  const result = spawnSync("bash", ["-u", scriptPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDirectory,
      PATH: `${binDirectory}:/usr/bin:/bin`,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /页面：http:\/\/127\.0\.0\.1:30142\/（HTTP 200）/);
  assert.match(result.stdout, /网络：HTTP macOS 系统代理；HTTPS macOS 系统代理/);
  assert.doesNotMatch(result.stderr, /unbound variable/);
});
