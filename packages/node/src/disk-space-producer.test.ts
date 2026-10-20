import { resetStorageTracker, type StatFs, storageTrackerFor } from '@bugsee/trackers/node';
import { afterEach, describe, expect, it } from 'vitest';
import { createDiskSpaceProducer } from './disk-space-producer';

const keys: object[] = [];
afterEach(() => {
  for (const k of keys.splice(0)) resetStorageTracker(k);
});

const flush = () => new Promise<void>((r) => setImmediate(r));

function setup(statfs: StatFs, over: { intervalMs?: number } = {}) {
  const key = {};
  keys.push(key);
  const handles: unknown[] = [];
  let tick: (() => void) | undefined;
  const producer = createDiskSpaceProducer({
    key,
    dataDir: '/var/bugsee',
    statfs,
    scheduler: {
      setInterval: (cb) => {
        tick = cb;
        handles.push(cb);
        return handles.length;
      },
      clearInterval: () => void handles.pop(),
    },
    ...over,
  });
  const calls: Array<[string, unknown, unknown?]> = [];
  const sink = {
    emit: (n: string, v: unknown, _d?: number, o?: unknown) => void calls.push([n, v, o]),
  };
  return { producer, sink, calls, key, handles, tick: () => tick?.() };
}

describe('createDiskSpaceProducer (composition over the StorageTracker)', () => {
  it('attaches nothing until start(), then maps the tracker stage to integer-MB traces (free then total)', async () => {
    const paths: string[] = [];
    const s = setup(async (p) => {
      paths.push(p);
      return { bsize: 4096, bavail: 300 * 256 + 100, blocks: 1000 * 256 + 5 };
    });
    expect(paths).toEqual([]);
    expect(s.handles).toHaveLength(0);
    s.producer.start(s.sink);
    await flush();
    expect(paths).toEqual(['/var/bugsee']);
    expect(s.calls.map(([n, v]) => [n, v])).toEqual([
      ['disk_mem_free', 300],
      ['disk_mem_total', 1000],
    ]);
  });

  it('is POLLED, not held: every poll emits with hold:false', async () => {
    let free = 10 * 256;
    const s = setup(async () => ({ bsize: 4096, bavail: free, blocks: 100 * 256 }));
    s.producer.start(s.sink);
    await flush();
    free = 9 * 256;
    s.tick();
    await flush();
    expect(s.calls.map(([n, v]) => [n, v])).toEqual([
      ['disk_mem_free', 10],
      ['disk_mem_total', 100],
      ['disk_mem_free', 9],
      ['disk_mem_total', 100],
    ]);
    expect(s.calls.every(([, , o]) => (o as { hold?: boolean })?.hold === false)).toBe(true);
  });

  it('a full disk is a true 0 MB free; an unreadable volume emits nothing (gap, never a stale or zero value)', async () => {
    let next: 'full' | 'fail' = 'full';
    const s = setup(async () => {
      if (next === 'fail') throw new Error('EIO');
      return { bsize: 4096, bavail: 0, blocks: 256 * 10 };
    });
    s.producer.start(s.sink);
    await flush();
    expect(s.calls.map(([n, v]) => [n, v])).toEqual([
      ['disk_mem_free', 0],
      ['disk_mem_total', 10],
    ]);
    next = 'fail';
    s.tick();
    await flush();
    expect(s.calls).toHaveLength(2);
  });

  it('stop() unsubscribes (the tracker releases its timer); a restart reads and emits again', async () => {
    const s = setup(async () => ({ bsize: 4096, bavail: 256, blocks: 512 }));
    s.producer.start(s.sink);
    await flush();
    expect(s.handles).toHaveLength(1);
    s.producer.stop();
    expect(s.handles).toHaveLength(0);
    s.producer.start(s.sink);
    await flush();
    expect(s.calls).toHaveLength(4);
  });

  it('stop() before start() is harmless', () => {
    const s = setup(async () => ({ bsize: 1, bavail: 1, blocks: 1 }));
    expect(() => s.producer.stop()).not.toThrow();
  });

  it('shares the per-process tracker: building a producer hands it the data dir and onError (latest wins)', async () => {
    const key = {};
    keys.push(key);
    const errors: unknown[] = [];
    createDiskSpaceProducer({
      key,
      dataDir: '/first',
      statfs: async () => {
        throw new Error('boom');
      },
      scheduler: { setInterval: () => 1, clearInterval: () => {} },
      onError: (e) => errors.push(e),
    });
    const paths: string[] = [];
    const second = createDiskSpaceProducer({
      key,
      dataDir: '/second',
      statfs: async (p) => {
        paths.push(p);
        return { bsize: 1, bavail: 1, blocks: 1 };
      },
    });
    second.start({ emit() {} });
    await flush();
    expect(paths).toEqual(['/second']);
    expect(storageTrackerFor({ key }).current()?.totalBytes).toBe(1);
    second.stop();
  });

  it('reads the real filesystem by default (the data dir volume)', async () => {
    const key = {};
    keys.push(key);
    const calls: Array<[string, unknown]> = [];
    const p = createDiskSpaceProducer({
      key,
      dataDir: process.cwd(),
      scheduler: { setInterval: () => 1, clearInterval: () => {} },
    });
    p.start({ emit: (n, v) => void calls.push([n, v]) });
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    p.stop();
    const total = calls.find(([n]) => n === 'disk_mem_total')?.[1];
    const free = calls.find(([n]) => n === 'disk_mem_free')?.[1];
    expect(Number.isInteger(total) && (total as number) > 0).toBe(true);
    expect(Number.isInteger(free) && (free as number) <= (total as number)).toBe(true);
  });
});
