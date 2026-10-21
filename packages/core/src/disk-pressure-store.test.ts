import type { FileType } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { ChunkBackend } from './chunk-backend';
import { createInMemoryChunkStorage } from './chunk-storage';
import type { Clock } from './clock';
import type { CaptureStore, StoredEntry } from './contracts';
import { createDiskPressure } from './disk-pressure';
import { withDiskPressure } from './disk-pressure-backend';
import { createFileCaptureStore } from './file-capture-store';
import { createFileChunkBackend } from './file-chunk-backend';
import { createMemoryChunkBackend } from './memory-chunk-backend';

const MB = 1_000_000;
const clockAt = (now: number): Clock => ({ wallNow: () => now, monotonicNow: () => 0 });
const rec = (
  type: FileType,
  timestamp: number,
  serialized = `${type}@${timestamp}`,
): StoredEntry => ({
  type,
  timestamp,
  serialized,
});

const drain = async (store: CaptureStore): Promise<Map<FileType, StoredEntry[]>> => {
  const snap = store.snapshot();
  try {
    return await snap.drainAll();
  } finally {
    snap.release();
  }
};
const names = (list: StoredEntry[] | undefined): string[] => (list ?? []).map((r) => r.serialized);

function setup(opts: { maxRecordingTimeMs?: number; maxDataSizeBytes?: number } = {}) {
  const storage = createInMemoryChunkStorage();
  const pressure = createDiskPressure();
  const store = createFileCaptureStore(storage, {
    clock: clockAt(1000),
    generation: 7,
    diskPressure: pressure,
    ...opts,
  });
  return { storage, pressure, store };
}

describe('disk pressure over the file capture store', () => {
  it('with no pressure behaves as before: everything on the durable medium, nothing shadowed', async () => {
    const { storage, store } = setup();
    store.add(rec('log', 1));
    store.add(rec('replay', 2));
    store.add(rec('traces.system', 3));
    expect(storage.files(7, 0).sort()).toEqual(['log', 'meta', 'replay', 'traces.system']);
    const all = await drain(store);
    expect(names(all.get('log'))).toEqual(['log@1']);
    expect(names(all.get('replay'))).toEqual(['replay@2']);
  });

  it('LOW: replay, log and network stop reaching the medium; traces, events, input, breadcrumbs keep going', () => {
    const { storage, pressure, store } = setup();
    pressure.observe(30 * MB);
    for (const type of [
      'replay',
      'log',
      'network',
      'traces.system',
      'events.system',
      'traces.user',
      'events.user',
      'input',
      'breadcrumbs',
    ] as const) {
      store.add(rec(type, 5));
    }
    expect(storage.files(7, 0).sort()).toEqual([
      'breadcrumbs',
      'events.system',
      'events.user',
      'input',
      'meta',
      'traces.system',
      'traces.user',
    ]);
  });

  it('LOW: a report built while the process is alive still holds the whole window', async () => {
    const { pressure, store } = setup();
    store.add(rec('log', 1));
    pressure.observe(30 * MB);
    store.add(rec('log', 2));
    store.add(rec('replay', 3));
    store.add(rec('traces.system', 4));
    const all = await drain(store);
    expect(names(all.get('log'))).toEqual(['log@1', 'log@2']);
    expect(names(all.get('replay'))).toEqual(['replay@3']);
    expect(names(all.get('traces.system'))).toEqual(['traces.system@4']);
  });

  it('NONE: nothing is persisted, not even a new part, yet the live window is complete', async () => {
    const { storage, pressure, store } = setup();
    store.add(rec('log', 1));
    pressure.observe(5 * MB);
    store.add(rec('traces.system', 2));
    store.tick(2000); // a new part opens while there is no room
    store.add(rec('log', 2500));
    expect(storage.chunks(7)).toEqual([0]); // part 1 was never created on the medium
    expect(storage.read(7, 0, 'traces.system')).toBeUndefined();
    const all = await drain(store);
    expect(names(all.get('log'))).toEqual(['log@1', 'log@2500']);
    expect(names(all.get('traces.system'))).toEqual(['traces.system@2']);
  });

  it('never rewrites or truncates what was already persisted', () => {
    const { storage, pressure, store } = setup();
    store.add(rec('log', 1));
    const before = storage.read(7, 0, 'log');
    pressure.observe(5 * MB);
    store.add(rec('log', 2));
    store.tick(2000);
    expect(storage.read(7, 0, 'log')).toBe(before);
  });

  it('recovers: persistence resumes and the snapshot stays ordered per type across the gap', async () => {
    const { storage, pressure, store } = setup();
    store.add(rec('log', 1));
    pressure.observe(30 * MB);
    store.add(rec('log', 2));
    store.add(rec('log', 3));
    pressure.observe(70 * MB);
    store.add(rec('log', 4));
    expect(storage.read(7, 0, 'log')).toBe('1\tlog@1\n4\tlog@4\n');
    const all = await drain(store);
    expect(names(all.get('log'))).toEqual(['log@1', 'log@2', 'log@3', 'log@4']);
  });

  it('breaks a timestamp tie in write order (the persisted record first)', async () => {
    const { pressure, store } = setup();
    store.add(rec('log', 9, 'durable'));
    pressure.observe(30 * MB);
    store.add(rec('log', 9, 'shadow'));
    expect(names((await drain(store)).get('log'))).toEqual(['durable', 'shadow']);
  });

  it('streams the merged window too', async () => {
    const { pressure, store } = setup();
    store.add(rec('log', 1));
    pressure.observe(30 * MB);
    store.add(rec('log', 2));
    const snap = store.snapshot();
    const seen: string[] = [];
    for await (const r of snap.stream()) seen.push(r.serialized);
    snap.release();
    expect(seen).toEqual(['log@1', 'log@2']);
  });

  it('a snapshot is frozen: later captures stay out of it', async () => {
    const { pressure, store } = setup();
    pressure.observe(30 * MB);
    store.add(rec('log', 1));
    const snap = store.snapshot();
    store.add(rec('log', 2));
    store.add(rec('traces.system', 3));
    const all = await snap.drainAll();
    snap.release();
    expect(names(all.get('log'))).toEqual(['log@1']);
    expect(all.has('traces.system')).toBe(false);
  });

  it('evicts shadowed records with their part (memory stays bounded by the window)', async () => {
    const { pressure, store } = setup({ maxRecordingTimeMs: 2000 });
    pressure.observe(30 * MB);
    store.add(rec('log', 1));
    store.tick(2000);
    store.tick(3000);
    store.tick(4000);
    store.tick(8000); // part 0 is outside the window
    store.add(rec('log', 8001));
    expect(names((await drain(store)).get('log'))).toEqual(['log@8001']);
  });

  it('honours the byte cap over shadowed data', async () => {
    const { pressure, store } = setup({ maxDataSizeBytes: 20 });
    pressure.observe(30 * MB);
    store.add(rec('log', 1, 'a'.repeat(15)));
    store.tick(2000);
    store.add(rec('log', 2001, 'b'.repeat(15)));
    expect(names((await drain(store)).get('log'))).toEqual(['b'.repeat(15)]);
  });

  it('clear() drops both halves', async () => {
    const { pressure, store } = setup();
    store.add(rec('traces.system', 1));
    pressure.observe(30 * MB);
    store.add(rec('log', 2));
    store.clear();
    expect((await drain(store)).size).toBe(0);
    store.add(rec('log', 3));
    expect(names((await drain(store)).get('log'))).toEqual(['log@3']);
  });

  it('records the DURABLE bytes only in a closed part, so crash recovery sees an honest size', () => {
    const { storage, pressure, store } = setup();
    store.add(rec('traces.system', 1, 'abcd')); // durable: "1\tabcd\n" = 7 bytes
    pressure.observe(30 * MB);
    store.add(rec('log', 2, 'x'.repeat(100))); // shadow only
    store.tick(2000);
    expect(JSON.parse(storage.read(7, 0, 'meta') as string)).toEqual({
      n: 0,
      s: 1000,
      e: 2000,
      b: 7,
    });
  });

  it('does not seal a part while there is no room, and never creates a meta for a part the medium never saw', () => {
    const { storage, pressure, store } = setup();
    store.add(rec('traces.system', 1));
    pressure.observe(5 * MB);
    store.tick(2000);
    expect(JSON.parse(storage.read(7, 0, 'meta') as string).e).toBeNull();
    store.tick(3000); // part 1 was opened under none and never written
    expect(storage.chunks(7)).toEqual([0]);
  });

  it('opens a part lazily on its first durable write after recovery', () => {
    const { storage, pressure, store } = setup();
    pressure.observe(5 * MB);
    store.tick(2000); // part 1 opens under none
    expect(storage.chunks(7)).toEqual([0]);
    pressure.observe(100 * MB);
    store.add(rec('log', 2500));
    expect(storage.chunks(7).sort()).toEqual([0, 1]);
    expect(JSON.parse(storage.read(7, 1, 'meta') as string)).toMatchObject({
      n: 1,
      s: 2000,
      e: null,
    });
  });

  it('removes a durable part on eviction even while there is no room (that frees space)', () => {
    const { storage, pressure, store } = setup({ maxRecordingTimeMs: 2000 });
    store.add(rec('traces.system', 1));
    pressure.observe(5 * MB);
    store.tick(2000);
    store.tick(3000);
    store.tick(4000);
    store.tick(9000);
    expect(storage.chunks(7)).not.toContain(0);
  });

  it('a crash during pressure leaves exactly the gap: a fresh backend over the medium sees only the durable half', async () => {
    const { storage, pressure, store } = setup();
    store.add(rec('log', 1));
    pressure.observe(30 * MB);
    store.add(rec('log', 2));
    store.add(rec('traces.system', 3));
    const reborn = createFileChunkBackend(storage, { generation: 7, cleanOtherGenerations: false });
    const snap = reborn.snapshot([{ ref: { generation: 7, number: 0 }, count: 99 }]);
    const all = await snap.drainAll();
    expect(names(all.get('log'))).toEqual(['log@1']);
    expect(names(all.get('traces.system'))).toEqual(['traces.system@3']);
  });
});

describe('withDiskPressure — failures and surface', () => {
  it('a refused durable write keeps the record in the in-memory window and surfaces the error', async () => {
    const storage = createInMemoryChunkStorage();
    const real = storage.append.bind(storage);
    let full = false;
    storage.append = (...args) => {
      if (full) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      real(...args);
    };
    const pressure = createDiskPressure();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: pressure,
    });
    store.add(rec('log', 1));
    full = true;
    expect(() => store.add(rec('log', 2))).toThrow('no space');
    expect(pressure.noteWriteError({ code: 'ENOSPC' })).toBe(true);
    store.add(rec('log', 3));
    expect(names((await drain(store)).get('log'))).toEqual(['log@1', 'log@2', 'log@3']);
  });

  it('a durable openPart that throws does not mark the part opened (it is retried)', () => {
    const storage = createInMemoryChunkStorage();
    const durable = createFileChunkBackend(storage, { generation: 1 });
    const open = vi.spyOn(durable, 'openPart');
    open.mockImplementationOnce(() => {
      throw new Error('open failed');
    });
    const backend = withDiskPressure(durable, createDiskPressure());
    // the part is opened lazily under normal pressure at openPart, which threw; a later durable write retries it
    expect(() => backend.openPart({ generation: 1, number: 0 }, 5)).toThrow('open failed');
    backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('forwards flush only when the durable backend has one', async () => {
    const memory = createMemoryChunkBackend();
    expect('flush' in withDiskPressure(memory, createDiskPressure())).toBe(false);
    const flush = vi.fn(() => Promise.resolve());
    const durable: ChunkBackend = { ...memory, flush };
    const wrapped = withDiskPressure(durable, createDiskPressure());
    await wrapped.flush?.();
    expect(flush).toHaveBeenCalledOnce();
  });

  it('delegates recovery reads (parts, generations) to the durable medium', async () => {
    const storage = createInMemoryChunkStorage();
    const wrapped = withDiskPressure(
      createFileChunkBackend(storage, { generation: 3 }),
      createDiskPressure(),
    );
    wrapped.openPart({ generation: 3, number: 0 }, 10);
    expect(await wrapped.listGenerations()).toEqual([3]);
    expect(await wrapped.listParts(3)).toEqual([
      { generation: 3, number: 0, start: 10, end: undefined, byteSize: 0 },
    ]);
  });

  it('removeGeneration clears the shadow for that generation only', async () => {
    const memory = createMemoryChunkBackend({ generation: 1 });
    const pressure = createDiskPressure();
    const wrapped = withDiskPressure(memory, pressure);
    pressure.observe(30 * MB);
    wrapped.openPart({ generation: 1, number: 0 }, 0);
    wrapped.appendEntry({ generation: 1, number: 0 }, rec('log', 1));
    wrapped.openPart({ generation: 2, number: 0 }, 0);
    wrapped.appendEntry({ generation: 2, number: 0 }, rec('log', 2));
    wrapped.removeGeneration(1);
    const gone = wrapped.snapshot([{ ref: { generation: 1, number: 0 }, count: 5 }]);
    expect((await gone.drainAll()).size).toBe(0);
    gone.release();
    const kept = wrapped.snapshot([{ ref: { generation: 2, number: 0 }, count: 5 }]);
    expect((await kept.drainAll()).get('log')?.length).toBe(1);
    kept.release();
  });

  it('an unknown part in a snapshot contributes nothing', async () => {
    const wrapped = withDiskPressure(createMemoryChunkBackend(), createDiskPressure());
    const snap = wrapped.snapshot([{ ref: { generation: 0, number: 9 }, count: 3 }]);
    expect((await snap.drainAll()).size).toBe(0);
  });
});
