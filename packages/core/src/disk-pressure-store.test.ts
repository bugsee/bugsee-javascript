import type { FileType } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { ChunkBackend } from './chunk-backend';
import { createChunkCaptureStore } from './chunk-capture-store';
import { createInMemoryChunkStorage } from './chunk-storage';
import type { Clock } from './clock';
import type { CaptureStore, StoredEntry } from './contracts';
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

  it('while PINNED each tick probes the medium with a throwaway part, and the probe leaves nothing behind', () => {
    const storage = createInMemoryChunkStorage();
    const pressure = createDiskPressure();
    const store = createFileCaptureStore(storage, {
      clock: clockAt(1000),
      generation: 1,
      diskPressure: pressure,
    });
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
