import type { TransactionWire } from '@bugsee/performance';
import { describe, expect, it } from 'vitest';
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

  it('threads maxAgeMs/maxTraces into the assembler (maxTraces:1 evicts the older buffered trace)', () => {
    const emitted: TransactionWire[] = [];
    const proc = createBugseeSpanProcessor({
      onTransaction: (t) => emitted.push(t),
      clock: { wallNow: () => 0 },
      maxAgeMs: 10_000,
      maxTraces: 1,
    });
    proc.onEnd(readable({ traceId: 'A', spanId: 'ca', parentSpanId: 'ra' })); // buffered
    proc.onEnd(readable({ traceId: 'B', spanId: 'cb', parentSpanId: 'rb' })); // over cap(1) → A evicted
    proc.onEnd(readable({ traceId: 'A', spanId: 'ra', name: 'rootA' })); // A's child was evicted → no child
    expect(emitted[0]?.spans).toEqual([]);
  });

  it('defaults to a Date.now clock when none is injected (still assembles on root end)', () => {
    const emitted: TransactionWire[] = [];
    const proc = createBugseeSpanProcessor({ onTransaction: (t) => emitted.push(t) });
    proc.onEnd(readable({ traceId: 'T', spanId: 'r', name: 'solo' }));
    expect(emitted).toHaveLength(1);
  });
});
