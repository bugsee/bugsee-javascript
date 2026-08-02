import type { EventSubscribable } from '@bugsee/core';
import { type NetworkEvent, type NetworkStage, sanitizeUrl } from '@bugsee/protocol';
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
 *  Validated like @bugsee/capture's `parseTraceparent` (lowercase-normalized, reject the `ff` forbidden
 *  version + the all-zero trace/span ids) so a third-party backend's value is handled correctly, not just
 *  the (lowercase, conformant) Bugsee X4 backend. Reimplemented inline — performance has no capture dep.
 *  Deliberately does NOT require the `flags` segment (we only need the span id) — slightly MORE lenient
 *  than `parseTraceparent`, which rejects a missing/non-hex flags field; that tolerance is desirable when
 *  reading a return header we did not author. */
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
 * `http.server` span via `traceresponse` and/or `Server-Timing: traceparent;desc="…"`. For an SDK-owned
 * request the response headers are already captured on the `complete` event (`custom.headers`); read the
 * backend span id from them so the FE `http.client` span records which server span handled it — completing
 * the FE↔BE link on the frontend side. The header-NAME match is case-insensitive; prefers `traceresponse`,
 * falls back to `Server-Timing`. Cross-origin this active (header-read) path works for `traceresponse` once
 * F0's ACEH exposes it; `Server-Timing` off `response.headers` is same-origin-only (cross-origin its value
 * is readable only via `PerformanceResourceTiming.serverTiming` + TAO — the deferred passive F3b path). No
 * competitor reads this.
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

// PER-TRANSACTION ceiling on http.client spans (symmetric with the resource/long-task caps in page-load,
// which also reset per transaction): bounds the §8.8 wire of any one long-lived transaction (e.g. the SPA
// continuous-transaction mode). The collector is created ONCE per session and serves EVERY transaction
// (the pageload + each navigation + each interaction), so the budget must be keyed on the active
// transaction — a single session-wide counter would starve http spans on every transaction after the
// first ~100 requests of the whole session.
const MAX_HTTP_SPANS = 100;

export function collectHttpSpans(deps: HttpSpanCollectorDeps): () => void {
  const pending = new Map<string, { startTimestampMs: number; method: string; url: string }>();
  // Per-active-transaction recorded count (each transaction gets its own MAX_HTTP_SPANS budget). A
  // WeakMap so finished transactions are GC'd, never leaking entries over a long SPA session.
  const recordedByTxn = new WeakMap<Span, number>();
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
    const recorded = recordedByTxn.get(active) ?? 0;
    if (recorded >= MAX_HTTP_SPANS) return; // this transaction's cap reached → drop the overflow
    recordedByTxn.set(active, recorded + 1);
    // F3: read the backend's http.server span from the response's return headers (X4) and stamp it on the
    // FE client span — the FE↔BE link completed on the frontend side.
    const backendSpanId = backendSpanIdFromHeaders(e.custom?.headers);
    active.recordChildSpan('http.client', {
      startTimestampMs: start.startTimestampMs,
      endTimestampMs: e.timestamp,
      // Dropping `?…` removes query secrets but NOT a `user:pass@` credential, which node:http fully
      // supports; the description is uploaded like any other attribute (Wave 1.1).
      description: `${start.method} ${sanitizeUrl(start.url.replace(/[?#].*$/, ''))}`,
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
    pending.clear(); // drop any still-in-flight starts (a hung request never delivers an END stage)
  };
}
