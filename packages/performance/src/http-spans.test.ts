import type { NetworkEvent } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { collectHttpSpans, type NetworkSource } from './http-spans';
import type { RecordChildSpanOptions } from './span';

const netEvent = (over: Partial<NetworkEvent>): NetworkEvent =>
  ({
    timestamp: 0,
    id: '',
    sequence: '',
    mechanism: 'fetch',
    url: '',
    method: 'GET',
    type: 'before',
    ...over,
  }) as NetworkEvent;

function fakeNetworkSource() {
  const listeners = new Map<string, Set<(e: NetworkEvent) => void>>();
  const source = {
    on: (name: string, fn: (e: NetworkEvent) => void) => {
      (listeners.get(name) ?? listeners.set(name, new Set()).get(name))?.add(fn);
      return () => {
        listeners.get(name)?.delete(fn);
      };
    },
    onAny: () => () => {},
  } as unknown as NetworkSource;
  const emit = (name: string, e: NetworkEvent) => {
    for (const l of listeners.get(name) ?? []) l(e);
  };
  const count = (name: string) => listeners.get(name)?.size ?? 0;
  return { source, emit, count };
}

function fakeActive() {
  const calls: { op: string; opts: RecordChildSpanOptions }[] = [];
  const span = {
    recordChildSpan: (op: string, opts: RecordChildSpanOptions) => {
      calls.push({ op, opts });
    },
  };
  return { span, calls };
}

describe('collectHttpSpans', () => {
  it('records an http.client span on the active transaction for a completed request', () => {
    const { source, emit } = fakeNetworkSource();
    const { span, calls } = fakeActive();
    collectHttpSpans({ source, getActiveSpan: () => span as never });
    emit(
      'before',
      netEvent({ id: 'r1', timestamp: 1000, method: 'POST', url: 'https://x/a?token=secret' }),
    );
    emit('complete', netEvent({ id: 'r1', timestamp: 1080, status: 201, mechanism: 'fetch' }));
    expect(calls).toEqual([
      {
        op: 'http.client',
        opts: {
          startTimestampMs: 1000,
          endTimestampMs: 1080,
          description: 'POST https://x/a', // query (with the token) stripped — see the userinfo test below
          attributes: { 'http.method': 'POST', 'http.mechanism': 'fetch', 'http.status_code': 201 },
        },
      },
    ]);
  });

  it('redacts URL userinfo credentials from the span description (Wave 1.1)', () => {
    // Stripping `?…` removes query secrets but leaves `user:pass@` completely intact, and the span
    // description is uploaded like any other attribute. node:http supports userinfo and it is routine for
    // private registries and service-to-service calls (docs/review/node-B-http-server.md SEV1 #3).
    const { source, emit } = fakeNetworkSource();
    const { span, calls } = fakeActive();
    collectHttpSpans({ source, getActiveSpan: () => span as never });
    emit(
      'before',
      netEvent({ id: 'r1', timestamp: 10, method: 'GET', url: 'http://alice:PWSECRET@reg/pkg' }),
    );
    emit('complete', netEvent({ id: 'r1', timestamp: 50, status: 200 }));
    expect(calls[0]?.opts.description).toBe('GET http://alice:%3Credacted%3E@reg/pkg');
  });

  it('F3: stamps the backend http.server span id read from the response `traceresponse` header', () => {
    const { source, emit } = fakeNetworkSource();
    const { span, calls } = fakeActive();
    collectHttpSpans({ source, getActiveSpan: () => span as never });
    emit('before', netEvent({ id: 'r1', timestamp: 10, method: 'GET', url: 'https://api/x' }));
    emit(
      'complete',
      netEvent({
        id: 'r1',
        timestamp: 50,
        status: 200,
        custom: {
          headers: { traceresponse: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
        },
      }),
    );
    expect(calls[0]?.opts.attributes?.['bugsee.server_span_id']).toBe('b7ad6b7169203331');
  });

  it('F3: case-insensitive header NAME + value (uppercase-hex normalized); ignores unrelated headers', () => {
    const { source, emit } = fakeNetworkSource();
    const { span, calls } = fakeActive();
    collectHttpSpans({ source, getActiveSpan: () => span as never });
    emit('before', netEvent({ id: 'r1', timestamp: 10, method: 'GET', url: 'u' }));
    emit(
      'complete',
      netEvent({
        id: 'r1',
        timestamp: 50,
        custom: {
          headers: {
            'content-type': 'application/json', // an unrelated header is skipped
            Traceresponse: '00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01', // uppercase hex
          },
        },
      }),
    );
    expect(calls[0]?.opts.attributes?.['bugsee.server_span_id']).toBe('b7ad6b7169203331'); // lowercased
  });

  it('F3: falls back to `Server-Timing` (traceparent;desc=...) when there is no traceresponse', () => {
    const { source, emit } = fakeNetworkSource();
    const { span, calls } = fakeActive();
    collectHttpSpans({ source, getActiveSpan: () => span as never });
    emit('before', netEvent({ id: 'r1', timestamp: 10, method: 'GET', url: 'u' }));
    emit(
      'complete',
      netEvent({
        id: 'r1',
        timestamp: 50,
        custom: {
          headers: {
            'server-timing':
              'app;dur=5, traceparent;desc="00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"',
          },
        },
      }),
    );
    expect(calls[0]?.opts.attributes?.['bugsee.server_span_id']).toBe('b7ad6b7169203331');
  });

  it('F3: reads `Server-Timing` when traceparent is the SOLE entry (the real X4 backend format)', () => {
    const { source, emit } = fakeNetworkSource();
    const { span, calls } = fakeActive();
    collectHttpSpans({ source, getActiveSpan: () => span as never });
    emit('before', netEvent({ id: 'r1', timestamp: 10, method: 'GET', url: 'u' }));
    emit(
      'complete',
      netEvent({
        id: 'r1',
        timestamp: 50,
        // No leading `app;dur=5,` — server-instrument emits traceparent as the SOLE entry, which only the
        // regex's `^` alternative matches (the realistic backend case).
        custom: {
          headers: {
            'server-timing':
              'traceparent;desc="00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"',
          },
        },
      }),
    );
    expect(calls[0]?.opts.attributes?.['bugsee.server_span_id']).toBe('b7ad6b7169203331');
  });

  it('F3: no stamp for invalid / ff-version / zero trace / zero span / no return header', () => {
    const { source, emit } = fakeNetworkSource();
    const { span, calls } = fakeActive();
    collectHttpSpans({ source, getActiveSpan: () => span as never });
    const cases: Array<string | undefined> = [
      'not-valid', // malformed
      'ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', // forbidden `ff` version
      '00-00000000000000000000000000000000-b7ad6b7169203331-01', // all-zero trace id
      '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01', // all-zero span id
      undefined, // no return header
    ];
    cases.forEach((tr, i) => {
      emit('before', netEvent({ id: `c${i}`, timestamp: 1, method: 'GET', url: 'u' }));
      emit(
        'complete',
        netEvent({
          id: `c${i}`,
          timestamp: 2,
          ...(tr !== undefined ? { custom: { headers: { traceresponse: tr } } } : {}),
        }),
      );
    });
    for (const call of calls) {
      expect(call.opts.attributes?.['bugsee.server_span_id']).toBeUndefined();
    }
    expect(calls).toHaveLength(cases.length);
  });

  it('finishes on error/abort too, and omits a 0 status (cross-origin opaque)', () => {
    const { source, emit } = fakeNetworkSource();
    const { span, calls } = fakeActive();
    collectHttpSpans({ source, getActiveSpan: () => span as never });
    emit('before', netEvent({ id: 'r1', timestamp: 10, method: 'GET', url: 'https://x/img' }));
    emit('error', netEvent({ id: 'r1', timestamp: 30, status: 0, mechanism: 'xhr' }));
    expect(calls[0]?.opts.attributes).toEqual({ 'http.method': 'GET', 'http.mechanism': 'xhr' });
  });

  it('drops a completion with no matching start, and consumes the pending (no double span)', () => {
    const { source, emit } = fakeNetworkSource();
    const { span, calls } = fakeActive();
    collectHttpSpans({ source, getActiveSpan: () => span as never });
    emit('complete', netEvent({ id: 'ghost', timestamp: 5 })); // no `before`
    expect(calls).toEqual([]);
    emit('before', netEvent({ id: 'r1', timestamp: 1, method: 'GET', url: 'u' }));
    emit('complete', netEvent({ id: 'r1', timestamp: 2 }));
    emit('complete', netEvent({ id: 'r1', timestamp: 9 })); // pending already consumed → no second span
    expect(calls).toHaveLength(1);
  });

  it('drops the span when no transaction is in flight', () => {
    const { source, emit } = fakeNetworkSource();
    let active: { recordChildSpan: () => void } | undefined;
    const calls: unknown[] = [];
    collectHttpSpans({ source, getActiveSpan: () => active as never });
    emit('before', netEvent({ id: 'r1', timestamp: 1, method: 'GET', url: 'u' }));
    emit('complete', netEvent({ id: 'r1', timestamp: 2 })); // active is undefined → dropped
    expect(calls).toEqual([]);
  });

  it('caps the http.client spans for ONE transaction and drops the overflow (symmetric with resource/long-task caps)', () => {
    const { source, emit } = fakeNetworkSource();
    const { span, calls } = fakeActive();
    collectHttpSpans({ source, getActiveSpan: () => span as never });
    for (let i = 0; i < 150; i++) {
      emit('before', netEvent({ id: `r${i}`, timestamp: i, method: 'GET', url: `https://x/${i}` }));
      emit('complete', netEvent({ id: `r${i}`, timestamp: i + 1, status: 200 }));
    }
    expect(calls).toHaveLength(100); // MAX_HTTP_SPANS for this transaction — beyond it, dropped
    expect(calls[99]?.opts.description).toBe('GET https://x/99'); // the first 100 are kept, in order
  });

  it('the cap is PER-TRANSACTION: a new active transaction gets a FRESH budget (no session-wide starvation)', () => {
    const { source, emit } = fakeNetworkSource();
    const calls: { op: string; opts: RecordChildSpanOptions }[] = [];
    const mkSpan = () => ({
      recordChildSpan: (op: string, opts: RecordChildSpanOptions) => calls.push({ op, opts }),
    });
    const txnA = mkSpan();
    const txnB = mkSpan();
    let active = txnA;
    collectHttpSpans({ source, getActiveSpan: () => active as never });
    // Transaction A records past its cap (the pageload of a busy SPA).
    for (let i = 0; i < 120; i++) {
      emit(
        'before',
        netEvent({ id: `a${i}`, timestamp: i, method: 'GET', url: `https://x/a${i}` }),
      );
      emit('complete', netEvent({ id: `a${i}`, timestamp: i + 1, status: 200 }));
    }
    expect(calls).toHaveLength(100); // A capped at MAX_HTTP_SPANS
    // A later navigation becomes active → it must record from a FRESH budget, NOT be starved by A's count
    // (under the old session-global counter this request would have been dropped).
    active = txnB;
    emit('before', netEvent({ id: 'b1', timestamp: 200, method: 'GET', url: 'https://x/b1' }));
    emit('complete', netEvent({ id: 'b1', timestamp: 201, status: 200 }));
    expect(calls).toHaveLength(101); // B recorded its first span
  });

  it('counts only RECORDED spans toward the cap — drops (no active span) do not consume the budget', () => {
    const { source, emit } = fakeNetworkSource();
    const { span, calls } = fakeActive();
    let active: typeof span | undefined;
    collectHttpSpans({ source, getActiveSpan: () => active as never });
    // 100 requests complete while there is NO active transaction → all dropped, none counted.
    for (let i = 0; i < 100; i++) {
      emit('before', netEvent({ id: `d${i}`, timestamp: i, method: 'GET', url: `https://x/${i}` }));
      emit('complete', netEvent({ id: `d${i}`, timestamp: i + 1, status: 200 }));
    }
    expect(calls).toHaveLength(0);
    // Now a transaction is active: a real request must still record (the budget wasn't burned by drops).
    active = span;
    emit('before', netEvent({ id: 'real', timestamp: 5, method: 'GET', url: 'https://x/real' }));
    emit('complete', netEvent({ id: 'real', timestamp: 6, status: 200 }));
    expect(calls).toHaveLength(1);
  });

  it('unsubscribes from every stage', () => {
    const { source, count } = fakeNetworkSource();
    const off = collectHttpSpans({ source, getActiveSpan: () => undefined });
    expect(count('before') + count('complete') + count('error') + count('abort')).toBe(4);
    off();
    expect(count('before') + count('complete') + count('error') + count('abort')).toBe(0);
  });
});

// WAVE 3b.4 — an outgoing call belongs to the request that MADE it.
//
// The parent transaction was resolved at COMPLETION time, from a module-scoped single slot that always
// holds the most-recently-started transaction. On the browser that slot is the design (D12: "the single
// active slot follows the MOST RECENT"). On Node it is not: `perf.startTransaction` runs once per INCOMING
// request and a server serves them concurrently, so the slot is "whichever request arrived last" and every
// outgoing call was parented to it regardless of who made it.
//
// That is misattribution, not absence — the worse category. Request A's database call appears in request
// B's trace, under B's traceId and B's root, while A ships with zero children, and nothing signals it. The
// child also starts BEFORE its own parent, which is structurally invalid. A long-poll or SSE request that
// happens to start last holds the slot for its entire lifetime, so every outgoing call from every other
// request during that window lands on it.
//
// The repo already knows this hazard and guards it one line away: `bugsee/src/wire.ts:255-259` gates the
// trace-propagation decorator on `platform.pageload` because the same single slot "would leak the ambient
// transaction's trace across concurrent server requests". The gate was simply missing here.
describe('concurrent requests (Wave 3b.4)', () => {
  it('parents each http.client span to the transaction that was active when the call STARTED', () => {
    const { source, emit } = fakeNetworkSource();
    const a = fakeActive();
    const b = fakeActive();
    let active = a.span;
    collectHttpSpans({ source, getActiveSpan: () => active as never });

    // Request A starts its outgoing call…
    emit(
      'before',
      netEvent({ id: 'req-a', timestamp: 1_000_000, url: 'https://db/a', method: 'GET' }),
    );
    // …then request B arrives and takes the slot (this is what a concurrent server does)…
    active = b.span;
    emit(
      'before',
      netEvent({ id: 'req-b', timestamp: 1_000_010, url: 'https://db/b', method: 'GET' }),
    );
    // …and A's call completes last.
    emit(
      'complete',
      netEvent({ id: 'req-a', timestamp: 1_000_020, type: 'complete', status: 200 }),
    );

    expect(a.calls.map((c) => c.opts.description)).toEqual(['GET https://db/a']);
    expect(b.calls).toEqual([]); // B did not make that call and must not be credited with it
  });

  it('never produces a child that starts before its own parent', () => {
    // The structural consequence: a waterfall renderer draws a negative offset. Measured on the broken
    // code — B start 1000010, child start 1000000.
    const { source, emit } = fakeNetworkSource();
    const a = fakeActive();
    const b = fakeActive();
    let active = a.span;
    collectHttpSpans({ source, getActiveSpan: () => active as never });
    emit('before', netEvent({ id: 'x', timestamp: 1_000_000, url: 'https://db/a' }));
    active = b.span;
    emit('complete', netEvent({ id: 'x', timestamp: 1_000_020, type: 'complete' }));
    expect(b.calls).toEqual([]);
    expect(a.calls[0]?.opts.startTimestampMs).toBe(1_000_000);
  });

  it('drops a call that had no transaction when it started', () => {
    // Binding at start also means a call issued outside any transaction stays outside one, rather than
    // being adopted by whichever transaction happens to be running when it finishes.
    const { source, emit } = fakeNetworkSource();
    const b = fakeActive();
    let active: { recordChildSpan: unknown } | undefined;
    collectHttpSpans({ source, getActiveSpan: () => active as never });
    emit('before', netEvent({ id: 'orphan', timestamp: 1_000_000, url: 'https://db/x' }));
    active = b.span;
    emit('complete', netEvent({ id: 'orphan', timestamp: 1_000_020, type: 'complete' }));
    expect(b.calls).toEqual([]);
  });

  it('still records a call whose transaction stayed active throughout — the canary', () => {
    // Without this, "no misattribution" is satisfied by recording nothing at all.
    const { source, emit } = fakeNetworkSource();
    const { span, calls } = fakeActive();
    collectHttpSpans({ source, getActiveSpan: () => span as never });
    emit('before', netEvent({ id: 'ok', timestamp: 1000, url: 'https://db/ok', method: 'POST' }));
    emit('complete', netEvent({ id: 'ok', timestamp: 1200, type: 'complete', status: 201 }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.description).toBe('POST https://db/ok');
  });

  it('keeps each transaction’s own span budget when several are interleaved', () => {
    // The cap is per-transaction. Binding at start must not collapse two transactions' budgets into one.
    const { source, emit } = fakeNetworkSource();
    const a = fakeActive();
    const b = fakeActive();
    let active = a.span;
    collectHttpSpans({ source, getActiveSpan: () => active as never });
    for (let i = 0; i < 120; i += 1) {
      emit('before', netEvent({ id: `a${i}`, timestamp: 1000 + i, url: 'https://db/a' }));
      emit('complete', netEvent({ id: `a${i}`, timestamp: 1100 + i, type: 'complete' }));
    }
    active = b.span;
    emit('before', netEvent({ id: 'b1', timestamp: 2000, url: 'https://db/b' }));
    emit('complete', netEvent({ id: 'b1', timestamp: 2100, type: 'complete' }));
    expect(a.calls).toHaveLength(100); // A hit its own cap…
    expect(b.calls).toHaveLength(1); // …and B still has its own budget
  });
});
