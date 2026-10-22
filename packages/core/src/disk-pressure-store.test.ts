import type { FileType } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { ChunkBackend } from './chunk-backend';
import { createChunkCaptureStore } from './chunk-capture-store';
import { createInMemoryChunkStorage } from './chunk-storage';
import type { Clock } from './clock';
import type { CaptureSnapshot, CaptureStore, StoredEntry } from './contracts';
import { createDiskPressure } from './disk-pressure';
import { withDiskPressure } from './disk-pressure-backend';
import { createFileCaptureStore } from './file-capture-store';
import { createFileChunkBackend } from './file-chunk-backend';
import { createMemoryChunkBackend } from './memory-chunk-backend';

const MB = 1024 * 1024;
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

  it('keeps WRITE order at onset when timestamps tie', async () => {
    const { pressure, store } = setup();
    store.add(rec('log', 9, 'durable'));
    pressure.observe(30 * MB);
    store.add(rec('log', 9, 'shadow'));
    expect(names((await drain(store)).get('log'))).toEqual(['durable', 'shadow']);
  });

  it('keeps WRITE order at recovery when timestamps tie (the shadowed record first)', async () => {
    const { pressure, store } = setup();
    pressure.observe(30 * MB);
    store.add(rec('replay', 500, 'A'));
    pressure.observe(100 * MB);
    store.add(rec('replay', 500, 'B'));
    expect(names((await drain(store)).get('replay'))).toEqual(['A', 'B']);
  });

  it('orders by write sequence, not timestamp, when timestamps are not monotonic', async () => {
    const { pressure, store } = setup();
    store.add(rec('log', 50, 'd1'));
    pressure.observe(30 * MB);
    store.add(rec('log', 10, 's1'));
    store.add(rec('log', 40, 's2'));
    pressure.observe(100 * MB);
    store.add(rec('log', 5, 'd2'));
    pressure.observe(30 * MB);
    store.add(rec('log', 70, 's3'));
    expect(names((await drain(store)).get('log'))).toEqual(['d1', 's1', 's2', 'd2', 's3']);
  });

  it('keeps each type in its own write order when types interleave across the halves', async () => {
    const { pressure, store } = setup();
    store.add(rec('traces.system', 1, 't1'));
    pressure.observe(30 * MB);
    store.add(rec('log', 2, 'l1'));
    store.add(rec('traces.system', 3, 't2')); // durable under low
    store.add(rec('log', 4, 'l2'));
    pressure.observe(5 * MB);
    store.add(rec('traces.system', 5, 't3')); // shadow under none
    const all = await drain(store);
    expect(names(all.get('traces.system'))).toEqual(['t1', 't2', 't3']);
    expect(names(all.get('log'))).toEqual(['l1', 'l2']);
  });

  it('a type that first appears durable AFTER the part was shadowed is still ordered', async () => {
    const { pressure, store } = setup();
    pressure.observe(5 * MB);
    store.add(rec('log', 1, 's1'));
    pressure.observe(100 * MB);
    store.add(rec('traces.system', 2, 'd1'));
    store.add(rec('log', 3, 'd2'));
    expect(names((await drain(store)).get('log'))).toEqual(['s1', 'd2']);
  });

  it('streams one part at a time, oldest part first, releasing each before the next', async () => {
    const { pressure, store } = setup();
    pressure.observe(30 * MB);
    store.add(rec('log', 1, 'p0'));
    store.tick(2000);
    store.add(rec('log', 2001, 'p1'));
    store.add(rec('traces.system', 2002, 'p1t'));
    const snap = store.snapshot();
    const seen: string[] = [];
    for await (const r of snap.stream()) seen.push(r.serialized);
    snap.release();
    expect(seen).toEqual(['p0', 'p1t', 'p1']); // part order first; within a part, grouped by type
  });

  it('releases each part as it is streamed, not all at the end', async () => {
    const releases: number[] = [];
    const memory = createMemoryChunkBackend({ generation: 1 });
    const durable: ChunkBackend = {
      ...memory,
      snapshot: (parts) => {
        const snap = memory.snapshot(parts);
        const first = parts[0]?.ref.number as number;
        return {
          ...snap,
          release: () => {
            releases.push(first);
            snap.release();
          },
        };
      },
    };
    const pressure = createDiskPressure();
    const store = createChunkCaptureStore(durable, {
      clock: clockAt(1000),
      diskPressure: pressure,
    });
    pressure.observe(30 * MB);
    store.add(rec('log', 1, 'p0'));
    store.tick(2000);
    store.add(rec('log', 2001, 'p1'));
    const snap = store.snapshot();
    const stream = snap.stream();
    await stream.next(); // part 0's first record
    expect(releases).toEqual([0]); // part 0 is already released while part 1 is still unread
    await stream.next();
    await stream.next();
    expect(releases).toEqual([0, 1]);
  });

  it('release() before reading frees every half, and a second release is harmless', async () => {
    const { pressure, store } = setup();
    pressure.observe(30 * MB);
    store.add(rec('log', 1));
    const snap = store.snapshot();
    snap.release();
    snap.release();
    expect((await snap.drainAll()).size).toBe(0);
  });

  it('streams a window that is entirely on the medium (the guarded durable half yields it)', async () => {
    const { store } = setup();
    store.add(rec('log', 1));
    store.add(rec('traces.system', 2));
    const snap = store.snapshot();
    const seen: string[] = [];
    for await (const r of snap.stream()) seen.push(r.serialized);
    snap.release();
    expect(seen.sort()).toEqual(['log@1', 'traces.system@2']);
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

  it('seals an opened part at every level (its meta must not lie, the writer closes its handles), and never creates a meta for a part the medium never saw', () => {
    const { storage, pressure, store } = setup();
    store.add(rec('traces.system', 1, 'abcd'));
    pressure.observe(5 * MB);
    store.tick(2000);
    expect(JSON.parse(storage.read(7, 0, 'meta') as string)).toEqual({
      n: 0,
      s: 1000,
      e: 2000,
      b: 7,
    });
    store.tick(3000); // part 1 was opened under none and never written
    expect(storage.chunks(7)).toEqual([0]);
  });

  it('while a refused write PINS none the state entry is NOT written either (a tiny record would succeed and release the pin)', () => {
    const { storage, pressure, store } = setup();
    pressure.noteWriteError({ code: 'ENOSPC' });
    const state =
      '{"timestamp":9,"data":{"timestamp":9,"name":"capture","value":{"state":"no_disk_space"}}}';
    store.add(rec('traces.system', 9, state));
    expect(storage.read(7, 0, 'traces.system')).toBeUndefined();
  });

  it('NONE still persists the `capture` state entry, so a chunk-recovered report can explain its own emptiness', async () => {
    const { storage, pressure, store } = setup();
    pressure.observe(5 * MB);
    const state =
      '{"timestamp":9,"data":{"timestamp":9,"name":"capture","value":{"state":"no_disk_space"}}}';
    store.add(rec('traces.system', 9, state));
    store.add(
      rec(
        'traces.system',
        10,
        '{"timestamp":10,"data":{"timestamp":10,"name":"cpu_usage_process","value":1}}',
      ),
    );
    store.add(rec('log', 11));
    expect(storage.read(7, 0, 'traces.system')).toBe(`9\t${state}\n`);
    expect(storage.files(7, 0).sort()).toEqual(['meta', 'traces.system']);
    expect(names((await drain(store)).get('traces.system'))).toHaveLength(2); // the live window still has both
  });

  it('only a traces.system record counts as the state entry (a log line mentioning it is gated like any log)', () => {
    const { storage, pressure, store } = setup();
    pressure.observe(5 * MB);
    store.add(rec('log', 1, '"name":"capture","value":{"state":"x"}'));
    expect(storage.files(7, 0)).toEqual(['meta']);
  });

  it('a part whose meta could not be created is retried by the first durable write', () => {
    const storage = createInMemoryChunkStorage();
    const real = storage.write.bind(storage);
    let broken = true;
    storage.write = (...args) => {
      if (broken) throw new Error('no room for a meta');
      real(...args);
    };
    const onDiskWriteError = vi.fn();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: createDiskPressure(),
      onDiskWriteError,
    });
    expect(onDiskWriteError).toHaveBeenCalledOnce(); // construction opened part 0: meta refused
    broken = false;
    store.add(rec('traces.system', 1));
    expect(JSON.parse(storage.read(1, 0, 'meta') as string)).toMatchObject({ n: 0, e: null });
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
  const refusingStorage = () => {
    const storage = createInMemoryChunkStorage();
    const real = storage.append.bind(storage);
    const state = { full: false };
    storage.append = (...args) => {
      if (state.full) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      real(...args);
    };
    return { storage, state };
  };

  it('a refused durable write keeps the record in the window and rethrows when nobody owns reporting', async () => {
    const { storage, state } = refusingStorage();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: createDiskPressure(),
    });
    store.add(rec('log', 1));
    state.full = true;
    expect(() => store.add(rec('log', 2))).toThrow('no space');
    expect(names((await drain(store)).get('log'))).toEqual(['log@1', 'log@2']);
  });

  it('with onDiskWriteError the refused write is reported, kept, counted by the byte cap, and does not throw', async () => {
    const { storage, state } = refusingStorage();
    const onDiskWriteError = vi.fn();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: createDiskPressure(),
      onDiskWriteError,
      maxDataSizeBytes: 20,
    });
    store.add(rec('log', 1, 'a'.repeat(15)));
    store.tick(2000);
    state.full = true;
    store.add(rec('log', 2001, 'b'.repeat(15))); // refused: counted at its shadow size, so the cap evicts part 0
    expect(onDiskWriteError).toHaveBeenCalledOnce();
    expect(onDiskWriteError.mock.calls[0]?.[0]).toMatchObject({ code: 'ENOSPC' });
    expect(names((await drain(store)).get('log'))).toEqual(['b'.repeat(15)]);
  });

  it('while PINNED each tick probes a backend without probeWrite with a throwaway part, and the probe leaves nothing behind', () => {
    const storage = createInMemoryChunkStorage();
    const pressure = createDiskPressure();
    const store = throwawayProbeStore(storage, { clock: clockAt(1000), diskPressure: pressure });
    store.tick(2000);
    expect(storage.chunks(1)).toEqual([0, 1]);
    const open = vi.spyOn(storage, 'write');
    pressure.noteWriteError({ code: 'ENOSPC' });
    store.tick(3000);
    expect(open.mock.calls.some((c) => c[1] === 2_000_000_000)).toBe(true);
    expect(storage.chunks(1)).not.toContain(2_000_000_000);
  });

  it('does not probe when not pinned (a size-reading none must not touch the full disk)', () => {
    const storage = createInMemoryChunkStorage();
    const pressure = createDiskPressure();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: pressure,
    });
    pressure.observe(5 * MB);
    const write = vi.spyOn(storage, 'write');
    store.tick(2000);
    expect(write.mock.calls.some((c) => c[1] === 2_000_000_000)).toBe(false); // the seal is a write; the probe is not
    expect(storage.chunks(1)).toEqual([0]);
  });

  it('a probe that throws is reported through onDiskWriteError and swallowed', () => {
    const storage = createInMemoryChunkStorage();
    const pressure = createDiskPressure();
    const onDiskWriteError = vi.fn();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: pressure,
      onDiskWriteError,
    });
    pressure.noteWriteError({ code: 'ENOSPC' });
    storage.write = () => {
      throw new Error('still full');
    };
    expect(() => store.tick(2000)).not.toThrow();
    expect(onDiskWriteError).toHaveBeenCalled();
  });

  it('a seal that throws is reported through onDiskWriteError and does not take the tick down', () => {
    const storage = createInMemoryChunkStorage();
    const onDiskWriteError = vi.fn();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: createDiskPressure(),
      onDiskWriteError,
    });
    storage.write = () => {
      throw new Error('cannot seal');
    };
    expect(() => store.tick(2000)).not.toThrow();
    expect(onDiskWriteError).toHaveBeenCalled(); // the seal and the next part's meta both failed
    store.add(rec('traces.system', 2001));
  });

  it('a seal that throws with no owner of reporting is swallowed too', () => {
    const storage = createInMemoryChunkStorage();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: createDiskPressure(),
    });
    storage.write = () => {
      throw new Error('cannot seal');
    };
    expect(() => store.tick(2000)).not.toThrow();
  });

  it('a probe that throws with no owner of reporting is swallowed too', () => {
    const storage = createInMemoryChunkStorage();
    const pressure = createDiskPressure();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: pressure,
    });
    pressure.noteWriteError({ code: 'ENOSPC' });
    storage.write = () => {
      throw new Error('still full');
    };
    expect(() => store.tick(2000)).not.toThrow();
  });

  it('a durable openPart that throws is swallowed, does not mark the part opened, and the first durable write retries it', () => {
    const storage = createInMemoryChunkStorage();
    const durable = createFileChunkBackend(storage, { generation: 1 });
    const open = vi.spyOn(durable, 'openPart');
    open.mockImplementationOnce(() => {
      throw new Error('open failed');
    });
    const backend = withDiskPressure(durable, createDiskPressure());
    expect(() => backend.openPart({ generation: 1, number: 0 }, 5)).not.toThrow();
    backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('with nobody owning reporting, a durable open that throws on the first write keeps the record and rethrows', () => {
    const durable = createFileChunkBackend(createInMemoryChunkStorage(), { generation: 1 });
    const backend = withDiskPressure(durable, createDiskPressure());
    backend.openPart({ generation: 1, number: 0 }, 5);
    vi.spyOn(durable, 'openPart').mockImplementation(() => {
      throw new Error('open failed');
    });
    // a part the backend never opened (its meta write was refused): force the lazy path
    backend.openPart({ generation: 1, number: 1 }, 6);
    expect(() => backend.appendEntry({ generation: 1, number: 1 }, rec('log', 2))).toThrow(
      'open failed',
    );
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

describe('withDiskPressure — a durable half that cannot be read', () => {
  const failingRead = (): ChunkBackend => {
    const memory = createMemoryChunkBackend({ generation: 1 });
    return {
      ...memory,
      snapshot: (parts) => {
        const snap = memory.snapshot(parts);
        return {
          ...snap,
          drainAll: () =>
            Promise.reject(Object.assign(new Error('closing'), { name: 'InvalidStateError' })),
          stream: async function* () {
            yield* [] as StoredEntry[];
            throw new Error('closing');
          },
        };
      },
    };
  };

  it('serves the in-memory half and reports ONCE per snapshot when the durable read fails (a live report survives the disk)', async () => {
    const onReadError = vi.fn();
    const pressure = createDiskPressure();
    const backend = withDiskPressure(failingRead(), pressure, { onReadError });
    pressure.observe(30 * MB);
    backend.openPart({ generation: 1, number: 0 }, 0);
    backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1, 'in-memory'));
    backend.appendEntry({ generation: 1, number: 0 }, rec('traces.system', 2, 'on-disk'));
    const snap = backend.snapshot([{ ref: { generation: 1, number: 0 }, count: 2 }]);
    const all = await snap.drainAll();
    expect(names(all.get('log'))).toEqual(['in-memory']);
    expect(all.has('traces.system')).toBe(false);
    expect(onReadError).toHaveBeenCalledOnce();
    expect(onReadError.mock.calls[0]?.[0]).toMatchObject({ name: 'InvalidStateError' });
  });

  it('after the FIRST part fails to read, the other parts of that SNAPSHOT are not waited on again (reported once)', async () => {
    let reads = 0;
    const memory = createMemoryChunkBackend({ generation: 1 });
    const durable: ChunkBackend = {
      ...memory,
      snapshot: (parts) => ({
        ...memory.snapshot(parts),
        drainAll: () => {
          reads += 1;
          return Promise.reject(new Error('closing'));
        },
      }),
    };
    const onReadError = vi.fn();
    const pressure = createDiskPressure();
    const backend = withDiskPressure(durable, pressure, { onReadError });
    pressure.observe(30 * MB);
    const frozen = [0, 1, 2, 3].map((n) => ({ ref: { generation: 1, number: n }, count: 1 }));
    for (const { ref } of frozen) {
      backend.openPart(ref, 0);
      backend.appendEntry(ref, rec('log', ref.number, `mem-${ref.number}`));
    }
    const all = await backend.snapshot(frozen).drainAll();
    expect(reads).toBe(1);
    expect(onReadError).toHaveBeenCalledOnce();
    expect(names(all.get('log'))).toEqual(['mem-0', 'mem-1', 'mem-2', 'mem-3']); // every in-memory record is still served
    const again = await backend.snapshot(frozen).drainAll(); // a NEW snapshot tries the medium again, at once
    expect(reads).toBe(2);
    expect(again.get('log')).toHaveLength(4);
    expect(onReadError).toHaveBeenCalledOnce(); // the same streak: reported once, not once per snapshot
  });

  it('the fast path (nothing shadowed) is guarded too: an unreadable disk yields an empty window, not a thrown report', async () => {
    const onReadError = vi.fn();
    const backend = withDiskPressure(failingRead(), createDiskPressure(), { onReadError });
    backend.openPart({ generation: 1, number: 0 }, 0);
    backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1));
    const snap = backend.snapshot([{ ref: { generation: 1, number: 0 }, count: 1 }]);
    expect((await snap.drainAll()).size).toBe(0);
    expect(onReadError).toHaveBeenCalledOnce();
  });

  it('stream() is guarded as well, and release() is delegated', async () => {
    const onReadError = vi.fn();
    const backend = withDiskPressure(failingRead(), createDiskPressure(), { onReadError });
    backend.openPart({ generation: 1, number: 0 }, 0);
    backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1));
    const snap = backend.snapshot([{ ref: { generation: 1, number: 0 }, count: 1 }]);
    const seen: string[] = [];
    for await (const r of snap.stream()) seen.push(r.serialized);
    expect(seen).toEqual([]);
    expect(onReadError).toHaveBeenCalledOnce();
    expect(() => snap.release()).not.toThrow();
  });

  it('without a callback the failure is swallowed the same way, and the store forwards onDiskReadError', async () => {
    const backend = withDiskPressure(failingRead(), createDiskPressure());
    backend.openPart({ generation: 1, number: 0 }, 0);
    backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1));
    expect(
      (await backend.snapshot([{ ref: { generation: 1, number: 0 }, count: 1 }]).drainAll()).size,
    ).toBe(0);
    const onDiskReadError = vi.fn();
    const store = createChunkCaptureStore(failingRead(), {
      clock: clockAt(1000),
      diskPressure: createDiskPressure(),
      onDiskReadError,
    });
    store.add(rec('log', 1));
    await store.snapshot().drainAll();
    expect(onDiskReadError).toHaveBeenCalledOnce();
    const fileStore = createFileCaptureStore(createInMemoryChunkStorage(), {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: createDiskPressure(),
      onDiskReadError,
    });
    expect(fileStore).toBeDefined();
  });
});

/** A file-backed store whose backend has NO `probeWrite` (like IndexedDB): the gate probes with a throwaway part. */
function throwawayProbeStore(
  storage: ReturnType<typeof createInMemoryChunkStorage>,
  options: Parameters<typeof createChunkCaptureStore>[1],
) {
  const file = createFileChunkBackend(storage, { generation: 1 });
  const { probeWrite: _omit, ...withoutProbeWrite } = file;
  return createChunkCaptureStore(withoutProbeWrite as ChunkBackend, options);
}

describe('withDiskPressure — the probe backs off instead of flapping', () => {
  const PROBE = 2_000_000_000;
  const rig = () => {
    const storage = createInMemoryChunkStorage();
    const pressure = createDiskPressure();
    const onDiskWriteError = vi.fn();
    const store = throwawayProbeStore(storage, {
      clock: clockAt(1000),
      diskPressure: pressure,
      onDiskWriteError,
    });
    let probes = 0;
    const append = storage.append.bind(storage);
    storage.append = (g, c, f, d) => {
      if (c === PROBE) probes += 1; // the probe's DATA record: one per probe
      append(g, c, f, d);
    };
    let t = 1000;
    const tick = (n = 1): void => {
      for (let i = 0; i < n; i++) {
        t += 1000;
        store.tick(t);
      }
    };
    return { storage, pressure, store, tick, probes: () => probes, onDiskWriteError };
  };
  const pin = (p: ReturnType<typeof createDiskPressure>): void =>
    void p.noteWriteError({ code: 'ENOSPC' });

  it('probes on the very next tick after a fresh pin, then every tick while it holds (interval 1)', () => {
    const r = rig();
    pin(r.pressure);
    r.tick(3);
    expect(r.probes()).toBe(3);
  });

  it('a pin right after a release (a flap) doubles the interval: 1, 2, 4, ... and never probes faster again', () => {
    const r = rig();
    const probesAfter: number[] = [];
    for (let flap = 0; flap < 4; flap++) {
      pin(r.pressure);
      const before = r.probes();
      r.tick(12);
      probesAfter.push(r.probes() - before);
      r.pressure.noteWriteRecovered(); // the probe "succeeded" and released the pin
      r.tick(1);
    }
    // interval 1 -> 12 probes in 12 ticks; then 2 -> 6; then 4 -> 3; then 8 -> 1 (the next one is past the window)
    expect(probesAfter).toEqual([12, 6, 3, 1]);
  });

  it('the probe is a DATA record as large as the biggest recent record (clamped 1 KiB..256 KiB), sealed and removed', () => {
    const sizes: number[] = [];
    const r = rig();
    const append = r.storage.append.bind(r.storage);
    r.storage.append = (g, c, f, d) => {
      if (c === PROBE) sizes.push(d.length);
      append(g, c, f, d);
    };
    pin(r.pressure);
    r.tick(1);
    expect(sizes.at(-1)).toBe(1024 + '0\t\n'.length); // nothing seen yet: the 1 KiB floor
    r.store.add(rec('replay', 5, 'r'.repeat(5000)));
    r.tick(1);
    expect(sizes.at(-1)).toBe(5000 + '0\t\n'.length);
    r.store.add(rec('replay', 6, 'r'.repeat(900_000)));
    r.tick(1);
    expect(sizes.at(-1)).toBe(256 * 1024 + '0\t\n'.length); // clamped
    expect(r.storage.chunks(1)).not.toContain(PROBE);
  });

  it('the remembered record size halves every 60 ticks, so one huge record does not size the probe forever', () => {
    const sizes: number[] = [];
    const r = rig();
    const append = r.storage.append.bind(r.storage);
    r.storage.append = (g, c, f, d) => {
      if (c === PROBE) sizes.push(d.length);
      append(g, c, f, d);
    };
    r.store.add(rec('replay', 5, 'r'.repeat(40_000)));
    r.tick(60); // the 60th tick halves it: 20000
    pin(r.pressure);
    r.tick(1);
    expect(sizes.at(-1)).toBe(20_000 + '0\t\n'.length);
  });

  it('the interval is capped at 60 ticks', () => {
    const r = rig();
    for (let flap = 0; flap < 12; flap++) {
      pin(r.pressure);
      r.tick(1);
      r.pressure.noteWriteRecovered();
    }
    pin(r.pressure);
    const before = r.probes();
    r.tick(120);
    expect(r.probes() - before).toBe(2); // at most one probe per 60 ticks
  });

  it('a pin that follows a LONG healthy stretch starts again at interval 1', () => {
    const r = rig();
    for (let flap = 0; flap < 3; flap++) {
      pin(r.pressure);
      r.tick(1);
      r.pressure.noteWriteRecovered();
    }
    r.tick(30); // healthy for a long time
    pin(r.pressure);
    const before = r.probes();
    r.tick(3);
    expect(r.probes() - before).toBe(3);
  });

  it('the flap window is inclusive: a pin exactly 10 ticks after the release still counts, 11 does not', () => {
    const exact = rig();
    pin(exact.pressure);
    exact.tick(1);
    exact.pressure.noteWriteRecovered();
    exact.tick(10);
    pin(exact.pressure); // 10 ticks after the release: a flap -> interval 2
    const before = exact.probes();
    exact.tick(2);
    expect(exact.probes() - before).toBe(1);
    const late = rig();
    pin(late.pressure);
    late.tick(1);
    late.pressure.noteWriteRecovered();
    late.tick(11);
    pin(late.pressure); // 11 ticks: not a flap -> interval 1
    const b2 = late.probes();
    late.tick(2);
    expect(late.probes() - b2).toBe(2);
  });

  it('a probe the medium keeps refusing is reported ONCE per pin, not once per tick, and again after a re-pin', () => {
    const r = rig();
    const realWrite = r.storage.write.bind(r.storage);
    r.storage.write = (g, c, f, d) => {
      if (c === PROBE) throw new Error('still full'); // only the probe is refused: real parts open and seal fine
      realWrite(g, c, f, d);
    };
    pin(r.pressure);
    r.tick(5);
    const fromProbe = (): number =>
      r.onDiskWriteError.mock.calls.filter((c) => (c[0] as Error).message === 'still full').length;
    const first = fromProbe();
    expect(first).toBe(1);
    r.tick(5);
    expect(fromProbe()).toBe(first); // nothing new while the same pin holds
    r.pressure.noteWriteRecovered();
    r.tick(11); // a long healthy stretch, then the disk refuses again
    pin(r.pressure);
    r.tick(3);
    expect(fromProbe()).toBeGreaterThan(first); // a new pin is a new episode: it is reported again
  });
});

describe('withDiskPressure — a SLOW but healthy durable read is not mistaken for a dead one', () => {
  it('a read that completes after 12 s (a slow device with a long write queue) still returns its data and reports nothing', async () => {
    vi.useFakeTimers();
    try {
      const onReadError = vi.fn();
      const memory = createMemoryChunkBackend({ generation: 1 });
      const slow: ChunkBackend = {
        ...memory,
        snapshot: (parts) => {
          const snap = memory.snapshot(parts);
          return {
            ...snap,
            drainAll: () =>
              new Promise((resolve) => {
                (
                  globalThis as unknown as { setTimeout(cb: () => void, ms: number): void }
                ).setTimeout(() => resolve(snap.drainAll()), 12_000);
              }),
          };
        },
      };
      const backend = withDiskPressure(slow, createDiskPressure(), { onReadError });
      backend.openPart({ generation: 1, number: 0 }, 0);
      backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1, 'persisted'));
      const read = backend.snapshot([{ ref: { generation: 1, number: 0 }, count: 1 }]).drainAll();
      await vi.advanceTimersByTimeAsync(12_000);
      expect(names((await read).get('log'))).toEqual(['persisted']);
      expect(onReadError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withDiskPressure — a durable read that never answers', () => {
  const hanging = (): ChunkBackend => {
    const memory = createMemoryChunkBackend({ generation: 1 });
    return {
      ...memory,
      snapshot: (parts) => ({ ...memory.snapshot(parts), drainAll: () => new Promise(() => {}) }),
    };
  };

  it('counts as failed after the timeout, reports once, and serves the in-memory half (a report is not held hostage)', async () => {
    vi.useFakeTimers();
    try {
      const onReadError = vi.fn();
      const pressure = createDiskPressure();
      const backend = withDiskPressure(hanging(), pressure, { onReadError, readTimeoutMs: 1000 });
      pressure.observe(30 * MB);
      backend.openPart({ generation: 1, number: 0 }, 0);
      backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1, 'in-memory'));
      backend.appendEntry({ generation: 1, number: 0 }, rec('traces.system', 2, 'on-disk'));
      const read = backend.snapshot([{ ref: { generation: 1, number: 0 }, count: 2 }]).drainAll();
      await vi.advanceTimersByTimeAsync(999);
      expect(onReadError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const all = await read;
      expect(names(all.get('log'))).toEqual(['in-memory']);
      expect(onReadError).toHaveBeenCalledOnce();
      expect((onReadError.mock.calls[0]?.[0] as Error).message).toMatch(
        /did not answer a read in time/,
      );
      expect(vi.getTimerCount()).toBe(0); // the timer is cleared once settled
    } finally {
      vi.useRealTimers();
    }
  });

  it('a read that answers in time clears its timer and reports nothing; the default backstop is 30 s and the store forwards the override', async () => {
    vi.useFakeTimers();
    try {
      const onReadError = vi.fn();
      const backend = withDiskPressure(
        createMemoryChunkBackend({ generation: 1 }),
        createDiskPressure(),
        { onReadError },
      );
      backend.openPart({ generation: 1, number: 0 }, 0);
      backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1));
      await backend.snapshot([{ ref: { generation: 1, number: 0 }, count: 1 }]).drainAll();
      expect(vi.getTimerCount()).toBe(0);
      const hung = withDiskPressure(hanging(), createDiskPressure(), { onReadError });
      hung.openPart({ generation: 1, number: 0 }, 0);
      hung.appendEntry({ generation: 1, number: 0 }, rec('log', 1));
      const read = hung.snapshot([{ ref: { generation: 1, number: 0 }, count: 1 }]).drainAll();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(onReadError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await read;
      expect(onReadError).toHaveBeenCalledOnce();
      const store = createChunkCaptureStore(hanging(), {
        clock: clockAt(1000),
        diskPressure: createDiskPressure(),
        diskReadTimeoutMs: 100,
        onDiskReadError: onReadError,
      });
      store.add(rec('log', 1));
      const pending = store.snapshot().drainAll();
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(onReadError).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withDiskPressure — the probe on a backend that can write padding (the file backends)', () => {
  const PAD = (d: string): boolean => d.startsWith('#');
  const rig = () => {
    const storage = createInMemoryChunkStorage();
    const flushNow = vi.fn();
    (storage as { flushNow?: () => void }).flushNow = flushNow;
    const pressure = createDiskPressure();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: pressure,
      onDiskWriteError: vi.fn(),
    });
    const pads: Array<{ chunk: number; file: string; bytes: number }> = [];
    const append = storage.append.bind(storage);
    storage.append = (g, c, f, d) => {
      if (PAD(d)) pads.push({ chunk: c, file: f, bytes: d.length });
      append(g, c, f, d);
    };
    return { storage, pressure, store, pads, flushNow };
  };

  it('pads the part JUST OPENED by the tick (never the one being closed, never a throwaway one) in a file of its own, and clamps the size to 1..16 KiB', () => {
    const r = rig();
    r.pressure.noteWriteError({ code: 'ENOSPC' });
    r.store.tick(2000); // closes part 0, opens part 1, THEN probes: part 1 is padded
    expect(r.pads.at(-1)).toEqual({ chunk: 1, file: 'probe', bytes: 1024 }); // the 1 KiB floor
    r.store.tick(3000);
    expect(r.pads.at(-1)).toEqual({ chunk: 2, file: 'probe', bytes: 1024 });
    expect(r.pads.map((p) => p.chunk)).toEqual([1, 2]); // part 0 (closed by the first tick) was never padded
    expect(r.flushNow).toHaveBeenCalled();
    expect(r.storage.chunks(1).every((c) => c < 1000)).toBe(true); // no throwaway part exists
    r.store.add(rec('log', 5, 'r'.repeat(900_000)));
    r.store.tick(4000);
    expect(r.pads.at(-1)?.bytes).toBe(16 * 1024);
  });

  it('every part that was padded is SEALED when its turn comes: no meta is left claiming a part never ended', () => {
    const r = rig();
    r.pressure.noteWriteError({ code: 'ENOSPC' });
    for (let t = 2; t <= 12; t++) r.store.tick(t * 1000);
    const chunks = r.storage.chunks(1).sort((a, b) => a - b);
    const current = Math.max(...chunks);
    for (const c of chunks) {
      const meta = JSON.parse(r.storage.read(1, c, 'meta') as string) as { e: number | null };
      if (c === current)
        expect(meta.e).toBeNull(); // the open part is the only one still open
      else expect(meta.e, `part ${c}`).not.toBeNull();
    }
  });

  it('the padding leaves no residue: a snapshot returns the real records only, and a recovery-style read skips it', async () => {
    const r = rig();
    r.store.add(rec('log', 1, 'real-1'));
    r.pressure.noteWriteError({ code: 'ENOSPC' });
    r.store.tick(2000);
    r.store.tick(3000);
    r.pressure.noteWriteRecovered();
    r.store.add(rec('log', 4, 'real-2'));
    expect(names((await drain(r.store)).get('log'))).toEqual(['real-1', 'real-2']);
    const reborn = createFileChunkBackend(r.storage, {
      generation: 1,
      cleanOtherGenerations: false,
    });
    const parts = (await reborn.listParts(1)).map((p) => ({
      ref: { generation: 1, number: p.number },
      count: 99,
    }));
    const all = await reborn.snapshot(parts).drainAll();
    expect(names(all.get('log'))).toEqual(['real-1', 'real-2']);
  });

  it('opens the part the medium never saw before padding it, and works with a storage that has neither appendNow nor flushNow', () => {
    const storage = createInMemoryChunkStorage();
    const pressure = createDiskPressure();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: pressure,
    });
    pressure.observe(5 * MB); // none: the next part is opened without a meta
    store.tick(2000);
    expect(storage.chunks(1)).toEqual([0]);
    pressure.noteWriteError({ code: 'ENOSPC' });
    store.tick(3000); // closes part 1 (never opened on disk) and opens part 2, which is padded (and so gets its meta)
    expect(storage.chunks(1)).toContain(2);
    expect(storage.read(1, 2, 'meta')).toBeDefined(); // opened under a pin: meta first, then the padding
    expect(storage.read(1, 1, 'meta')).toBeUndefined(); // the part being closed was NOT created just to be padded
  });

  it('a padding write that throws is reported once per pin', () => {
    const r = rig();
    const onDiskWriteError = vi.fn();
    const storage = createInMemoryChunkStorage();
    const pressure = createDiskPressure();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: pressure,
      onDiskWriteError,
    });
    const append = storage.append.bind(storage);
    storage.append = (g, c, f, d) => {
      if (PAD(d)) throw new Error('still full');
      append(g, c, f, d);
    };
    pressure.noteWriteError({ code: 'ENOSPC' });
    for (let t = 2; t < 8; t++) store.tick(t * 1000);
    expect(
      onDiskWriteError.mock.calls.filter((c) => (c[0] as Error).message === 'still full'),
    ).toHaveLength(1);
    void r;
  });

  it('pin episodes are tracked by the PIN, not by level changes: with the reading already none each episode reports again', () => {
    const storage = createInMemoryChunkStorage();
    const pressure = createDiskPressure();
    const onDiskWriteError = vi.fn();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: pressure,
      onDiskWriteError,
    });
    const append = storage.append.bind(storage);
    storage.append = (g, c, f, d) => {
      if (PAD(d)) throw new Error('still full');
      append(g, c, f, d);
    };
    pressure.observe(5 * MB); // the size reading says none for the whole test
    const reports = (): number =>
      onDiskWriteError.mock.calls.filter((c) => (c[0] as Error).message === 'still full').length;
    let t = 1000;
    const tick = (n: number): void => {
      for (let i = 0; i < n; i++) {
        t += 1000;
        store.tick(t);
      }
    };
    const seen: number[] = [];
    for (let episode = 0; episode < 3; episode++) {
      pressure.noteWriteError({ code: 'ENOSPC' });
      tick(3);
      pressure.noteWriteRecovered();
      tick(12);
      seen.push(reports());
    }
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('withDiskPressure — an unreadable medium serves what the backend still holds in memory', () => {
  const held = (): Map<FileType, StoredEntry[]> =>
    new Map([['log' as FileType, [rec('log', 1, 'queued')]]]);
  const failing = (
    extra: Partial<CaptureSnapshot> = {},
  ): { backend: ChunkBackend; released: () => number } => {
    const memory = createMemoryChunkBackend({ generation: 1 });
    let released = 0;
    const backend: ChunkBackend = {
      ...memory,
      snapshot: (parts) => ({
        ...memory.snapshot(parts),
        drainAll: () => Promise.reject(new Error('closing')),
        release: () => {
          released += 1;
        },
        ...extra,
      }),
    };
    return { backend, released: () => released };
  };

  it("serves the snapshot's inMemory() records, and releases the abandoned read (its pins and references)", async () => {
    const f = failing({ inMemory: held });
    const onReadError = vi.fn();
    const backend = withDiskPressure(f.backend, createDiskPressure(), { onReadError });
    backend.openPart({ generation: 1, number: 0 }, 0);
    backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1));
    const all = await backend
      .snapshot([{ ref: { generation: 1, number: 0 }, count: 1 }])
      .drainAll();
    expect(names(all.get('log'))).toEqual(['queued']);
    expect(f.released()).toBeGreaterThanOrEqual(1);
    expect(onReadError).toHaveBeenCalledOnce();
  });

  it('serves inMemory() immediately while the medium is known dead (no waiting, no second report), and exposes it on the guarded snapshot', async () => {
    const f = failing({ inMemory: held });
    const onReadError = vi.fn();
    const backend = withDiskPressure(f.backend, createDiskPressure(), { onReadError });
    backend.openPart({ generation: 1, number: 0 }, 0);
    backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1));
    const frozen = [{ ref: { generation: 1, number: 0 }, count: 1 }];
    await backend.snapshot(frozen).drainAll();
    const second = backend.snapshot(frozen);
    expect(names((await second.drainAll()).get('log'))).toEqual(['queued']);
    expect(onReadError).toHaveBeenCalledOnce();
    expect(names(second.inMemory?.().get('log'))).toEqual(['queued']);
  });

  it('a snapshot without inMemory() serves nothing from the medium, and inMemory is not invented for it', async () => {
    const f = failing();
    const backend = withDiskPressure(f.backend, createDiskPressure());
    backend.openPart({ generation: 1, number: 0 }, 0);
    backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1));
    const snap = backend.snapshot([{ ref: { generation: 1, number: 0 }, count: 1 }]);
    expect((await snap.drainAll()).size).toBe(0);
    expect(snap.inMemory).toBeUndefined();
  });
});

describe('withDiskPressure — a transient read failure must not hide what the medium holds (no dead window)', () => {
  /** A durable backend whose reads can be switched between failing, hanging and healthy. */
  function flaky() {
    const memory = createMemoryChunkBackend({ generation: 1 });
    const state: { mode: 'ok' | 'fail' | 'hang'; reads: number } = { mode: 'ok', reads: 0 };
    const durable: ChunkBackend = {
      ...memory,
      snapshot: (parts) => {
        const snap = memory.snapshot(parts);
        return {
          ...snap,
          drainAll: () => {
            state.reads += 1;
            if (state.mode === 'fail') {
              return Promise.reject(
                Object.assign(new Error('closing'), { name: 'InvalidStateError' }),
              );
            }
            return state.mode === 'hang' ? new Promise(() => {}) : snap.drainAll();
          },
        };
      },
    };
    return { durable, state };
  }
  const logsOf = async (b: ChunkBackend, n: number): Promise<string[]> =>
    names(
      (await b.snapshot([{ ref: { generation: 1, number: 0 }, count: n }]).drainAll()).get('log'),
    );

  it('serves EVERY landed record again at the very next snapshot once the medium answers (the old 60-tick skip hid them)', async () => {
    const { durable, state } = flaky();
    const onReadError = vi.fn();
    const backend = withDiskPressure(durable, createDiskPressure(), { onReadError });
    backend.openPart({ generation: 1, number: 0 }, 0);
    const ref = { generation: 1, number: 0 };
    backend.appendEntry(ref, rec('log', 1, 'a'));
    state.mode = 'fail';
    expect(await logsOf(backend, 1)).toEqual([]); // the medium is unreadable: nothing from it
    state.mode = 'ok';
    backend.appendEntry(ref, rec('log', 2, 'b')); // lands while the medium is healthy again
    for (let tick = 0; tick < 62; tick++) {
      backend.closePart(ref, 1, 0);
      if (tick === 0 || tick === 29 || tick === 58 || tick === 61) {
        expect(await logsOf(backend, 2), `tick ${tick}`).toEqual(['a', 'b']);
      }
    }
    expect(onReadError).toHaveBeenCalledOnce();
  });

  it('reports ONCE per streak of failures across snapshots, and again after a read succeeded in between', async () => {
    const { durable, state } = flaky();
    const onReadError = vi.fn();
    const backend = withDiskPressure(durable, createDiskPressure(), { onReadError });
    backend.openPart({ generation: 1, number: 0 }, 0);
    backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1));
    state.mode = 'fail';
    for (let i = 0; i < 3; i++) await logsOf(backend, 1);
    expect(onReadError).toHaveBeenCalledTimes(1);
    state.mode = 'ok';
    await logsOf(backend, 1);
    state.mode = 'fail';
    await logsOf(backend, 1);
    expect(onReadError).toHaveBeenCalledTimes(2);
  });

  it('while degraded each snapshot waits at most 2 s for the medium; a healthy one is given the full backstop', async () => {
    vi.useFakeTimers();
    try {
      const { durable, state } = flaky();
      const onReadError = vi.fn();
      const backend = withDiskPressure(durable, createDiskPressure(), { onReadError });
      backend.openPart({ generation: 1, number: 0 }, 0);
      backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1, 'a'));
      const snap = () =>
        backend.snapshot([{ ref: { generation: 1, number: 0 }, count: 1 }]).drainAll();
      state.mode = 'hang';
      const first = snap();
      await vi.advanceTimersByTimeAsync(29_999); // not yet degraded: the full 30 s backstop applies
      expect(onReadError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await first;
      expect(onReadError).toHaveBeenCalledOnce();
      const second = snap(); // degraded: 2 s
      await vi.advanceTimersByTimeAsync(1999);
      let done = false;
      void second.then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(onReadError).toHaveBeenCalledOnce(); // same streak
      state.mode = 'ok'; // the medium is back: the next snapshot gets its data at once
      expect(names((await snap()).get('log'))).toEqual(['a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a configured readTimeoutMs below 2 s still wins while degraded', async () => {
    vi.useFakeTimers();
    try {
      const { durable, state } = flaky();
      const backend = withDiskPressure(durable, createDiskPressure(), {
        readTimeoutMs: 100,
        onReadError: () => {},
      });
      backend.openPart({ generation: 1, number: 0 }, 0);
      backend.appendEntry({ generation: 1, number: 0 }, rec('log', 1));
      state.mode = 'hang';
      const snap = () =>
        backend.snapshot([{ ref: { generation: 1, number: 0 }, count: 1 }]).drainAll();
      const first = snap();
      await vi.advanceTimersByTimeAsync(100);
      await first;
      const second = snap();
      await vi.advanceTimersByTimeAsync(100);
      await second; // resolved at 100 ms, not 2 s
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withDiskPressure — a probe that cannot land its meta leaves nothing and is retried', () => {
  it('when the meta write only REPORTS its failure, the part is not padded, its empty directory is removed, and the next durable write recreates the meta', () => {
    const storage = createInMemoryChunkStorage();
    const pressure = createDiskPressure();
    const onDiskWriteError = vi.fn();
    let refuseMeta = false;
    const write = storage.write.bind(storage);
    // like the batched / ring writers: a failed meta write creates the directory, reports, and does not throw
    storage.write = (g, c, f, d) => {
      if (refuseMeta && f === 'meta') {
        storage.append(g, c, 'zz-scaffold', '');
        storage.removeChunk(g, c);
        storage.append(g, c, 'scaffold', ''); // the directory exists, the meta does not
        return;
      }
      write(g, c, f, d);
    };
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: pressure,
      onDiskWriteError,
    });
    refuseMeta = true;
    pressure.noteWriteError({ code: 'ENOSPC' });
    store.tick(2000); // opens part 1 under a pin (no meta), probe due: its meta write 'fails' silently
    expect(storage.read(1, 1, 'probe')).toBeUndefined(); // never padded
    expect(storage.chunks(1)).not.toContain(1); // the empty directory is gone
    expect(
      onDiskWriteError.mock.calls.some((c) =>
        /no meta on the medium/.test(String((c[0] as Error).message)),
      ),
    ).toBe(true);
    refuseMeta = false;
    pressure.noteWriteRecovered();
    store.add(rec('traces.system', 2500, 'real'));
    expect(storage.read(1, 1, 'meta')).toBeDefined(); // the first durable write re-opened the part
    expect(storage.read(1, 1, 'traces.system')).toBe('2500\treal\n');
  });
});
