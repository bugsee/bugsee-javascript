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
          description: 'POST https://x/a', // query (with the token) stripped
          attributes: { 'http.method': 'POST', 'http.mechanism': 'fetch', 'http.status_code': 201 },
        },
      },
    ]);
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

  it('caps the http.client spans per collector and drops the overflow (symmetric with resource/long-task caps)', () => {
    const { source, emit } = fakeNetworkSource();
    const { span, calls } = fakeActive();
    collectHttpSpans({ source, getActiveSpan: () => span as never });
    for (let i = 0; i < 150; i++) {
      emit('before', netEvent({ id: `r${i}`, timestamp: i, method: 'GET', url: `https://x/${i}` }));
      emit('complete', netEvent({ id: `r${i}`, timestamp: i + 1, status: 200 }));
    }
    expect(calls).toHaveLength(100); // MAX_HTTP_SPANS — beyond it, completed requests are dropped
    expect(calls[99]?.opts.description).toBe('GET https://x/99'); // the first 100 are kept, in order
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
