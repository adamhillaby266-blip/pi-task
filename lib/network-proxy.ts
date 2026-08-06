import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";
export const MACOS_NETWORK_PROXY_CONFIG_PATH = ".pi-task/network.env";

type ProxyConfigKey = "HTTP_PROXY" | "HTTPS_PROXY" | "NO_PROXY";
type ProxyConfigValues = Partial<Record<ProxyConfigKey, string>>;

const PROXY_CONFIG_KEYS: ReadonlyMap<string, ProxyConfigKey> = new Map([
  ["HTTP_PROXY", "HTTP_PROXY"],
  ["http_proxy", "HTTP_PROXY"],
  ["HTTPS_PROXY", "HTTPS_PROXY"],
  ["https_proxy", "HTTPS_PROXY"],
  ["NO_PROXY", "NO_PROXY"],
  ["no_proxy", "NO_PROXY"],
]);

type ProxySource = "environment" | "local-config" | "macos-system" | "direct";
type NoProxySource = "environment" | "local-config" | "default" | "unset";
type LocalConfigState = "not-used" | "missing" | "loaded" | "insecure" | "invalid" | "unreadable";
type MacosSystemState = "not-applicable" | "unchecked" | "checked" | "unavailable";

export type NetworkProxyWarning =
  | "local_config_insecure"
  | "local_config_invalid"
  | "local_config_unreadable"
  | "macos_system_proxy_unavailable"
  | "macos_http_proxy_invalid"
  | "macos_https_proxy_invalid"
  | "macos_socks_proxy_requires_http"
  | "macos_pac_proxy_requires_http";

export interface NetworkProxyStatus {
  initialized: boolean;
  http: { source: ProxySource; enabled: boolean };
  https: { source: ProxySource; enabled: boolean; fallsBackToHttp: boolean };
  noProxy: { source: NoProxySource; enabled: boolean };
  localConfig: LocalConfigState;
  macosSystem: MacosSystemState;
  warnings: NetworkProxyWarning[];
}

/** Values are consumed only by Undici. They are never returned by the browser API. */
export interface NetworkProxyAgentOptions {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

export interface NetworkProxyResolution {
  agentOptions: NetworkProxyAgentOptions;
  /** Hash only; raw proxy values are never persisted in process-wide diagnostics. */
  fingerprint: string;
  status: NetworkProxyStatus;
}

interface MacosSystemProxy {
  httpProxy?: string;
  httpsProxy?: string;
  httpInvalid: boolean;
  httpsInvalid: boolean;
  socksEnabled: boolean;
  pacEnabled: boolean;
}

interface LocalConfigLoadResult {
  values: ProxyConfigValues;
  state: LocalConfigState;
  warnings: NetworkProxyWarning[];
}

interface ConfigureNetworkProxyOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  readConfig?: (path: string) => LocalConfigLoadResult;
  readMacosProxy?: () => { proxy: MacosSystemProxy; state: MacosSystemState; warnings: NetworkProxyWarning[] };
}

type ResolvedProxy = { source: ProxySource; value: string };
type ResolvedNoProxy = { source: NoProxySource; value: string };

const directMacosProxy: MacosSystemProxy = {
  httpInvalid: false,
  httpsInvalid: false,
  socksEnabled: false,
  pacEnabled: false,
};

type NetworkProxyGlobal = typeof globalThis & {
  __piTaskNetworkProxyStatus?: NetworkProxyStatus;
};

const networkProxyGlobal = globalThis as NetworkProxyGlobal;
const defaultNetworkProxyStatus: NetworkProxyStatus = {
  initialized: false,
  http: { source: "direct", enabled: false },
  https: { source: "direct", enabled: false, fallsBackToHttp: false },
  noProxy: { source: "unset", enabled: false },
  localConfig: "not-used",
  macosSystem: "not-applicable",
  warnings: [],
};

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value);
}

function isSupportedProxyUrl(value: string): boolean {
  if (!value || hasControlCharacter(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isValidNoProxyValue(value: string): boolean {
  return !hasControlCharacter(value);
}

function normalizeConfigValue(key: ProxyConfigKey, value: string): string | undefined {
  if (key === "NO_PROXY") return isValidNoProxyValue(value) ? value : undefined;
  return isSupportedProxyUrl(value) ? value : undefined;
}

function createMacosProxyUrl(host: string | undefined, port: string | undefined): string | undefined {
  const trimmedHost = host?.trim() ?? "";
  const trimmedPort = port?.trim() ?? "";
  if (!trimmedHost || !/^[0-9]+$/.test(trimmedPort)) return undefined;
  const numericPort = Number(trimmedPort);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) return undefined;
  if (/[\s/@?#\\]/.test(trimmedHost)) return undefined;

  const hostForUrl = trimmedHost.includes(":") && !trimmedHost.startsWith("[")
    ? `[${trimmedHost}]`
    : trimmedHost;
  return isSupportedProxyUrl(`http://${hostForUrl}:${numericPort}`)
    ? `http://${hostForUrl}:${numericPort}`
    : undefined;
}

export function parseMacosSystemProxy(output: string): MacosSystemProxy {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*?)\s*$/);
    if (match) values.set(match[1], match[2]);
  }

  const httpEnabled = values.get("HTTPEnable") === "1";
  const httpsEnabled = values.get("HTTPSEnable") === "1";
  const httpProxy = httpEnabled
    ? createMacosProxyUrl(values.get("HTTPProxy"), values.get("HTTPPort"))
    : undefined;
  const httpsProxy = httpsEnabled
    ? createMacosProxyUrl(values.get("HTTPSProxy"), values.get("HTTPSPort"))
    : undefined;

  return {
    httpProxy,
    httpsProxy,
    httpInvalid: httpEnabled && !httpProxy,
    httpsInvalid: httpsEnabled && !httpsProxy,
    socksEnabled: values.get("SOCKSEnable") === "1",
    pacEnabled: values.get("ProxyAutoConfigEnable") === "1",
  };
}

export function parseNetworkProxyConfig(content: string): LocalConfigLoadResult {
  const values: ProxyConfigValues = {};
  const warnings = new Set<NetworkProxyWarning>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      warnings.add("local_config_invalid");
      continue;
    }

    const key = PROXY_CONFIG_KEYS.get(match[1]);
    if (!key) {
      warnings.add("local_config_invalid");
      continue;
    }

    const value = match[2].trim();
    if (value && !normalizeConfigValue(key, value)) {
      warnings.add("local_config_invalid");
      continue;
    }
    values[key] = value;
  }

  return {
    values,
    state: warnings.size > 0 ? "invalid" : "loaded",
    warnings: [...warnings],
  };
}

export function defaultMacosNetworkProxyConfigPath(homeDirectory: string = homedir()): string {
  return join(homeDirectory, MACOS_NETWORK_PROXY_CONFIG_PATH);
}

export function readPrivateNetworkProxyConfig(path: string): LocalConfigLoadResult {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      return { values: {}, state: "insecure", warnings: ["local_config_insecure"] };
    }
    return parseNetworkProxyConfig(readFileSync(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { values: {}, state: "missing", warnings: [] };
    return { values: {}, state: "unreadable", warnings: ["local_config_unreadable"] };
  }
}

function readMacosSystemProxy(): { proxy: MacosSystemProxy; state: MacosSystemState; warnings: NetworkProxyWarning[] } {
  try {
    const output = execFileSync("/usr/sbin/scutil", ["--proxy"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    const proxy = parseMacosSystemProxy(output);
    const warnings: NetworkProxyWarning[] = [];
    if (proxy.httpInvalid) warnings.push("macos_http_proxy_invalid");
    if (proxy.httpsInvalid) warnings.push("macos_https_proxy_invalid");
    if (proxy.socksEnabled && !proxy.httpProxy && !proxy.httpsProxy) {
      warnings.push("macos_socks_proxy_requires_http");
    }
    if (proxy.pacEnabled && !proxy.httpProxy && !proxy.httpsProxy) {
      warnings.push("macos_pac_proxy_requires_http");
    }
    return { proxy, state: "checked", warnings };
  } catch {
    return {
      proxy: directMacosProxy,
      state: "unavailable",
      warnings: ["macos_system_proxy_unavailable"],
    };
  }
}

function readEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  upper: "HTTP_PROXY" | "HTTPS_PROXY" | "NO_PROXY",
  lower: "http_proxy" | "https_proxy" | "no_proxy",
): { found: boolean; value: string } {
  if (hasOwn(environment, lower) && environment[lower] !== undefined) {
    return { found: true, value: environment[lower] ?? "" };
  }
  if (hasOwn(environment, upper) && environment[upper] !== undefined) {
    return { found: true, value: environment[upper] ?? "" };
  }
  return { found: false, value: "" };
}

function resolveNetworkProxy({
  environment,
  localConfig,
  macosProxy,
  localConfigState,
  macosSystemState,
  warnings,
}: {
  environment: NodeJS.ProcessEnv;
  localConfig: ProxyConfigValues;
  macosProxy: MacosSystemProxy;
  localConfigState: LocalConfigState;
  macosSystemState: MacosSystemState;
  warnings: NetworkProxyWarning[];
}): NetworkProxyResolution {
  const httpEnvironment = readEnvironmentValue(environment, "HTTP_PROXY", "http_proxy");
  const httpsEnvironment = readEnvironmentValue(environment, "HTTPS_PROXY", "https_proxy");
  const noProxyEnvironment = readEnvironmentValue(environment, "NO_PROXY", "no_proxy");

  const resolveProxy = (
    environmentValue: { found: boolean; value: string },
    configKey: "HTTP_PROXY" | "HTTPS_PROXY",
    systemValue: string | undefined,
  ): ResolvedProxy => {
    if (environmentValue.found) {
      return { source: environmentValue.value ? "environment" : "direct", value: environmentValue.value };
    }
    if (hasOwn(localConfig, configKey)) {
      const value = localConfig[configKey] ?? "";
      return { source: value ? "local-config" : "direct", value };
    }
    if (systemValue) return { source: "macos-system", value: systemValue };
    return { source: "direct", value: "" };
  };

  const http = resolveProxy(httpEnvironment, "HTTP_PROXY", macosProxy.httpProxy);
  const https = resolveProxy(httpsEnvironment, "HTTPS_PROXY", macosProxy.httpsProxy);

  let noProxy: ResolvedNoProxy;
  if (noProxyEnvironment.found) {
    noProxy = { source: "environment", value: noProxyEnvironment.value };
  } else if (hasOwn(localConfig, "NO_PROXY")) {
    noProxy = { source: "local-config", value: localConfig.NO_PROXY ?? "" };
  } else if (http.value || https.value) {
    noProxy = { source: "default", value: DEFAULT_NO_PROXY };
  } else {
    noProxy = { source: "unset", value: "" };
  }

  const effectiveHttps = https.value
    ? { source: https.source, enabled: true, fallsBackToHttp: false }
    : http.value
      ? { source: http.source, enabled: true, fallsBackToHttp: true }
      : { source: "direct" as const, enabled: false, fallsBackToHttp: false };
  const status: NetworkProxyStatus = {
    initialized: true,
    http: { source: http.source, enabled: Boolean(http.value) },
    https: effectiveHttps,
    noProxy: { source: noProxy.source, enabled: Boolean(noProxy.value) },
    localConfig: localConfigState,
    macosSystem: macosSystemState,
    warnings: [...new Set(warnings)],
  };
  const agentOptions: NetworkProxyAgentOptions = {
    // Passing empty strings intentionally prevents EnvHttpProxyAgent from
    // silently re-reading a stale value that a previous refresh injected.
    httpProxy: http.value,
    httpsProxy: https.value,
    noProxy: noProxy.value,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      httpProxy: agentOptions.httpProxy,
      httpsProxy: agentOptions.httpsProxy,
      noProxy: agentOptions.noProxy,
      httpSource: status.http.source,
      httpsSource: status.https.source,
      noProxySource: status.noProxy.source,
    }))
    .digest("base64url");

  return { agentOptions, fingerprint, status };
}

/**
 * Resolve the current outbound network route without mutating process.env.
 * macOS system proxy values are intentionally re-read on every call so a new
 * top-level model prompt can use the currently active VPN/proxy route.
 */
export function resolveNetworkProxyConfiguration(options: ConfigureNetworkProxyOptions = {}): NetworkProxyResolution {
  const environment = options.environment ?? process.env;
  const targetPlatform = options.platform ?? process.platform;
  const configPath = targetPlatform === "darwin"
    ? defaultMacosNetworkProxyConfigPath(options.homeDirectory ?? homedir())
    : undefined;
  const localResult = configPath
    ? (options.readConfig ?? readPrivateNetworkProxyConfig)(configPath)
    : { values: {}, state: "not-used" as const, warnings: [] as NetworkProxyWarning[] };

  const hasHttpOverride = hasOwn(environment, "HTTP_PROXY")
    || hasOwn(environment, "http_proxy")
    || hasOwn(localResult.values, "HTTP_PROXY");
  const hasHttpsOverride = hasOwn(environment, "HTTPS_PROXY")
    || hasOwn(environment, "https_proxy")
    || hasOwn(localResult.values, "HTTPS_PROXY");
  const shouldReadMacosProxy = targetPlatform === "darwin" && (!hasHttpOverride || !hasHttpsOverride);
  const macosResult = shouldReadMacosProxy
    ? (options.readMacosProxy ?? readMacosSystemProxy)()
    : {
      proxy: directMacosProxy,
      state: targetPlatform === "darwin" ? "unchecked" as const : "not-applicable" as const,
      warnings: [] as NetworkProxyWarning[],
    };

  const resolution = resolveNetworkProxy({
    environment,
    localConfig: localResult.values,
    macosProxy: macosResult.proxy,
    localConfigState: localResult.state,
    macosSystemState: macosResult.state,
    warnings: [...localResult.warnings, ...macosResult.warnings],
  });
  networkProxyGlobal.__piTaskNetworkProxyStatus = resolution.status;
  return {
    ...resolution,
    agentOptions: { ...resolution.agentOptions },
    status: getNetworkProxyStatus(),
  };
}

export function getNetworkProxyStatus(): NetworkProxyStatus {
  const status = networkProxyGlobal.__piTaskNetworkProxyStatus ?? defaultNetworkProxyStatus;
  return {
    ...status,
    http: { ...status.http },
    https: { ...status.https },
    noProxy: { ...status.noProxy },
    warnings: [...status.warnings],
  };
}

export function describeNetworkProxyStatus(status: NetworkProxyStatus): string {
  const sourceName = (source: ProxySource) => ({
    environment: "standard environment variables",
    "local-config": "private local network config",
    "macos-system": "macOS system proxy",
    direct: "direct connection",
  })[source];

  if (status.https.enabled) {
    return `outbound HTTPS uses ${sourceName(status.https.source)}${status.https.fallsBackToHttp ? " (HTTP proxy fallback)" : ""}`;
  }
  return "outbound HTTPS uses direct connection";
}
