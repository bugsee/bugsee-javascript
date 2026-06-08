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

  it('rounds durationNanos to the NEAREST nanosecond (not floor/ceil/trunc)', () => {
    const c1 = clockAt(0, 0);
    const t1 = mk(c1);
    c1.mono = 0.0000014; // 1.4 ns → rounds DOWN to 1 (ceil would give 2)
    t1.finish();
    expect(serializeTransaction(t1).durationNanos).toBe(1);
    const c2 = clockAt(0, 0);
    const t2 = mk(c2);
    c2.mono = 0.0000016; // 1.6 ns → rounds UP to 2 (floor/trunc would give 1)
    t2.finish();
    expect(serializeTransaction(t2).durationNanos).toBe(2);
  });

  it('clamps durationNanos to 0 when the monotonic clock does not advance (or regresses)', () => {
    // monotonicNow() falls back to the non-monotonic Date.now() on some runtimes; a backwards
    // adjustment must never put a negative duration on the wire.
    const clock = clockAt(1000, 5);
    const txn = mk(clock);
    clock.wall = 1100;
    clock.mono = 3; // regressed below the start reading (5)
    txn.finish();
    expect(serializeTransaction(txn).durationNanos).toBe(0);
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
    // Both the ROOT wire and the child wire carry ONLY present fields — no undefined-valued
    // end/duration/appVersion/appBuild/attributes keys (toEqual ignores undefined → assert exact keys).
    expect(Object.keys(wire).sort()).toEqual([
      'isSnapshot',
      'name',
      'operation',
      'spans',
      'startTimestampMs',
      'status',
      'traceId',
    ]);
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
  it('defaultTraceId/defaultSpanId convert the random bytes to lowercase hex of the expected length', () => {
    // Distinct per-byte values so the hex mapping (padStart(2,'0'), radix 16, byte order) is pinned.
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = (i * 17 + 3) & 0xff;
        return a;
      },
    });
    const t = defaultTraceId();
    const s = defaultSpanId();
    expect(t).toMatch(/^[0-9a-f]{32}$/); // 16 bytes → 32 hex chars
    expect(s).toMatch(/^[0-9a-f]{16}$/); // 8 bytes → 16 hex chars
    expect(t.startsWith('031425')).toBe(true); // bytes 3,20,37,... → '03','14','25' (pins byte→hex order)
  });

  it('falls back to Math.random when no crypto.getRandomValues is present', () => {
    vi.stubGlobal('crypto', undefined);
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.5); // floor(0.5 * 256) = 128 = 0x80
    expect(defaultTraceId()).toBe('80'.repeat(16)); // 16 bytes of 0x80 (pins the *256 range + floor + hex)
    expect(defaultSpanId()).toBe('80'.repeat(8));
    rand.mockRestore();
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
