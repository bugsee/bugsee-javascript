import type { FileType } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { CaptureDataEntryBase } from './capture-data-entry';
import { createCaptureExporter } from './capture-exporter';
import type { CaptureEntryFactory, CaptureSnapshot, CaptureStore, StoredEntry } from './contracts';

const rec = (type: FileType, timestamp: number, data: unknown): StoredEntry => ({
  type,
  timestamp,
  serialized: JSON.stringify({ timestamp, data }),
});

function groupByType(records: StoredEntry[]): Map<FileType, StoredEntry[]> {
  const map = new Map<FileType, StoredEntry[]>();
  for (const r of records) {
    (map.get(r.type) ?? map.set(r.type, []).get(r.type))?.push(r);
  }
  return map;
}

// A fake store whose snapshot() serves a fixed record list and tracks release().
function fakeStore(records: StoredEntry[]) {
  let released = false;
  const snapshot: CaptureSnapshot = {
    stream: async function* () {
      for (const r of records) {
        yield r;
      }
    },
    drainAll: async () => groupByType(records),
    release: () => {
      released = true;
    },
  };
  const snapshotFn = vi.fn(() => snapshot);
  const store: CaptureStore = {
    add: () => {},
    tick: () => {},
    snapshot: snapshotFn,
    clear: () => {},
  };
  return { store, isReleased: () => released, snapshotFn };
}

describe('createCaptureExporter — stream', () => {
  it('snapshots the store and deserializes records one-by-one in order', async () => {
    const { store } = fakeStore([rec('log', 1, { m: 'a' }), rec('network', 2, { url: 'u' })]);
    const seen: Array<{ type: string; timestamp: number; data: unknown }> = [];
    for await (const e of createCaptureExporter(store).stream()) {
      seen.push({ type: e.type, timestamp: e.timestamp, data: e.data });
    }
    expect(seen).toEqual([
      { type: 'log', timestamp: 1, data: { m: 'a' } },
      { type: 'network', timestamp: 2, data: { url: 'u' } },
    ]);
  });

  it('produces CaptureDataEntryBase instances via the default factory', async () => {
    const { store } = fakeStore([rec('log', 1, {})]);
    for await (const e of createCaptureExporter(store).stream()) {
      expect(e).toBeInstanceOf(CaptureDataEntryBase);
    }
  });

  it('releases the snapshot after streaming completes', async () => {
    const fake = fakeStore([rec('log', 1, {})]);
    const it = createCaptureExporter(fake.store).stream();
    // not released until the iteration is driven to completion
    for await (const _e of it) {
      // consume
    }
    expect(fake.isReleased()).toBe(true);
  });

  it('yields nothing for an empty snapshot', async () => {
    const seen: unknown[] = [];
    for await (const e of createCaptureExporter(fakeStore([]).store).stream()) {
      seen.push(e);
    }
    expect(seen).toEqual([]);
  });
});

describe('createCaptureExporter — drain', () => {
  it('deserializes all snapshot records grouped by file type, then releases', async () => {
    const fake = fakeStore([
      rec('log', 1, { m: 'a' }),
      rec('log', 3, { m: 'b' }),
      rec('network', 2, { url: 'u' }),
    ]);
    const out = await createCaptureExporter(fake.store).drain();
    expect(out.get('log')?.map((e) => e.data)).toEqual([{ m: 'a' }, { m: 'b' }]);
    expect(out.get('network')?.map((e) => e.data)).toEqual([{ url: 'u' }]);
    expect(out.get('log')?.[0]?.timestamp).toBe(1);
    expect(fake.isReleased()).toBe(true);
  });

  it('returns an empty map for an empty snapshot', async () => {
    expect((await createCaptureExporter(fakeStore([]).store).drain()).size).toBe(0);
  });
});

describe('createCaptureExporter — factory', () => {
  it('uses the injected factory to create entries (asked for each record type)', async () => {
    const factory = vi.fn<CaptureEntryFactory>((type) => new CaptureDataEntryBase(type));
    const { store } = fakeStore([rec('log', 1, {}), rec('network', 2, {})]);
    await createCaptureExporter(store, factory).drain();
    expect(factory.mock.calls.map((c) => c[0])).toEqual(['log', 'network']);
  });

  it('deserializes into the custom entry the factory returns', async () => {
    class TaggedEntry extends CaptureDataEntryBase {
      tagged = true;
    }
    const factory: CaptureEntryFactory = (type) => new TaggedEntry(type);
    const { store } = fakeStore([rec('log', 1, { m: 'x' })]);
    const [entry] = (await createCaptureExporter(store, factory).drain()).get('log') ?? [];
    expect(entry).toBeInstanceOf(TaggedEntry);
    expect((entry as TaggedEntry).tagged).toBe(true);
    expect(entry?.data).toEqual({ m: 'x' });
  });
});
