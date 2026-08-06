"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

function resolveLoopbackHostname(value) {
  const hostname = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    throw new Error("Pi Task only supports loopback hosts: 127.0.0.1 or localhost.");
  }
  return hostname;
}

function parseLaunchOptions(args = process.argv.slice(2), env = process.env) {
  const { values: cliArgs } = parseArgs({
    args,
    options: {
      port:      { type: "string", short: "p" },
      hostname:  { type: "string", short: "H" },
      "no-open": { type: "boolean" },
    },
    strict: false,
  });

  const hostname = resolveLoopbackHostname(
    cliArgs.hostname ?? env.PI_WEB_HOSTNAME ?? "127.0.0.1",
  );

  return {
    port: cliArgs.port ?? env.PORT ?? "30142",
    hostname,
    openBrowser: !cliArgs["no-open"] && !isEnabled(env.PI_WEB_NO_OPEN),
  };
}

module.exports = { parseLaunchOptions };
