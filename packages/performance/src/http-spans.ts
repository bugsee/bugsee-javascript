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

export function collectHttpSpans(deps: HttpSpanCollectorDeps): () => void {
  const pending = new Map<string, { startTimestampMs: number; method: string; url: string }>();
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
    active.recordChildSpan('http.client', {
      startTimestampMs: start.startTimestampMs,
      endTimestampMs: e.timestamp,
      description: `${start.method} ${start.url.replace(/[?#].*$/, '')}`,
      attributes: {
        'http.method': start.method,
        'http.mechanism': e.mechanism,
        ...(e.status ? { 'http.status_code': e.status } : {}), // 0 = cross-origin opaque → omit
      },
    });
  };
  for (const stage of END_STAGES) offs.push(deps.source.on(stage, finish));

  return () => {
    for (const off of offs) off();
  };
}
