import type { FileType } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import type { Clock } from './clock';
import type { FileStorageAdapter, StoredEntry } from './contracts';
import { createFileCaptureStore, type FileCaptureStoreOptions } from './file-capture-store';

const rec = (type: FileType, timestamp: number, serialized = '{}'): StoredEntry => ({
  type,
  timestamp,
  serialized,
});
const clockAt = (now: number): Clock => ({ wallNow: () => now, monotonicNow: () => 0 });

// Capture-file name helper: <gen13>__<part12>__<type>. Default generation is the clock's wallNow at
// construction — clockAt(10_000) below, so the default `mk` store's generation is 10_000.
const cf = (type: string, part = 0, gen = 10_000): string =>
  `${String(gen).padStart(13, '0')}__${String(part).padStart(12, '0')}__${type}`;

// In-memory fake FileStorageAdapter (a name→text map), so the part logic is tested without disk.
function fakeAdapter() {
  const streams = new Map<string, string>();
  const adapter: FileStorageAdapter = {
    append: (name, data) => streams.set(name, (streams.get(name) ?? '') + data),
    read: (name) => streams.get(name),
    names: () => [...streams.keys()],
    remove: (name) => {
      streams.delete(name);
    },
  };
  return { adapter, streams };
}

const mk = (adapter: FileStorageAdapter, over: FileCaptureStoreOptions = {}) =>
  createFileCaptureStore(adapter, { clock: clockAt(10_000), ...over });

describe('createFileCaptureStore — add + snapshot', () => {
  it('persists records and snapshots them grouped by file type', async () => {
    const { adapter } = fakeAdapter();
    const store = mk(adapter);
    const log = rec('log', 10_000, '{"m":"hi"}');
    const net = rec('network', 10_000, '{"u":"x"}');
    store.add(log);
    store.add(net);
    const snap = await store.snapshot().drainAll();
    expect(snap.get('log')).toEqual([log]);
    expect(snap.get('network')).toEqual([net]);
  });

  it('writes one file per (part, type), named <gen13>__<part12>__<type> (default gen = clock)', () => {
    const { adapter, streams } = fakeAdapter();
    mk(adapter).add(rec('log', 10_000));
    expect([...streams.keys()]).toEqual([cf('log')]);
  });

  it('keeps same-type records in part order across a rotation', async () => {
    const { adapter } = fakeAdapter();
    const store = mk(adapter);
    store.add(rec('log', 10_000));
    store.tick(11_000);
    store.add(rec('log', 11_000));
    expect((await store.snapshot().drainAll()).get('log')).toEqual([
      rec('log', 10_000),
      rec('log', 11_000),
    ]);
  });

  it('ignores files belonging to no active part (a leftover/evicted part of this generation)', async () => {
    const { adapter } = fakeAdapter();
    const store = mk(adapter);
    store.add(rec('log', 10_000)); // part0 (active)
    adapter.append(cf('log', 99), '{"t":99,"s":"{}"}\n'); // a file for a part the store doesn't track
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 10_000)]);
  });

  it('skips a corrupt line and a stray (non-part) file', async () => {
    const { adapter } = fakeAdapter();
    const store = mk(adapter);
    store.add(rec('log', 10_000, '{"m":"a"}'));
    adapter.append(cf('log'), 'corrupt-not-json\n'); // a bad line in the part file
    adapter.append('stray-file', 'whatever\n'); // not a part file
    expect((await store.snapshot().drainAll()).get('log')).toEqual([
      rec('log', 10_000, '{"m":"a"}'),
    ]);
  });
});

describe('createFileCaptureStore — tick rotation + cleanup', () => {
  it('deletes the files of parts outside the recording window on tick', async () => {
    const { adapter, streams } = fakeAdapter();
    const store = mk(adapter, { maxRecordingTimeMs: 2000 }); // cutting = now - 3000
    store.add(rec('log', 10_000)); // part0
    store.tick(11_000); // part0 closes @11000, part1 opens
    store.add(rec('log', 11_000)); // part1
    store.tick(15_000); // cutting 12000 → part0 (end 11000) evicted, its files removed
    expect([...streams.keys()]).toEqual([cf('log', 1)]); // only part1's file remains
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 11_000)]);
  });

  it('keeps a part whose end is exactly at the cutting edge (strict <)', async () => {
    const { adapter } = fakeAdapter();
    const store = mk(adapter, { maxRecordingTimeMs: 2000 });
    store.add(rec('log', 10_000));
    store.tick(12_000); // part0 end = 12000
    store.tick(15_000); // cutting 12000; 12000 is NOT < 12000 → kept
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 10_000)]);
  });
});

describe('createFileCaptureStore — generations', () => {
  it('namespaces files by generation (a different generation does not see this one’s data)', async () => {
    const { adapter } = fakeAdapter();
    const a = createFileCaptureStore(adapter, { clock: clockAt(10_000), generation: 1 });
    a.add(rec('log', 1));
    // a second store on the same adapter for a different generation; do not let it clean a's files
    const b = createFileCaptureStore(adapter, {
      clock: clockAt(10_000),
      generation: 2,
      cleanOtherGenerations: false,
    });
    expect((await b.snapshot().drainAll()).size).toBe(0); // gen 2 has no records
    expect((await a.snapshot().drainAll()).get('log')).toEqual([rec('log', 1)]); // gen 1 still sees its own
  });

  it('on a fresh launch, deletes other generations’ leftover capture files', () => {
    const { adapter, streams } = fakeAdapter();
    adapter.append(cf('log', 0, 5), '{"t":1,"s":"{}"}\n'); // a prior launch (generation 5) left this
    createFileCaptureStore(adapter, { clock: clockAt(10_000), generation: 9 });
    expect([...streams.keys()]).toEqual([]); // the stale generation’s file is discarded
  });

  it('leaves foreign (non capture-part) files untouched on a fresh launch', () => {
    const { adapter, streams } = fakeAdapter();
    adapter.append('bundle_abc.zip', 'zipdata'); // e.g. a persisted crash bundle
    adapter.append(cf('log', 0, 5), 'stale'); // a prior generation’s capture file
    createFileCaptureStore(adapter, { clock: clockAt(10_000), generation: 9 });
    expect([...streams.keys()]).toEqual(['bundle_abc.zip']); // bundle kept, stale capture file removed
  });

  it('does not delete its OWN generation’s pre-existing files on construction', () => {
    const { adapter, streams } = fakeAdapter();
    adapter.append(cf('log', 0, 9), 'mine'); // same generation as the store about to launch
    createFileCaptureStore(adapter, { clock: clockAt(10_000), generation: 9 });
    expect(streams.has(cf('log', 0, 9))).toBe(true);
  });

  it('cleanOtherGenerations: false keeps other generations’ files', () => {
    const { adapter, streams } = fakeAdapter();
    adapter.append(cf('log', 0, 5), 'stale');
    createFileCaptureStore(adapter, {
      clock: clockAt(10_000),
      generation: 9,
      cleanOtherGenerations: false,
    });
    expect(streams.has(cf('log', 0, 5))).toBe(true);
  });
});

describe('createFileCaptureStore — snapshot isolation', () => {
  it('freezes the snapshot: capture after snapshot() does not change it', async () => {
    const { adapter } = fakeAdapter();
    const store = mk(adapter);
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
    const { adapter } = fakeAdapter();
    const store = mk(adapter);
    store.add(rec('log', 10_000));
    const snap = store.snapshot();
    snap.release();
    expect((await snap.drainAll()).size).toBe(0);
  });

  it('snapshot of an empty store yields nothing', async () => {
    expect((await mk(fakeAdapter().adapter).snapshot().drainAll()).size).toBe(0);
  });

  it('works with default options (system clock, 60s window)', async () => {
    const { adapter } = fakeAdapter();
    const store = createFileCaptureStore(adapter); // no clock/window → defaults
    store.add(rec('log', 10_000)); // no tick → current part never evicted
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 10_000)]);
  });

  it('tolerates an active part file that reads as undefined (removed mid-snapshot)', async () => {
    const adapter: FileStorageAdapter = {
      append: () => {},
      read: () => undefined,
      names: () => [cf('log', 0)], // part 0 is active, but its file reads undefined
      remove: () => {},
    };
    expect((await mk(adapter).snapshot().drainAll()).size).toBe(0);
  });
});

describe('createFileCaptureStore — clear', () => {
  it('removes this generation’s files and keeps working afterwards', async () => {
    const { adapter, streams } = fakeAdapter();
    const store = mk(adapter);
    store.add(rec('log', 10_000));
    store.add(rec('network', 10_000));
    store.clear();
    expect(streams.size).toBe(0);
    store.add(rec('log', 10_001));
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 10_001)]);
  });

  it('clear() leaves another generation’s files intact', () => {
    const { adapter, streams } = fakeAdapter();
    adapter.append(cf('log', 0, 5), 'other-gen');
    const store = createFileCaptureStore(adapter, {
      clock: clockAt(10_000),
      generation: 9,
      cleanOtherGenerations: false,
    });
    store.add(rec('log', 10_000));
    store.clear();
    expect(streams.has(cf('log', 0, 5))).toBe(true); // only generation 9’s files were cleared
  });
});
