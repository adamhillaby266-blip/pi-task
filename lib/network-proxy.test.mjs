import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DEFAULT_NO_PROXY,
  configureNetworkProxyEnvironment,
  defaultMacosNetworkProxyConfigPath,
  getNetworkProxyStatus,
  parseMacosSystemProxy,
  parseNetworkProxyConfig,
  readPrivateNetworkProxyConfig,
} = await jiti.import("./network-proxy.ts");

const EMPTY_MACOS_PROXY = {
  httpInvalid: false,
  httpsInvalid: false,
  socksEnabled: false,
  pacEnabled: false,
};

function macosResult(proxy = EMPTY_MACOS_PROXY, warnings = []) {
  return { proxy, state: "checked", warnings };
}

test("parses only safe HTTP(S) values from macOS system proxy output", () => {
  const proxy = parseMacosSystemProxy(`
<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 7890
  HTTPSEnable : 1
  HTTPSProxy : proxy.example.test
  HTTPSPort : 8443
  SOCKSEnable : 0
  ProxyAutoConfigEnable : 0
}
`);

  assert.equal(proxy.httpProxy, "http://127.0.0.1:7890");
  assert.equal(proxy.httpsProxy, "http://proxy.example.test:8443");
  assert.equal(proxy.httpInvalid, false);
  assert.equal(proxy.httpsInvalid, false);
});

test("flags enabled macOS SOCKS and PAC modes without treating them as HTTP proxies", () => {
  const proxy = parseMacosSystemProxy(`
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
  SOCKSPort : 1080
  ProxyAutoConfigEnable : 1
`);

  assert.equal(proxy.httpProxy, undefined);
  assert.equal(proxy.httpsProxy, undefined);
  assert.equal(proxy.socksEnabled, true);
  assert.equal(proxy.pacEnabled, true);
});

test("parses a private local network config without executing its contents", () => {
  const parsed = parseNetworkProxyConfig(`
# Values are parsed as data, never sourced as shell.
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=https://proxy.example.test:8443
NO_PROXY=localhost,127.0.0.1,::1
`);

  assert.equal(parsed.state, "loaded");
  assert.deepEqual(parsed.values, {
    HTTP_PROXY: "http://127.0.0.1:7890",
    HTTPS_PROXY: "https://proxy.example.test:8443",
    NO_PROXY: "localhost,127.0.0.1,::1",
  });
  assert.deepEqual(parsed.warnings, []);
});

test("does not accept unsupported keys or SOCKS URLs in local network config", () => {
  const parsed = parseNetworkProxyConfig(`
HTTPS_PROXY=socks5://127.0.0.1:1080
NODE_OPTIONS=--require=unexpected
`);

  assert.equal(parsed.state, "invalid");
  assert.deepEqual(parsed.values, {});
  assert.deepEqual(parsed.warnings, ["local_config_invalid"]);
});

test("rejects a group-readable private network config before parsing it", async (t) => {
  const runtimeRoot = join(process.cwd(), ".runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(runtimeRoot, "network-proxy-test-"));
  const configPath = join(temporaryDirectory, "network.env");
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  await writeFile(configPath, "HTTPS_PROXY=http://127.0.0.1:7890\n", { mode: 0o644 });
  await chmod(configPath, 0o644);
  assert.deepEqual(readPrivateNetworkProxyConfig(configPath), {
    values: {},
    state: "insecure",
    warnings: ["local_config_insecure"],
  });

  await chmod(configPath, 0o600);
  assert.deepEqual(readPrivateNetworkProxyConfig(configPath), {
    values: { HTTPS_PROXY: "http://127.0.0.1:7890" },
    state: "loaded",
    warnings: [],
  });
});

test("standard environment variables take precedence over local and macOS settings", () => {
  const environment = {
    HTTP_PROXY: "http://environment.example.test:8080",
    HTTPS_PROXY: "http://environment.example.test:8080",
    NO_PROXY: "internal.example.test",
  };
  let macosReads = 0;
  const status = configureNetworkProxyEnvironment({
    environment,
    platform: "darwin",
    homeDirectory: "/Users/test",
    readConfig: () => ({
      values: { HTTPS_PROXY: "http://local.example.test:8080" },
      state: "loaded",
      warnings: [],
    }),
    readMacosProxy: () => {
      macosReads += 1;
      return macosResult({ ...EMPTY_MACOS_PROXY, httpsProxy: "http://system.example.test:8080" });
    },
  });

  assert.equal(macosReads, 0);
  assert.equal(status.http.source, "environment");
  assert.equal(status.https.source, "environment");
  assert.equal(status.noProxy.source, "environment");
  assert.equal(environment.HTTPS_PROXY, "http://environment.example.test:8080");
});

test("uses macOS system HTTP(S) proxy only when no explicit configuration exists", () => {
  const environment = {};
  const status = configureNetworkProxyEnvironment({
    environment,
    platform: "darwin",
    homeDirectory: "/Users/test",
    readConfig: () => ({ values: {}, state: "missing", warnings: [] }),
    readMacosProxy: () => macosResult({
      ...EMPTY_MACOS_PROXY,
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
    }),
  });

  assert.equal(environment.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(environment.NO_PROXY, DEFAULT_NO_PROXY);
  assert.deepEqual(status.http, { source: "macos-system", enabled: true });
  assert.deepEqual(status.https, { source: "macos-system", enabled: true, fallsBackToHttp: false });
  assert.deepEqual(status.noProxy, { source: "default", enabled: true });
  assert.equal(JSON.stringify(status).includes("127.0.0.1:7890"), false);
});

test("uses a private local config before a macOS system proxy", () => {
  const environment = {};
  const status = configureNetworkProxyEnvironment({
    environment,
    platform: "darwin",
    homeDirectory: "/Users/test",
    readConfig: () => ({
      values: { HTTPS_PROXY: "http://127.0.0.1:7890" },
      state: "loaded",
      warnings: [],
    }),
    readMacosProxy: () => macosResult({
      ...EMPTY_MACOS_PROXY,
      httpsProxy: "http://system.example.test:8080",
    }),
  });

  assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(status.https.source, "local-config");
  assert.equal(status.http.source, "direct");
  assert.equal(status.localConfig, "loaded");
});

test("does not inspect macOS proxy settings when local config defines both protocols", () => {
  const environment = {};
  let macosReads = 0;
  const status = configureNetworkProxyEnvironment({
    environment,
    platform: "darwin",
    homeDirectory: "/Users/test",
    readConfig: () => ({
      values: {
        HTTP_PROXY: "http://127.0.0.1:7890",
        HTTPS_PROXY: "http://127.0.0.1:7890",
      },
      state: "loaded",
      warnings: [],
    }),
    readMacosProxy: () => {
      macosReads += 1;
      return macosResult();
    },
  });

  assert.equal(macosReads, 0);
  assert.equal(status.macosSystem, "unchecked");
  assert.equal(status.http.source, "local-config");
  assert.equal(status.https.source, "local-config");
});

test("reports unsupported macOS SOCKS/PAC-only settings without leaking endpoint details", () => {
  const environment = {};
  const status = configureNetworkProxyEnvironment({
    environment,
    platform: "darwin",
    homeDirectory: "/Users/test",
    readConfig: () => ({ values: {}, state: "missing", warnings: [] }),
    readMacosProxy: () => macosResult({
      ...EMPTY_MACOS_PROXY,
      socksEnabled: true,
      pacEnabled: true,
    }, ["macos_socks_proxy_requires_http", "macos_pac_proxy_requires_http"]),
  });

  assert.equal(status.https.enabled, false);
  assert.deepEqual(status.warnings, ["macos_socks_proxy_requires_http", "macos_pac_proxy_requires_http"]);
  assert.equal(JSON.stringify(getNetworkProxyStatus()).includes("127.0.0.1"), false);
});

test("uses the documented default private config location on macOS", () => {
  assert.equal(
    defaultMacosNetworkProxyConfigPath("/Users/example"),
    "/Users/example/.pi-task/network.env",
  );
});
