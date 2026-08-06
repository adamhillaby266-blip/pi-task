import { EventEmitter } from "node:events";
import * as undici from "undici";
import {
  describeNetworkProxyStatus,
  getNetworkProxyStatus,
  resolveNetworkProxyConfiguration,
  type NetworkProxyResolution,
  type NetworkProxyStatus,
} from "./network-proxy";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

type ManagedHttpDispatcher = {
  dispatcher: undici.Dispatcher;
  fingerprint: string;
  timeoutMs: number;
};

type DispatcherGlobal = typeof globalThis & {
  __piWebHttpDispatcherConfigured?: boolean;
  __piTaskManagedHttpDispatcher?: ManagedHttpDispatcher;
};

const dispatcherGlobal = globalThis as DispatcherGlobal;
const originalGlobalFetch = globalThis.fetch;
const ignoreUndiciDispatcherError = (): void => {};

function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    if (trimmed.length === 0) return undefined;
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

// Undici can emit an internal Client error while terminating a response body.
// The body stream still rejects; this prevents the EventEmitter error from
// terminating the Next.js process first.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(
    new undici.Client(origin, options as undici.Client.Options),
  );
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }

  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: createUndiciClient,
    }),
  );
}

function createDispatcher(
  timeoutMs: number,
  network: NetworkProxyResolution,
): undici.Dispatcher {
  return withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      ...network.agentOptions,
      allowH2: false,
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  );
}

function reportNetworkProxyStatus(status: NetworkProxyStatus): void {
  if (status.warnings.length > 0) {
    console.warn(`[pi-task] network proxy configuration warnings: ${status.warnings.join(", ")}`);
  }
  if (status.http.enabled || status.https.enabled) {
    console.log(`[pi-task] ${describeNetworkProxyStatus(status)}`);
  }
}

function installDispatcher(timeoutMs: number, network: NetworkProxyResolution): ManagedHttpDispatcher {
  const previous = dispatcherGlobal.__piTaskManagedHttpDispatcher;
  const dispatcher = createDispatcher(timeoutMs, network);
  const managed = { dispatcher, fingerprint: network.fingerprint, timeoutMs };
  undici.setGlobalDispatcher(dispatcher);
  dispatcherGlobal.__piTaskManagedHttpDispatcher = managed;

  // A graceful close lets any unrelated fetch already using the retired agent
  // finish. New model requests use the replacement immediately.
  if (previous) {
    void previous.dispatcher.close().catch(() => {});
  }
  return managed;
}

/** Initialize the one shared dispatcher at server startup. */
export function configureHttpDispatcher(
  timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
): void {
  if (dispatcherGlobal.__piWebHttpDispatcherConfigured && dispatcherGlobal.__piTaskManagedHttpDispatcher) return;

  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }

  const network = resolveNetworkProxyConfiguration();
  reportNetworkProxyStatus(network.status);
  installDispatcher(normalizedTimeoutMs, network);

  // Keep fetch and the dispatcher on the same undici implementation. Preserve
  // an intentional fetch override installed after this module was loaded.
  if (globalThis.fetch === originalGlobalFetch) {
    undici.install?.();
  }

  dispatcherGlobal.__piWebHttpDispatcherConfigured = true;
}

export interface HttpDispatcherRefreshResult {
  refreshed: boolean;
  configurationChanged: boolean;
  status: NetworkProxyStatus;
}

/**
 * Replace the outbound connection pool before a new top-level model prompt.
 * This intentionally creates fresh sockets even when the proxy signature is
 * unchanged: VPN/TUN routing can change without changing macOS proxy fields.
 * Callers must ensure no other Rpc Session is currently running.
 */
export function refreshHttpDispatcherForNewPrompt(): HttpDispatcherRefreshResult {
  const existing = dispatcherGlobal.__piTaskManagedHttpDispatcher;
  if (!existing) {
    configureHttpDispatcher();
    return {
      refreshed: true,
      configurationChanged: false,
      status: getNetworkProxyStatus(),
    };
  }

  const network = resolveNetworkProxyConfiguration();
  const configurationChanged = existing.fingerprint !== network.fingerprint;
  installDispatcher(existing.timeoutMs, network);
  if (configurationChanged) reportNetworkProxyStatus(network.status);

  return {
    refreshed: true,
    configurationChanged,
    status: network.status,
  };
}
