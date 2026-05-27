import type { FileType } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import type { Clock } from './clock';
import type { StoredEntry } from './contracts';
import { createMemoryCaptureStore, type MemoryCaptureStoreOptions } from './memory-capture-store';

const rec = (type: FileType, timestamp: number, serialized = '{}'): StoredEntry => ({
  type,
  timestamp,
  serialized,
});

const clockAt = (now: number): Clock => ({ wallNow: () => now, monotonicNow: () => 0 });

// Non-retention tests run with now=1000 so the tiny timestamps below stay within the 60s window.
const mk = (over: MemoryCaptureStoreOptions = {}) =>
  createMemoryCaptureStore({ clock: clockAt(1000), ...over });

describe('createMemoryCaptureStore', () => {
  it('stores a record under its file type', async () => {
    const store = mk();
    const r = rec('log', 1, '{"message":"hi"}');
    store.add(r);
    expect(await store.drainAll()).toEqual(new Map([['log', [r]]]));
  });

  it('routes records to separate buffers by file type', async () => {
    const store = mk();
    const net = rec('network', 1);
    const log = rec('log', 2);
    store.add(net);
    store.add(log);
    const snap = await store.drainAll();
    expect(snap.get('network')).toEqual([net]);
    expect(snap.get('log')).toEqual([log]);
  });

  it('accumulates same-type records in insertion order', async () => {
    const store = mk();
    store.add(rec('log', 1));
    store.add(rec('log', 2));
    expect((await store.drainAll()).get('log')).toEqual([rec('log', 1), rec('log', 2)]);
  });

  it('drainAll clears the buffers (next drain is empty)', async () => {
    const store = mk();
    store.add(rec('log', 1));
    await store.drainAll();
    expect((await store.drainAll()).size).toBe(0);
  });

  it('drainAll omits file types with no buffered records', async () => {
    const store = mk();
    store.add(rec('log', 1));
    await store.drainAll();
    store.add(rec('network', 2));
    expect([...(await store.drainAll()).keys()]).toEqual(['network']);
  });

  it('bounds a file-type buffer at the count safety cap, evicting oldest', async () => {
    const store = mk({ defaultCapacity: 2 });
    store.add(rec('log', 1));
    store.add(rec('log', 2));
    store.add(rec('log', 3));
    expect((await store.drainAll()).get('log')?.map((e) => e.timestamp)).toEqual([2, 3]);
  });

  it('applies a per-type count cap override', async () => {
    const store = mk({ defaultCapacity: 100, capacities: { breadcrumbs: 1 } });
    store.add(rec('breadcrumbs', 1));
    store.add(rec('breadcrumbs', 2));
    expect((await store.drainAll()).get('breadcrumbs')?.map((e) => e.timestamp)).toEqual([2]);
  });

  it('clear empties all buffers', async () => {
    const store = mk();
    store.add(rec('log', 1));
    store.add(rec('network', 2));
    store.clear();
    expect((await store.drainAll()).size).toBe(0);
  });

  it('throws (via the ring buffer) for an invalid capacity', () => {
    const store = mk({ defaultCapacity: 0 });
    expect(() => store.add(rec('log', 1))).toThrow(/must be a positive integer/);
  });

  it('stream yields records one-by-one grouped by file type, then clears', async () => {
    const store = mk();
    store.add(rec('log', 1));
    store.add(rec('network', 2));
    store.add(rec('log', 3));
    const seen: string[] = [];
    for await (const r of store.stream()) {
      seen.push(`${r.type}:${r.timestamp}`);
    }
    expect(seen).toEqual(['log:1', 'log:3', 'network:2']);
    expect((await store.drainAll()).size).toBe(0);
  });

  it('stream drains eagerly at call time (before iteration), not lazily per yield', async () => {
    const store = mk();
    store.add(rec('log', 1));
    store.add(rec('network', 2));
    store.stream();
    expect((await store.drainAll()).size).toBe(0);
  });

  it('stream over an empty store yields nothing', async () => {
    const store = mk();
    const seen: unknown[] = [];
    for await (const r of store.stream()) {
      seen.push(r);
    }
    expect(seen).toEqual([]);
  });
});

describe('createMemoryCaptureStore — time-window retention (maxRecordingTime)', () => {
  it('drops records older than the window (now=100000, window=60000 → cutoff 40000)', async () => {
    const store = createMemoryCaptureStore({
      clock: clockAt(100_000),
      maxRecordingTimeMs: 60_000,
      defaultCapacity: 100, // count cap high so only the time window evicts
    });
    store.add(rec('log', 30_000)); // older than cutoff → dropped
    store.add(rec('log', 40_000)); // exactly at cutoff → kept (window is inclusive)
    store.add(rec('log', 50_000)); // within window
    store.add(rec('log', 90_000)); // within window
    expect((await store.drainAll()).get('log')?.map((e) => e.timestamp)).toEqual([
      40_000, 50_000, 90_000,
    ]);
  });

  it('re-applies the window at read time relative to the read clock (idle then trigger)', async () => {
    let now = 50_000;
    const store = createMemoryCaptureStore({
      clock: { wallNow: () => now, monotonicNow: () => 0 },
      maxRecordingTimeMs: 60_000,
      defaultCapacity: 100,
    });
    store.add(rec('log', 10_000)); // within window at add time (cutoff -10000)
    store.add(rec('log', 40_000));
    now = 120_000; // time advances; cutoff is now 60000 → both records are stale
    expect((await store.drainAll()).size).toBe(0);
  });

  it('stream() applies the window at read time, keeping the boundary record (>= cutoff)', async () => {
    const store = createMemoryCaptureStore({
      clock: clockAt(200_000), // window 60000 → cutoff 140000
      maxRecordingTimeMs: 60_000,
      defaultCapacity: 100,
    });
    store.add(rec('log', 100_000)); // below cutoff → dropped
    store.add(rec('log', 140_000)); // exactly cutoff → kept
    store.add(rec('log', 180_000)); // within → kept
    const seen: number[] = [];
    for await (const r of store.stream()) {
      seen.push(r.timestamp);
    }
    expect(seen).toEqual([140_000, 180_000]);
  });

  it('keeps everything when the window is Infinity', async () => {
    const store = createMemoryCaptureStore({
      clock: clockAt(1_000_000),
      maxRecordingTimeMs: Number.POSITIVE_INFINITY,
    });
    store.add(rec('log', 1)); // ancient, but window is unbounded
    expect((await store.drainAll()).get('log')).toEqual([rec('log', 1)]);
  });

  it('defaults the window to 60s when unspecified', async () => {
    // now=100000, default window 60000 → cutoff 40000.
    const store = createMemoryCaptureStore({ clock: clockAt(100_000), defaultCapacity: 100 });
    store.add(rec('log', 10_000)); // stale
    store.add(rec('log', 80_000)); // fresh
    expect((await store.drainAll()).get('log')?.map((e) => e.timestamp)).toEqual([80_000]);
  });
});
