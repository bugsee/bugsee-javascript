import type { Bugsee, LaunchInternals } from '@bugsee/browser';
import { ClockToken, resolveLaunchOptions, SchedulerToken } from '@bugsee/core';
import {
  type BugseeSpanProcessor,
  createBugseeSpanProcessor,
  createOtlpTraceExporter,
  wireOpenTelemetry,
} from '@bugsee/opentelemetry';
import {
  createPerformanceSend,
  defaultTraceId,
  PERFORMANCE_OPTION_DEFINITIONS,
  PerformanceOption,
  type TransactionWire,
  wirePerformance,
} from '@bugsee/performance';

/**
 * Per-runtime root-transaction policy. The browser collects a pageload transaction (+ web-vitals); Node
 * has no pageload lifecycle, so it skips that and records a startup transaction spanning process-start →
 * launch (`startupAtMs` is the process start time).
 */
export interface UmbrellaPlatform {
  /** Collect the browser pageload transaction + web-vitals. */
  pageload: boolean;
  /** Process start time (ms) — when set, record an `app.start` startup transaction up to launch. */
  startupAtMs?: number;
}

// The runtime-agnostic umbrella wiring: given a launched client + its LaunchInternals (from EITHER the
// browser or node launchCore — the two are structurally identical), turn on the on-by-default extensions
// the bare platform packages deliberately leave out so they tree-shake: @bugsee/performance (web-vitals +
// transactions + http spans) and @bugsee/opentelemetry (produce/consume/propagation). Lives HERE, not in
// the platform packages, so a platform-only build never pulls the extensions in. The browser/node umbrella
// entries are thin callers of this.

/** The extension options the umbrella adds on top of each platform's launch options. */
export interface UmbrellaExtensionOptions {
  /** Master gate for performance capture (web-vitals + transactions). Default true. */
  performanceMonitoring?: boolean;
  /** Head sampling rate for performance transactions, 0..1. Default 1 (keep all). */
  performanceSampleRate?: number;
  /** Batched-upload flush interval in milliseconds. Default 30000. */
  performanceFlushIntervalMs?: number;
  /** The pageload transaction name. Default the current path (`location.pathname`) or `pageload`. */
  pageName?: string;

  /**
   * Enable W3C `traceparent` propagation on outgoing requests (the OTel distributed-trace / Next.js
   * story), linking the Bugsee frontend trace to the backend. OPT-IN (off by default). Same-origin
   * requests propagate; cross-origin requires `tracePropagationAllowlist`. Requires performance on.
   */
  tracePropagation?: boolean;
  /** Cross-origin URLs allowed to receive `traceparent` (string substring or RegExp). */
  tracePropagationAllowlist?: ReadonlyArray<string | RegExp>;
  /** App origin override for same-origin detection. Default `location.origin`. */
  tracePropagationOrigin?: string;

  /**
   * OTLP/HTTP-JSON traces endpoint (e.g. `https://api.honeycomb.io/v1/traces`). When set, finished
   * performance transactions are ALSO exported here (a TEE — Bugsee still receives them), so your data
   * lands in your own OTel backend. Requires performance on.
   */
  otelExportUrl?: string;
  /** Headers for the OTLP export (e.g. `authorization`, `x-honeycomb-team`). Use lowercase keys. */
  otelExportHeaders?: Record<string, string>;
  /** OTLP resource attributes for the export (e.g. `{ 'service.name': 'web' }`). */
  otelExportResource?: Record<string, unknown>;
  /**
   * Consume the user's OpenTelemetry spans into Bugsee. With `onOtelSpanProcessor`, the umbrella hands you
   * a `SpanProcessor` to register on YOUR `TracerProvider`; consumed traces become native Bugsee
   * transactions that ride the same upload (and OTLP tee). Requires performance on.
   */
  otelConsume?: boolean;
  /** Receives the wired `SpanProcessor` (register it on your OTel `TracerProvider`). */
  onOtelSpanProcessor?: (spanProcessor: BugseeSpanProcessor) => void;
}

/** Fan a drained batch to several `send`s (Bugsee upload + OTLP export); surface any failure to onError. */
function teeSend(
  ...sends: Array<(transactions: TransactionWire[]) => Promise<void>>
): (transactions: TransactionWire[]) => Promise<void> {
  return async (transactions) => {
    const results = await Promise.allSettled(sends.map((send) => send(transactions)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed !== undefined) throw failed.reason; // best-effort: the batch already drained, onError logs it
  };
}

/** The pageload transaction name: the current path where a runtime exposes one, else a stable default. */
function defaultPageName(): string {
  const location = (globalThis as { location?: { pathname?: string } }).location;
  return location?.pathname ?? 'pageload';
}

/** Wire the on-by-default extensions onto a launched client. Returns the same client (stop() now also
 *  tears the extensions down). `internals` must be present (the caller skips this on a repeat launch). */
export function wireUmbrella(
  client: Bugsee,
  internals: LaunchInternals,
  options: UmbrellaExtensionOptions,
  platform: UmbrellaPlatform,
): Bugsee {
  // Resolve the performance.* options the extension owns (friendly → canonical, defaults applied).
  const perf = resolveLaunchOptions(
    options as unknown as Record<string, unknown>,
    PERFORMANCE_OPTION_DEFINITIONS,
  );

  const bugseeSend = createPerformanceSend({
    api: internals.api,
    transport: internals.transport,
    baseUrl: internals.baseUrl,
    getEnvironment: internals.getEnvironment,
  });
  // Produce: when an OTLP endpoint is configured, TEE the drained batch to it too (Bugsee still receives
  // it). The internal-tagged transport keeps the SDK's own export out of network capture (self-isolation).
  const otlpSend =
    options.otelExportUrl !== undefined
      ? createOtlpTraceExporter({
          transport: internals.transport,
          url: options.otelExportUrl,
          ...(options.otelExportHeaders !== undefined
            ? { headers: options.otelExportHeaders }
            : {}),
          ...(options.otelExportResource !== undefined
            ? { resource: options.otelExportResource }
            : {}),
        })
      : undefined;
  const send = otlpSend !== undefined ? teeSend(bugseeSend, otlpSend) : bugseeSend;

  const wired = wirePerformance({
    client,
    pageName: options.pageName ?? defaultPageName(),
    send,
    scheduler: client.getService(SchedulerToken),
    monitoring: perf.options.get(PerformanceOption.Monitoring, true),
    sampleRate: perf.options.get(PerformanceOption.SampleRate, 1),
    flushIntervalMs: perf.options.get(PerformanceOption.FlushIntervalMs, 30000),
    pageload: platform.pageload,
    networkSource: internals.network.interceptor,
    ...(internals.appVersion !== undefined ? { appVersion: internals.appVersion } : {}),
    ...(internals.appBuild !== undefined ? { appBuild: internals.appBuild } : {}),
    ...(internals.onError !== undefined ? { onError: internals.onError } : {}),
  });

  // monitoring off → wirePerformance installed nothing; return the client as-is (no teardown to compose).
  if (wired === undefined) return client;

  // Node startup transaction (the pageload analog): record an already-finished `app.start` transaction
  // spanning process-start → launch, so it uploads immediately (no pageload/hidden lifecycle on Node).
  if (platform.startupAtMs !== undefined) {
    const endTimestampMs = client.getService(ClockToken).wallNow();
    wired.recordTransaction({
      traceId: defaultTraceId(),
      name: 'app.start',
      operation: 'app.start',
      status: 'OK',
      startTimestampMs: platform.startupAtMs,
      endTimestampMs,
      durationNanos: Math.max(0, Math.round((endTimestampMs - platform.startupAtMs) * 1_000_000)),
      isSnapshot: false,
      spans: [],
    });
  }

  // Consume (opt-in): hand the user a SpanProcessor to register on their OTel TracerProvider. Consumed
  // spans are assembled into §8.8 transactions (recordTransaction) and ride the same upload + OTLP tee.
  let spanProcessor: BugseeSpanProcessor | undefined;
  if (options.otelConsume === true && options.onOtelSpanProcessor !== undefined) {
    spanProcessor = createBugseeSpanProcessor({ onTransaction: wired.recordTransaction });
    options.onOtelSpanProcessor(spanProcessor);
  }

  // OTel trace-context propagation (opt-in) — propagate the active performance transaction's trace onto
  // outgoing requests via the network umbrella's request-decorator seam.
  const otel = wireOpenTelemetry({
    networkSource: internals.network.interceptor,
    getActiveSpan: () => client.ext('performance').getActiveSpan(),
    propagate: options.tracePropagation ?? false,
    ...(options.tracePropagationAllowlist !== undefined
      ? { allowlist: options.tracePropagationAllowlist }
      : {}),
    ...(options.tracePropagationOrigin !== undefined
      ? { origin: options.tracePropagationOrigin }
      : {}),
  });

  // Compose teardown IN PLACE (not via a new wrapper object): `client` is the SAME object launchCore
  // already registered as the process singleton, so mutating its stop() here means the carrier singleton,
  // a repeat launch, and this return value are all one consistent client whose stop() tears the extensions
  // (performance, OTel propagation, consume) down before the core teardown.
  const stopClient = client.stop;
  client.stop = (timeout?: number): Promise<boolean> => {
    void spanProcessor?.shutdown();
    otel?.stop();
    wired.stop();
    return stopClient(timeout);
  };
  return client;
}
