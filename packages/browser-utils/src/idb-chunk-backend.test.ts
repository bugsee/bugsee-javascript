import 'fake-indexeddb/auto';
import type { CaptureSnapshot, Clock, PartRef, StoredEntry } from '@bugsee/core';
import type { FileType } from '@bugsee/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
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

  it('freezes the snapshot: capture after snapshot() does not change it', async () => {
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
describe('flush (Wave 6.2)', () => {
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
