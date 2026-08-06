import assert from "node:assert/strict";
import test from "node:test";
import { MACOS_LAUNCH_AGENT_LABEL, renderMacosLaunchAgent } from "./macos-launch-agent.mjs";

test("renders a loopback-only user LaunchAgent without Pi data overrides", () => {
  const plist = renderMacosLaunchAgent({
    nodePath: "/opt/homebrew/bin/node",
    projectRoot: "/Users/A & B/Pi Task",
    homeDirectory: "/Users/A & B",
    logDirectory: "/Users/A & B/Library/Logs/Pi Task",
    pathValue: "/opt/homebrew/bin:/usr/bin:/bin",
  });

  assert.match(plist, new RegExp(`<string>${MACOS_LAUNCH_AGENT_LABEL}</string>`));
  assert.match(plist, /<string>127\.0\.0\.1<\/string>/);
  assert.match(plist, /<string>30142<\/string>/);
  assert.match(plist, /<string>--no-open<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /Users\/A &amp; B/);
  assert.doesNotMatch(plist, /PI_CODING_AGENT_DIR|PI_TASK_DATA_DIR|PI_TASK_NEXT_DIST_DIR/);
});

test("rejects unsafe launch agent text", () => {
  assert.throws(
    () => renderMacosLaunchAgent({
      nodePath: "/bin/node\0bad",
      projectRoot: "/project",
      homeDirectory: "/Users/test",
      logDirectory: "/tmp/logs",
      pathValue: "/usr/bin",
    }),
    /nodePath/,
  );
});
