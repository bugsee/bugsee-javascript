import type { BugseeClient, Scheduler } from '@bugsee/core';
import { createPerformanceExtension } from './extension';
import { collectHttpSpans, type NetworkSource } from './http-spans';
import { collectNavigations, type NavigationSource } from './navigations';
import { collectPageLoadVitals } from './page-load';
import { createPerformanceUploader } from './performance-uploader';
import { createRateSampler } from './sampling';
import type { TransactionWire } from './span';
import { realWebVitalsEnv, type WebVitalsEnv } from './web-vitals/env';

// The performance assembly — what the umbrella runs after launch() to make the extension LIVE. Gated by
// `monitoring` (performanceMonitoring): when off it does nothing (the extension tree-shakes / no observers
// installed). When on it: registers ext('performance') with a head sampler built from `sampleRate`,
// collects the page-load vitals + nav/resource/long-task spans into a pageload transaction, wires
// fetch/xhr http spans onto the active transaction (when a network source is available), and starts the
// continuous uploader (drain → `send` every flushIntervalMs). Returns a teardown, or undefined when off.

export interface WirePerformanceOptions {
  client: BugseeClient;
  /** The page name (URL/route) for the pageload transaction. */
  pageName: string;
  /** Delivers a batch (createPerformanceSend) — built by the umbrella from the client's api/transport. */
  send: (transactions: TransactionWire[]) => Promise<void>;
  scheduler: Scheduler;
  monitoring: boolean;
  sampleRate: number;
  flushIntervalMs: number;
  /** Collect the browser pageload transaction + web-vitals. Default true; Node sets false (no pageload
   *  lifecycle — it records its own startup transaction instead). */
  pageload?: boolean;
  appVersion?: string;
  appBuild?: string;
  /** The network interceptor source for http spans (omitted → no http spans). */
  networkSource?: NetworkSource;
  /** The browser navigation source (F1c) — drives `navigation` transactions per SPA route change. Omitted →
   *  none (e.g. Node, or navigation tracing off). Its activity-keepalive also reuses `networkSource`. */
  navigationSource?: NavigationSource;
  /** Web-vitals env override (tests). Default the real globals. */
  env?: WebVitalsEnv;
  onError?: (error: unknown) => void;
}

export interface WiredPerformance {
  stop(): void;
  /** Buffer an already-finished transaction (e.g. the Node `app.start` startup transaction, or consumed
   *  OTel spans assembled into a §8.8 transaction) into BOTH sinks — the continuous uploader AND the
   *  incident-bundle capture ring (performance.json). Externally sampled — it bypasses head sampling. */
  recordTransaction(transaction: TransactionWire): void;
}

export function wirePerformance(options: WirePerformanceOptions): WiredPerformance | undefined {
  if (!options.monitoring) return undefined;

  const extension = createPerformanceExtension({
    sampler: createRateSampler(options.sampleRate),
    ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
    ...(options.appBuild !== undefined ? { appBuild: options.appBuild } : {}),
  });
  extension.setup(options.client);
  const api = options.client.ext('performance');

  // The browser pageload transaction + web-vitals (default). Node opts out (`pageload: false`) — it has
  // no pageload/hidden lifecycle and records a startup transaction of its own instead.
  if (options.pageload !== false) {
    collectPageLoadVitals(options.env ?? realWebVitalsEnv(), api, { name: options.pageName });
  }

  let offHttp: (() => void) | undefined;
  if (options.networkSource !== undefined) {
    offHttp = collectHttpSpans({
      source: options.networkSource,
      getActiveSpan: () => api.getActiveSpan(),
    });
  }

  // SPA navigation transactions (F1c): each route change opens a `navigation` transaction (idle-finished).
  let offNav: (() => void) | undefined;
  if (options.navigationSource !== undefined) {
    offNav = collectNavigations({
      source: options.navigationSource,
      api,
      ...(options.networkSource !== undefined ? { networkSource: options.networkSource } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
  }

  const uploader = createPerformanceUploader({
    store: extension.store,
    send: options.send,
    scheduler: options.scheduler,
    flushIntervalMs: options.flushIntervalMs,
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  uploader.start();

  return {
    stop() {
      offNav?.();
      offHttp?.();
      uploader.stop();
      extension.stop();
    },
    recordTransaction(transaction) {
      // Dual-write: the continuous uploader AND the incident-bundle capture ring (performance.json).
      extension.recordExternal(transaction);
    },
  };
}
