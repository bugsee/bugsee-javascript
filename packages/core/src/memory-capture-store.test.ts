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

// A record whose serialized form is exactly `bytes` ASCII bytes (utf8 length == char count).
const recBytes = (type: FileType, timestamp: number, bytes: number): StoredEntry =>
  rec(type, timestamp, 'x'.repeat(bytes));

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

describe('createMemoryCaptureStore — maxDataSize byte bound', () => {
  it('is unbounded by default (no byte eviction)', async () => {
    const store = mk(); // no maxDataSizeBytes
    store.add(recBytes('log', 10_000, 1000));
    store.tick(11_000);
    store.add(recBytes('log', 11_000, 1000));
    store.tick(12_000);
    store.add(recBytes('log', 12_000, 1000));
    expect((await store.snapshot().drainAll()).get('log')).toHaveLength(3);
  });

  it('evicts whole oldest closed parts once the byte total exceeds the cap', async () => {
    // cap 30 bytes, 10-byte records: part0(r0) + part1(r1) + part2(r2,r3) → total 40 > 30, so the
    // oldest closed part (part0) is dropped down to 30.
    const store = mk({ maxDataSizeBytes: 30 });
    store.add(recBytes('log', 1, 10)); // part0
    store.tick(10_100);
    store.add(recBytes('log', 2, 10)); // part1
    store.tick(10_200);
    store.add(recBytes('log', 3, 10)); // part2
    store.add(recBytes('log', 4, 10)); // part2 → total 40 → evict part0
    const got = (await store.snapshot().drainAll()).get('log') ?? [];
    expect(got.map((r) => r.timestamp)).toEqual([2, 3, 4]); // oldest (ts 1) dropped, newest kept
  });

  it('never evicts the open current part (soft bound): a single oversized part is kept', async () => {
    const store = mk({ maxDataSizeBytes: 5 });
    store.add(recBytes('log', 1, 50)); // 50 > 5, but it is the only (open) part → kept
    expect((await store.snapshot().drainAll()).get('log')).toHaveLength(1);
  });

  it('evicts MULTIPLE oldest parts in a single add when one record overflows past several', async () => {
    // cap 25; two 10-byte closed parts (total 20, under cap) then a 30-byte record lands → total 50,
    // so a SINGLE add must evict BOTH older parts (loops), leaving only the large current record.
    const store = mk({ maxDataSizeBytes: 25 });
    store.add(recBytes('log', 1, 10)); // part0
    store.tick(10_100);
    store.add(recBytes('log', 2, 10)); // part1
    store.tick(10_200);
    store.add(recBytes('log', 3, 30)); // part2 → total 50 → evict part0 AND part1 in this one add
    const got = (await store.snapshot().drainAll()).get('log') ?? [];
    expect(got.map((r) => r.timestamp)).toEqual([3]); // both older parts gone, large record kept
  });

  it('keeps the byte total accurate when time-eviction also runs (no double-count drift)', async () => {
    // window 2000ms, cap 30, 10-byte records. part0 is time-evicted at tick(15_000); if its bytes
    // were NOT subtracted from the running total, a later add would over-evict part1.
    const store = mk({ maxRecordingTimeMs: 2000, maxDataSizeBytes: 30 });
    store.add(recBytes('log', 10_000, 10)); // part0
    store.tick(11_000); // part0 closes @11000
    store.add(recBytes('log', 11_000, 10)); // part1
    store.tick(15_000); // cutting 12000 → part0 (end 11000) time-evicted; part1 kept
    store.add(recBytes('log', 15_000, 10)); // part2
    store.add(recBytes('log', 15_001, 10)); // part2 → total should be 30 (not 40) → no byte evict
    const got = (await store.snapshot().drainAll()).get('log') ?? [];
    expect(got.map((r) => r.timestamp)).toEqual([11_000, 15_000, 15_001]); // part1 survives
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

  it('resets the byte total so post-clear captures are not wrongly evicted', async () => {
    // Fill to the cap, clear (must zero the running byte total), then capture fresh data under the
    // cap across two parts. If clear left the total at 30, the later adds would over-evict part_new.
    const store = mk({ maxDataSizeBytes: 30 });
    store.add(recBytes('log', 1, 10));
    store.add(recBytes('log', 2, 10));
    store.add(recBytes('log', 3, 10)); // total 30
    store.clear();
    store.add(recBytes('log', 4, 10)); // fresh part
    store.tick(10_100); // close it
    store.add(recBytes('log', 5, 10)); // total should be 20, well under 30 → nothing evicted
    const got = (await store.snapshot().drainAll()).get('log') ?? [];
    expect(got.map((r) => r.timestamp)).toEqual([4, 5]);
  });
});
