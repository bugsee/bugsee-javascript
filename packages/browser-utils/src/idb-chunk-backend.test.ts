import 'fake-indexeddb/auto';
import {
  type CaptureSnapshot,
  type Clock,
  createDiskPressure,
  type PartRef,
  type StoredEntry,
} from '@bugsee/core';
import type { FileType } from '@bugsee/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { type AsyncKeyedStore, createIdbKeyedStore } from './idb';
import { createIdbChunkBackend, createIdbChunkCaptureStore } from './idb-chunk-backend';

const keyed = (): AsyncKeyedStore => createIdbKeyedStore({ indexedDB: new IDBFactory() });
const ref = (generation: number, number: number): PartRef => ({ generation, number });
const rec = (serialized: string, type: FileType = 'log', timestamp = 0): StoredEntry => ({
  type,
  timestamp,
  serialized,
});
const clockAt = (now: number): Clock => ({ wallNow: () => now, monotonicNow: () => 0 });
// The data-key prefix for a chunk, mirroring the backend's own scheme, so a test can read back exactly
// what physically landed rather than trusting the backend's own view of it.
const dataPrefixFor = (gen: number, chunk: number): string =>
  `d/${String(gen).padStart(13, '0')}/${String(chunk).padStart(12, '0')}/`;

const collect = async (snap: CaptureSnapshot): Promise<string[]> => {
  const out: string[] = [];
  for await (const r of snap.stream()) {
    out.push(r.serialized);
  }
  return out;
};

describe('createIdbChunkBackend — backend contract', () => {
  it('exposes its generation', () => {
    expect(createIdbChunkBackend(keyed(), { generation: 7 }).generation).toBe(7);
  });

  it('openPart writes a durable meta record (end null) that listParts reads back', async () => {
    const b = createIdbChunkBackend(keyed(), { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    expect(await b.listParts(5)).toEqual([
      { generation: 5, number: 0, start: 1000, end: undefined, byteSize: 0 },
    ]);
  });

  it('appendEntry returns the utf8 byte size of the serialized form', () => {
    const b = createIdbChunkBackend(keyed(), { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    expect(b.appendEntry(ref(5, 0), rec('abc'))).toBe(3);
    expect(b.appendEntry(ref(5, 0), rec('héllo'))).toBe(6); // é is 2 bytes
  });

  it('appendEntry without an openPart defaults the sequence to 0', async () => {
    const b = createIdbChunkBackend(keyed(), { generation: 5, cleanOtherGenerations: false });
    b.appendEntry(ref(5, 0), rec('x')); // no openPart → seq defaults to 0
    expect(await collect(b.snapshot([{ ref: ref(5, 0), count: 1 }]))).toEqual(['x']);
  });

  it('closePart without an openPart defaults the start to 0', async () => {
    const b = createIdbChunkBackend(keyed(), { generation: 5, cleanOtherGenerations: false });
    b.closePart(ref(5, 0), 2000, 7); // no openPart → start defaults to 0
    expect(await b.listParts(5)).toEqual([
      { generation: 5, number: 0, start: 0, end: 2000, byteSize: 7 },
    ]);
  });

  it('swallows write-queue failures with the default (no-op) onError', async () => {
    const failing: AsyncKeyedStore = {
      put: () => Promise.reject(new Error('boom')),
      readPrefix: () => Promise.resolve([]),
      keys: () => Promise.resolve([]),
      deletePrefix: () => Promise.resolve(),
    };
    const b = createIdbChunkBackend(failing, { generation: 5 }); // no onError → default no-op
    b.openPart(ref(5, 0), 1000); // failing put → the default no-op swallows it
    await expect(b.listGenerations()).resolves.toEqual([]); // no throw, queue drained
  });

  it('closePart rewrites the meta with end + final byteSize (durable, recoverable)', async () => {
    const b = createIdbChunkBackend(keyed(), { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    b.closePart(ref(5, 0), 2000, 42);
    expect(await b.listParts(5)).toEqual([
      { generation: 5, number: 0, start: 1000, end: 2000, byteSize: 42 },
    ]);
  });

  it('snapshot reads frozen parts up to count, oldest-first, isolated from later appends', async () => {
    const b = createIdbChunkBackend(keyed(), { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    b.appendEntry(ref(5, 0), rec('a'));
    b.appendEntry(ref(5, 0), rec('b'));
    b.openPart(ref(5, 1), 2000);
    b.appendEntry(ref(5, 1), rec('c'));
    const snap = b.snapshot([
      { ref: ref(5, 0), count: 1 }, // only the first record of part 0
      { ref: ref(5, 1), count: 1 },
    ]);
    b.appendEntry(ref(5, 0), rec('after')); // captured after the snapshot
    expect(await collect(snap)).toEqual(['a', 'c']); // count-bounded + isolated, oldest part first
  });

  it('drainAll groups the snapshot records by file type', async () => {
    const b = createIdbChunkBackend(keyed(), { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    b.appendEntry(ref(5, 0), rec('{"m":"hi"}', 'log'));
    b.appendEntry(ref(5, 0), rec('{"u":"x"}', 'network'));
    const grouped = await b.snapshot([{ ref: ref(5, 0), count: 2 }]).drainAll();
    expect(grouped.get('log')?.map((r) => r.serialized)).toEqual(['{"m":"hi"}']);
    expect(grouped.get('network')?.map((r) => r.serialized)).toEqual(['{"u":"x"}']);
  });

  it('pins a frozen part so an eviction mid-snapshot defers the delete until release', async () => {
    const store = keyed();
    const b = createIdbChunkBackend(store, { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    b.appendEntry(ref(5, 0), rec('a'));
    const snap = b.snapshot([{ ref: ref(5, 0), count: 1 }]);
    b.removePart(ref(5, 0)); // evicted while the snapshot is live → deferred, not deleted
    expect(await collect(snap)).toEqual(['a']); // still readable (pinned)
    snap.release(); // now the deferred delete runs
    expect(await collect(b.snapshot([{ ref: ref(5, 0), count: 1 }]))).toEqual([]); // gone
  });

  it('removePart deletes the chunk (data + meta) when no snapshot pins it', async () => {
    const b = createIdbChunkBackend(keyed(), { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    b.appendEntry(ref(5, 0), rec('a'));
    b.openPart(ref(5, 1), 2000);
    b.removePart(ref(5, 0));
    expect((await b.listParts(5)).map((p) => p.number)).toEqual([1]);
  });

  it('removeGeneration deletes every chunk of a generation', async () => {
    const store = keyed();
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.openPart(ref(5, 1), 1);
    b.openPart(ref(9, 0), 1);
    b.removeGeneration(5);
    expect(await b.listParts(5)).toEqual([]);
    expect(await b.listGenerations()).toEqual([9]);
  });

  it('listParts(gen) tags parts with the QUERIED generation, not the backend’s own', async () => {
    const store = keyed();
    const writer = createIdbChunkBackend(store, { generation: 7, cleanOtherGenerations: false });
    writer.openPart(ref(9, 0), 1000); // a part durably belonging to generation 9
    writer.closePart(ref(9, 0), 2000, 4);
    await writer.listParts(9); // drain
    // A backend whose OWN generation is 7 reads generation 9's parts (the recovery seam).
    const reader = createIdbChunkBackend(store, { generation: 7, cleanOtherGenerations: false });
    expect(await reader.listParts(9)).toEqual([
      { generation: 9, number: 0, start: 1000, end: 2000, byteSize: 4 },
    ]);
  });

  it('round-trips a large (14-digit) generation id without truncation', async () => {
    const store = keyed();
    const big = 10_000_000_000_000; // 1e13 — one digit past the 13-digit pad width
    const b = createIdbChunkBackend(store, { generation: big, cleanOtherGenerations: false });
    b.openPart(ref(big, 0), 1000);
    await b.listParts(big);
    expect(await b.listGenerations()).toEqual([big]); // parsed back exactly, not truncated
  });

  it('clean-on-init discards a large (14-digit) other generation (no orphaned data)', async () => {
    const store = keyed();
    const big = 10_000_000_000_000;
    const prior = createIdbChunkBackend(store, { generation: big, cleanOtherGenerations: false });
    prior.openPart(ref(big, 0), 1);
    prior.appendEntry(ref(big, 0), rec('old'));
    await prior.listGenerations();
    const fresh = createIdbChunkBackend(store, { generation: 9 }); // clean-on-init
    fresh.openPart(ref(9, 0), 1);
    expect(await fresh.listGenerations()).toEqual([9]); // the big generation is fully discarded
  });

  it('listParts is sorted by part number; listGenerations is distinct and sorted', async () => {
    const store = keyed();
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(20, 1), 1);
    b.openPart(ref(20, 0), 1);
    b.openPart(ref(10, 0), 1);
    expect((await b.listParts(20)).map((p) => p.number)).toEqual([0, 1]);
    expect(await b.listGenerations()).toEqual([10, 20]);
  });

  it('on construction discards other generations’ chunks (clean-on-init), keeping its own', async () => {
    const store = keyed();
    const prior = createIdbChunkBackend(store, { generation: 1, cleanOtherGenerations: false });
    prior.openPart(ref(1, 0), 1);
    prior.appendEntry(ref(1, 0), rec('old'));
    await prior.listGenerations(); // drain the prior run's writes

    const fresh = createIdbChunkBackend(store, { generation: 9 });
    fresh.openPart(ref(9, 0), 1);
    expect(await fresh.listGenerations()).toEqual([9]); // generation 1 discarded
  });

  it('clean-on-init keeps its OWN generation when resuming it (gen === generation)', async () => {
    const store = keyed();
    const prior = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    prior.openPart(ref(5, 0), 1000);
    prior.closePart(ref(5, 0), 2000, 4);
    await prior.listParts(5); // drain — gen 5's meta is now durable

    // A fresh backend with the SAME generation + clean-on-init must NOT delete its own prior chunks.
    const resumed = createIdbChunkBackend(store, { generation: 5 });
    expect(await resumed.listParts(5)).toEqual([
      { generation: 5, number: 0, start: 1000, end: 2000, byteSize: 4 },
    ]);
  });

  it('listGenerations ignores a malformed (non-numeric) meta key', async () => {
    const store = keyed();
    await store.put('m/not-a-generation/0', new TextEncoder().encode('{}')); // a foreign/corrupt key
    const b = createIdbChunkBackend(store, { generation: 9, cleanOtherGenerations: false });
    b.openPart(ref(9, 0), 1);
    expect(await b.listGenerations()).toEqual([9]); // the malformed key is skipped
  });

  it('releasing a snapshot of a still-live (un-evicted) part does not delete its data', async () => {
    const store = keyed();
    const b = createIdbChunkBackend(store, { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    b.appendEntry(ref(5, 0), rec('live'));
    const snap = b.snapshot([{ ref: ref(5, 0), count: 1 }]);
    snap.release(); // part NOT evicted → no deferred delete → data retained
    expect(await collect(b.snapshot([{ ref: ref(5, 0), count: 1 }]))).toEqual(['live']);
  });

  it('snapshot reads only the records that exist when count exceeds them', async () => {
    const b = createIdbChunkBackend(keyed(), { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    b.appendEntry(ref(5, 0), rec('only'));
    // count 5 but a single record was stored → reads just the one (the i < records.length bound).
    expect(await collect(b.snapshot([{ ref: ref(5, 0), count: 5 }]))).toEqual(['only']);
  });

  it('release is idempotent and refcounts concurrent snapshots of the same part', async () => {
    const store = keyed();
    const b = createIdbChunkBackend(store, { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    b.appendEntry(ref(5, 0), rec('a'));
    const snapA = b.snapshot([{ ref: ref(5, 0), count: 1 }]);
    const snapB = b.snapshot([{ ref: ref(5, 0), count: 1 }]); // a second pin on the same part
    b.removePart(ref(5, 0)); // evicted → deferred while pinned
    snapA.release(); // refcount 2 → 1: still pinned, data kept
    snapA.release(); // idempotent: a second release is a no-op
    expect(await collect(snapB)).toEqual(['a']); // snapB still pins → data kept
    snapB.release(); // refcount 1 → 0: now the deferred delete runs
    expect(await collect(b.snapshot([{ ref: ref(5, 0), count: 1 }]))).toEqual([]); // gone
  });

  it('cleanOtherGenerations:false preserves prior generations (durable round-trip / reload)', async () => {
    const store = keyed();
    const first = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    first.openPart(ref(5, 0), 1000);
    first.appendEntry(ref(5, 0), rec('survives'));
    first.closePart(ref(5, 0), 2000, 8);
    await first.listParts(5); // drain

    // A fresh backend over the SAME store (a simulated reload) still sees the prior chunk's durable meta.
    const second = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    expect(await second.listParts(5)).toEqual([
      { generation: 5, number: 0, start: 1000, end: 2000, byteSize: 8 },
    ]);
  });

  it('routes a write-queue failure to onError without throwing the capture path', async () => {
    const errors: unknown[] = [];
    const failing: AsyncKeyedStore = {
      put: () => Promise.reject(new Error('boom')),
      readPrefix: () => Promise.resolve([]),
      keys: () => Promise.resolve([]),
      deletePrefix: () => Promise.resolve(),
    };
    const b = createIdbChunkBackend(failing, { generation: 5, onError: (e) => errors.push(e) });
    expect(() => {
      b.openPart(ref(5, 0), 1000); // enqueues a failing put
      b.appendEntry(ref(5, 0), rec('a')); // another failing put
    }).not.toThrow();
    await b.listGenerations(); // drains the queue (the failures are caught en route)
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('createIdbChunkCaptureStore — chunk store over IndexedDB', () => {
  const mk = (
    store: AsyncKeyedStore,
    over: Partial<Parameters<typeof createIdbChunkCaptureStore>[1]> = {},
  ) => createIdbChunkCaptureStore(store, { clock: clockAt(10_000), generation: 42, ...over });

  it('defaults the clock (system) and generation (wallNow) when unspecified', async () => {
    const store = createIdbChunkCaptureStore(keyed()); // no clock, no generation → defaults
    store.add(rec('x', 'log', 1));
    expect((await store.snapshot().drainAll()).get('log')?.map((r) => r.serialized)).toEqual(['x']);
  });

  it('persists records and snapshots them grouped by type', async () => {
    const store = mk(keyed());
    const log = rec('{"m":"hi"}', 'log', 10_000);
    const net = rec('{"u":"x"}', 'network', 10_000);
    store.add(log);
    store.add(net);
    const snap = await store.snapshot().drainAll();
    expect(snap.get('log')).toEqual([log]);
    expect(snap.get('network')).toEqual([net]);
  });

  it('keeps records in order across a tick rotation', async () => {
    const store = mk(keyed());
    store.add(rec('a', 'log', 10_000));
    store.tick(11_000);
    store.add(rec('b', 'log', 11_000));
    expect((await store.snapshot().drainAll()).get('log')?.map((r) => r.serialized)).toEqual([
      'a',
      'b',
    ]);
  });

  it('evicts parts outside the recording window on tick', async () => {
    const store = mk(keyed(), { maxRecordingTimeMs: 2000 });
    store.add(rec('old', 'log', 10_000)); // part 0
    store.tick(11_000); // part 0 closes @11000
    store.add(rec('new', 'log', 11_000)); // part 1
    store.tick(15_000); // cutting 12000 → part 0 evicted
    expect((await store.snapshot().drainAll()).get('log')?.map((r) => r.serialized)).toEqual([
      'new',
    ]);
  });

  it('evicts oldest closed parts once over the maxDataSize byte cap', async () => {
    const P = 'x'.repeat(20); // 20-byte serialized payload (byte cap counts serialized bytes)
    const store = mk(keyed(), { maxDataSizeBytes: 3 * 20 });
    store.add(rec(P, 'log', 10_000)); // part0
    store.tick(10_100);
    store.add(rec(P, 'log', 10_001)); // part1
    store.tick(10_200);
    store.add(rec(P, 'log', 10_002)); // part2
    store.add(rec(P, 'log', 10_003)); // part2 → 4 records 80B > 60B → evict part0
    const got = (await store.snapshot().drainAll()).get('log') ?? [];
    expect(got.map((r) => r.timestamp)).toEqual([10_001, 10_002, 10_003]);
  });

  it('freezes the snapshot(): capture after snapshot() does not change it', async () => {
    const store = mk(keyed());
    store.add(rec('first', 'log', 10_000));
    const snap = store.snapshot();
    store.add(rec('second', 'log', 10_001)); // after the snapshot
    expect((await snap.drainAll()).get('log')?.map((r) => r.serialized)).toEqual(['first']);
    expect((await store.snapshot().drainAll()).get('log')?.map((r) => r.serialized)).toEqual([
      'first',
      'second',
    ]);
  });

  it('clear discards this generation and keeps working afterwards', async () => {
    const store = mk(keyed());
    store.add(rec('gone', 'log', 10_000));
    store.clear();
    store.add(rec('kept', 'log', 10_001));
    expect((await store.snapshot().drainAll()).get('log')?.map((r) => r.serialized)).toEqual([
      'kept',
    ]);
  });

  it('survives a reload: a fresh store reading the same generation sees the prior parts’ data', async () => {
    const idb = new IDBFactory();
    const store1 = createIdbChunkCaptureStore(createIdbKeyedStore({ indexedDB: idb }), {
      clock: clockAt(10_000),
      generation: 42,
    });
    store1.add(rec('before-reload', 'log', 10_000));
    store1.tick(11_000); // close part 0 so its data + meta are durable
    await store1.snapshot().drainAll(); // drain the write queue

    // A fresh backend over the SAME database + generation, preserving prior chunks, reads them back.
    const backend2 = createIdbChunkBackend(createIdbKeyedStore({ indexedDB: idb }), {
      generation: 42,
      cleanOtherGenerations: false,
    });
    const parts = await backend2.listParts(42);
    expect(parts.length).toBeGreaterThanOrEqual(1);
    const snap = backend2.snapshot(parts.map((p) => ({ ref: ref(42, p.number), count: 1 })));
    expect(await collect(snap)).toContain('before-reload');
  });
});

// WAVE 6.2 — commit-on-demand, for the moment the page is going away.
//
// `appendEntry` returns immediately and queues the physical IndexedDB write; that is what keeps capture
// off the critical path, and it is also exactly what a killed tab discards. `flush()` is the seam the
// browser's `pagehide`/`visibilitychange` hook awaits so the window shrinks to what was queued in the last
// instant instead of everything since the previous commit.
describe('flush', () => {
  it('resolves only AFTER queued writes have landed', async () => {
    const store = keyed();
    const b = createIdbChunkBackend(store, { generation: 3 });
    b.openPart(ref(3, 0), 1000);
    b.appendEntry(ref(3, 0), rec('captured-but-not-yet-committed'));
    await b.flush?.();
    // Read through a SECOND backend over the same store, so nothing in the first one's queue can be
    // mistaken for durability: this is what a fresh page load would see.
    const reader = createIdbChunkBackend(store, { generation: 3, cleanOtherGenerations: false });
    const parts = await reader.listParts(3);
    expect(parts).toHaveLength(1);
    expect(await collect(reader.snapshot([{ ref: ref(3, 0), count: 1 }]))).toEqual([
      'captured-but-not-yet-committed',
    ]);
  });

  it('is not yet durable BEFORE the flush — the canary that the wait is real', async () => {
    // Without this, the test above would pass against a `flush()` that returns an already-resolved
    // promise, because fake-indexeddb settles quickly enough on its own.
    const store = keyed();
    const b = createIdbChunkBackend(store, { generation: 4 });
    b.openPart(ref(4, 0), 1000);
    b.appendEntry(ref(4, 0), rec('pending'));
    const reader = createIdbChunkBackend(store, { generation: 4, cleanOtherGenerations: false });
    expect(await reader.listParts(4)).toEqual([]); // queued, not committed
    await b.flush?.();
    expect(await reader.listParts(4)).toHaveLength(1);
  });

  it('resolves rather than rejecting when a queued write failed', async () => {
    // The queue routes failures to onError and continues. Flush must report "there is nothing left
    // pending", not re-raise a failure the caller cannot act on — it runs as the page dies.
    const failing: AsyncKeyedStore = {
      ...keyed(),
      put: () => Promise.reject(new Error('quota exceeded')),
    };
    const errors: unknown[] = [];
    const b = createIdbChunkBackend(failing, {
      generation: 6,
      onError: (e) => errors.push(e),
      cleanOtherGenerations: false,
    });
    b.openPart(ref(6, 0), 1000);
    await expect(b.flush?.()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('resolves even when the app’s own onError throws', () => {
    // `onError` is application-supplied. When it throws, the queue's own `.catch` rejects, and a flush
    // that propagated that would reject at page-hide — inside the browser's event dispatch, with nobody
    // left to handle it. The failure sink failing must not become the caller's problem.
    const failing: AsyncKeyedStore = {
      ...keyed(),
      put: () => Promise.reject(new Error('quota exceeded')),
    };
    const b = createIdbChunkBackend(failing, {
      generation: 9,
      cleanOtherGenerations: false,
      onError: () => {
        throw new Error('the error sink is broken too');
      },
    });
    b.openPart(ref(9, 0), 1000);
    return expect(b.flush?.()).resolves.toBeUndefined();
  });

  it('the capture store exposes it too — the page-hide hook holds a CaptureStore, not a backend', async () => {
    const store = createIdbChunkCaptureStore(keyed(), { generation: 8, clock: clockAt(1000) });
    await expect(store.flush?.()).resolves.toBeUndefined();
  });
});

// WAVE 6.5 — one corrupt record must not destroy the whole generation's recovery.
//
// This is the exact failure class CORE explicitly designed against, and the IDB port dropped the guard:
//   · packages/core/src/capture-drain.ts:24-30 — "Skip it; NEVER let one bad record poison the whole
//     generation's recovery (which would keep the marker + chunks and repeat the failure on every launch —
//     a permanent loss)".
//   · packages/core/src/file-chunk-backend.ts:66-69 falls back to a derived meta; :128/:133 `continue` past
//     a torn line.
// Here both `dec<StoredMeta>` and `dec<StoredData>` were bare `JSON.parse` inside a loop, so ONE bad value
// rejected `listParts()` / `drainAll()` for everything.
//
// The loss is PERMANENT, which is what makes it worse than a dropped record: capture-recovery catches per
// generation, does NOT remove the marker, so the generation stays pending, the sweep keeps it, and the next
// launch fails identically. Forever — and the poisoned data is never freed either.
describe('torn-record tolerance', () => {
  const torn = new TextEncoder().encode('{"t":0,"s":"trunc');

  it('keeps the intact records either side of a corrupt DATA envelope', async () => {
    const store = keyed();
    const b = createIdbChunkBackend(store, { generation: 5 });
    b.openPart(ref(5, 0), 1000);
    b.appendEntry(ref(5, 0), rec('good-0'));
    b.appendEntry(ref(5, 0), rec('torn-1'));
    b.appendEntry(ref(5, 0), rec('good-2'));
    await b.flush?.();
    // Overwrite the middle envelope with a truncated one, the way a killed write leaves it.
    const keys = (await store.readPrefix('d/')).map(([k]) => k).sort();
    await store.put(keys[1] as string, torn);
    expect(await collect(b.snapshot([{ ref: ref(5, 0), count: 3 }]))).toEqual(['good-0', 'good-2']);
  });

  it('keeps the other chunks’ metadata when ONE chunk’s meta is corrupt', async () => {
    const store = keyed();
    const b = createIdbChunkBackend(store, { generation: 6 });
    b.openPart(ref(6, 0), 1000);
    b.closePart(ref(6, 0), 2000, 10);
    b.openPart(ref(6, 1), 2000);
    await b.flush?.();
    const metaKeys = (await store.readPrefix('m/')).map(([k]) => k).sort();
    await store.put(metaKeys[0] as string, new TextEncoder().encode('{oops'));
    const parts = await b.listParts(6);
    expect(parts.map((p) => p.number)).toEqual([0, 1]); // chunk 1 survives…
    expect(parts[1]).toMatchObject({ start: 2000 }); // …with its real metadata intact
  });

  it('derives a usable default for the corrupt meta rather than dropping the chunk', async () => {
    // Core does the same (file-chunk-backend.ts:66-69): a chunk whose meta is unreadable still has DATA,
    // and dropping the meta would orphan those records where nothing ever reads or frees them.
    const store = keyed();
    const b = createIdbChunkBackend(store, { generation: 7 });
    b.openPart(ref(7, 0), 1000);
    await b.flush?.();
    const metaKeys = (await store.readPrefix('m/')).map(([k]) => k);
    await store.put(metaKeys[0] as string, new TextEncoder().encode('not json at all'));
    const parts = await b.listParts(7);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ generation: 7, number: 0, byteSize: 0 });
  });

  it('survives an EMPTY value — the shape a missing getAll slot decodes to', async () => {
    // `values[index] as Uint8Array` casts away a hole; `TextDecoder().decode(undefined)` yields '' and
    // `JSON.parse('')` throws. Same total loss, from a different trigger.
    const store = keyed();
    const b = createIdbChunkBackend(store, { generation: 8 });
    b.openPart(ref(8, 0), 1000);
    b.appendEntry(ref(8, 0), rec('kept'));
    b.appendEntry(ref(8, 0), rec('empty-next'));
    await b.flush?.();
    const keys = (await store.readPrefix('d/')).map(([k]) => k).sort();
    await store.put(keys[1] as string, new Uint8Array());
    expect(await collect(b.snapshot([{ ref: ref(8, 0), count: 2 }]))).toEqual(['kept']);
  });

  it('still reads a fully intact generation — the canary', async () => {
    // Without this, "tolerates corruption" would also be satisfied by a backend that returns nothing.
    const store = keyed();
    const b = createIdbChunkBackend(store, { generation: 9 });
    b.openPart(ref(9, 0), 1000);
    b.appendEntry(ref(9, 0), rec('a'));
    b.appendEntry(ref(9, 0), rec('b'));
    await b.flush?.();
    expect(await collect(b.snapshot([{ ref: ref(9, 0), count: 2 }]))).toEqual(['a', 'b']);
    expect(await b.listParts(9)).toHaveLength(1);
  });
});

// WAVE 6.3 — the write queue had ZERO back-pressure.
//
// `appendEntry` is sync-issue / async-complete: every captured entry allocates a closure retaining its
// serialized payload and chains it onto one serial promise queue, with no depth counter, no cap and no
// signal back to the capture path. Reproduced in the review: a stalled store + 20,000 entries × 10 KB →
// ONE write actually started and ~200 MB retained live in the pending chain, while `add()` returned
// success to every caller. Core's ring eviction cannot rescue it either, because `removePart` enqueues its
// delete at the TAIL of the same queue — eviction can never run ahead of the backlog.
//
// Quota pressure, private/incognito storage and a busy IDB thread all produce exactly this stall.
describe('write-queue back-pressure', () => {
  /** A store whose writes hang until released, so a backlog can be built deterministically. */
  const stalledStore = () => {
    const inner = keyed();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = 0;
    return {
      store: {
        ...inner,
        put: async (key: string, bytes: Uint8Array) => {
          started += 1;
          await gate;
          return inner.put(key, bytes);
        },
      } as AsyncKeyedStore,
      release,
      started: () => started,
      inner,
    };
  };

  it('bounds what it retains while the store is stalled — it does not accept everything', async () => {
    const s = stalledStore();
    const b = createIdbChunkBackend(s.store, { generation: 1, cleanOtherGenerations: false });
    b.openPart(ref(1, 0), 1000);
    for (let i = 0; i < 5000; i += 1) {
      b.appendEntry(ref(1, 0), rec(`entry-${i}`));
    }
    s.release();
    await b.flush?.();
    const landed = await s.inner.readPrefix(dataPrefixFor(1, 0));
    expect(landed.length).toBeLessThan(5000); // the queue refused to grow without limit…
    expect(landed.length).toBeGreaterThan(0); // …while still writing what it could
  });

  it('keeps the NEWEST entries when it has to drop — matching the capture ring', async () => {
    // The ring evicts oldest and keeps most-recent, because the moments before a crash are the ones worth
    // having. A queue that dropped the newest instead would inverte that at exactly the wrong time.
    const s = stalledStore();
    const b = createIdbChunkBackend(s.store, {
      generation: 2,
      cleanOtherGenerations: false,
      maxPendingWrites: 8,
    });
    b.openPart(ref(2, 0), 1000);
    for (let i = 0; i < 40; i += 1) {
      b.appendEntry(ref(2, 0), rec(`entry-${i}`));
    }
    s.release();
    await b.flush?.();
    const landed = (await s.inner.readPrefix(dataPrefixFor(2, 0))).map(
      ([, v]) => (JSON.parse(new TextDecoder().decode(v)) as { s: string }).s,
    );
    expect(landed).toContain('entry-39'); // the last thing before the crash survived
    expect(landed).not.toContain('entry-0'); // the oldest was the one given up
  });

  it('reports a FAILING store a bounded number of times, not once per entry', async () => {
    // The review measured 5001 puts → 5001 onError calls. `onError` is the HOST's sink: the obvious
    // implementation is `console.error`, which the console interceptor then captures, which appends, which
    // fails, which calls onError… a self-sustaining livelock for the life of the page. The console
    // interceptor's re-entrancy guard does not stop it — that flag is synchronous, and onError arrives in
    // a later microtask with the flag already cleared.
    const errors: unknown[] = [];
    const failing: AsyncKeyedStore = {
      ...keyed(),
      put: () => Promise.reject(new Error('QuotaExceededError')),
    };
    const b = createIdbChunkBackend(failing, {
      generation: 3,
      cleanOtherGenerations: false,
      onError: (e) => errors.push(e),
    });
    b.openPart(ref(3, 0), 1000);
    for (let i = 0; i < 2000; i += 1) {
      b.appendEntry(ref(3, 0), rec(`entry-${i}`));
    }
    await b.flush?.();
    // The exact contract, not a loose ceiling: the FIRST failure is reported in full — that is the
    // diagnosis — and everything after it is coalesced into ONE summary when the queue drains. A
    // ceiling of "under 100" was satisfied by reporting every single attempt, because the circuit
    // breaker had already bounded the attempts; it did not test the coalescing at all.
    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe('QuotaExceededError');
    expect((errors[1] as Error).message).toMatch(/dropped \d+ capture write\(s\)/);
  });

  it('stops ATTEMPTING writes once the store is persistently failing', async () => {
    // Not just quieter reporting — a store that rejects every put should stop being hammered. Otherwise
    // every captured entry still costs an IDB transaction and a rejected promise.
    let attempts = 0;
    const failing: AsyncKeyedStore = {
      ...keyed(),
      put: () => {
        attempts += 1;
        return Promise.reject(new Error('QuotaExceededError'));
      },
    };
    const b = createIdbChunkBackend(failing, { generation: 4, cleanOtherGenerations: false });
    b.openPart(ref(4, 0), 1000);
    for (let i = 0; i < 2000; i += 1) {
      b.appendEntry(ref(4, 0), rec(`entry-${i}`));
    }
    await b.flush?.();
    expect(attempts).toBeLessThan(200);
  });

  it('RECOVERS when the store starts working again', async () => {
    // A circuit that never re-closes turns a transient quota blip into permanent silent data loss for the
    // rest of the page's life.
    let failing = true;
    const inner = keyed();
    const flaky: AsyncKeyedStore = {
      ...inner,
      put: (key: string, bytes: Uint8Array) =>
        failing ? Promise.reject(new Error('QuotaExceededError')) : inner.put(key, bytes),
    };
    const b = createIdbChunkBackend(flaky, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1000);
    for (let i = 0; i < 500; i += 1) {
      b.appendEntry(ref(5, 0), rec(`fail-${i}`));
    }
    await b.flush?.();
    failing = false;
    for (let i = 0; i < 20; i += 1) {
      b.appendEntry(ref(5, 0), rec(`ok-${i}`));
    }
    await b.flush?.();
    const landed = await inner.readPrefix(dataPrefixFor(5, 0));
    // EVERY post-recovery entry, not just the probe. `> 0` was satisfied by a circuit that lets one write
    // through and then re-closes on the caller — which is indistinguishable from staying broken.
    expect(landed).toHaveLength(20);
  });

  it('bounds retained BYTES, not just the number of pending writes', async () => {
    // The depth cap alone does not answer the measured failure: 2048 pending writes of a large network
    // body is still hundreds of MB. Big entries, small count — only a byte bound catches this.
    const s = stalledStore();
    const b = createIdbChunkBackend(s.store, {
      generation: 7,
      cleanOtherGenerations: false,
      maxPendingWrites: 1_000_000, // deliberately no depth pressure — isolate the byte bound
      maxPendingBytes: 50_000,
    });
    b.openPart(ref(7, 0), 1000);
    const big = 'x'.repeat(10_000);
    for (let i = 0; i < 100; i += 1) {
      b.appendEntry(ref(7, 0), rec(`${i}:${big}`));
    }
    s.release();
    await b.flush?.();
    const landed = await s.inner.readPrefix(dataPrefixFor(7, 0));
    // ~1 MB offered, 50 KB allowed to wait: only a handful can have been retained and written.
    expect(landed.length).toBeLessThan(15);
    expect(landed.length).toBeGreaterThan(0);
  });

  it('never drops the ONLY pending write, however large', async () => {
    // The eviction loop must not empty the queue to satisfy a bound a single entry already exceeds — that
    // would silently discard every oversized entry rather than storing it.
    const store = keyed();
    const b = createIdbChunkBackend(store, {
      generation: 8,
      cleanOtherGenerations: false,
      maxPendingBytes: 10,
    });
    b.openPart(ref(8, 0), 1000);
    b.appendEntry(ref(8, 0), rec('a-record-far-larger-than-the-byte-bound'));
    await b.flush?.();
    expect(await store.readPrefix(dataPrefixFor(8, 0))).toHaveLength(1);
  });

  it('a HEALTHY store still writes every entry — the canary', async () => {
    // Without this, every bound above is satisfied by a backend that writes nothing at all.
    const store = keyed();
    const b = createIdbChunkBackend(store, { generation: 6, cleanOtherGenerations: false });
    b.openPart(ref(6, 0), 1000);
    for (let i = 0; i < 200; i += 1) {
      b.appendEntry(ref(6, 0), rec(`entry-${i}`));
    }
    await b.flush?.();
    expect(await store.readPrefix(dataPrefixFor(6, 0))).toHaveLength(200);
  });
});

describe('createIdbChunkCaptureStore — disk pressure (C7)', () => {
  const MB = 1024 * 1024;
  const mk = (store: AsyncKeyedStore) => {
    const pressure = createDiskPressure();
    return {
      pressure,
      store: createIdbChunkCaptureStore(store, {
        clock: clockAt(10_000),
        generation: 42,
        diskPressure: pressure,
      }),
    };
  };
  const dataKeys = async (store: AsyncKeyedStore): Promise<string[]> =>
    (await store.readPrefix('d/')).map(([key]) => key);

  it('stops writing replay/log/network below low, still writes traces, and keeps the window', async () => {
    const backing = keyed();
    const { pressure, store } = mk(backing);
    store.add(rec('before', 'log', 10_000));
    pressure.observe(30 * MB);
    store.add(rec('dropped-log', 'log', 10_001));
    store.add(rec('dropped-replay', 'replay', 10_002));
    store.add(rec('kept-trace', 'traces.system', 10_003));
    await store.flush?.();
    expect((await dataKeys(backing)).length).toBe(2); // 'before' + the trace
    const all = await store.snapshot().drainAll();
    expect(all.get('log')?.map((r) => r.serialized)).toEqual(['before', 'dropped-log']);
    expect(all.get('replay')?.map((r) => r.serialized)).toEqual(['dropped-replay']);
    expect(all.get('traces.system')?.map((r) => r.serialized)).toEqual(['kept-trace']);
  });

  it('persists nothing below none, then resumes on recovery', async () => {
    const backing = keyed();
    const { pressure, store } = mk(backing);
    pressure.observe(5 * MB);
    store.add(rec('a', 'traces.system', 10_000));
    store.tick(11_000);
    store.add(rec('b', 'log', 11_000));
    await store.flush?.();
    expect(await dataKeys(backing)).toEqual([]);
    pressure.observe(100 * MB);
    store.add(rec('c', 'log', 11_500));
    await store.flush?.();
    expect((await dataKeys(backing)).length).toBe(1);
    expect((await store.snapshot().drainAll()).get('log')?.map((r) => r.serialized)).toEqual([
      'b',
      'c',
    ]);
  });

  it('a snapshot taken under low stays frozen when a durable record is appended to the same open part', async () => {
    const { pressure, store } = mk(keyed());
    store.add(rec('d1', 'traces.system', 10_000));
    pressure.observe(30 * MB);
    store.add(rec('s1', 'log', 10_001));
    const snap = store.snapshot();
    store.add(rec('d2', 'traces.system', 10_002));
    const all = await snap.drainAll();
    snap.release();
    expect(all.get('traces.system')?.map((r) => r.serialized)).toEqual(['d1']);
    expect(all.get('log')?.map((r) => r.serialized)).toEqual(['s1']);
  });

  it('is unchanged when no pressure is supplied', async () => {
    const backing = keyed();
    const store = createIdbChunkCaptureStore(backing, { clock: clockAt(10_000), generation: 42 });
    store.add(rec('x', 'log', 10_000));
    await store.flush?.();
    expect((await dataKeys(backing)).length).toBe(1);
  });
});

describe('createIdbChunkBackend — health hooks (onWriteFailure / onWriteRecovered)', () => {
  const quota = (): Error => Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
  const flaky = () => {
    const inner = keyed();
    const state = { broken: false };
    const store: AsyncKeyedStore = {
      ...inner,
      put: (key, value) => (state.broken ? Promise.reject(quota()) : inner.put(key, value)),
    };
    return { store, state };
  };
  const hooks = () => {
    const failures: unknown[] = [];
    const counts = { recovered: 0 };
    return {
      failures,
      counts,
      options: {
        onWriteFailure: (e: unknown) => void failures.push(e),
        onWriteRecovered: () => {
          counts.recovered += 1;
        },
      },
    };
  };

  it('reports EVERY failed write (onError hears only the first), then recovers once on the first success after', async () => {
    const { store, state } = flaky();
    const h = hooks();
    const errors: unknown[] = [];
    const b = createIdbChunkBackend(store, {
      generation: 5,
      cleanOtherGenerations: false,
      onError: (e) => errors.push(e),
      failureThreshold: 1000,
      ...h.options,
    });
    b.openPart(ref(5, 0), 1);
    await b.flush?.();
    state.broken = true;
    b.appendEntry(ref(5, 0), rec('a'));
    await b.flush?.();
    b.appendEntry(ref(5, 0), rec('b'));
    await b.flush?.();
    b.appendEntry(ref(5, 0), rec('c'));
    await b.flush?.();
    expect(h.failures).toHaveLength(3);
    expect(errors.filter((e) => (e as Error).name === 'QuotaExceededError')).toHaveLength(1);
    expect(h.counts.recovered).toBe(0);
    state.broken = false;
    b.appendEntry(ref(5, 0), rec('d'));
    await b.flush?.();
    b.appendEntry(ref(5, 0), rec('e'));
    await b.flush?.();
    expect(h.counts.recovered).toBe(1);
  });

  it('neither a successful DELETE nor a META put after failures reports recovery (both work on a full quota); a DATA put does', async () => {
    const inner = keyed();
    const state = { broken: false };
    const store: AsyncKeyedStore = {
      ...inner,
      put: (key, value) => (state.broken ? Promise.reject(quota()) : inner.put(key, value)),
    };
    const h = hooks();
    const b = createIdbChunkBackend(store, {
      generation: 5,
      cleanOtherGenerations: false,
      ...h.options,
    });
    b.openPart(ref(5, 0), 1);
    await b.flush?.();
    state.broken = true;
    b.appendEntry(ref(5, 0), rec('a'));
    await b.flush?.();
    expect(h.failures).toHaveLength(1);
    b.removePart(ref(5, 0)); // deletes still work
    await b.flush?.();
    expect(h.counts.recovered).toBe(0);
    state.broken = false;
    b.openPart(ref(5, 1), 2); // a META write succeeds: a few dozen bytes proves nothing about real records
    await b.flush?.();
    expect(h.counts.recovered).toBe(0);
    b.appendEntry(ref(5, 1), rec('real')); // a DATA write does
    await b.flush?.();
    expect(h.counts.recovered).toBe(1);
  });

  it('a throwing hook never breaks the drain: later flushes still resolve', async () => {
    const { store, state } = flaky();
    const b = createIdbChunkBackend(store, {
      generation: 5,
      cleanOtherGenerations: false,
      onWriteFailure: () => {
        throw new Error('hook');
      },
      onWriteRecovered: () => {
        throw new Error('hook');
      },
    });
    state.broken = true;
    b.appendEntry(ref(5, 0), rec('a'));
    await b.flush?.();
    state.broken = false;
    b.appendEntry(ref(5, 0), rec('b'));
    await b.flush?.();
    b.appendEntry(ref(5, 0), rec('c'));
    await expect(b.flush?.()).resolves.toBeUndefined();
  });

  it('the capture store forwards the hooks to its IndexedDB backend', async () => {
    const { store, state } = flaky();
    const h = hooks();
    const s = createIdbChunkCaptureStore(store, {
      clock: clockAt(10_000),
      generation: 42,
      cleanOtherGenerations: false,
      ...h.options,
    });
    state.broken = true;
    s.add(rec('a', 'log', 10_000));
    await s.flush?.();
    expect(h.failures.length).toBeGreaterThan(0);
  });
});

describe('createIdbChunkBackend — a record whose write never lands stays in the live window', () => {
  const quota = (): Error => Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
  const refusing = () => {
    const inner = keyed();
    const state = { refuse: (_key: string): boolean => false };
    const store: AsyncKeyedStore = {
      ...inner,
      put: (key, value) => (state.refuse(key) ? Promise.reject(quota()) : inner.put(key, value)),
    };
    return { store, state };
  };
  const seqOf = (key: string): number => Number(key.slice(key.lastIndexOf('/') + 1));
  const texts = async (snap: CaptureSnapshot): Promise<string[]> => collect(snap);

  it('a refused put is served from memory, in sequence, between the records that landed', async () => {
    const { store, state } = refusing();
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    state.refuse = (key) => key.startsWith('d/') && seqOf(key) === 1;
    b.appendEntry(ref(5, 0), rec('r0'));
    b.appendEntry(ref(5, 0), rec('big-replay-snapshot')); // refused
    b.appendEntry(ref(5, 0), rec('r2'));
    expect(await texts(b.snapshot([{ ref: ref(5, 0), count: 3 }]))).toEqual([
      'r0',
      'big-replay-snapshot',
      'r2',
    ]);
  });

  it('honours the freeze by sequence: a record appended after the snapshot stays out, even with a hole before it', async () => {
    const { store, state } = refusing();
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    state.refuse = (key) => key.startsWith('d/') && seqOf(key) === 1;
    b.appendEntry(ref(5, 0), rec('r0'));
    b.appendEntry(ref(5, 0), rec('r1-refused'));
    const snap = b.snapshot([{ ref: ref(5, 0), count: 2 }]);
    b.appendEntry(ref(5, 0), rec('r2-after'));
    expect(await texts(snap)).toEqual(['r0', 'r1-refused']);
    snap.release();
  });

  it('a record skipped by the open circuit, and one shed by the queue bound, are kept too', async () => {
    const { store, state } = refusing();
    state.refuse = (key) => key.startsWith('d/');
    const b = createIdbChunkBackend(store, {
      generation: 5,
      cleanOtherGenerations: false,
      failureThreshold: 1,
      maxPendingWrites: 3,
    });
    b.openPart(ref(5, 0), 1);
    for (let i = 0; i < 8; i++) b.appendEntry(ref(5, 0), rec(`r${i}`));
    const got = await texts(b.snapshot([{ ref: ref(5, 0), count: 8 }]));
    expect(got).toEqual(Array.from({ length: 8 }, (_, i) => `r${i}`));
  });

  it('a refused record is dropped with its part, and a snapshot taken before keeps its own copy', async () => {
    const { store, state } = refusing();
    state.refuse = (key) => key.startsWith('d/');
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('lost'));
    const snap = b.snapshot([{ ref: ref(5, 0), count: 1 }]);
    b.removePart(ref(5, 0));
    expect(await texts(snap)).toEqual(['lost']);
    snap.release();
    expect(await texts(b.snapshot([{ ref: ref(5, 0), count: 1 }]))).toEqual([]);
  });

  it('a write that fails AFTER its part was evicted does not retain the record (nothing will ever read it)', async () => {
    const { store, state } = refusing();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    state.refuse = () => true;
    const slow: AsyncKeyedStore = {
      ...store,
      put: async (k, v) => {
        await gate;
        return store.put(k, v);
      },
    };
    const b = createIdbChunkBackend(slow, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('x'));
    b.removePart(ref(5, 0));
    release?.();
    await b.flush?.();
    expect(await texts(b.snapshot([{ ref: ref(5, 0), count: 1 }]))).toEqual([]);
  });

  it('removeGeneration drops the refused records of that generation only', async () => {
    const { store, state } = refusing();
    state.refuse = (key) => key.startsWith('d/');
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.openPart(ref(6, 0), 1);
    b.appendEntry(ref(5, 0), rec('gen5'));
    b.appendEntry(ref(6, 0), rec('gen6'));
    await b.flush?.();
    b.removeGeneration(5);
    expect(await texts(b.snapshot([{ ref: ref(5, 0), count: 1 }]))).toEqual([]);
    expect(await texts(b.snapshot([{ ref: ref(6, 0), count: 1 }]))).toEqual(['gen6']);
  });

  it('a failed DELETE or META write does not call onWriteFailure for the pressure pin only when it is not a write: deletes never do', async () => {
    const inner = keyed();
    const failures: unknown[] = [];
    const store: AsyncKeyedStore = {
      ...inner,
      deletePrefix: () => Promise.reject(new Error('delete failed')),
    };
    const b = createIdbChunkBackend(store, {
      generation: 5,
      cleanOtherGenerations: false,
      onError: () => {},
      onWriteFailure: (e) => void failures.push(e),
    });
    b.openPart(ref(5, 0), 1);
    b.removePart(ref(5, 0));
    await b.flush?.();
    expect(failures).toEqual([]);
  });
});

const MB_UNREADABLE = 1024 * 1024;

describe('createIdbChunkCaptureStore — an unreadable IndexedDB serves the in-memory window (a live report survives)', () => {
  it('a read that fails (a closed connection) falls back to memory and reports once through onDiskReadError', async () => {
    const inner = keyed();
    const store: AsyncKeyedStore = {
      ...inner,
      readPrefix: () =>
        Promise.reject(Object.assign(new Error('closing'), { name: 'InvalidStateError' })),
    };
    const pressure = createDiskPressure();
    const onDiskReadError = vi.fn();
    const s = createIdbChunkCaptureStore(store, {
      clock: clockAt(10_000),
      generation: 42,
      cleanOtherGenerations: false,
      diskPressure: pressure,
      onDiskReadError,
    });
    pressure.observe(30 * MB_UNREADABLE);
    s.add(rec('in-memory', 'log', 10_000));
    const snap = s.snapshot();
    const all = await snap.drainAll();
    snap.release();
    expect(all.get('log')?.map((r) => r.serialized)).toEqual(['in-memory']);
    expect(onDiskReadError).toHaveBeenCalledOnce();
  });
});

describe('createIdbChunkBackend — inMemory(), cancellation and the freeze over unlanded records', () => {
  const quota = (): Error => Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
  const seqOf = (key: string): number => Number(key.slice(key.lastIndexOf('/') + 1));
  const flat = (m: Map<FileType, StoredEntry[]> | undefined): string[] =>
    [...(m?.values() ?? [])]
      .flat()
      .map((r) => r.serialized)
      .sort();

  it('inMemory() holds records still QUEUED for a store that never answers, grouped by type, without touching the store', () => {
    const never = () => new Promise<never>(() => {});
    const store: AsyncKeyedStore = {
      put: never,
      readPrefix: never,
      keys: never,
      deletePrefix: never,
    };
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('queued-log', 'log'));
    b.appendEntry(ref(5, 0), rec('queued-net', 'network'));
    const snap = b.snapshot([{ ref: ref(5, 0), count: 2 }]);
    const held = snap.inMemory?.();
    expect(held?.get('log')?.map((r) => r.serialized)).toEqual(['queued-log']);
    expect(held?.get('network')?.map((r) => r.serialized)).toEqual(['queued-net']);
  });

  it('inMemory() holds refused records and NOT the ones that landed, in sequence, honouring the freeze (seq < count)', async () => {
    const inner = keyed();
    const store: AsyncKeyedStore = {
      ...inner,
      put: (key, value) =>
        key.startsWith('d/') && seqOf(key) % 2 === 1
          ? Promise.reject(quota())
          : inner.put(key, value),
    };
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    for (let i = 0; i < 6; i++) b.appendEntry(ref(5, 0), rec(`r${i}`));
    await b.flush?.();
    const snap = b.snapshot([{ ref: ref(5, 0), count: 4 }]); // seq 0..3 frozen: refused are seq 1 and 3
    expect(flat(snap.inMemory?.())).toEqual(['r1', 'r3']);
    // the readable half applies the same freeze to the in-memory records: r5 (seq 5 >= count) must not appear
    expect(await collect(snap)).toEqual(['r0', 'r1', 'r2', 'r3']);
  });

  it('release() cancels a read waiting on a queue that never drains, and the read resolves empty instead of hanging', async () => {
    const never = () => new Promise<never>(() => {});
    const store: AsyncKeyedStore = {
      put: never,
      readPrefix: never,
      keys: never,
      deletePrefix: never,
    };
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('x'));
    const snap = b.snapshot([{ ref: ref(5, 0), count: 1 }]);
    const read = snap.drainAll();
    snap.release();
    expect((await read).size).toBe(0);
  });

  it('release() also cancels a read stuck inside readPrefix (an open() that never answers)', async () => {
    const inner = keyed();
    const store: AsyncKeyedStore = { ...inner, readPrefix: () => new Promise(() => {}) };
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('x'));
    await b.flush?.();
    const snap = b.snapshot([{ ref: ref(5, 0), count: 1 }]);
    const read = snap.drainAll();
    await Promise.resolve();
    snap.release();
    expect((await read).size).toBe(0);
  });

  it('release() lets go of the in-memory maps at once, so an abandoned snapshot cannot pin a part window of records', () => {
    const never = () => new Promise<never>(() => {});
    const store: AsyncKeyedStore = {
      put: never,
      readPrefix: never,
      keys: never,
      deletePrefix: never,
    };
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('held'));
    const snap = b.snapshot([{ ref: ref(5, 0), count: 1 }]);
    expect(flat(snap.inMemory?.())).toEqual(['held']);
    snap.release();
    expect(flat(snap.inMemory?.())).toEqual([]);
  });

  it('a record that LANDED is no longer held in memory', async () => {
    const b = createIdbChunkBackend(keyed(), { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('landed'));
    await b.flush?.();
    expect(flat(b.snapshot([{ ref: ref(5, 0), count: 1 }]).inMemory?.())).toEqual([]);
  });

  it('a part removed while a snapshot holds its in-memory records keeps serving them to that snapshot only', async () => {
    const never = () => new Promise<never>(() => {});
    const store: AsyncKeyedStore = {
      put: never,
      readPrefix: never,
      keys: never,
      deletePrefix: never,
    };
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('kept'));
    const snap = b.snapshot([{ ref: ref(5, 0), count: 1 }]);
    b.removePart(ref(5, 0));
    expect(flat(snap.inMemory?.())).toEqual(['kept']);
    expect(flat(b.snapshot([{ ref: ref(5, 0), count: 1 }]).inMemory?.())).toEqual([]);
  });
});

describe('createIdbChunkBackend — a snapshot tells a stalled queue from a slow one', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('gives up on a queue that makes NO progress for stallMs and rejects (the wrapper then serves memory)', async () => {
    const never = () => new Promise<never>(() => {});
    const store: AsyncKeyedStore = {
      put: never,
      readPrefix: never,
      keys: never,
      deletePrefix: never,
    };
    const b = createIdbChunkBackend(store, {
      generation: 5,
      cleanOtherGenerations: false,
      stallMs: 300,
    });
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('x'));
    const snap = b.snapshot([{ ref: ref(5, 0), count: 1 }]);
    const t0 = Date.now();
    await expect(snap.drainAll()).rejects.toThrow(/no progress for 300 ms/);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(
      snap
        .inMemory?.()
        .get('log')
        ?.map((r) => r.serialized),
    ).toEqual(['x']);
    snap.release();
  });

  it('keeps waiting while the queue IS progressing, however long that takes (a slow healthy device must not be mistaken for a dead one)', async () => {
    const inner = keyed();
    const store: AsyncKeyedStore = {
      ...inner,
      put: async (k, v) => {
        await sleep(120); // each write is slow, but they keep landing
        return inner.put(k, v);
      },
    };
    const b = createIdbChunkBackend(store, {
      generation: 5,
      cleanOtherGenerations: false,
      stallMs: 300,
    });
    b.openPart(ref(5, 0), 1);
    for (let i = 0; i < 10; i++) b.appendEntry(ref(5, 0), rec(`r${i}`));
    const started = Date.now();
    const got = await collect(b.snapshot([{ ref: ref(5, 0), count: 10 }]));
    expect(Date.now() - started).toBeGreaterThan(900); // far longer than stallMs
    expect(got).toEqual(Array.from({ length: 10 }, (_, i) => `r${i}`));
  });

  it('the stall clock starts when the queue becomes BUSY, not when it was last busy (an idle hour is not a stall)', async () => {
    const never = () => new Promise<never>(() => {});
    const store: AsyncKeyedStore = {
      put: never,
      readPrefix: never,
      keys: never,
      deletePrefix: never,
    };
    const b = createIdbChunkBackend(store, {
      generation: 5,
      cleanOtherGenerations: false,
      stallMs: 600,
    });
    await sleep(700); // idle for longer than stallMs before anything is queued
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('x'));
    const t0 = Date.now();
    await expect(b.snapshot([{ ref: ref(5, 0), count: 1 }]).drainAll()).rejects.toThrow(
      /no progress/,
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500); // it waited for stallMs of silence, it did not fire at once
  });

  it('an abandoned wait (release()) stops its watch timer', async () => {
    vi.useFakeTimers();
    try {
      const never = () => new Promise<never>(() => {});
      const store: AsyncKeyedStore = {
        put: never,
        readPrefix: never,
        keys: never,
        deletePrefix: never,
      };
      const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
      b.openPart(ref(5, 0), 1);
      b.appendEntry(ref(5, 0), rec('x'));
      const snap = b.snapshot([{ ref: ref(5, 0), count: 1 }]);
      const read = snap.drainAll();
      expect(vi.getTimerCount()).toBeGreaterThan(0); // the watch is running
      snap.release();
      await read;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an op that FAILS counts as progress (the store is answering)', async () => {
    const inner = keyed();
    const store: AsyncKeyedStore = {
      ...inner,
      put: async (k, v) => {
        await sleep(120);
        if (k.startsWith('d/'))
          throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        return inner.put(k, v);
      },
    };
    const b = createIdbChunkBackend(store, {
      generation: 5,
      cleanOtherGenerations: false,
      stallMs: 300,
      failureThreshold: 1000,
      onError: () => {},
    });
    b.openPart(ref(5, 0), 1);
    for (let i = 0; i < 8; i++) b.appendEntry(ref(5, 0), rec(`r${i}`));
    const got = await collect(b.snapshot([{ ref: ref(5, 0), count: 8 }]));
    expect(got).toEqual(Array.from({ length: 8 }, (_, i) => `r${i}`)); // all refused, all served from memory
  });

  it('a readPrefix that never answers rejects after readTimeoutMs, and a cancelled wait stops its watch timer', async () => {
    const inner = keyed();
    const store: AsyncKeyedStore = { ...inner, readPrefix: () => new Promise(() => {}) };
    const b = createIdbChunkBackend(store, {
      generation: 5,
      cleanOtherGenerations: false,
      readTimeoutMs: 200,
    });
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('x'));
    await b.flush?.();
    await expect(b.snapshot([{ ref: ref(5, 0), count: 1 }]).drainAll()).rejects.toThrow(
      /did not answer a read in 200 ms/,
    );
    const never = () => new Promise<never>(() => {});
    const stuck = createIdbChunkBackend(
      { put: never, readPrefix: never, keys: never, deletePrefix: never },
      {
        generation: 6,
        cleanOtherGenerations: false,
        stallMs: 60_000,
      },
    );
    stuck.openPart(ref(6, 0), 1);
    stuck.appendEntry(ref(6, 0), rec('y'));
    const snap = stuck.snapshot([{ ref: ref(6, 0), count: 1 }]);
    const read = snap.drainAll();
    snap.release();
    expect((await read).size).toBe(0);
  });

  it('a read that answers in time clears its deadline timer (no timer is left behind)', async () => {
    const b = createIdbChunkBackend(keyed(), { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('x'));
    await b.flush?.();
    const got = await collect(b.snapshot([{ ref: ref(5, 0), count: 1 }]));
    expect(got).toEqual(['x']);
  });
});

describe('createIdbChunkCaptureStore — a transient unreadable IndexedDB never hides what landed (no dead window)', () => {
  it('after ONE failed read the very next report has every landed record, old and new, not just the not-yet-landed ones', async () => {
    const inner = keyed();
    const state = { failReads: false, failures: 0 };
    const store: AsyncKeyedStore = {
      ...inner,
      readPrefix: (prefix) => {
        if (state.failReads) {
          state.failures += 1;
          return Promise.reject(Object.assign(new Error('closing'), { name: 'InvalidStateError' }));
        }
        return inner.readPrefix(prefix);
      },
    };
    const pressure = createDiskPressure();
    const onDiskReadError = vi.fn();
    let now = 10_000;
    const s = createIdbChunkCaptureStore(store, {
      clock: { wallNow: () => now, monotonicNow: () => now },
      generation: 42,
      cleanOtherGenerations: false,
      diskPressure: pressure,
      onDiskReadError,
    });
    const logs = async (): Promise<string[]> => {
      const snap = s.snapshot();
      const all = await snap.drainAll();
      snap.release();
      return (all.get('log') ?? []).map((r) => r.serialized);
    };
    for (let i = 0; i < 5; i++) s.add(rec(`old-${i}`, 'log', now));
    await s.flush?.();
    state.failReads = true;
    expect(await logs()).toEqual([]); // unreadable: nothing landed can be shown, nothing is invented
    state.failReads = false; // one transient failure, then the store is healthy
    for (let i = 0; i < 5; i++) s.add(rec(`new-${i}`, 'log', now));
    await s.flush?.();
    const expected = [
      ...Array.from({ length: 5 }, (_, i) => `old-${i}`),
      ...Array.from({ length: 5 }, (_, i) => `new-${i}`),
    ];
    for (let tick = 0; tick < 62; tick++) {
      now += 1000;
      s.tick(now);
      if (tick === 0 || tick === 30 || tick === 59 || tick === 61) {
        expect(await logs(), `tick ${tick}`).toEqual(expected); // was: 0 records until the 60-tick window ended
      }
    }
    expect(state.failures).toBe(1);
    expect(onDiskReadError).toHaveBeenCalledOnce();
  });
});

describe('createIdbChunkBackend — freeze boundary and default deadlines', () => {
  const never = () => new Promise<never>(() => {});

  it('the in-memory freeze is EXCLUSIVE at count: seq == count was appended after the snapshot and stays out', () => {
    const store: AsyncKeyedStore = {
      put: never,
      readPrefix: never,
      keys: never,
      deletePrefix: never,
    };
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    for (let i = 0; i < 3; i++) b.appendEntry(ref(5, 0), rec(`r${i}`)); // seq 0, 1, 2
    const snap = b.snapshot([{ ref: ref(5, 0), count: 2 }]);
    expect([...(snap.inMemory?.().values() ?? [])].flat().map((r) => r.serialized)).toEqual([
      'r0',
      'r1',
    ]);
  });

  it('a readPrefix gets 10 s by default: 9999 ms is waited out, 10000 ms rejects', async () => {
    vi.useFakeTimers();
    try {
      const store: AsyncKeyedStore = {
        put: async () => undefined, // plain promises: fake-indexeddb schedules with timers that fake timers would freeze
        readPrefix: never,
        keys: async () => [],
        deletePrefix: async () => undefined,
      };
      const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
      b.openPart(ref(5, 0), 1);
      b.appendEntry(ref(5, 0), rec('x'));
      await b.flush?.();
      let rejected: unknown;
      const read = b.snapshot([{ ref: ref(5, 0), count: 1 }]).drainAll();
      read.catch((e: unknown) => {
        rejected = e;
      });
      await vi.advanceTimersByTimeAsync(9999);
      expect(rejected).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect((rejected as Error).message).toMatch(/did not answer a read in 10000 ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the queue stall default is 5 s: 4999 ms of silence is waited out, 5000 ms gives up', async () => {
    vi.useFakeTimers();
    try {
      const store: AsyncKeyedStore = {
        put: never,
        readPrefix: never,
        keys: never,
        deletePrefix: never,
      };
      const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
      b.openPart(ref(5, 0), 1);
      b.appendEntry(ref(5, 0), rec('x'));
      let rejected: unknown;
      b.snapshot([{ ref: ref(5, 0), count: 1 }])
        .drainAll()
        .catch((e: unknown) => {
          rejected = e;
        });
      await vi.advanceTimersByTimeAsync(4750);
      expect(rejected).toBeUndefined();
      await vi.advanceTimersByTimeAsync(250);
      expect((rejected as Error).message).toMatch(/no progress for 5000 ms/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createIdbChunkBackend — the frozen in-memory copy', () => {
  const flat = (m: Map<FileType, StoredEntry[]> | undefined): string[] =>
    [...(m?.values() ?? [])]
      .flat()
      .map((r) => r.serialized)
      .sort();

  it('a write that LANDS after the freeze but before a failing read is still served from memory', async () => {
    const inner = keyed();
    const state = { failReads: false };
    const store: AsyncKeyedStore = {
      ...inner,
      readPrefix: (prefix) =>
        state.failReads
          ? Promise.reject(Object.assign(new Error('closing'), { name: 'InvalidStateError' }))
          : inner.readPrefix(prefix),
    };
    const b = createIdbChunkBackend(store, { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('queued', 'log')); // not landed yet at the freeze
    const snap = b.snapshot([{ ref: ref(5, 0), count: 1 }]);
    await b.flush?.(); // it lands now: it leaves the live map
    state.failReads = true;
    await expect(snap.drainAll()).rejects.toThrow();
    expect(flat(snap.inMemory?.())).toEqual(['queued']); // the copy still has it
  });

  it('a record that both landed and sits in the frozen copy appears ONCE when the read succeeds', async () => {
    const b = createIdbChunkBackend(keyed(), { generation: 5, cleanOtherGenerations: false });
    b.openPart(ref(5, 0), 1);
    b.appendEntry(ref(5, 0), rec('once', 'log'));
    const snap = b.snapshot([{ ref: ref(5, 0), count: 1 }]); // frozen while queued
    expect(await collect(snap)).toEqual(['once']); // landed by the time it is read, still in the copy
  });
});
