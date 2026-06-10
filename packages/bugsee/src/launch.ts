import { type Bugsee, type BugseeLaunchOptions, launchCore } from '@bugsee/browser';
import { resolveLaunchOptions, SchedulerToken } from '@bugsee/core';
import {
  createPerformanceSend,
  PERFORMANCE_OPTION_DEFINITIONS,
  PerformanceOption,
  wirePerformance,
} from '@bugsee/performance';

// The `bugsee` umbrella launch() — the batteries-included entry. It runs the platform composition root
// (@bugsee/browser's launchCore, which returns the client PLUS its internal wiring) and then turns on the
// on-by-default extensions the bare platform package deliberately leaves out so it can tree-shake them:
// today that is @bugsee/performance (passive web-vitals + the active transaction API + http spans). The
// performance wiring lives HERE, not in @bugsee/browser, so a @bugsee/browser-only build never pulls in
// the extension. Returns the same public client; its stop() additionally tears performance down.

export interface BugseeLaunchOptionsWithPerformance extends BugseeLaunchOptions {
  /** Master gate for performance capture (web-vitals + transactions). Default true. */
  performanceMonitoring?: boolean;
  /** Head sampling rate for performance transactions, 0..1. Default 1 (keep all). */
  performanceSampleRate?: number;
  /** Batched-upload flush interval in milliseconds. Default 30000. */
  performanceFlushIntervalMs?: number;
  /** The pageload transaction name. Default the current path (`location.pathname`) or `pageload`. */
  pageName?: string;
}

export function launch(appToken: string, options: BugseeLaunchOptionsWithPerformance = {}): Bugsee {
  const { client, internals } = launchCore(appToken, options);
  // No internals → a prior launch already owns the process singleton (and already wired performance).
  if (internals === undefined) return client;

  // Resolve the performance.* options the extension owns (friendly → canonical, defaults applied).
  const perf = resolveLaunchOptions(
    options as unknown as Record<string, unknown>,
    PERFORMANCE_OPTION_DEFINITIONS,
  );

  const send = createPerformanceSend({
    api: internals.api,
    transport: internals.transport,
    baseUrl: internals.baseUrl,
    getEnvironment: internals.getEnvironment,
  });

  const wired = wirePerformance({
    client,
    pageName: options.pageName ?? defaultPageName(),
    send,
    scheduler: client.getService(SchedulerToken),
    monitoring: perf.options.get(PerformanceOption.Monitoring, true),
    sampleRate: perf.options.get(PerformanceOption.SampleRate, 1),
    flushIntervalMs: perf.options.get(PerformanceOption.FlushIntervalMs, 30000),
    networkSource: internals.network.interceptor,
    ...(internals.appVersion !== undefined ? { appVersion: internals.appVersion } : {}),
    ...(internals.appBuild !== undefined ? { appBuild: internals.appBuild } : {}),
    ...(internals.onError !== undefined ? { onError: internals.onError } : {}),
  });

  // monitoring off → wirePerformance installed nothing; return the client as-is (no teardown to compose).
  if (wired === undefined) return client;

  // Compose teardown IN PLACE (not via a new wrapper object): `client` is the SAME object launchCore
  // already registered as the process singleton, so mutating its stop() here means the carrier singleton,
  // a repeat launch, and this return value are all one consistent client whose stop() tears performance
  // down (uploader + http spans + extension) before the core teardown.
  const stopClient = client.stop;
  client.stop = (timeout?: number): Promise<boolean> => {
    wired.stop();
    return stopClient(timeout);
  };
  return client;
}

/** The pageload transaction name: the current path where a runtime exposes one, else a stable default. */
function defaultPageName(): string {
  const location = (globalThis as { location?: { pathname?: string } }).location;
  return location?.pathname ?? 'pageload';
}
