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

  it('writes one file per (part, type), named <paddedPart>__<type>', () => {
    const { adapter, streams } = fakeAdapter();
    mk(adapter).add(rec('log', 10_000));
    expect([...streams.keys()]).toEqual(['000000000000__log']);
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

  it('ignores files belonging to no active part (a leftover/evicted part)', async () => {
    const { adapter } = fakeAdapter();
    const store = mk(adapter);
    store.add(rec('log', 10_000)); // part0 (active)
    adapter.append('000000000099__log', '{"t":99,"s":"{}"}\n'); // a file for a part the store doesn't track
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 10_000)]);
  });

  it('skips a corrupt line and a stray (non-part) file', async () => {
    const { adapter } = fakeAdapter();
    const store = mk(adapter);
    store.add(rec('log', 10_000, '{"m":"a"}'));
    adapter.append('000000000000__log', 'corrupt-not-json\n'); // a bad line in the part file
    adapter.append('stray-file', 'whatever\n'); // not a part file (no "__")
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
    expect([...streams.keys()]).toEqual(['000000000001__log']); // only part1's file remains
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
      names: () => ['000000000000__log'], // part 0 is active, but its file reads undefined
      remove: () => {},
    };
    expect((await mk(adapter).snapshot().drainAll()).size).toBe(0);
  });
});

describe('createFileCaptureStore — clear', () => {
  it('removes all files and keeps working afterwards', async () => {
    const { adapter, streams } = fakeAdapter();
    const store = mk(adapter);
    store.add(rec('log', 10_000));
    store.add(rec('network', 10_000));
    store.clear();
    expect(streams.size).toBe(0);
    store.add(rec('log', 10_001));
    expect((await store.snapshot().drainAll()).get('log')).toEqual([rec('log', 10_001)]);
  });
});
