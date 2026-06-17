import type { FileType } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { type ChunkStorage, createInMemoryChunkStorage } from './chunk-storage';
import type { Clock } from './clock';
import type { StoredEntry } from './contracts';
import { createFileCaptureStore, type FileCaptureStoreOptions } from './file-capture-store';

const rec = (type: FileType, timestamp: number, serialized = '{}'): StoredEntry => ({
  type,
  timestamp,
  serialized,
});
const clockAt = (now: number): Clock => ({ wallNow: () => now, monotonicNow: () => 0 });

// The default generation is the clock's wallNow at construction — clockAt(10_000) below → generation G.
const G = 10_000;
const mk = (storage: ChunkStorage, over: FileCaptureStoreOptions = {}) =>
  createFileCaptureStore(storage, { clock: clockAt(10_000), ...over });

// A 20-char ASCII payload; every such record (5-digit timestamp) encodes to the same on-disk bytes (`enc`),
// so the byte-cap math in the tests is exact. `enc` mirrors the backend's frame: `<timestamp>\t<serialized>\n`.
const PAYLOAD = 'x'.repeat(20);
const recBytes = (type: FileType, timestamp: number): StoredEntry => rec(type, timestamp, PAYLOAD);
const enc = (timestamp: number): number => `${timestamp}\t${PAYLOAD}\n`.length;
const U = enc(10_000); // one record's on-disk byte size (5-digit timestamp)

describe('createFileCaptureStore — add + snapshot', () => {
  it('persists records and snapshots them grouped by file type', async () => {
    const store = mk(createInMemoryChunkStorage());
    const log = rec('log', 10_000, '{"m":"hi"}');
    const net = rec('network', 10_000, '{"u":"x"}');
    store.add(log);
    store.add(net);
    const snap = await store.snapshot().drainAll();
    expect(snap.get('log')).toEqual([log]);
    expect(snap.get('network')).toEqual([net]);
  });

  it('lays each part out as a chunk dir: a meta file + one data file per type', () => {
    const storage = createInMemoryChunkStorage();
    mk(storage).add(rec('log', 10_000));
    expect(storage.chunks(G)).toEqual([0]); // one part → one chunk
    expect(new Set(storage.files(G, 0))).toEqual(new Set(['meta', 'log']));
    expect(storage.read(G, 0, 'log')).toBe('10000\t{}\n');
  });

  it('writes a durable meta file on open (end null) and rewrites it on close (end + byteSize)', () => {
    const storage = createInMemoryChunkStorage();
    const store = mk(storage);
    store.add(rec('log', 10_000));
    expect(JSON.parse(storage.read(G, 0, 'meta') as string)).toEqual({
      n: 0,
      s: 10_000,
      e: null,
      b: 0,
    });
    store.tick(11_000); // closes part 0
    expect(JSON.parse(storage.read(G, 0, 'meta') as string)).toEqual({
      n: 0,
      s: 10_000,
      e: 11_000,
      b: '10000\t{}\n'.length, // the one '{}' record's on-disk bytes
    });
  });

  it('keeps same-type records in part order across a rotation', async () => {
    const store = mk(createInMemoryChunkStorage());
    store.add(rec('log', 10_000));
    store.tick(11_000);
    store.add(rec('log', 11_000));
    expect((await store.snapshot().drainAll()).get('log')).toEqual([
      rec('log', 10_000),
      rec('log', 11_000),
    ]);
  });

  it('ignores a chunk the store does not track (a leftover/evicted part of this generation)', async () => {
    const storage = createInMemoryChunkStorage();
    const store = mk(storage);
    store.add(rec('log', 10_000)); // part 0 (active)
    storage.append(G, 99, 'log', '99\t{}\n'); // a chunk the store doesn't track
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 10_000)]);
  });

  it('skips a corrupt line in a part data file', async () => {
    const storage = createInMemoryChunkStorage();
    const store = mk(storage);
    store.add(rec('log', 10_000, '{"m":"a"}'));
    storage.append(G, 0, 'log', 'corrupt-not-json\n'); // a bad line appended to the part file
    expect((await store.snapshot().drainAll()).get('log')).toEqual([
      rec('log', 10_000, '{"m":"a"}'),
    ]);
  });
});

describe('createFileCaptureStore — tick rotation + cleanup', () => {
  it('deletes the chunk dirs of parts outside the recording window on tick', async () => {
    const storage = createInMemoryChunkStorage();
    const store = mk(storage, { maxRecordingTimeMs: 2000 }); // cutting = now - 3000
    store.add(rec('log', 10_000)); // part 0
    store.tick(11_000); // part 0 closes @11000, part 1 opens
    store.add(rec('log', 11_000)); // part 1
    store.tick(15_000); // cutting 12000 → part 0 (end 11000) evicted, its chunk removed
    expect(storage.chunks(G)).not.toContain(0); // part 0's chunk gone
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 11_000)]);
  });

  it('keeps a part whose end is exactly at the cutting edge (strict <)', async () => {
    const store = mk(createInMemoryChunkStorage(), { maxRecordingTimeMs: 2000 });
    store.add(rec('log', 10_000));
    store.tick(12_000); // part 0 end = 12000
    store.tick(15_000); // cutting 12000; 12000 is NOT < 12000 → kept
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 10_000)]);
  });
});

describe('createFileCaptureStore — generations', () => {
  it('namespaces chunks by generation (a different generation does not see this one’s data)', async () => {
    const storage = createInMemoryChunkStorage();
    const a = createFileCaptureStore(storage, { clock: clockAt(10_000), generation: 1 });
    a.add(rec('log', 1));
    const b = createFileCaptureStore(storage, {
      clock: clockAt(10_000),
      generation: 2,
      cleanOtherGenerations: false, // do not let it clean a's chunks
    });
    expect((await b.snapshot().drainAll()).size).toBe(0); // gen 2 has no records
    expect((await a.snapshot().drainAll()).get('log')).toEqual([rec('log', 1)]); // gen 1 still sees its own
  });

  it('on a fresh launch, deletes other generations’ leftover chunks', () => {
    const storage = createInMemoryChunkStorage();
    storage.append(5, 0, 'log', '1\t{}\n'); // a prior launch (generation 5) left this
    createFileCaptureStore(storage, { clock: clockAt(10_000), generation: 9 });
    expect(storage.generations()).not.toContain(5); // the stale generation is discarded
  });

  it('does not delete its OWN generation’s pre-existing chunks on construction', () => {
    const storage = createInMemoryChunkStorage();
    storage.append(9, 0, 'log', 'mine'); // same generation as the store about to launch
    createFileCaptureStore(storage, { clock: clockAt(10_000), generation: 9 });
    expect(storage.read(9, 0, 'log')).toBe('mine');
  });

  it('cleanOtherGenerations: false keeps other generations’ chunks', () => {
    const storage = createInMemoryChunkStorage();
    storage.append(5, 0, 'log', 'stale');
    createFileCaptureStore(storage, {
      clock: clockAt(10_000),
      generation: 9,
      cleanOtherGenerations: false,
    });
    expect(storage.generations()).toContain(5);
  });
});

describe('createFileCaptureStore — maxDataSize byte bound', () => {
  it('is unbounded by default (no byte eviction)', async () => {
    const store = mk(createInMemoryChunkStorage()); // no maxDataSizeBytes
    store.add(recBytes('log', 10_000));
    store.tick(10_100);
    store.add(recBytes('log', 10_001));
    store.tick(10_200);
    store.add(recBytes('log', 10_002));
    expect((await store.snapshot().drainAll()).get('log')).toHaveLength(3);
  });

  it('evicts whole oldest closed parts and removes their chunk dirs once over the byte cap', async () => {
    // cap = 3 records: part0(r0) + part1(r1) + part2(r2,r3) = 4U > 3U → drop oldest closed part0.
    const storage = createInMemoryChunkStorage();
    const store = mk(storage, { maxDataSizeBytes: 3 * U });
    store.add(recBytes('log', 10_000)); // part0
    store.tick(10_100);
    store.add(recBytes('log', 10_001)); // part1
    store.tick(10_200);
    store.add(recBytes('log', 10_002)); // part2
    store.add(recBytes('log', 10_003)); // part2 → total 4U → evict part0
    const got = (await store.snapshot().drainAll()).get('log') ?? [];
    expect(got.map((r) => r.timestamp)).toEqual([10_001, 10_002, 10_003]);
    expect(storage.chunks(G)).not.toContain(0); // part0's chunk deleted
    expect(storage.chunks(G)).toContain(1); // part1's chunk kept
  });

  it('never evicts the open current part (soft bound): a single oversized part is kept', async () => {
    const store = mk(createInMemoryChunkStorage(), { maxDataSizeBytes: 1 }); // far below one record
    store.add(recBytes('log', 10_000)); // only (open) part → kept despite exceeding the cap
    expect((await store.snapshot().drainAll()).get('log')).toHaveLength(1);
  });

  it('evicts MULTIPLE oldest parts in a single add when one record overflows past several', async () => {
    const recPay = (ts: number, chars: number): StoredEntry => rec('log', ts, 'x'.repeat(chars));
    // Frame bytes = <5-digit ts>\t + payload + \n = chars + 7.
    const store = mk(createInMemoryChunkStorage(), { maxDataSizeBytes: 80 });
    store.add(recPay(10_000, 20)); // part0 (27B)
    store.tick(10_100);
    store.add(recPay(10_001, 20)); // part1 (27B) → total 54
    store.tick(10_200);
    store.add(recPay(10_002, 60)); // part2 (67B) → total 121 → evict part0 AND part1 in this add
    const got = (await store.snapshot().drainAll()).get('log') ?? [];
    expect(got.map((r) => r.timestamp)).toEqual([10_002]); // both older parts gone, large record kept
  });

  it('keeps the byte total accurate when time-eviction also runs (no double-count drift)', async () => {
    const store = mk(createInMemoryChunkStorage(), {
      maxRecordingTimeMs: 2000,
      maxDataSizeBytes: 3 * U,
    });
    store.add(recBytes('log', 10_000)); // part0
    store.tick(11_000); // part0 closes @11000
    store.add(recBytes('log', 11_000)); // part1
    store.tick(15_000); // cutting 12000 → part0 time-evicted; part1 kept
    store.add(recBytes('log', 15_000)); // part2
    store.add(recBytes('log', 15_001)); // part2 → total should be 3U (not 4U) → no byte evict
    const got = (await store.snapshot().drainAll()).get('log') ?? [];
    expect(got.map((r) => r.timestamp)).toEqual([11_000, 15_000, 15_001]); // part1 survives
  });
});

describe('createFileCaptureStore — snapshot isolation', () => {
  it('freezes the snapshot: capture after snapshot() does not change it', async () => {
    const store = mk(createInMemoryChunkStorage());
    store.add(rec('log', 10_000));
    const snap = store.snapshot();
    store.add(rec('log', 10_001)); // after the snapshot
    expect((await snap.drainAll()).get('log')).toEqual([rec('log', 10_000)]); // unchanged
    expect((await store.snapshot().drainAll()).get('log')).toEqual([
      rec('log', 10_000),
      rec('log', 10_001),
    ]);
  });

  it('release() empties the snapshot', async () => {
    const store = mk(createInMemoryChunkStorage());
    store.add(rec('log', 10_000));
    const snap = store.snapshot();
    snap.release();
    expect((await snap.drainAll()).size).toBe(0);
  });

  it('snapshot of an empty store yields nothing', async () => {
    expect((await mk(createInMemoryChunkStorage()).snapshot().drainAll()).size).toBe(0);
  });

  it('works with default options (system clock, 60s window)', async () => {
    const store = createFileCaptureStore(createInMemoryChunkStorage()); // no clock/window → defaults
    store.add(rec('log', 10_000)); // no tick → current part never evicted
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 10_000)]);
  });

  it('tolerates an active part data file that reads as undefined (removed mid-snapshot)', async () => {
    // A ChunkStorage that lists a data file but reads it as undefined.
    const storage: ChunkStorage = {
      append: () => {},
      write: () => {},
      read: () => undefined,
      files: () => ['log'],
      removeChunk: () => {},
      chunks: () => [],
      generations: () => [],
      removeGeneration: () => {},
    };
    expect((await mk(storage).snapshot().drainAll()).size).toBe(0);
  });
});

describe('createFileCaptureStore — clear', () => {
  it('removes this generation’s chunks and keeps working afterwards', async () => {
    const storage = createInMemoryChunkStorage();
    const store = mk(storage);
    store.add(rec('log', 10_000));
    store.add(rec('network', 10_000));
    store.clear();
    expect(storage.chunks(G).length).toBeLessThanOrEqual(1); // only the fresh post-clear part may exist
    store.add(rec('log', 10_001));
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 10_001)]);
  });

  it('resets the byte total so post-clear captures are not wrongly evicted', async () => {
    const store = mk(createInMemoryChunkStorage(), { maxDataSizeBytes: 3 * U });
    store.add(recBytes('log', 10_000));
    store.add(recBytes('log', 10_001));
    store.add(recBytes('log', 10_002)); // total 3U
    store.clear(); // must zero the running byte total
    store.add(recBytes('log', 10_003)); // fresh part
    store.tick(10_100); // close it
    store.add(recBytes('log', 10_004)); // total should be 2U, under cap → nothing evicted
    const got = (await store.snapshot().drainAll()).get('log') ?? [];
    expect(got.map((r) => r.timestamp)).toEqual([10_003, 10_004]);
  });

  it('clear() leaves another generation’s chunks intact', () => {
    const storage = createInMemoryChunkStorage();
    storage.append(5, 0, 'log', 'other-gen');
    const store = createFileCaptureStore(storage, {
      clock: clockAt(10_000),
      generation: 9,
      cleanOtherGenerations: false,
    });
    store.add(rec('log', 10_000));
    store.clear();
    expect(storage.read(5, 0, 'log')).toBe('other-gen'); // only generation 9’s chunks were cleared
  });
});
