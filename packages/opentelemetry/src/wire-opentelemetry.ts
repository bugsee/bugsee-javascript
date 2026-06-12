import {
  createTraceparentDecorator,
  type RequestDecoratable,
  type TraceContextSource,
} from '@bugsee/capture';

// The OTel assembly the umbrella runs after launch() — the analog of wirePerformance for OTel. Today it
// wires W3C trace-context PROPAGATION: registers the traceparent decorator (the transformer seam's first
// consumer) on the network source, propagating the Bugsee active transaction so a frontend trace links to
// the backend (the Next.js / SSR story). Opt-in (security); same-origin by default, cross-origin only via
// an explicit allowlist. Produce (tee finished transactions to createOtlpTraceExporter) and consume
// (expose createBugseeSpanProcessor) are wired by the umbrella directly. See
// docs/design/opentelemetry-integration.md.

export interface WireOpenTelemetryOptions {
  /** The network source to register the propagation decorator on (the umbrella's network umbrella). */
  networkSource: RequestDecoratable;
  /** The active Bugsee trace to propagate (e.g. the performance extension's getActiveSpan). */
  getActiveSpan: () => TraceContextSource | undefined;
  /** Enable W3C `traceparent` propagation. Opt-in (security). */
  propagate: boolean;
  /** Cross-origin URLs allowed to receive `traceparent` (same-origin always is). string/RegExp. */
  allowlist?: ReadonlyArray<string | RegExp>;
  /** App origin override for same-origin detection. Default `globalThis.location?.origin`. */
  origin?: string;
}

export interface WiredOpenTelemetry {
  /** Tear down the OTel wiring (unsubscribe the propagation decorator). */
  stop(): void;
}

export function wireOpenTelemetry(
  options: WireOpenTelemetryOptions,
): WiredOpenTelemetry | undefined {
  if (!options.propagate) {
    return undefined; // nothing to wire (propagation is the only live wiring today, and it's opt-in)
  }
  const off = options.networkSource.addRequestDecorator(
    createTraceparentDecorator({
      getActiveSpan: options.getActiveSpan,
      ...(options.allowlist !== undefined ? { allowlist: options.allowlist } : {}),
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
    }),
  );
  return {
    stop() {
      off();
    },
  };
}
