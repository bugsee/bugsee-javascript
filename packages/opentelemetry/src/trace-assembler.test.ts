import type { TransactionWire } from '@bugsee/performance';
import { describe, expect, it } from 'vitest';
import type { ConsumedSpan } from './from-otlp';
import { createTraceAssembler } from './trace-assembler';

const span = (over: Partial<ConsumedSpan>): ConsumedSpan => ({
  traceId: 'T',
  spanId: 's',
  name: 'op',
  startTimeMs: 0,
  endTimeMs: 1,
  status: { code: 1 },
  ...over,
});

function fakeClock(start = 0) {
  let t = start;
  return { clock: { wallNow: () => t }, set: (v: number) => (t = v) };
}

describe('createTraceAssembler', () => {
  it('emits ONE transaction when the root ends, bundling the children seen so far', () => {
    const emitted: TransactionWire[] = [];
    const a = createTraceAssembler({
      onTransaction: (t) => emitted.push(t),
      clock: fakeClock().clock,
    });
    a.add(
      span({
        traceId: 'T',
        spanId: 'c1',
        parentSpanId: 'r',
        name: 'child',
        startTimeMs: 10,
        endTimeMs: 20,
      }),
    );
    a.add(span({ traceId: 'T', spanId: 'c2', parentSpanId: 'c1', name: 'gc' }));
    expect(emitted).toHaveLength(0); // no root yet
    expect(a.size()).toBe(1); // one buffered trace
    a.add(span({ traceId: 'T', spanId: 'r', name: 'root', startTimeMs: 5, endTimeMs: 30 })); // root (no parent)
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.traceId).toBe('T');
    expect(emitted[0]?.name).toBe('root'); // the root's name becomes the transaction name
    expect(emitted[0]?.spans.map((s) => s.spanId)).toEqual(['c1', 'c2']); // children, in arrival order
    expect(a.size()).toBe(0); // buffer cleared
  });

  it('emits a root-only transaction (no children) immediately', () => {
    const emitted: TransactionWire[] = [];
    const a = createTraceAssembler({
      onTransaction: (t) => emitted.push(t),
      clock: fakeClock().clock,
    });
    a.add(span({ traceId: 'X', spanId: 'r', name: 'solo' }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.spans).toEqual([]);
    expect(a.size()).toBe(0);
  });

  it('does not emit an incomplete trace (no root); it stays buffered', () => {
    const emitted: TransactionWire[] = [];
    const a = createTraceAssembler({
      onTransaction: (t) => emitted.push(t),
      clock: fakeClock().clock,
    });
    a.add(span({ traceId: 'Y', spanId: 'c', parentSpanId: 'missing' }));
    expect(emitted).toHaveLength(0);
    expect(a.size()).toBe(1);
  });

  it('assembles independent traces independently', () => {
    const emitted: TransactionWire[] = [];
    const a = createTraceAssembler({
      onTransaction: (t) => emitted.push(t),
      clock: fakeClock().clock,
    });
    a.add(span({ traceId: 'A', spanId: 'ca', parentSpanId: 'ra' }));
    a.add(span({ traceId: 'B', spanId: 'cb', parentSpanId: 'rb' }));
    expect(a.size()).toBe(2);
    a.add(span({ traceId: 'A', spanId: 'ra', name: 'rootA' }));
    expect(emitted.map((t) => t.traceId)).toEqual(['A']);
    expect(a.size()).toBe(1); // B still buffered
  });

  it('evicts a trace whose root never arrives after maxAgeMs (dropped, not emitted)', () => {
    const emitted: TransactionWire[] = [];
    const { clock, set } = fakeClock(1000);
    const a = createTraceAssembler({
      onTransaction: (t) => emitted.push(t),
      clock,
      maxAgeMs: 5000,
    });
    a.add(span({ traceId: 'old', spanId: 'c', parentSpanId: 'r' })); // firstSeen 1000
    expect(a.size()).toBe(1);
    set(6001); // age 5001 > 5000
    a.add(span({ traceId: 'new', spanId: 'c2', parentSpanId: 'r2' })); // triggers eviction of 'old'
    expect(a.size()).toBe(1); // only 'new'
    expect(emitted).toHaveLength(0); // 'old' was dropped, never emitted
  });

  it('ages a trace from its ACTUAL first-seen time, not from clock zero', () => {
    // A young trace added at a large clock value must NOT be evicted; if firstSeen were 0 it would be,
    // since now (100100) - 0 > maxAge. This pins that firstSeenMs is the real wall-clock at first sight.
    const { clock, set } = fakeClock(100_000);
    const a = createTraceAssembler({ onTransaction: () => {}, clock, maxAgeMs: 5000 });
    a.add(span({ traceId: 'young', spanId: 'c', parentSpanId: 'r' })); // firstSeen 100000
    set(100_100); // only 100 ms later → age 100 << 5000
    a.add(span({ traceId: 'other', spanId: 'c2', parentSpanId: 'r2' }));
    expect(a.size()).toBe(2); // 'young' kept (a firstSeen of 0 would wrongly evict it)
  });

  it('does not evict a trace exactly at maxAgeMs (boundary)', () => {
    const { clock, set } = fakeClock(0);
    const a = createTraceAssembler({ onTransaction: () => {}, clock, maxAgeMs: 5000 });
    a.add(span({ traceId: 'edge', spanId: 'c', parentSpanId: 'r' })); // firstSeen 0
    set(5000); // age exactly 5000 == maxAge → keep
    a.add(span({ traceId: 'other', spanId: 'c2', parentSpanId: 'r2' }));
    expect(a.size()).toBe(2); // edge NOT evicted
  });

  it('caps the buffer at maxTraces, evicting the OLDEST (not the newest)', () => {
    const emitted: TransactionWire[] = [];
    const a = createTraceAssembler({
      onTransaction: (t) => emitted.push(t),
      clock: fakeClock().clock,
      maxTraces: 2,
    });
    a.add(span({ traceId: 'T1', spanId: 'c1', parentSpanId: 'r' }));
    a.add(span({ traceId: 'T2', spanId: 'c2', parentSpanId: 'r' }));
    a.add(span({ traceId: 'T3', spanId: 'c3', parentSpanId: 'r' })); // over cap → evict T1 (oldest)
    expect(a.size()).toBe(2);
    // Prove T1 (the OLDEST) was evicted and T2 survived — an "evict newest" bug would flip these.
    a.add(span({ traceId: 'T1', spanId: 'r1', name: 'rootT1' }));
    expect(emitted.find((t) => t.traceId === 'T1')?.spans).toEqual([]); // T1's child c1 was evicted
    a.add(span({ traceId: 'T2', spanId: 'r2', name: 'rootT2' }));
    expect(emitted.find((t) => t.traceId === 'T2')?.spans.map((s) => s.spanId)).toEqual(['c2']); // T2 survived
  });

  it('clear() drops all buffered traces', () => {
    const a = createTraceAssembler({ onTransaction: () => {}, clock: fakeClock().clock });
    a.add(span({ traceId: 'Z', spanId: 'c', parentSpanId: 'r' }));
    a.clear();
    expect(a.size()).toBe(0);
  });
});
