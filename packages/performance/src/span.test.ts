import type { Clock } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTransaction,
  defaultSpanId,
  defaultTraceId,
  type SpanStatus,
  serializeTransaction,
} from './span';

afterEach(() => vi.unstubAllGlobals());

// A mutable clock: set `.wall` / `.mono` between operations to pin timestamps + durations.
function clockAt(wall: number, mono: number): Clock & { wall: number; mono: number } {
  return {
    wall,
    mono,
    wallNow() {
      return this.wall;
    },
    monotonicNow() {
      return this.mono;
    },
  };
}

// Deterministic id generators for model assertions.
function ids(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${n++}`;
}

const mk = (clock: Clock, over: Partial<Parameters<typeof createTransaction>[0]> = {}) =>
  createTransaction(
    { name: 'Checkout', operation: 'ui.load', ...over },
    { clock, newTraceId: () => 'trace-1', newSpanId: ids('span-') },
  );

describe('createTransaction / Transaction', () => {
  it('builds a sampled root transaction with the given name/operation, a trace id, and OK status', () => {
    const txn = mk(clockAt(1000, 5));
    expect(txn.getName()).toBe('Checkout');
    expect(txn.getOperation()).toBe('ui.load');
    expect(txn.getTraceId()).toBe('trace-1');
    expect(txn.getSpanId()).toBe('span-0'); // the root takes the first span id
    expect(txn.getStatus()).toBe('OK');
    expect(txn.isFinished()).toBe(false);
    expect(txn.isSampled()).toBe(true);
    expect(txn.getDescription()).toBeUndefined();
    expect(txn.getAttributes()).toEqual({});
  });

  it('honours sampled:false and a description', () => {
    const txn = mk(clockAt(1, 1), { sampled: false, description: 'root desc' });
    expect(txn.isSampled()).toBe(false);
    expect(txn.getDescription()).toBe('root desc');
  });

  it('fluent setters mutate and return the same span for chaining', () => {
    const txn = mk(clockAt(1, 1));
    const ret = txn
      .setName('Renamed')
      .setDescription('d')
      .setAttribute('k', 1)
      .setAttribute('k2', 'v')
      .setStatus('ERROR');
    expect(ret).toBe(txn);
    expect(txn.getName()).toBe('Renamed');
    expect(txn.getDescription()).toBe('d');
    expect(txn.getAttributes()).toEqual({ k: 1, k2: 'v' });
    expect(txn.getStatus()).toBe('ERROR');
    // setDescription(undefined) clears it.
    expect(txn.setDescription(undefined).getDescription()).toBeUndefined();
  });

  it('getAttributes returns a copy (mutating it does not affect the span)', () => {
    const txn = mk(clockAt(1, 1)).setAttribute('k', 1);
    const attrs = txn.getAttributes();
    attrs.k = 999;
    expect(txn.getAttributes()).toEqual({ k: 1 });
  });
});

describe('startChildSpan', () => {
  it('creates a child sharing the trace id, parented to its creator, with a fresh span id', () => {
    const txn = mk(clockAt(1, 1));
    const child = txn.startChildSpan('http.client', 'GET /x');
    expect(child.getTraceId()).toBe('trace-1');
    expect(child.getOperation()).toBe('http.client');
    expect(child.getDescription()).toBe('GET /x');
    expect(child.getSpanId()).toBe('span-1');
    expect(child.getStatus()).toBe('OK');
    const grandchild = child.startChildSpan('db.query');
    expect(grandchild.getSpanId()).toBe('span-2');
    expect(grandchild.getTraceId()).toBe('trace-1');
  });
});

describe('finish', () => {
  it('records the end timestamp + duration (nanos from the monotonic clock) and is idempotent', () => {
    const clock = clockAt(1000, 5);
    const txn = mk(clock);
    clock.wall = 1100;
    clock.mono = 7.5; // 2.5 ms elapsed → 2_500_000 ns
    txn.finish();
    expect(txn.isFinished()).toBe(true);
    const wire = serializeTransaction(txn);
    expect(wire.endTimestampMs).toBe(1100);
    expect(wire.durationNanos).toBe(2_500_000);
    // A second finish() with a later clock does NOT recompute (idempotent).
    clock.wall = 9999;
    clock.mono = 100;
    txn.finish('ERROR');
    expect(serializeTransaction(txn).endTimestampMs).toBe(1100);
    expect(serializeTransaction(txn).durationNanos).toBe(2_500_000);
    expect(txn.getStatus()).toBe('OK'); // status not changed by the ignored second finish
  });

  it('finish(status) sets the status on first finish', () => {
    const txn = mk(clockAt(1, 1));
    txn.finish('TIMEOUT' satisfies SpanStatus);
    expect(txn.getStatus()).toBe('TIMEOUT');
  });

  it('rounds durationNanos (sub-nanosecond fractions)', () => {
    const clock = clockAt(0, 1.0000005); // 0.0000005 ms = 0.5 ns after start at... set start then finish
    const txn = mk(clock);
    clock.mono = 1.0000015; // delta 0.000001 ms = 1.0 ns → rounds to 1
    txn.finish();
    expect(serializeTransaction(txn).durationNanos).toBe(1);
  });
});

describe('onFinish hook', () => {
  it('fires once when the root transaction finishes, with the finished transaction', () => {
    const finished: unknown[] = [];
    const clock = clockAt(1, 1);
    const txn = createTransaction(
      { name: 'N', operation: 'op' },
      { clock, newTraceId: () => 't', newSpanId: ids('s'), onFinish: (t) => finished.push(t) },
    );
    expect(finished).toEqual([]); // not yet
    txn.finish('OK');
    expect(finished).toEqual([txn]);
    expect((finished[0] as typeof txn).isFinished()).toBe(true); // already finished when delivered
  });

  it('does not fire when a child span finishes, and fires only once on a double finish', () => {
    let count = 0;
    const txn = createTransaction(
      { name: 'N', operation: 'op' },
      { clock: clockAt(1, 1), onFinish: () => count++ },
    );
    txn.startChildSpan('c').finish(); // child finish → no onFinish
    expect(count).toBe(0);
    txn.finish();
    txn.finish(); // idempotent
    expect(count).toBe(1);
  });
});

describe('serializeTransaction (§8.8 wire)', () => {
  it('emits the documented transaction shape with child spans (parentSpanId linkage)', () => {
    const clock = clockAt(1000, 0);
    const txn = createTransaction(
      {
        name: 'Checkout',
        operation: 'ui.load',
        appVersion: '1.2.3',
        appBuild: '456',
      },
      { clock, newTraceId: () => 'tr', newSpanId: ids('s') },
    );
    const child = txn.startChildSpan('http.client', 'GET /api').setAttribute('http.method', 'GET');
    clock.wall = 1010;
    clock.mono = 4;
    child.finish('OK');
    clock.wall = 1020;
    clock.mono = 10;
    txn.finish('OK');

    expect(serializeTransaction(txn)).toEqual({
      traceId: 'tr',
      name: 'Checkout',
      operation: 'ui.load',
      status: 'OK',
      startTimestampMs: 1000,
      endTimestampMs: 1020,
      durationNanos: 10_000_000,
      isSnapshot: false,
      appVersion: '1.2.3',
      appBuild: '456',
      spans: [
        {
          spanId: 's1',
          parentSpanId: 's0',
          operation: 'http.client',
          description: 'GET /api',
          status: 'OK',
          startTimestampMs: 1000,
          endTimestampMs: 1010,
          durationNanos: 4_000_000,
          attributes: { 'http.method': 'GET' },
        },
      ],
    });
  });

  it('omits optional fields: an unfinished/attribute-less span has no end/duration/attributes/description/parentSpanId', () => {
    const txn = mk(clockAt(1000, 0)); // never finished, no attributes, no app info
    txn.startChildSpan('work'); // child never finished, no description/attributes
    const wire = serializeTransaction(txn);
    expect(wire).toEqual({
      traceId: 'trace-1',
      name: 'Checkout',
      operation: 'ui.load',
      status: 'OK',
      startTimestampMs: 1000,
      isSnapshot: false,
      spans: [
        {
          spanId: 'span-1',
          parentSpanId: 'span-0',
          operation: 'work',
          status: 'OK',
          startTimestampMs: 1000,
        },
      ],
    });
    expect('endTimestampMs' in wire).toBe(false);
    expect('appVersion' in wire).toBe(false);
    // The child wire carries ONLY the present fields — no undefined-valued end/duration/description/
    // attributes keys (toEqual ignores undefined, so assert the exact key set).
    expect(Object.keys(wire.spans[0] as object).sort()).toEqual([
      'operation',
      'parentSpanId',
      'spanId',
      'startTimestampMs',
      'status',
    ]);
  });

  it('carries transaction-level attributes and the isSnapshot flag', () => {
    const txn = mk(clockAt(1, 0), { isSnapshot: true }).setAttribute('page', '/checkout');
    const wire = serializeTransaction(txn);
    expect(wire.isSnapshot).toBe(true);
    expect(wire.attributes).toEqual({ page: '/checkout' });
  });
});

describe('default id generators', () => {
  it('defaultTraceId/defaultSpanId produce lowercase hex of the expected length, and are unique', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = (i * 17 + 3) & 0xff;
        return a;
      },
    });
    const t = defaultTraceId();
    const s = defaultSpanId();
    expect(t).toMatch(/^[0-9a-f]{32}$/); // 16 bytes
    expect(s).toMatch(/^[0-9a-f]{16}$/); // 8 bytes
    expect(defaultTraceId()).not.toBe(s);
  });

  it('falls back to Math.random when no crypto.getRandomValues is present', () => {
    vi.stubGlobal('crypto', undefined);
    expect(defaultTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(defaultSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('createTransaction uses the default id generators when none are injected', () => {
    vi.stubGlobal('crypto', undefined); // exercise the Math.random fallback through the factory
    const txn = createTransaction({ name: 'N', operation: 'op' }, { clock: clockAt(1, 1) });
    const child = txn.startChildSpan('c');
    expect(txn.getTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(txn.getSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(child.getTraceId()).toBe(txn.getTraceId()); // child shares the generated trace id
    expect(child.getSpanId()).not.toBe(txn.getSpanId());
  });
});
