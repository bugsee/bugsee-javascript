import { createTraceparentDecorator, type NetworkCapture } from '@bugsee/capture';
import {
  type BugseeApi,
  type BugseeClient,
  ClockToken,
  type HttpTransport,
  resolveLaunchOptions,
  SchedulerToken,
} from '@bugsee/core';
import {
  type BugseeSpanProcessor,
  createBugseeSpanProcessor,
  createOtlpTraceExporter,
} from '@bugsee/opentelemetry';
import {
  type ActiveSpanStore,
  createPerformanceSend,
  defaultSpanId,
  defaultTraceId,
  PERFORMANCE_OPTION_DEFINITIONS,
  PerformanceOption,
  type TransactionWire,
  wirePerformance,
} from '@bugsee/performance';
import type { EnvironmentEnvelope } from '@bugsee/protocol';

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

/**
 * The internal wiring `launchCore` hands back (the browser and node launchCore produce a structurally
 * compatible value — same shared fields; each side may add its own, e.g. `activeSpanStore` below, which
 * every platform must declare but only the server fills in). Typed against runtime-neutral
 * packages only, so this shared module never imports a platform package — that is what keeps
 * `@bugsee/browser` out of the node umbrella entry's type graph.
 */
interface UmbrellaInternals {
  baseUrl: string;
  api: BugseeApi;
  transport: HttpTransport;
  getEnvironment: () => EnvironmentEnvelope;
  network: NetworkCapture;
  appVersion: string | undefined;
  appBuild: string | undefined;
  onError: ((error: unknown) => void) | undefined;
  /**
   * Where the performance controller's active transaction lives. The server `launchCore` supplies a
   * per-request-context store (D2 part 2); the browser passes `undefined` and keeps the single-slot
   * default. REQUIRED-but-nullable rather than optional (R-16): `UmbrellaInternals` is a
   * hand-maintained structural mirror of two independently declared `LaunchInternals`, and an
   * optional field let a platform omit the store with no type error — it would silently fall back to
   * the single slot, which is the D2 defect. A required key forces every platform to state its choice.
   */
  activeSpanStore: ActiveSpanStore | undefined;
}

// The browser-only capture-source FACTORIES the browser umbrella entry injects (so this shared module
// never imports @bugsee/browser). Factories, not instances, so wire calls them ONLY when the option gate
// passes — behaviour-identical to creating them inline. Types derived from what wirePerformance accepts.
type WirePerformanceOptions = Parameters<typeof wirePerformance>[0];
export interface UmbrellaBrowserSources {
  createNavigationSource?: () => NonNullable<WirePerformanceOptions['navigationSource']>;
  createInteractionSource?: () => NonNullable<WirePerformanceOptions['interactionSource']>;
  readMetaTraceContinuation?: () => WirePerformanceOptions['pageloadContinuation'];
}

// The runtime-agnostic umbrella wiring: given a launched client + its LaunchInternals (from EITHER the
// browser or node launchCore — structurally compatible; see UmbrellaInternals), turn on the on-by-default extensions
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
  /** Open a `navigation` transaction per SPA route change (History/Navigation-API detection). Browser only;
   *  default `true`. Requires performance on. */
  traceNavigations?: boolean;
  /** Open a `ui.interaction` transaction per qualifying user interaction (Event Timing — the INP unit).
   *  Browser only; default `true`. Requires performance on. Only interactions slower than the threshold
   *  (40ms) qualify, and one already owned by a navigation is skipped (no double-count). */
  traceInteractions?: boolean;

  /**
   * Enable W3C `traceparent` + the `bugsee=` session tracestate propagation on outgoing requests (the
   * cross-project / Next.js / SSR story), linking the Bugsee frontend trace to the backend. The SAME
   * native option vocabulary as the `@bugsee/node` launch (one propagation path, not two). On the BROWSER
   * this is OPT-IN (off by default — same-origin propagates, cross-origin requires `tracePropagationTargets`);
   * on Node it is the `@bugsee/node` launch's own option (default on, allowlist-gated). Requires performance on.
   */
  propagateTrace?: boolean;
  /** URLs allowed to receive the trace headers — your own downstream services (string substring or RegExp).
   *  On the browser, cross-origin requires this (same-origin always propagates); on Node nothing propagates
   *  without it (a backend has no same-origin and must not leak its trace topology). */
  tracePropagationTargets?: ReadonlyArray<string | RegExp>;
  /** (Browser) app origin override for same-origin detection. Default `location.origin`. */
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
  client: BugseeClient,
  internals: UmbrellaInternals,
  options: UmbrellaExtensionOptions,
  platform: UmbrellaPlatform,
  browserSources: UmbrellaBrowserSources = {},
): BugseeClient {
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
  // Profile v1 §5: the OTLP instrumentation scope name is `com.bugsee.<sdk>/<providerId>`. The SDK token
  // follows telemetry.sdk.language (§4): `webjs` on the browser, `nodejs` on the node-family runtimes
  // (node/bun/deno all run the node umbrella entry, pageload:false). The provider here is `performance`.
  const scopeName = `com.bugsee.${platform.pageload ? 'webjs' : 'nodejs'}/performance`;
  // Produce: when an OTLP endpoint is configured, TEE the drained batch to it too (Bugsee still receives
  // it). The internal-tagged transport keeps the SDK's own export out of network capture (self-isolation).
  const otlpSend =
    options.otelExportUrl !== undefined
      ? createOtlpTraceExporter({
          transport: internals.transport,
          url: options.otelExportUrl,
          scope: { name: scopeName },
          ...(options.otelExportHeaders !== undefined
            ? { headers: options.otelExportHeaders }
            : {}),
          ...(options.otelExportResource !== undefined
            ? { resource: options.otelExportResource }
            : {}),
        })
      : undefined;
  const send = otlpSend !== undefined ? teeSend(bugseeSend, otlpSend) : bugseeSend;

  // SPA navigation transactions (F1c) — browser only (`platform.pageload`; Node has no History/SPA
  // navigation), opt-out via `traceNavigations: false`. The detector self-skips if the browser globals are
  // absent; wirePerformance subscribes to it (which activates it) and tears it down on stop.
  const navigationSource =
    platform.pageload && (options.traceNavigations ?? true)
      ? browserSources.createNavigationSource?.()
      : undefined;

  // Interaction transactions (F4) — browser only (`platform.pageload`), opt-out via `traceInteractions:
  // false`. The Event Timing source self-skips where the API is unsupported; wirePerformance subscribes
  // (activating it) and tears it down on stop.
  const interactionSource =
    platform.pageload && (options.traceInteractions ?? true)
      ? browserSources.createInteractionSource?.()
      : undefined;

  // Pageload trace continuation (D4): on the browser, continue a server-injected `<meta name="traceparent">`
  // so the SSR request and the client pageload are one trace (a fresh root if absent/invalid).
  const pageloadContinuation = platform.pageload
    ? browserSources.readMetaTraceContinuation?.()
    : undefined;

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
    ...(navigationSource !== undefined ? { navigationSource } : {}),
    ...(interactionSource !== undefined ? { interactionSource } : {}),
    ...(pageloadContinuation !== undefined ? { pageloadContinuation } : {}),
    ...(internals.appVersion !== undefined ? { appVersion: internals.appVersion } : {}),
    ...(internals.appBuild !== undefined ? { appBuild: internals.appBuild } : {}),
    ...(internals.onError !== undefined ? { onError: internals.onError } : {}),
    ...(internals.activeSpanStore !== undefined
      ? { activeSpanStore: internals.activeSpanStore }
      : {}),
  });

  // monitoring off → wirePerformance installed nothing; return the client as-is (no teardown to compose).
  if (wired === undefined) return client;

  // Node startup transaction (the pageload analog): record an already-finished `app.start` transaction
  // spanning process-start → launch, so it uploads immediately (no pageload/hidden lifecycle on Node).
  if (platform.startupAtMs !== undefined) {
    const endTimestampMs = client.getService(ClockToken).wallNow();
    wired.recordTransaction({
      traceId: defaultTraceId(),
      spanId: defaultSpanId(), // a real root id — see TransactionWire.spanId (Wave 5.3)
      name: 'app.start',
      operation: 'app.start',
      status: 'OK',
      sampled: true, // the startup transaction is always recorded + uploaded (Profile v1 §6 sampled flag)
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

  // W3C trace-context propagation (opt-in) — register the NATIVE traceparent decorator (the shared
  // `@bugsee/capture` transformer, NOT an OTel-gated path) on the network umbrella's request-decorator
  // seam, propagating the active performance transaction's trace + the `bugsee=` session tracestate.
  // BROWSER ONLY (`platform.pageload`): on Node the `@bugsee/node` launch already wires its OWN
  // per-request-context-sourced decorator, so the umbrella must NOT double-wire. The perf-sourced one
  // stays browser-only on its own merits even after D2 part 2 made the controller's slot request-scoped
  // on Node: it reads whatever transaction is active rather than the request context the node decorator
  // is built on, and it is tied to the OPT-IN APM extension. Same-origin propagates by default; cross-origin only via the
  // allowlist (`tracePropagationTargets`).
  let offPropagation: (() => void) | undefined;
  if (platform.pageload && (options.propagateTrace ?? false)) {
    offPropagation = internals.network.interceptor.addRequestDecorator(
      createTraceparentDecorator({
        getActiveSpan: () => client.ext('performance').getActiveSpan(),
        getBugseeState: () => ({ record: true, sessionId: internals.api.sessionId }),
        ...(options.tracePropagationTargets !== undefined
          ? { allowlist: options.tracePropagationTargets }
          : {}),
        ...(options.tracePropagationOrigin !== undefined
          ? { origin: options.tracePropagationOrigin }
          : {}),
      }),
    );
  }

  // Compose teardown IN PLACE (not via a new wrapper object): `client` is the SAME object launchCore
  // already registered as the process singleton, so mutating its stop() here means the carrier singleton,
  // a repeat launch, and this return value are all one consistent client whose stop() tears the extensions
  // (performance, OTel propagation, consume) down before the core teardown.
  //
  // `flush()` is composed the same way and for the same reason: the performance uploader delivers on an
  // interval, so without this everything buffered since the last tick is lost whenever the process ends
  // first — the normal case for a serverless invocation, a CLI run, or a closing tab. The extension's
  // drain runs BEFORE the core drain so a transaction batch and the reports leave in one flush.
  const stopClient = client.stop;
  const flushClient = client.flush;
  // No guard around it: `uploader.flush()` already catches a failed batch into `onError` and drops it, so
  // a broken APM upload cannot turn a caller's flush()/stop() into a rejection and cost them the crash
  // report they were flushing. Wrapping it again here would be untestable through this seam.
  const flushExtensions = (): Promise<void> => wired.flush();
  client.flush = async (timeout?: number): Promise<boolean> => {
    await flushExtensions();
    return flushClient(timeout);
  };
  client.stop = async (timeout?: number): Promise<boolean> => {
    void spanProcessor?.shutdown();
    offPropagation?.();
    await flushExtensions();
    wired.stop();
    return stopClient(timeout);
  };
  return client;
}
