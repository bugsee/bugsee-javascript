import { describe, expect, it } from 'vitest';
import {
  createAvailableMemoryReader,
  createMemoryLimitReader,
  createV8HeapReader,
} from './runtime-readers';

const GiB = 1024 ** 3;

describe('createV8HeapReader', () => {
  const stats = {
    heap_size_limit: 4 * GiB,
    used_heap_size: 100,
    total_available_size: 4 * GiB - 100,
    malloced_memory: 7,
    peak_malloced_memory: 9,
  };

  it('maps v8.getHeapStatistics() onto limit / used / available / malloced / peakMalloced', () => {
    expect(createV8HeapReader(() => stats)()).toEqual({
      limit: 4 * GiB,
      used: 100,
      available: 4 * GiB - 100,
      malloced: 7,
      peakMalloced: 9,
    });
  });

  it('answers undefined when a field is missing or not a finite number (never a half-true row)', () => {
    for (const bad of [
      { ...stats, heap_size_limit: undefined },
      { ...stats, used_heap_size: Number.NaN },
      { ...stats, total_available_size: Number.POSITIVE_INFINITY },
      { ...stats, malloced_memory: 'x' },
      { ...stats, peak_malloced_memory: null },
    ]) {
      expect(createV8HeapReader(() => bad as never)()).toBeUndefined();
    }
  });

  it('reads the statistics fresh on every call', () => {
    let used = 1;
    const read = createV8HeapReader(() => ({ ...stats, used_heap_size: used }));
    expect(read()?.used).toBe(1);
    used = 2;
    expect(read()?.used).toBe(2);
  });
});

describe('createMemoryLimitReader', () => {
  const total = 16 * GiB;
  const mk = (value: unknown) =>
    createMemoryLimitReader({ constrainedMemory: () => value as number }, () => total);

  it('reports a real cgroup cap', () => {
    expect(mk(256 * 1024 * 1024)()).toBe(256 * 1024 * 1024);
    expect(mk(total - 1)()).toBe(total - 1);
  });

  it('omits 0 (macOS / unconstrained)', () => {
    expect(mk(0)()).toBeUndefined();
  });

  it('omits the 2^64 Linux "no limit" sentinel', () => {
    expect(mk(18446744073709552000)()).toBeUndefined();
    expect(mk(2 ** 63)()).toBeUndefined();
  });

  it('omits a value equal to total RAM (Bun reports totalmem when unconstrained) or above it', () => {
    expect(mk(total)()).toBeUndefined();
    expect(mk(total + 1)()).toBeUndefined();
  });

  it('omits negatives and non-finite or non-number answers', () => {
    for (const v of [-1, Number.NaN, Number.POSITIVE_INFINITY, undefined, '5', null]) {
      expect(mk(v)()).toBeUndefined();
    }
  });

  it('is undefined (feature-detected) where process.constrainedMemory does not exist', () => {
    expect(createMemoryLimitReader({}, () => total)()).toBeUndefined();
  });

  it('reads total RAM per call, not once', () => {
    let t = 100;
    const read = createMemoryLimitReader({ constrainedMemory: () => 50 }, () => t);
    expect(read()).toBe(50);
    t = 40;
    expect(read()).toBeUndefined();
  });
});

describe('createAvailableMemoryReader', () => {
  it('reports process.availableMemory()', () => {
    expect(createAvailableMemoryReader({ availableMemory: () => 123 })()).toBe(123);
    expect(createAvailableMemoryReader({ availableMemory: () => 0 })()).toBe(0);
  });

  it('is undefined (feature-detected) where it does not exist, and for non-finite or negative answers', () => {
    expect(createAvailableMemoryReader({})()).toBeUndefined();
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, -1, '1', undefined]) {
      expect(createAvailableMemoryReader({ availableMemory: () => v as number })()).toBeUndefined();
    }
  });
});
