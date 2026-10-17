import type { Scheduler } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import { createDiskSpaceProducer, type StatFs } from './disk-space-producer';

function fakeScheduler() {
  let cb: (() => void) | undefined;
  const live = new Set<unknown>();
  let n = 0;
  const scheduler: Scheduler = {
    setInterval: (c) => {
      cb = c;
      n += 1;
      const h = { id: n };
      live.add(h);
      return h;
    },
    clearInterval: (h) => {
      expect(live.has(h)).toBe(true);
      live.delete(h);
    },
  };
  return { scheduler, tick: () => cb?.(), live: () => live.size };
}

type Sample = { bsize: number; bavail: number; blocks: number };
const mkStat = (sample: () => Sample | Error): { statfs: StatFs; paths: string[] } => {
  const paths: string[] = [];
  return {
    paths,
    statfs: async (path) => {
      paths.push(path);
      const s = sample();
      if (s instanceof Error) throw s;
      return s;
    },
  };
};
const flush = () => new Promise<void>((r) => setImmediate(r));

function run(
  sample: () => Sample | Error,
  over: { dataDir?: string; statfs?: StatFs | null } = {},
) {
  const fs = fakeScheduler();
  const stat = mkStat(sample);
  const calls: Array<[string, unknown, { hold?: boolean } | undefined]> = [];
  const errors: unknown[] = [];
  const producer = createDiskSpaceProducer({
    dataDir: over.dataDir ?? '/data',
    ...(over.statfs === null ? {} : { statfs: over.statfs ?? stat.statfs }),
    scheduler: fs.scheduler,
    onError: (e) => errors.push(e),
  });
  const sink = {
    emit: (n: string, v: unknown, _d?: number, o?: { hold?: boolean }) =>
      void calls.push([n, v, o]),
  };
  return { producer, sink, calls, errors, fs, stat };
}
const names = (calls: Array<[string, unknown, unknown]>) => calls.map(([n, v]) => [n, v] as const);

describe('createDiskSpaceProducer', () => {
  it('attaches nothing until start()', () => {
    const r = run(() => ({ bsize: 4096, bavail: 1, blocks: 2 }));
    expect(r.fs.live()).toBe(0);
    expect(r.stat.paths).toEqual([]);
  });

  it('reads the dataDir volume at start and emits binary integer MB: free = bsize*bavail, total = bsize*blocks', async () => {
    const r = run(() => ({ bsize: 4096, bavail: 300 * 256 + 100, blocks: 1000 * 256 + 5 }), {
      dataDir: '/var/bugsee',
    });
    r.producer.start(r.sink);
    await flush();
    expect(r.stat.paths).toEqual(['/var/bugsee']);
    expect(names(r.calls)).toEqual([
      ['disk_mem_free', 300],
      ['disk_mem_total', 1000],
    ]);
  });

  it('is POLLED, not held: every read emits, and a read that later fails leaves a gap instead of a frozen value', async () => {
    let free = 10 * 256;
    const r = run(() => ({ bsize: 4096, bavail: free, blocks: 100 * 256 }));
    r.producer.start(r.sink);
    await flush();
    free = 9 * 256;
    r.fs.tick();
    await flush();
    expect(names(r.calls)).toEqual([
      ['disk_mem_free', 10],
      ['disk_mem_total', 100],
      ['disk_mem_free', 9],
      ['disk_mem_total', 100],
    ]);
    // hold:false = the provider never re-records it, so a failing statfs cannot leave a stale value in the window
    expect(r.calls.every(([, , o]) => o?.hold === false)).toBe(true);
  });

  it('a full disk is a true 0 MB free, not an omission', async () => {
    const r = run(() => ({ bsize: 4096, bavail: 0, blocks: 256 * 10 }));
    r.producer.start(r.sink);
    await flush();
    expect(names(r.calls)).toEqual([
      ['disk_mem_free', 0],
      ['disk_mem_total', 10],
    ]);
  });

  it('omits both traces when the reading is not sane (never a fabricated 0)', async () => {
    for (const bad of [
      { bsize: 0, bavail: 5, blocks: 5 },
      { bsize: 4096, bavail: Number.NaN, blocks: 5 },
      { bsize: 4096, bavail: -1, blocks: 5 },
      { bsize: 4096, bavail: 5, blocks: 0 },
      { bsize: 4096, bavail: 5, blocks: Number.POSITIVE_INFINITY },
      { bsize: Number.NaN, bavail: 5, blocks: 5 },
      { bsize: Number.POSITIVE_INFINITY, bavail: 5, blocks: 5 },
      { bsize: 4096, bavail: Number.POSITIVE_INFINITY, blocks: 5 },
    ]) {
      const r = run(() => bad);
      r.producer.start(r.sink);
      await flush();
      expect(r.calls, JSON.stringify(bad)).toEqual([]);
      expect(r.errors).toEqual([]);
    }
  });

  it('a failing statfs is reported and omits only that reading; the next tick recovers', async () => {
    let fail = true;
    const r = run(() => (fail ? new Error('EIO') : { bsize: 4096, bavail: 256, blocks: 512 }));
    r.producer.start(r.sink);
    await flush();
    expect(r.calls).toEqual([]);
    expect((r.errors[0] as Error).message).toBe('EIO');
    fail = false;
    r.fs.tick();
    await flush();
    expect(names(r.calls)).toEqual([
      ['disk_mem_free', 1],
      ['disk_mem_total', 2],
    ]);
  });

  it('reports a failure streak once, and again after a recovery (no flood every 5 s)', async () => {
    let fail = true;
    const r = run(() => (fail ? new Error('ENOENT') : { bsize: 4096, bavail: 256, blocks: 512 }));
    r.producer.start(r.sink);
    await flush();
    for (let i = 0; i < 3; i++) {
      r.fs.tick();
      await flush();
    }
    expect(r.errors).toHaveLength(1);
    fail = false;
    r.fs.tick();
    await flush();
    fail = true;
    r.fs.tick();
    await flush();
    expect(r.errors).toHaveLength(2);
    r.producer.stop(); // a new session starts a new streak
    r.producer.start(r.sink);
    await flush();
    expect(r.errors).toHaveLength(3);
  });

  it('a read abandoned by stop() reports nothing when it fails afterwards (no restart needed)', async () => {
    let reject: (() => void) | undefined;
    const slow: StatFs = () =>
      new Promise((_resolve, rej) => {
        reject = () => rej(new Error('late'));
      });
    const r = run(() => ({ bsize: 1, bavail: 1, blocks: 1 }), { statfs: slow });
    r.producer.start(r.sink);
    r.producer.stop();
    reject?.();
    await flush();
    expect(r.errors).toEqual([]);
  });

  it('a synchronously throwing statfs is reported too, and onError is optional', async () => {
    const throwing: StatFs = () => {
      throw new Error('sync');
    };
    const r = run(() => ({ bsize: 1, bavail: 1, blocks: 1 }), { statfs: throwing });
    r.producer.start(r.sink);
    await flush();
    expect((r.errors[0] as Error).message).toBe('sync');

    const quiet = createDiskSpaceProducer({
      dataDir: '/d',
      statfs: throwing,
      scheduler: fakeScheduler().scheduler,
    });
    expect(() => quiet.start(r.sink)).not.toThrow();
    await flush();
  });

  it('never overlaps reads: a tick while one is in flight is skipped', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const slow: StatFs = (path) => {
      calls += 1;
      return new Promise((resolve) => {
        release = () => resolve({ bsize: 4096, bavail: 256, blocks: 512 });
        void path;
      });
    };
    const r = run(() => ({ bsize: 1, bavail: 1, blocks: 1 }), { statfs: slow });
    r.producer.start(r.sink);
    r.fs.tick();
    r.fs.tick();
    expect(calls).toBe(1);
    release?.();
    await flush();
    r.fs.tick();
    expect(calls).toBe(2);
  });

  it('a read that finishes after stop() emits nothing', async () => {
    let release: (() => void) | undefined;
    const slow: StatFs = () =>
      new Promise((resolve) => {
        release = () => resolve({ bsize: 4096, bavail: 256, blocks: 512 });
      });
    const r = run(() => ({ bsize: 1, bavail: 1, blocks: 1 }), { statfs: slow });
    r.producer.start(r.sink);
    r.producer.stop();
    release?.();
    await flush();
    expect(r.calls).toEqual([]);
  });

  it('stop() releases the timer; a restart reads again and re-emits (fresh dedupe state)', async () => {
    const r = run(() => ({ bsize: 4096, bavail: 256, blocks: 512 }));
    r.producer.start(r.sink);
    await flush();
    expect(r.fs.live()).toBe(1);
    r.producer.stop();
    expect(r.fs.live()).toBe(0);
    r.producer.start(r.sink);
    await flush();
    expect(r.calls).toHaveLength(4);
  });

  it('a read from before a stop never lands after a restart (value or error), and the restart reads afresh', async () => {
    const resolvers: Array<{ ok: () => void; fail: () => void }> = [];
    const sizes = [300, 7];
    let calls = 0;
    const slow: StatFs = () =>
      new Promise((resolve, reject) => {
        const size = sizes[calls] ?? 1;
        calls += 1;
        resolvers.push({
          ok: () => resolve({ bsize: 1024 * 1024, bavail: size, blocks: 1000 }),
          fail: () => reject(new Error('stale')),
        });
      });
    const r = run(() => ({ bsize: 1, bavail: 1, blocks: 1 }), { statfs: slow });
    r.producer.start(r.sink);
    r.producer.stop();
    r.producer.start(r.sink);
    expect(calls).toBe(2); // the restart is not blocked by the dead read
    resolvers[0]?.ok(); // stale value
    await flush();
    expect(r.calls).toEqual([]);
    resolvers[1]?.ok();
    await flush();
    expect(names(r.calls)).toEqual([
      ['disk_mem_free', 7],
      ['disk_mem_total', 1000],
    ]);
    // the error path obeys the same generation rule
    r.producer.stop();
    r.producer.start(r.sink); // read #3, then dies with the next stop
    r.producer.stop();
    r.producer.start(r.sink);
    resolvers[2]?.fail();
    await flush();
    expect(r.errors).toEqual([]);
  });

  it('polls every 5 s by default and honors intervalMs', () => {
    const seen: number[] = [];
    const sched: Scheduler = {
      setInterval: (_cb, ms) => {
        seen.push(ms);
        return 1;
      },
      clearInterval: () => {},
    };
    const stat: StatFs = async () => ({ bsize: 1, bavail: 1, blocks: 1 });
    createDiskSpaceProducer({ dataDir: '/d', statfs: stat, scheduler: sched }).start({ emit() {} });
    createDiskSpaceProducer({
      dataDir: '/d',
      statfs: stat,
      scheduler: sched,
      intervalMs: 123,
    }).start({
      emit() {},
    });
    expect(seen).toEqual([5000, 123]);
  });

  it("the default timer is unref'd (never keeps the process alive) and is cleared on stop", () => {
    const real = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const handle = { unref: vi.fn() };
    const cleared: unknown[] = [];
    const intervals: unknown[] = [];
    globalThis.setInterval = ((_cb: unknown, ms: unknown) => {
      intervals.push(ms);
      return handle;
    }) as never;
    globalThis.clearInterval = ((h: unknown) => void cleared.push(h)) as never;
    try {
      const p = createDiskSpaceProducer({
        dataDir: '/d',
        statfs: async () => ({ bsize: 1, bavail: 1, blocks: 1 }),
      });
      p.start({ emit() {} });
      expect(handle.unref).toHaveBeenCalledTimes(1);
      expect(intervals).toEqual([5000]);
      p.stop();
      expect(cleared).toEqual([handle]);
    } finally {
      globalThis.setInterval = real;
      globalThis.clearInterval = realClear;
    }
  });

  it('stop() before start() is harmless', async () => {
    const r = run(() => ({ bsize: 4096, bavail: 256, blocks: 512 }));
    expect(() => r.producer.stop()).not.toThrow();
  });

  it('a runtime without statfs is a no-op: nothing read, nothing emitted, no timer', async () => {
    const fs = fakeScheduler();
    const calls: unknown[] = [];
    const p = createDiskSpaceProducer({ dataDir: '/d', statfs: null, scheduler: fs.scheduler });
    p.start({ emit: (...a) => void calls.push(a) });
    await flush();
    expect(calls).toEqual([]);
    expect(fs.live()).toBe(0);
  });

  it('reads the real filesystem by default (the dataDir volume)', async () => {
    const calls: Array<[string, unknown]> = [];
    const p = createDiskSpaceProducer({
      dataDir: process.cwd(),
      scheduler: fakeScheduler().scheduler,
    });
    p.start({ emit: (n, v) => void calls.push([n, v]) });
    await new Promise((r) => setTimeout(r, 50));
    p.stop();
    const total = calls.find(([n]) => n === 'disk_mem_total')?.[1];
    const free = calls.find(([n]) => n === 'disk_mem_free')?.[1];
    expect(Number.isInteger(total) && (total as number) > 0).toBe(true);
    expect(Number.isInteger(free) && (free as number) <= (total as number)).toBe(true);
  });
});
