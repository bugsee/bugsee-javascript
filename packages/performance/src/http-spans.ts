import type { EventSubscribable } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import type { Span } from './span';

// Active-APM http instrumentation: subscribe to the network interceptor (the cross-runtime
// fetch/xhr/ws/… source) and turn each completed request into an `http.client` child span on the ACTIVE
// transaction. Correlate by request id: `before` records the start; `complete`/`error`/`abort` records
// the span (with method/url + status). Dropped when no transaction is in flight (the request isn't part
// of a captured trace). The URL is query/fragment-stripped (low cardinality + no PII).

/** The network interceptor's listenable surface (a NetworkEvent per stage). */
export type NetworkSource = EventSubscribable<Record<NetworkStage, NetworkEvent>>;

export interface HttpSpanCollectorDeps {
  source: NetworkSource;
  /** The currently active span/transaction to attach the http span to. */
  getActiveSpan: () => Span | undefined;
}

const END_STAGES = ['complete', 'error', 'abort'] as const;

const VERSION_RE = /^[0-9a-f]{2}$/;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

/** Extract the BACKEND span id from a W3C `traceparent`-format value `00-<traceId>-<spanId>-<flags>`.
 *  Validated exactly like @bugsee/capture's `parseTraceparent` (lowercase-normalized, reject the `ff`
 *  forbidden version + the all-zero trace/span ids) so a third-party backend's value is handled correctly,
 *  not just the (lowercase, conformant) Bugsee X4 backend. Reimplemented inline — performance has no capture dep. */
function spanIdFromTraceContext(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const [version = '', traceId = '', spanId = ''] = value.trim().toLowerCase().split('-');
  if (
    !VERSION_RE.test(version) ||
    version === 'ff' || // the forbidden version
    !TRACE_ID_RE.test(traceId) ||
    traceId === ZERO_TRACE_ID ||
    !SPAN_ID_RE.test(spanId) ||
    spanId === ZERO_SPAN_ID
  ) {
    return undefined;
  }
  return spanId;
}

/** Pull the trace context out of a `Server-Timing` value: a `traceparent;desc="00-…"` metric entry. */
function serverTimingTraceContext(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /(?:^|,)\s*traceparent\s*;\s*desc="([^"]+)"/.exec(value)?.[1];
}

/**
 * F3 — the BE→FE RETURN-HEADER reader (the cross-project differentiator). The backend (X4) returns its
 * `http.server` span via `traceresponse` and/or `Server-Timing: traceparent;desc="…"` (cross-origin-readable
 * once F0's TAO/ACEH are set). For an SDK-owned request the response headers are already captured on the
 * `complete` event (`custom.headers`); read the backend span id from them so the FE `http.client` span records
 * which server span handled it — completing the FE↔BE link on the frontend side. Case-insensitive; prefers
 * `traceresponse`, falls back to `Server-Timing`. No competitor reads this.
 */
function backendSpanIdFromHeaders(headers: Record<string, string> | undefined): string | undefined {
  if (headers === undefined) return undefined;
  let traceResponse: string | undefined;
  let serverTiming: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'traceresponse') traceResponse = value;
    else if (lower === 'server-timing') serverTiming = value;
  }
  return (
    spanIdFromTraceContext(traceResponse) ??
    spanIdFromTraceContext(serverTimingTraceContext(serverTiming))
  );
}

// Per-collector ceiling on http.client spans, symmetric with the resource/long-task caps in page-load
// (bounds the §8.8 wire when a single transaction is long-lived, e.g. the SPA continuous-transaction
// mode — a classic pageload finishes on hide and never approaches this).
const MAX_HTTP_SPANS = 100;

export function collectHttpSpans(deps: HttpSpanCollectorDeps): () => void {
  const pending = new Map<string, { startTimestampMs: number; method: string; url: string }>();
  let recorded = 0;
  const offs: Array<() => void> = [
    deps.source.on('before', (e) => {
      pending.set(e.id, { startTimestampMs: e.timestamp, method: e.method, url: e.url });
    }),
  ];

  const finish = (e: NetworkEvent): void => {
    const start = pending.get(e.id);
    if (start === undefined) return; // no matching start (e.g. started before we subscribed)
    pending.delete(e.id);
    const active = deps.getActiveSpan();
    if (active === undefined) return; // no transaction in flight → not part of a trace
    if (recorded >= MAX_HTTP_SPANS) return; // cap reached → drop the overflow
    recorded++;
    // F3: read the backend's http.server span from the response's return headers (X4) and stamp it on the
    // FE client span — the FE↔BE link completed on the frontend side.
    const backendSpanId = backendSpanIdFromHeaders(e.custom?.headers);
    active.recordChildSpan('http.client', {
      startTimestampMs: start.startTimestampMs,
      endTimestampMs: e.timestamp,
      description: `${start.method} ${start.url.replace(/[?#].*$/, '')}`,
      attributes: {
        'http.method': start.method,
        'http.mechanism': e.mechanism,
        ...(e.status ? { 'http.status_code': e.status } : {}), // 0 = cross-origin opaque → omit
        ...(backendSpanId !== undefined ? { 'bugsee.server_span_id': backendSpanId } : {}),
      },
    });
  };
  for (const stage of END_STAGES) offs.push(deps.source.on(stage, finish));

  return () => {
    for (const off of offs) off();
  };
}
