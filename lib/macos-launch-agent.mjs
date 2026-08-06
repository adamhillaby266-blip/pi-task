export const MACOS_LAUNCH_AGENT_LABEL = "com.pi-task.local";

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${name} must be non-empty text without NUL bytes`);
  }
  return value;
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function string(value) {
  return `<string>${xml(value)}</string>`;
}

export function renderMacosLaunchAgent({ nodePath, projectRoot, homeDirectory, logDirectory, pathValue }) {
  const config = {
    nodePath: requiredText(nodePath, "nodePath"),
    projectRoot: requiredText(projectRoot, "projectRoot"),
    homeDirectory: requiredText(homeDirectory, "homeDirectory"),
    logDirectory: requiredText(logDirectory, "logDirectory"),
    pathValue: requiredText(pathValue, "pathValue"),
  };
  const args = [
    config.nodePath,
    `${config.projectRoot}/bin/pi-web.js`,
    "--hostname",
    "127.0.0.1",
    "--port",
    "30142",
    "--no-open",
  ];
  const environment = {
    HOME: config.homeDirectory,
    PATH: config.pathValue,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    PI_WEB_NO_OPEN: "1",
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(MACOS_LAUNCH_AGENT_LABEL)}
  <key>ProgramArguments</key>
  <array>
${args.map((argument) => `    ${string(argument)}`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  ${string(config.projectRoot)}
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment).map(([key, value]) => `    <key>${xml(key)}</key>\n    ${string(value)}`).join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  ${string(`${config.logDirectory}/pi-task.log`)}
  <key>StandardErrorPath</key>
  ${string(`${config.logDirectory}/pi-task-error.log`)}
</dict>
</plist>
`;
}
