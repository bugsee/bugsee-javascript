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

const mk = (over: MemoryCaptureStoreOptions = {}) =>
  createMemoryCaptureStore({ clock: clockAt(10_000), ...over });

describe('createMemoryCaptureStore — add + snapshot', () => {
  it('snapshots records grouped by file type', async () => {
    const store = mk();
    const log = rec('log', 10_000, '{"m":"hi"}');
    const net = rec('network', 10_000, '{"u":"x"}');
    store.add(log);
    store.add(net);
    const snap = await store.snapshot().drainAll();
    expect(snap.get('log')).toEqual([log]);
    expect(snap.get('network')).toEqual([net]);
  });

  it('keeps same-type records in insertion order across parts', async () => {
    const store = mk();
    store.add(rec('log', 10_000));
    store.tick(11_000); // rotate to a new part
    store.add(rec('log', 11_000));
    expect((await store.snapshot().drainAll()).get('log')).toEqual([
      rec('log', 10_000),
      rec('log', 11_000),
    ]);
  });

  it('stream yields records one-by-one, chronologically across parts', async () => {
    const store = mk();
    store.add(rec('log', 10_000));
    store.add(rec('network', 10_000));
    store.tick(11_000);
    store.add(rec('log', 11_000));
    const seen: string[] = [];
    for await (const r of store.snapshot().stream()) {
      seen.push(`${r.type}:${r.timestamp}`);
    }
    expect(seen).toEqual(['log:10000', 'network:10000', 'log:11000']);
  });
});

describe('createMemoryCaptureStore — tick rotation + cleanup', () => {
  it('evicts parts outside the recording window on tick', async () => {
    // window 2000ms → cutting = now - 2000 - 1000(partDuration) = now - 3000.
    const store = mk({ maxRecordingTimeMs: 2000 });
    store.add(rec('log', 10_000)); // part0
    store.tick(11_000); // part0 closes @11000, part1 opens
    store.add(rec('log', 11_000)); // part1
    store.tick(15_000); // part1 closes @15000, part2 opens; cutting=12000 → part0 (end 11000) evicted
    const snap = await store.snapshot().drainAll();
    expect(snap.get('log')).toEqual([rec('log', 11_000)]); // the 10_000 record is gone
  });

  it('keeps a part whose end is exactly at the cutting edge (strict <)', async () => {
    const store = mk({ maxRecordingTimeMs: 2000 });
    store.add(rec('log', 10_000));
    store.tick(12_000); // part0 end = 12000
    // next tick at now where cutting == 12000 exactly: now - 3000 = 12000 → now = 15000
    store.tick(15_000); // cutting 12000; part0.end 12000 is NOT < 12000 → kept
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 10_000)]);
  });

  it('cleanup is part-granular: a recently-closed part keeps its (older) records', async () => {
    // A part's lifetime is bounded by close time, not record timestamps (Android parity): a part
    // closed within the window is kept whole, even if it holds older records.
    const store = mk({ maxRecordingTimeMs: 2000 });
    store.add(rec('log', 5_000)); // an old record, but part0 stays open a while
    store.tick(11_000); // part0 closes @11000 (recent) → within window
    store.tick(11_500); // cutting 8500; part0.end 11000 >= 8500 → kept
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 5_000)]);
  });
});

describe('createMemoryCaptureStore — snapshot isolation', () => {
  it('freezes the snapshot: capture after snapshot() does not change it', async () => {
    const store = mk();
    store.add(rec('log', 10_000));
    const snap = store.snapshot();
    store.add(rec('log', 10_001)); // captured after the snapshot
    store.tick(11_000);
    store.add(rec('log', 11_000));
    expect((await snap.drainAll()).get('log')).toEqual([rec('log', 10_000)]); // unchanged
    // a fresh snapshot sees everything still in the window
    expect((await store.snapshot().drainAll()).get('log')).toEqual([
      rec('log', 10_000),
      rec('log', 10_001),
      rec('log', 11_000),
    ]);
  });

  it('release() empties the snapshot (its frozen copy is dropped)', async () => {
    const store = mk();
    store.add(rec('log', 10_000));
    const snap = store.snapshot();
    snap.release();
    expect((await snap.drainAll()).size).toBe(0);
    const seen: unknown[] = [];
    for await (const r of snap.stream()) {
      seen.push(r);
    }
    expect(seen).toEqual([]);
  });

  it('snapshot of an empty store yields nothing', async () => {
    expect((await mk().snapshot().drainAll()).size).toBe(0);
  });
});

describe('createMemoryCaptureStore — clear', () => {
  it('drops all records', async () => {
    const store = mk();
    store.add(rec('log', 10_000));
    store.add(rec('network', 10_000));
    store.clear();
    expect((await store.snapshot().drainAll()).size).toBe(0);
  });

  it('keeps working after clear (new captures land in a fresh part)', async () => {
    const store = mk();
    store.add(rec('log', 10_000));
    store.clear();
    store.add(rec('log', 10_001));
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 10_001)]);
  });
});
