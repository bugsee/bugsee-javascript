import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DiskReading,
  resetStorageTracker,
  type StatFs,
  type StatFsResult,
  type StorageEnv,
  StorageTracker,
  storageTrackerFor,
} from './index';

// clearInterval must be handed exactly a live handle setInterval returned (never undefined/null/twice).
function fakeScheduler() {
  const callbacks: (() => void)[] = [];
  const periods: number[] = [];
  const live = new Set<unknown>();
  const scheduler = {
    setInterval: (cb: () => void, ms: number) => {
      callbacks.push(cb);
      periods.push(ms);
      const handle = { id: callbacks.length };
      live.add(handle);
      return handle;
    },
    clearInterval: (h: unknown) => {
      expect(live.has(h), 'clearInterval was not given a live handle').toBe(true);
      live.delete(h);
    },
  };
  return {
    scheduler,
    tick: () => callbacks.at(-1)?.(),
    callbackAt: (i: number) => callbacks[i],
    sets: () => callbacks.length,
    periods,
    live: () => live.size,
  };
}

const MB = 1024 * 1024;
const flush = () => new Promise<void>((r) => setImmediate(r));
type Outcome = StatFsResult | Error;
const stat = (sample: () => Outcome) => {
  const paths: string[] = [];
  const statfs: StatFs = async (path) => {
    paths.push(path);
    const s = sample();
    if (s instanceof Error) throw s;
    return s;
  };
  return { statfs, paths };
};

function mk(sample: () => Outcome, over: StorageEnv = {}, onError?: (e: unknown) => void) {
  const fs = fakeScheduler();
  const st = stat(sample);
  const tracker = new StorageTracker(
    { dataDir: '/data', statfs: st.statfs, scheduler: fs.scheduler, ...over },
    onError,
  );
  const seen: DiskReading[] = [];
  const subscribe = () => tracker.on('disk', (r) => void seen.push(r));
  return { tracker, fs, st, seen, subscribe };
}
const ok = (bavail = 300, blocks = 1000): StatFsResult => ({ bsize: MB, bavail, blocks });

describe('StorageTracker (node)', () => {
  it('does nothing until a listener arrives: no timer, no read', () => {
    const r = mk(() => ok());
    expect(r.fs.sets()).toBe(0);
    expect(r.st.paths).toEqual([]);
    expect(r.tracker.current()).toBeUndefined();
  });

  it('reads the data dir volume on the first listener and emits bytes: free = bsize*bavail, total = bsize*blocks', async () => {
    const r = mk(() => ({ bsize: 4096, bavail: 10, blocks: 25 }), { dataDir: '/var/bugsee' });
    r.subscribe();
    await flush();
    expect(r.st.paths).toEqual(['/var/bugsee']);
    expect(r.seen).toEqual([{ freeBytes: 40960, totalBytes: 102400 }]);
    expect(r.tracker.current()).toEqual({ freeBytes: 40960, totalBytes: 102400 });
  });

  it('polls on its own timer (5 s by default, intervalMs honoured) and emits every poll', async () => {
    let free = 10;
    const r = mk(() => ok(free, 100));
    r.subscribe();
    await flush();
    expect(r.fs.periods).toEqual([5000]);
    free = 9;
    r.fs.tick();
    await flush();
    expect(r.seen.map((s) => s.freeBytes)).toEqual([10 * MB, 9 * MB]);
    const custom = mk(() => ok(), { intervalMs: 123 });
    custom.subscribe();
    expect(custom.fs.periods).toEqual([123]);
  });

  it('a second listener shares the poll; the timer is released only with the LAST listener', async () => {
    const r = mk(() => ok());
    const off1 = r.subscribe();
    const off2 = r.subscribe();
    await flush();
    expect(r.fs.sets()).toBe(1);
    expect(r.st.paths).toHaveLength(1);
    off1();
    expect(r.fs.live()).toBe(1);
    off2();
    expect(r.fs.live()).toBe(0);
  });

  it('a full disk is a true 0 free, not an omission', async () => {
    const r = mk(() => ok(0, 10));
    r.subscribe();
    await flush();
    expect(r.seen).toEqual([{ freeBytes: 0, totalBytes: 10 * MB }]);
  });

  it('omits an unsane reading (never a fabricated 0) without reporting an error', async () => {
    for (const bad of [
      { bsize: 0, bavail: 5, blocks: 5 },
      { bsize: 4096, bavail: Number.NaN, blocks: 5 },
      { bsize: 4096, bavail: -1, blocks: 5 },
      { bsize: 4096, bavail: 5, blocks: 0 },
      { bsize: 4096, bavail: 5, blocks: Number.POSITIVE_INFINITY },
      { bsize: Number.NaN, bavail: 5, blocks: 5 },
      { bsize: Number.POSITIVE_INFINITY, bavail: 5, blocks: 5 },
      { bsize: 4096, bavail: Number.POSITIVE_INFINITY, blocks: 5 },
      { bsize: '4096', bavail: 5, blocks: 5 },
      { bsize: 1e308, bavail: 1e308, blocks: 5 }, // product overflows
      { bsize: 1e308, bavail: 1, blocks: 1e308 },
      {},
      null,
      undefined,
    ]) {
      const errors: unknown[] = [];
      const r = mk(
        () => bad as unknown as StatFsResult,
        {},
        (e) => errors.push(e),
      );
      r.subscribe();
      await flush();
      expect(r.seen, JSON.stringify(bad)).toEqual([]);
      expect(r.tracker.current()).toBeUndefined();
      expect(errors).toEqual([]);
    }
  });

  it('a non-number block count is rejected (never coerced)', async () => {
    const r = mk(() => ({ bsize: MB, bavail: 5, blocks: true }) as unknown as StatFsResult);
    r.subscribe();
    await flush();
    expect(r.seen).toEqual([]);
  });

  it('an overflowing reading after a good one clears the retained reading', async () => {
    let next: Outcome = ok(5, 9);
    const r = mk(() => next);
    r.subscribe();
    await flush();
    expect(r.tracker.current()).toBeDefined();
    next = { bsize: 1e308, bavail: 1e308, blocks: 5 };
    r.fs.tick();
    await flush();
    expect(r.tracker.current()).toBeUndefined();
  });

  it('after the last unsubscribe a changed seam stores only: no read and no live timer', async () => {
    const r = mk(() => ok(), { dataDir: '/a' });
    const off = r.subscribe();
    await flush();
    off();
    const reads = r.st.paths.length;
    r.tracker.rebind({ dataDir: '/b' });
    await flush();
    expect(r.st.paths).toHaveLength(reads);
    expect(r.fs.live()).toBe(0);
    r.subscribe();
    await flush();
    expect(r.st.paths.at(-1)).toBe('/b');
  });

  it('a failing statfs is reported and omits only that reading; the next poll recovers', async () => {
    let fail = true;
    const errors: unknown[] = [];
    const r = mk(
      () => (fail ? new Error('EIO') : ok(1, 2)),
      {},
      (e) => errors.push(e),
    );
    r.subscribe();
    await flush();
    expect(r.seen).toEqual([]);
    expect((errors[0] as Error).message).toBe('EIO');
    fail = false;
    r.fs.tick();
    await flush();
    expect(r.seen).toEqual([{ freeBytes: MB, totalBytes: 2 * MB }]);
  });

  it('reports a failure streak once, and again after a recovery or a new run (no flood every 5 s)', async () => {
    let fail = true;
    const errors: unknown[] = [];
    const r = mk(
      () => (fail ? new Error('ENOENT') : ok()),
      {},
      (e) => errors.push(e),
    );
    const off = r.subscribe();
    await flush();
    for (let i = 0; i < 3; i++) {
      r.fs.tick();
      await flush();
    }
    expect(errors).toHaveLength(1);
    fail = false;
    r.fs.tick();
    await flush();
    fail = true;
    r.fs.tick();
    await flush();
    expect(errors).toHaveLength(2);
    off(); // a new run starts a new streak
    r.subscribe();
    await flush();
    expect(errors).toHaveLength(3);
  });

  it('an unsane reading ends a failure streak like any answered read', async () => {
    let next: Outcome = new Error('x');
    const errors: unknown[] = [];
    const r = mk(
      () => next,
      {},
      (e) => errors.push(e),
    );
    r.subscribe();
    await flush();
    next = { bsize: 0, bavail: 0, blocks: 0 };
    r.fs.tick();
    await flush();
    next = new Error('y');
    r.fs.tick();
    await flush();
    expect(errors).toHaveLength(2);
  });

  it('a failed or unsane read drops the retained reading (a gap, never a stale number)', async () => {
    let next: Outcome = ok(5, 9);
    const r = mk(
      () => next,
      {},
      () => {},
    );
    r.subscribe();
    await flush();
    expect(r.tracker.current()?.freeBytes).toBe(5 * MB);
    next = new Error('gone');
    r.fs.tick();
    await flush();
    expect(r.tracker.current()).toBeUndefined();
    next = ok(6, 9);
    r.fs.tick();
    await flush();
    expect(r.tracker.current()?.freeBytes).toBe(6 * MB);
    next = { bsize: 0, bavail: 0, blocks: 0 };
    r.fs.tick();
    await flush();
    expect(r.tracker.current()).toBeUndefined();
  });

  it('emitted payloads and current() are copies: a subscriber cannot corrupt the retained reading', async () => {
    const r = mk(() => ok());
    r.tracker.on('disk', (d) => {
      d.freeBytes = -5;
    });
    r.subscribe();
    await flush();
    (r.tracker.current() as DiskReading).freeBytes = -1;
    expect(r.tracker.current()?.freeBytes).toBe(300 * MB);
  });

  it('a synchronously throwing or non-promise statfs is handled (reported / awaited)', async () => {
    const errors: unknown[] = [];
    const throwing = mk(
      () => ok(),
      {
        statfs: () => {
          throw new Error('sync');
        },
      },
      (e) => errors.push(e),
    );
    throwing.subscribe();
    await flush();
    expect((errors[0] as Error).message).toBe('sync');
    const plain = mk(() => ok(), { statfs: (() => ok(2, 4)) as unknown as StatFs });
    plain.subscribe();
    await flush();
    expect(plain.seen).toEqual([{ freeBytes: 2 * MB, totalBytes: 4 * MB }]);
  });

  it('onError is optional and a throwing reporter never escapes', async () => {
    const quiet = mk(() => new Error('e'));
    expect(() => quiet.subscribe()).not.toThrow();
    await flush();
    const loud = mk(
      () => new Error('e'),
      {},
      () => {
        throw new Error('reporter');
      },
    );
    loud.subscribe();
    await flush();
    loud.fs.tick();
    await flush();
    // a throwing LISTENER is isolated by the emitter and reported through the same guarded reporter
    const l = mk(
      () => ok(),
      {},
      () => {
        throw new Error('reporter');
      },
    );
    l.tracker.on('disk', () => {
      throw new Error('listener');
    });
    await flush();
  });

  it('never overlaps reads: a tick while one is in flight is skipped', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const slow: StatFs = () => {
      calls += 1;
      return new Promise((resolve) => {
        release = () => resolve(ok());
      });
    };
    const r = mk(() => ok(), { statfs: slow });
    r.subscribe();
    r.fs.tick();
    r.fs.tick();
    expect(calls).toBe(1);
    release?.();
    await flush();
    r.fs.tick();
    expect(calls).toBe(2);
  });

  it('a read in flight when the last listener leaves can neither emit nor report when it settles', async () => {
    const pending: Array<{ ok: () => void; fail: () => void }> = [];
    const slow: StatFs = () =>
      new Promise((resolve, reject) => {
        pending.push({ ok: () => resolve(ok()), fail: () => reject(new Error('late')) });
      });
    const errors: unknown[] = [];
    const r = mk(
      () => ok(),
      { statfs: slow },
      (e) => errors.push(e),
    );
    const off = r.subscribe();
    off();
    const off2 = r.subscribe(); // the restart is not blocked by the dead read
    expect(pending).toHaveLength(2);
    pending[0]?.ok();
    await flush();
    expect(r.seen).toEqual([]);
    off2();
    pending[1]?.fail();
    await flush();
    expect(errors).toEqual([]);
    expect(r.seen).toEqual([]);
  });

  it('a timer callback from an earlier run (its clear failed) never reads', async () => {
    const r = mk(() => ok());
    const off = r.subscribe();
    await flush();
    off();
    const reads = r.st.paths.length;
    r.fs.callbackAt(0)?.();
    await flush();
    expect(r.st.paths).toHaveLength(reads);
    r.subscribe();
    await flush();
    r.fs.callbackAt(0)?.(); // still the OLD generation after a re-arm
    await flush();
    expect(r.st.paths).toHaveLength(reads + 1);
  });

  it('retention: only the seams survive the last unsubscribe; the reading does not, and a re-subscribe re-reads', async () => {
    let free = 5;
    const r = mk(() => ok(free, 9), { dataDir: '/kept' });
    const off = r.subscribe();
    await flush();
    expect(r.tracker.current()?.freeBytes).toBe(5 * MB);
    off();
    expect(r.tracker.current()).toBeUndefined();
    free = 4;
    r.subscribe();
    await flush();
    expect(r.st.paths).toEqual(['/kept', '/kept']);
    expect(r.seen.map((s) => s.freeBytes)).toEqual([5 * MB, 4 * MB]);
  });

  it('is inert without a data dir: no timer, no read, no error; a later rebind with one starts it', async () => {
    const fs = fakeScheduler();
    const st = stat(() => ok());
    const errors: unknown[] = [];
    const t = new StorageTracker({ statfs: st.statfs, scheduler: fs.scheduler }, (e) =>
      errors.push(e),
    );
    const seen: DiskReading[] = [];
    t.on('disk', (r) => void seen.push(r));
    await flush();
    expect(fs.sets()).toBe(0);
    expect(st.paths).toEqual([]);
    t.rebind({ dataDir: '/late' });
    await flush();
    expect(st.paths).toEqual(['/late']);
    expect(fs.live()).toBe(1);
    expect(seen).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('a runtime without statfs (null) is inert: nothing read, no timer; rebind(undefined) never sheds the seam', async () => {
    const fs = fakeScheduler();
    const t = new StorageTracker({ dataDir: '/d', statfs: null, scheduler: fs.scheduler });
    const seen: DiskReading[] = [];
    t.on('disk', (r) => void seen.push(r));
    await flush();
    expect(fs.sets()).toBe(0);
    expect(seen).toEqual([]);
    t.rebind({ scheduler: fs.scheduler });
    expect(fs.sets()).toBe(0); // unchanged: still null
  });

  it('reads the real filesystem by default (the data dir volume)', async () => {
    const fs = fakeScheduler();
    const t = new StorageTracker({ dataDir: process.cwd(), scheduler: fs.scheduler });
    const seen: DiskReading[] = [];
    const off = t.on('disk', (r) => void seen.push(r));
    for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    off();
    expect(seen).toHaveLength(1);
    const { freeBytes, totalBytes } = seen[0] as DiskReading;
    expect(Number.isInteger(totalBytes) && totalBytes > 0).toBe(true);
    expect(freeBytes <= totalBytes).toBe(true);
  });

  it("the default timer is unref'd, uses the default period and is cleared on the last unsubscribe", () => {
    const real = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const handle = { unref: vi.fn() };
    const cleared: unknown[] = [];
    const periods: unknown[] = [];
    globalThis.setInterval = ((_cb: unknown, ms: unknown) => {
      periods.push(ms);
      return handle;
    }) as never;
    globalThis.clearInterval = ((h: unknown) => void cleared.push(h)) as never;
    try {
      const t = new StorageTracker({ dataDir: '/d', statfs: async () => ok() });
      const off = t.on('disk', () => {});
      expect(handle.unref).toHaveBeenCalledTimes(1);
      expect(periods).toEqual([5000]);
      off();
      expect(cleared).toEqual([handle]);
    } finally {
      globalThis.setInterval = real;
      globalThis.clearInterval = realClear;
    }
  });

  it('a handle without unref is tolerated by the default timer', () => {
    const real = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    globalThis.setInterval = (() => 7) as never;
    globalThis.clearInterval = (() => {}) as never;
    try {
      const t = new StorageTracker({ dataDir: '/d', statfs: async () => ok() });
      expect(() => t.on('disk', () => {})()).not.toThrow();
    } finally {
      globalThis.setInterval = real;
      globalThis.clearInterval = realClear;
    }
  });

  describe('failures to arm or release', () => {
    it('a timer that cannot be armed is reported and leaves the tracker inert (no read), retried on the next activation', async () => {
      let throwOnce = true;
      const errors: unknown[] = [];
      const fs = fakeScheduler();
      const st = stat(() => ok());
      const t = new StorageTracker(
        {
          dataDir: '/d',
          statfs: st.statfs,
          scheduler: {
            setInterval: (cb, ms) => {
              if (throwOnce) {
                throwOnce = false;
                throw new Error('no timer');
              }
              return fs.scheduler.setInterval(cb, ms);
            },
            clearInterval: fs.scheduler.clearInterval,
          },
        },
        (e) => errors.push(e),
      );
      const seen: DiskReading[] = [];
      const off = t.on('disk', (r) => void seen.push(r));
      await flush();
      expect((errors[0] as Error).message).toBe('no timer');
      expect(st.paths).toEqual([]);
      off();
      t.on('disk', (r) => void seen.push(r));
      await flush();
      expect(seen).toHaveLength(1);
    });

    it('a clearInterval that throws is reported and does not stop the teardown', async () => {
      const errors: unknown[] = [];
      const t = new StorageTracker(
        {
          dataDir: '/d',
          statfs: async () => ok(),
          scheduler: {
            setInterval: () => 1,
            clearInterval: () => {
              throw new Error('clear failed');
            },
          },
        },
        (e) => errors.push(e),
      );
      const off = t.on('disk', () => {});
      off();
      expect((errors[0] as Error).message).toBe('clear failed');
      // the next activation still works
      t.on('disk', () => {});
    });
  });

  describe('rebind (latest launch wins, merge never drop)', () => {
    it('a changed data dir while listening re-reads IMMEDIATELY on the new path and restarts the timer', async () => {
      const r = mk(() => ok(), { dataDir: '/a' });
      r.subscribe();
      await flush();
      r.tracker.rebind({ dataDir: '/b' });
      await flush();
      expect(r.st.paths).toEqual(['/a', '/b']);
      expect(r.fs.sets()).toBe(2);
      expect(r.fs.live()).toBe(1); // the old timer was cleared
      expect(r.seen).toHaveLength(2);
    });

    it('a retained reading and failure streak of the old path do not leak into the new one', async () => {
      let next: Outcome = ok(5, 9);
      const errors: unknown[] = [];
      const r = mk(
        () => next,
        { dataDir: '/a' },
        (e) => errors.push(e),
      );
      r.subscribe();
      await flush();
      next = new Error('a gone');
      r.fs.tick();
      await flush();
      expect(errors).toHaveLength(1);
      r.tracker.rebind({ dataDir: '/b' }); // still failing on the new path: a NEW streak is reported
      await flush();
      expect(errors).toHaveLength(2);
      next = ok(7, 9);
      r.tracker.rebind({ dataDir: '/c' });
      expect(r.tracker.current()).toBeUndefined(); // cleared until the new read lands
      await flush();
      expect(r.tracker.current()?.freeBytes).toBe(7 * MB);
    });

    it('a read of the OLD path in flight at the rebind is ignored when it settles', async () => {
      const pending: Array<(r: StatFsResult) => void> = [];
      const slow: StatFs = () => new Promise((resolve) => void pending.push(resolve));
      const r = mk(() => ok(), { statfs: slow, dataDir: '/a' });
      r.subscribe();
      r.tracker.rebind({ dataDir: '/b' });
      expect(pending).toHaveLength(2);
      pending[0]?.(ok(1, 1));
      await flush();
      expect(r.seen).toEqual([]);
      pending[1]?.(ok(2, 2));
      await flush();
      expect(r.seen).toEqual([{ freeBytes: 2 * MB, totalBytes: 2 * MB }]);
    });

    it('an UNCHANGED relaunch restarts nothing; an omitted seam keeps the earlier one', async () => {
      const r = mk(() => ok(), { dataDir: '/a', intervalMs: 77 });
      r.subscribe();
      await flush();
      r.tracker.rebind({});
      r.tracker.rebind({ dataDir: '/a', intervalMs: 77, scheduler: r.fs.scheduler });
      expect(r.fs.sets()).toBe(1);
      expect(r.st.paths).toEqual(['/a']);
      r.tracker.rebind({ dataDir: '/b' });
      await flush();
      expect(r.fs.periods).toEqual([77, 77]); // interval kept across the data dir swap
    });

    it('a new scheduler: the old timer is cleared on the OLD scheduler and re-armed on the new one', async () => {
      const r = mk(() => ok());
      r.subscribe();
      await flush();
      const next = fakeScheduler();
      r.tracker.rebind({ scheduler: next.scheduler });
      expect(r.fs.live()).toBe(0);
      expect(next.live()).toBe(1);
      await flush();
      next.tick();
      await flush();
      expect(r.seen).toHaveLength(3);
    });

    it('a new statfs seam is used at once; null switches the read off', async () => {
      const r = mk(() => ok(1, 2));
      r.subscribe();
      await flush();
      const other = stat(() => ok(3, 4));
      r.tracker.rebind({ statfs: other.statfs });
      await flush();
      expect(other.paths).toEqual(['/data']);
      expect(r.seen.at(-1)).toEqual({ freeBytes: 3 * MB, totalBytes: 4 * MB });
      r.tracker.rebind({ statfs: null });
      expect(r.fs.live()).toBe(0);
    });

    it('while idle, seams are only stored: nothing is read until a listener arrives, then it uses the latest', async () => {
      const r = mk(() => ok());
      r.tracker.rebind({ dataDir: '/later' });
      expect(r.st.paths).toEqual([]);
      r.subscribe();
      await flush();
      expect(r.st.paths).toEqual(['/later']);
    });

    it('the latest onError wins; undefined keeps it', async () => {
      const first = vi.fn();
      const second = vi.fn();
      const r = mk(() => new Error('x'), {}, first);
      r.tracker.rebind({}, second);
      r.tracker.rebind({}, undefined);
      r.subscribe();
      await flush();
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });
  });

  it('reset() drops every listener, releases the timer and ignores anything in flight', async () => {
    const r = mk(() => ok());
    r.subscribe();
    r.tracker.reset();
    expect(r.fs.live()).toBe(0);
    await flush();
    expect(r.seen).toEqual([]);
  });
});

describe('storageTrackerFor (singleton per data dir)', () => {
  const done: string[] = [];
  afterEach(() => {
    resetStorageTracker();
    done.length = 0;
  });

  it('two launches over DIFFERENT dirs get different trackers: each keeps polling its own dir and reporting to its own onError', async () => {
    const fsA = fakeScheduler();
    const fsB = fakeScheduler();
    const a = stat(() => new Error('a failed'));
    const b = stat(() => new Error('b failed'));
    const errA: unknown[] = [];
    const errB: unknown[] = [];
    const ta = storageTrackerFor(
      { dataDir: '/one', statfs: a.statfs, scheduler: fsA.scheduler },
      (e) => errA.push(e),
    );
    ta.on('disk', () => {});
    await flush();
    const tb = storageTrackerFor(
      { dataDir: '/two', statfs: b.statfs, scheduler: fsB.scheduler },
      (e) => errB.push(e),
    );
    tb.on('disk', () => {});
    await flush();
    expect(tb).not.toBe(ta);
    fsA.tick();
    fsB.tick();
    await flush();
    expect(a.paths).toEqual(['/one', '/one']);
    expect(b.paths).toEqual(['/two', '/two']);
    // each streak reported once, to its own launch
    expect(errA.map((e) => (e as Error).message)).toEqual(['a failed']);
    expect(errB.map((e) => (e as Error).message)).toEqual(['b failed']);
    expect(fsA.live()).toBe(1);
    expect(fsB.live()).toBe(1);
  });

  it('two launches over the SAME dir share one tracker; the latest seams win and omitted ones are kept', async () => {
    const fs = fakeScheduler();
    const a = stat(() => new Error('boom'));
    const first = vi.fn();
    const second = vi.fn();
    const t1 = storageTrackerFor(
      { dataDir: '/same', statfs: a.statfs, scheduler: fs.scheduler },
      first,
    );
    const t2 = storageTrackerFor({ dataDir: '/same/' }, second); // an equivalent spelling is the same volume identity
    expect(t2).toBe(t1);
    t2.on('disk', () => {});
    await flush();
    expect(a.paths).toEqual(['/same']);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('an explicit key overrides the data-dir identity; resetStorageTracker(key) drops just it', async () => {
    const key = {};
    const fs = fakeScheduler();
    const t = storageTrackerFor({
      key,
      dataDir: '/x',
      statfs: stat(() => ok()).statfs,
      scheduler: fs.scheduler,
    });
    expect(storageTrackerFor({ dataDir: '/x' })).not.toBe(t);
    expect(storageTrackerFor({ key })).toBe(t);
    t.on('disk', () => {});
    expect(fs.live()).toBe(1);
    resetStorageTracker(key);
    expect(fs.live()).toBe(0);
    expect(storageTrackerFor({ key })).not.toBe(t);
    resetStorageTracker(key);
  });

  it('a launch without a data dir gets the shared inert process-keyed tracker', async () => {
    const fs = fakeScheduler();
    const st = stat(() => ok());
    const t = storageTrackerFor({ statfs: st.statfs, scheduler: fs.scheduler });
    expect(storageTrackerFor()).toBe(t);
    t.on('disk', () => {});
    await flush();
    expect(st.paths).toEqual([]);
    expect(fs.sets()).toBe(0);
  });

  it('resetStorageTracker(dir) drops that dir only; resetStorageTracker() drops every dir tracker and the process one', async () => {
    const fs1 = fakeScheduler();
    const fs2 = fakeScheduler();
    const t1 = storageTrackerFor({
      dataDir: '/r1',
      statfs: stat(() => ok()).statfs,
      scheduler: fs1.scheduler,
    });
    const t2 = storageTrackerFor({
      dataDir: '/r2',
      statfs: stat(() => ok()).statfs,
      scheduler: fs2.scheduler,
    });
    const p = storageTrackerFor();
    t1.on('disk', () => {});
    t2.on('disk', () => {});
    resetStorageTracker('/r1');
    expect(fs1.live()).toBe(0);
    expect(fs2.live()).toBe(1);
    expect(storageTrackerFor({ dataDir: '/r1' })).not.toBe(t1);
    expect(storageTrackerFor({ dataDir: '/r2' })).toBe(t2);
    resetStorageTracker('/never-launched'); // no-op
    const rel = fakeScheduler();
    const tr = storageTrackerFor({
      dataDir: 'relative/dir',
      statfs: stat(() => ok()).statfs,
      scheduler: rel.scheduler,
    });
    tr.on('disk', () => {});
    resetStorageTracker('relative/dir'); // the same resolved identity as the launch spelling
    expect(rel.live()).toBe(0);
    resetStorageTracker();
    expect(fs2.live()).toBe(0);
    expect(storageTrackerFor({ dataDir: '/r2' })).not.toBe(t2);
    expect(storageTrackerFor()).not.toBe(p);
  });

  it('different explicit keys never share state', () => {
    const k1 = {};
    const k2 = {};
    expect(storageTrackerFor({ key: k1 })).not.toBe(storageTrackerFor({ key: k2 }));
    resetStorageTracker(k1);
    resetStorageTracker(k2);
  });
});

describe('StorageTracker (node) — a hung statfs must not blind the tracker for the whole launch', () => {
  const hung = () => {
    const resolvers: Array<(s: StatFsResult) => void> = [];
    let calls = 0;
    const statfs: StatFs = () => {
      calls += 1;
      return new Promise((resolve) => resolvers.push(resolve));
    };
    return { statfs, resolvers, calls: () => calls };
  };

  it('abandons a read pending past the timeout, reads again on the next tick, and reports ONCE per streak', async () => {
    const h = hung();
    const clock = { t: 0 };
    const onError = vi.fn();
    const r = mk(
      () => ok(),
      { statfs: h.statfs, now: () => clock.t, statfsTimeoutMs: 5000 },
      onError,
    );
    r.subscribe();
    expect(h.calls()).toBe(1);
    clock.t = 4999;
    r.fs.tick(); // not yet hung
    expect(h.calls()).toBe(1);
    expect(onError).not.toHaveBeenCalled();
    clock.t = 5000;
    r.fs.tick(); // hung: abandoned, a fresh read starts
    expect(h.calls()).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    clock.t = 10_000;
    r.fs.tick(); // the second one hangs too: still one report for the streak
    expect(h.calls()).toBe(3);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.tracker.current()).toBeUndefined();
  });

  it('a late answer of an abandoned read is ignored; the fresh read answers normally', async () => {
    const h = hung();
    const clock = { t: 0 };
    const r = mk(
      () => ok(),
      { statfs: h.statfs, now: () => clock.t },
      () => {},
    );
    r.subscribe();
    clock.t = 6000;
    r.fs.tick();
    h.resolvers[0]?.(ok(100)); // the abandoned one finally answers: ignored
    await flush();
    expect(r.seen).toEqual([]);
    h.resolvers[1]?.(ok(250));
    await flush();
    expect(r.seen).toEqual([{ freeBytes: 250 * MB, totalBytes: 1000 * MB }]);
  });

  it('drops the previous reading when a read hangs (an unanswered volume is a gap, never the old number)', async () => {
    let first = true;
    const resolvers: Array<(s: StatFsResult) => void> = [];
    const statfs: StatFs = () => {
      if (first) {
        first = false;
        return Promise.resolve(ok(300));
      }
      return new Promise((resolve) => resolvers.push(resolve));
    };
    const clock = { t: 0 };
    const r = mk(
      () => ok(),
      { statfs, now: () => clock.t },
      () => {},
    );
    r.subscribe();
    await flush();
    expect(r.tracker.current()).toBeDefined();
    r.fs.tick(); // hangs
    clock.t = 6000;
    r.fs.tick(); // abandoned
    expect(r.tracker.current()).toBeUndefined();
  });

  it('works with the default clock and timeout, and ends the streak with a successful read', async () => {
    const h = hung();
    const r = mk(
      () => ok(),
      { statfs: h.statfs },
      () => {},
    );
    r.subscribe();
    r.fs.tick(); // far under 5 s of real time: still the same read
    expect(h.calls()).toBe(1);
    h.resolvers[0]?.(ok());
    await flush();
    expect(r.seen).toHaveLength(1);
  });
});
