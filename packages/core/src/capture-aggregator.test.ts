import type { FileType } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { createCaptureAggregator } from './capture-aggregator';
import type { CaptureDataEntry } from './contracts';

const entry = (type: FileType, timestamp: number, data: unknown = {}): CaptureDataEntry => ({
  type,
  timestamp,
  data,
});

describe('createCaptureAggregator', () => {
  it('buffers an entry under its file type', () => {
    const agg = createCaptureAggregator();
    const e = entry('log', 1, { message: 'hi' });
    agg.addEntry(e);
    expect(agg.snapshot()).toEqual(new Map([['log', [e]]]));
  });

  it('routes entries to separate buffers by file type', () => {
    const agg = createCaptureAggregator();
    const net = entry('network', 1);
    const log = entry('log', 2);
    agg.addEntry(net);
    agg.addEntry(log);
    const snap = agg.snapshot();
    expect(snap.get('network')).toEqual([net]);
    expect(snap.get('log')).toEqual([log]);
  });

  it('accumulates same-type entries in insertion order', () => {
    const agg = createCaptureAggregator();
    const a = entry('log', 1);
    const b = entry('log', 2);
    agg.addEntry(a);
    agg.addEntry(b);
    expect(agg.snapshot().get('log')).toEqual([a, b]);
  });

  it('addEntries adds a batch of mixed types', () => {
    const agg = createCaptureAggregator();
    const items = [entry('log', 1), entry('network', 2), entry('log', 3)];
    agg.addEntries(items);
    const snap = agg.snapshot();
    expect(snap.get('log')).toEqual([items[0], items[2]]);
    expect(snap.get('network')).toEqual([items[1]]);
  });

  it('addEntries with an empty batch is a no-op', () => {
    const agg = createCaptureAggregator();
    agg.addEntries([]);
    expect(agg.snapshot().size).toBe(0);
  });

  it('snapshot atomically clears the buffers (next snapshot is empty)', () => {
    const agg = createCaptureAggregator();
    agg.addEntry(entry('log', 1));
    agg.snapshot();
    expect(agg.snapshot().size).toBe(0);
  });

  it('snapshot omits file types with no buffered entries', () => {
    const agg = createCaptureAggregator();
    agg.addEntry(entry('log', 1));
    agg.snapshot(); // drains 'log'
    agg.addEntry(entry('network', 2)); // only network has entries now
    const snap = agg.snapshot();
    expect([...snap.keys()]).toEqual(['network']);
  });

  it('bounds a file-type buffer at defaultCapacity, evicting oldest', () => {
    const agg = createCaptureAggregator({ defaultCapacity: 2 });
    agg.addEntry(entry('log', 1));
    agg.addEntry(entry('log', 2));
    agg.addEntry(entry('log', 3));
    expect(
      agg
        .snapshot()
        .get('log')
        ?.map((e) => e.timestamp),
    ).toEqual([2, 3]);
  });

  it('applies a per-type capacity override', () => {
    const agg = createCaptureAggregator({ defaultCapacity: 100, capacities: { breadcrumbs: 1 } });
    agg.addEntry(entry('breadcrumbs', 1));
    agg.addEntry(entry('breadcrumbs', 2));
    expect(
      agg
        .snapshot()
        .get('breadcrumbs')
        ?.map((e) => e.timestamp),
    ).toEqual([2]);
  });

  it('clear empties all buffers', () => {
    const agg = createCaptureAggregator();
    agg.addEntry(entry('log', 1));
    agg.addEntry(entry('network', 2));
    agg.clear();
    expect(agg.snapshot().size).toBe(0);
  });

  it('throws (via the ring buffer) for an invalid capacity', () => {
    const agg = createCaptureAggregator({ defaultCapacity: 0 });
    expect(() => agg.addEntry(entry('log', 1))).toThrow(/must be a positive integer/);
  });
});
