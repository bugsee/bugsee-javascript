import type { TransactionWire } from '@bugsee/performance';
import { describe, expect, it, vi } from 'vitest';
import {
  createBugseeSpanProcessor,
  type ReadableSpanLike,
  readableSpanToConsumed,
} from './span-processor';

const readable = (
  over: Partial<ReadableSpanLike> & { traceId?: string; spanId?: string } = {},
): ReadableSpanLike => {
  const {
    traceId = '0123456789abcdef0123456789abcdef',
    spanId = 'aaaaaaaaaaaaaaaa',
    ...rest
  } = over;
  return {
    spanContext: () => ({ traceId, spanId }),
    name: 'op',
    startTime: [1, 0],
    endTime: [2, 0],
    status: { code: 1 },
    ...rest,
  };
};

describe('readableSpanToConsumed', () => {
  it('normalizes a ReadableSpan to a ConsumedSpan (HrTime→ms, ids, kind, status, attributes)', () => {
    expect(
      readableSpanToConsumed(
        readable({
          name: 'HTTP GET',
          kind: 3,
          parentSpanId: 'bbbbbbbbbbbbbbbb', // OTel 1.x parent
          startTime: [1, 500_000_000], // 1.5 s
          endTime: [2, 250_000_000], // 2.25 s
          status: { code: 2, message: 'TIMEOUT' },
          attributes: { 'http.method': 'GET' },
        }),
      ),
    ).toEqual({
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: 'aaaaaaaaaaaaaaaa',
      parentSpanId: 'bbbbbbbbbbbbbbbb',
      name: 'HTTP GET',
      kind: 3,
      startTimeMs: 1500,
      endTimeMs: 2250,
      status: { code: 2, message: 'TIMEOUT' },
      attributes: { 'http.method': 'GET' },
    });
  });

  it('passes OTel attribute values through faithfully (string/number/boolean/array)', () => {
    const consumed = readableSpanToConsumed(
      readable({ attributes: { s: 'x', n: 3, ok: true, tags: ['a', 'b'] } }),
    );
    expect(consumed.attributes).toEqual({ s: 'x', n: 3, ok: true, tags: ['a', 'b'] });
  });

  it('prefers the OTel 2.x parentSpanContext over the 1.x parentSpanId', () => {
    const consumed = readableSpanToConsumed(
      readable({
        parentSpanId: '1111111111111111', // 1.x
        parentSpanContext: { traceId: 't', spanId: '2222222222222222' }, // 2.x wins
      }),
    );
    expect(consumed.parentSpanId).toBe('2222222222222222');
  });

  it('treats a REMOTE parent as a local trace root (parentSpanId omitted) — downstream service', () => {
    const consumed = readableSpanToConsumed(
      readable({ parentSpanContext: { traceId: 't', spanId: '2222222222222222', isRemote: true } }),
    );
    expect(consumed.parentSpanId).toBeUndefined();
  });

  it('omits parentSpanId / kind / status.message / attributes when absent (a parentless root)', () => {
    const consumed = readableSpanToConsumed(readable());
    expect(consumed.parentSpanId).toBeUndefined();
    expect(consumed.kind).toBeUndefined();
    expect(consumed.attributes).toBeUndefined();
    expect(consumed.status).toEqual({ code: 1 });
    expect('message' in consumed.status).toBe(false);
  });
});

describe('createBugseeSpanProcessor', () => {
  it('assembles a trace and emits a Bugsee transaction when the root span ends', () => {
    const emitted: TransactionWire[] = [];
    const proc = createBugseeSpanProcessor({
      onTransaction: (t) => emitted.push(t),
      clock: { wallNow: () => 0 },
    });
    proc.onEnd(readable({ traceId: 'T', spanId: 'c', parentSpanId: 'r', name: 'child' }));
    expect(emitted).toHaveLength(0); // child buffered
    proc.onEnd(readable({ traceId: 'T', spanId: 'r', name: 'root' })); // root → emit
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.name).toBe('root');
    expect(emitted[0]?.spans.map((s) => s.spanId)).toEqual(['c']);
  });

  it('onStart is a no-op and forceFlush resolves', async () => {
    const proc = createBugseeSpanProcessor({
      onTransaction: () => {},
      clock: { wallNow: () => 0 },
    });
    expect(() => proc.onStart()).not.toThrow();
    await expect(proc.forceFlush()).resolves.toBeUndefined();
  });

  it('shutdown() clears buffered (incomplete) traces', async () => {
    const emitted: TransactionWire[] = [];
    const proc = createBugseeSpanProcessor({
      onTransaction: (t) => emitted.push(t),
      clock: { wallNow: () => 0 },
    });
    proc.onEnd(readable({ traceId: 'T', spanId: 'c', parentSpanId: 'r' })); // buffered child
    await proc.shutdown();
    // The buffer was cleared, so a later root for T assembles with NO child (the child was dropped).
    proc.onEnd(readable({ traceId: 'T', spanId: 'r', name: 'root' }));
    expect(emitted[0]?.spans).toEqual([]);
  });

  // Two tests lived here that promised more than they checked, and are superseded by the forwarding
  // suite below:
  //   - "threads maxAgeMs/maxTraces into the assembler" pinned the clock at 0 with maxAgeMs 10_000, so
  //     the age bound could never elapse and only the maxTraces half was ever exercised;
  //   - "defaults to a Date.now clock when none is injected" fed a single ROOT span, which assembles
  //     against an empty buffer — it passed with a clock returning `undefined`, so it asserted nothing
  //     about the default clock at all.
});

/**
 * The factory's own wiring — the options it forwards to the assembler and the default it substitutes when
 * one is absent.
 *
 * Every other test in this file injects a clock and takes the bounds as given, so the DEFAULTS were never
 * exercised: the built-in `Date.now` clock could have returned anything, and `maxAgeMs`/`maxTraces` could
 * have been dropped on the floor between the option and the assembler, with no test disagreeing. Both are
 * only observable indirectly — through which buffered children survive to reach the emitted transaction.
 */
describe('createBugseeSpanProcessor — option forwarding + defaults', () => {
  const child = (traceId: string, spanId: string): ReadableSpanLike =>
    readable({ traceId, spanId, parentSpanId: 'ffffffffffffffff' });
  const root = (traceId: string): ReadableSpanLike =>
    readable({ traceId, spanId: 'r00tr00tr00tr00t' });

  const TRACE_A = '0123456789abcdef0123456789abcde1';
  const TRACE_B = '0123456789abcdef0123456789abcde2';

  it('forwards maxAgeMs, so a trace whose root is late loses its buffered children', () => {
    const emitted: TransactionWire[] = [];
    let now = 1_000_000;
    const processor = createBugseeSpanProcessor({
      onTransaction: (t) => emitted.push(t),
      clock: { wallNow: () => now },
      maxAgeMs: 1000,
    });

    processor.onEnd(child(TRACE_A, 'c1c1c1c1c1c1c1c1'));
    now += 5000; // well past the forwarded 1000ms, but well inside the 30000ms default
    processor.onEnd(root(TRACE_A));

    expect(emitted).toHaveLength(1);
    // With the option forwarded the buffer was evicted first, so the root assembles alone. If the forward
    // were dropped, the 30s default would have kept the child and this would be 1.
    expect(emitted[0]?.spans, 'the aged trace buffer was not evicted').toHaveLength(0);
  });

  it('forwards maxTraces, so a new trace evicts the oldest buffered one', () => {
    const emitted: TransactionWire[] = [];
    const processor = createBugseeSpanProcessor({
      onTransaction: (t) => emitted.push(t),
      clock: { wallNow: () => 1_000_000 },
      maxTraces: 1,
    });

    processor.onEnd(child(TRACE_A, 'c1c1c1c1c1c1c1c1'));
    processor.onEnd(child(TRACE_B, 'c2c2c2c2c2c2c2c2')); // over the cap of 1 → trace A is dropped
    processor.onEnd(root(TRACE_A));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.spans, 'the over-cap trace buffer was not evicted').toHaveLength(0);
  });

  it('keeps a trace inside the forwarded bounds', () => {
    const emitted: TransactionWire[] = [];
    let now = 1_000_000;
    const processor = createBugseeSpanProcessor({
      onTransaction: (t) => emitted.push(t),
      clock: { wallNow: () => now },
      maxAgeMs: 1000,
      maxTraces: 8,
    });

    processor.onEnd(child(TRACE_A, 'c1c1c1c1c1c1c1c1'));
    now += 500; // inside the age bound
    processor.onEnd(root(TRACE_A));

    expect(emitted[0]?.spans, 'a trace inside both bounds lost its child').toHaveLength(1);
    expect(emitted[0]?.spans[0]?.spanId).toBe('c1c1c1c1c1c1c1c1');
  });

  it('uses a real wall clock when none is injected', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const emitted: TransactionWire[] = [];
      // NO clock option — the built-in `Date.now` one has to do the work.
      const processor = createBugseeSpanProcessor({
        onTransaction: (t) => emitted.push(t),
        maxAgeMs: 1000,
      });

      processor.onEnd(child(TRACE_A, 'c1c1c1c1c1c1c1c1'));
      vi.setSystemTime(new Date('2026-01-01T00:00:10Z')); // +10s, past the 1s bound
      processor.onEnd(root(TRACE_A));

      // The default clock read real wall time and the age bound bit. A clock that returned a constant —
      // or `undefined` — would compare NaN, evict nothing, and leave the child attached.
      expect(emitted[0]?.spans, 'the default clock did not advance').toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
