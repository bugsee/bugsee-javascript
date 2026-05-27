import type { FileType } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import type { FileStorageAdapter, StoredEntry } from './contracts';
import { createFileCaptureStore } from './file-capture-store';

const rec = (type: FileType, timestamp: number, serialized = '{}'): StoredEntry => ({
  type,
  timestamp,
  serialized,
});

// An in-memory fake FileStorageAdapter (a name→text map), so the store logic is tested without disk.
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

describe('createFileCaptureStore — add + drainAll', () => {
  it('persists a record and reads it back grouped by file type', async () => {
    const { adapter } = fakeAdapter();
    const store = createFileCaptureStore(adapter);
    const r = rec('log', 1, '{"m":"hi"}');
    store.add(r);
    expect(await store.drainAll()).toEqual(new Map([['log', [r]]]));
  });

  it('keeps same-type records in insertion order', async () => {
    const { adapter } = fakeAdapter();
    const store = createFileCaptureStore(adapter);
    store.add(rec('log', 1));
    store.add(rec('log', 2));
    expect((await store.drainAll()).get('log')).toEqual([rec('log', 1), rec('log', 2)]);
  });

  it('routes records to separate streams by file type', async () => {
    const { adapter, streams } = fakeAdapter();
    const store = createFileCaptureStore(adapter);
    store.add(rec('network', 1));
    store.add(rec('log', 2));
    expect([...streams.keys()].sort()).toEqual(['log', 'network']);
    const snap = await store.drainAll();
    expect(snap.get('network')).toEqual([rec('network', 1)]);
    expect(snap.get('log')).toEqual([rec('log', 2)]);
  });

  it('drainAll clears the streams (next drain is empty)', async () => {
    const { adapter, streams } = fakeAdapter();
    const store = createFileCaptureStore(adapter);
    store.add(rec('log', 1));
    await store.drainAll();
    expect(streams.size).toBe(0);
    expect((await store.drainAll()).size).toBe(0);
  });

  it('omits a stream that holds no parseable records', async () => {
    const { adapter } = fakeAdapter();
    adapter.append('log', 'not-json\n'); // a corrupt-only stream
    expect((await createFileCaptureStore(adapter).drainAll()).size).toBe(0);
  });

  it('skips a corrupt line but keeps the valid ones', async () => {
    const { adapter } = fakeAdapter();
    const store = createFileCaptureStore(adapter);
    store.add(rec('log', 1, '{"m":"a"}'));
    adapter.append('log', '{"t":2,"s": not-valid-json}\n'); // a complete but corrupt line
    store.add(rec('log', 3, '{"m":"b"}'));
    expect((await store.drainAll()).get('log')).toEqual([
      rec('log', 1, '{"m":"a"}'),
      rec('log', 3, '{"m":"b"}'),
    ]);
  });

  it('skips a truncated trailing line (interrupted write)', async () => {
    const { adapter } = fakeAdapter();
    const store = createFileCaptureStore(adapter);
    store.add(rec('log', 1, '{"m":"a"}'));
    adapter.append('log', '{"t":2,"s": trunc'); // crash mid-append: no trailing newline
    expect((await store.drainAll()).get('log')).toEqual([rec('log', 1, '{"m":"a"}')]);
  });

  it('tolerates a listed stream that reads as undefined (removed mid-drain)', async () => {
    const adapter: FileStorageAdapter = {
      append: () => {},
      read: () => undefined,
      names: () => ['log'], // listed, but read returns undefined
      remove: () => {},
    };
    expect((await createFileCaptureStore(adapter).drainAll()).size).toBe(0);
  });
});

describe('createFileCaptureStore — capacity', () => {
  it('keeps only the newest defaultCapacity records per type', async () => {
    const { adapter } = fakeAdapter();
    const store = createFileCaptureStore(adapter, { defaultCapacity: 2 });
    store.add(rec('log', 1));
    store.add(rec('log', 2));
    store.add(rec('log', 3));
    expect((await store.drainAll()).get('log')?.map((e) => e.timestamp)).toEqual([2, 3]);
  });

  it('applies a per-type capacity override', async () => {
    const { adapter } = fakeAdapter();
    const store = createFileCaptureStore(adapter, {
      defaultCapacity: 100,
      capacities: { breadcrumbs: 1 },
    });
    store.add(rec('breadcrumbs', 1));
    store.add(rec('breadcrumbs', 2));
    expect((await store.drainAll()).get('breadcrumbs')?.map((e) => e.timestamp)).toEqual([2]);
  });

  it('is unbounded by default (keeps all records)', async () => {
    const { adapter } = fakeAdapter();
    const store = createFileCaptureStore(adapter);
    for (let i = 0; i < 50; i += 1) {
      store.add(rec('log', i));
    }
    expect((await store.drainAll()).get('log')).toHaveLength(50);
  });
});

describe('createFileCaptureStore — stream', () => {
  it('yields records one-by-one across streams, then clears', async () => {
    const { adapter, streams } = fakeAdapter();
    const store = createFileCaptureStore(adapter);
    store.add(rec('log', 1));
    store.add(rec('network', 2));
    store.add(rec('log', 3));
    const seen: string[] = [];
    for await (const r of store.stream()) {
      seen.push(`${r.type}:${r.timestamp}`);
    }
    expect(seen).toEqual(['log:1', 'log:3', 'network:2']);
    expect(streams.size).toBe(0);
  });

  it('applies capacity while streaming', async () => {
    const { adapter } = fakeAdapter();
    const store = createFileCaptureStore(adapter, { defaultCapacity: 1 });
    store.add(rec('log', 1));
    store.add(rec('log', 2));
    const seen: number[] = [];
    for await (const r of store.stream()) {
      seen.push(r.timestamp);
    }
    expect(seen).toEqual([2]);
  });

  it('tolerates a listed stream that reads as undefined while streaming', async () => {
    const adapter: FileStorageAdapter = {
      append: () => {},
      read: () => undefined,
      names: () => ['log'],
      remove: () => {},
    };
    const seen: unknown[] = [];
    for await (const r of createFileCaptureStore(adapter).stream()) {
      seen.push(r);
    }
    expect(seen).toEqual([]);
  });

  it('yields nothing for an empty store', async () => {
    const { adapter } = fakeAdapter();
    const seen: unknown[] = [];
    for await (const r of createFileCaptureStore(adapter).stream()) {
      seen.push(r);
    }
    expect(seen).toEqual([]);
  });
});

describe('createFileCaptureStore — clear', () => {
  it('removes all streams', async () => {
    const { adapter, streams } = fakeAdapter();
    const store = createFileCaptureStore(adapter);
    store.add(rec('log', 1));
    store.add(rec('network', 2));
    store.clear();
    expect(streams.size).toBe(0);
  });
});
