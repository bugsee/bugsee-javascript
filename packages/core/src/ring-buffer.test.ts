import { describe, expect, it } from 'vitest';
import { createRingBuffer } from './ring-buffer';

describe('createRingBuffer', () => {
  it('starts empty with the given capacity', () => {
    const buf = createRingBuffer<number>(3);
    expect(buf.capacity).toBe(3);
    expect(buf.size).toBe(0);
    expect(buf.toArray()).toEqual([]);
  });

  it('buffers items under capacity in insertion order', () => {
    const buf = createRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    expect(buf.size).toBe(2);
    expect(buf.toArray()).toEqual([1, 2]);
  });

  it('retains exactly capacity items when filled', () => {
    const buf = createRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.size).toBe(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
  });

  it('evicts the oldest item once full (FIFO), capping size at capacity', () => {
    const buf = createRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // evicts 1
    expect(buf.size).toBe(3);
    expect(buf.toArray()).toEqual([2, 3, 4]);
  });

  it('preserves oldest-to-newest order across multiple wraps', () => {
    const buf = createRingBuffer<number>(3);
    for (let i = 1; i <= 8; i += 1) {
      buf.push(i);
    }
    // last 3 pushed, in order
    expect(buf.toArray()).toEqual([6, 7, 8]);
    expect(buf.size).toBe(3);
  });

  it('with capacity 1 keeps only the latest item', () => {
    const buf = createRingBuffer<number>(1);
    buf.push(1);
    buf.push(2);
    expect(buf.size).toBe(1);
    expect(buf.toArray()).toEqual([2]);
  });

  it('drain returns the current contents oldest-to-newest and empties the buffer', () => {
    const buf = createRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    expect(buf.drain()).toEqual([1, 2]);
    expect(buf.size).toBe(0);
    expect(buf.toArray()).toEqual([]);
  });

  it('drain on an empty buffer returns []', () => {
    const buf = createRingBuffer<number>(3);
    expect(buf.drain()).toEqual([]);
    expect(buf.size).toBe(0);
  });

  it('drain after a wrap returns the live window, not stale slots', () => {
    const buf = createRingBuffer<number>(3);
    for (let i = 1; i <= 5; i += 1) {
      buf.push(i); // ends as [3,4,5]
    }
    expect(buf.drain()).toEqual([3, 4, 5]);
    expect(buf.size).toBe(0);
  });

  it('clear empties the buffer', () => {
    const buf = createRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.toArray()).toEqual([]);
  });

  it('pushing after drain refills correctly (slot reuse)', () => {
    const buf = createRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.drain();
    buf.push(10);
    buf.push(11);
    buf.push(12);
    buf.push(13); // evicts 10
    expect(buf.toArray()).toEqual([11, 12, 13]);
  });

  it('toArray returns a fresh, non-destructive copy', () => {
    const buf = createRingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    const a = buf.toArray();
    const b = buf.toArray();
    expect(a).not.toBe(b); // fresh array each call
    a.push(999); // mutating the copy must not affect the buffer
    expect(buf.size).toBe(2);
    expect(buf.toArray()).toEqual([1, 2]);
  });

  it('methods work when destructured (not this-bound)', () => {
    const buf = createRingBuffer<number>(3);
    const { push, drain } = buf;
    push(1);
    push(2);
    expect(drain()).toEqual([1, 2]);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('throws RangeError for invalid capacity %s', (cap) => {
    expect(() => createRingBuffer<number>(cap)).toThrow(RangeError);
    // Pin OUR validation specifically: `new Array(1.5)` also throws a RangeError ("Invalid array
    // length"), so a bare RangeError oracle would let a dropped integer/positivity check survive.
    expect(() => createRingBuffer<number>(cap)).toThrow(/must be a positive integer/);
  });
});
