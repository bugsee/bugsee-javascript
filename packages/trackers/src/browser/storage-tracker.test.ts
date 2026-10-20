import { describe, expect, it, vi } from 'vitest';
import {
  resetStorageTracker,
  type StorageEstimate,
  type StorageManagerLike,
  type StorageTimers,
  StorageTracker,
  storageTrackerFor,
  VISIBILITY_MIN_GAP_MS,
} from './storage-tracker';

const flush = (): Promise<void> =>
  new Promise((r) =>
    (globalThis as unknown as { setTimeout(f: () => void, ms: number): void }).setTimeout(
      () => r(),
      0,
    ),
  );

function mkScheduler() {
  let next = 1;
  const live = new Map<number, () => void>();
  const scheduler: StorageTimers & {
    live: typeof live;
    tick(): void;
    periods: number[];
  } = {
    live,
    periods: [],
    setInterval(cb, ms) {
      const id = next++;
      live.set(id, cb);
      scheduler.periods.push(ms);
      return id;
    },
    clearInterval(h) {
      live.delete(h as number);
    },
    tick() {
      for (const cb of [...live.values()]) cb();
    },
  };
  return scheduler;
}

function mkDocument(state = 'visible') {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: state,
    addEventListener: (t: string, l: () => void) => {
      if (t === 'visibilitychange') listeners.add(l);
    },
    removeEventListener: (t: string, l: () => void) => {
      if (t === 'visibilitychange') listeners.delete(l);
    },
    fire: () => {
      for (const l of [...listeners]) l();
    },
    count: () => listeners.size,
  };
  return doc;
}

const mkStorage = (usage: unknown = 1000, quota: unknown = 5000, persisted: unknown = true) => ({
  estimate: vi.fn(() => Promise.resolve({ usage, quota })),
  persisted: vi.fn(() => Promise.resolve(persisted)),
});

function setup(storage: StorageManagerLike | 'none' | 'default' = 'default', state = 'visible') {
  const scheduler = mkScheduler();
  const document = mkDocument(state);
  const onError = vi.fn();
  const navigator = {
    storage: storage === 'default' ? mkStorage() : storage === 'none' ? undefined : storage,
  };
  const clock = { t: 1_000_000 };
  const tracker = new StorageTracker(
    { navigator, document, scheduler, intervalMs: 1234, now: () => clock.t },
    onError,
  );
  const seen: StorageEstimate[] = [];
  return { tracker, scheduler, document, onError, navigator, seen, clock };
}

describe('StorageTracker', () => {
  it('does nothing at construction', () => {
    const storage = mkStorage();
    const { scheduler, document } = setup(storage);
    expect(storage.estimate).not.toHaveBeenCalled();
    expect(scheduler.live.size).toBe(0);
    expect(document.count()).toBe(0);
  });

  it('polls on activation and emits {usageBytes, quotaBytes, persisted}', async () => {
    const storage = mkStorage(1000, 5000, true);
    const { tracker, seen, scheduler, document } = setup(storage);
    tracker.on('storageEstimate', (e) => seen.push(e));
    expect(storage.estimate).toHaveBeenCalledTimes(1);
    expect(storage.persisted).toHaveBeenCalledTimes(1);
    expect(tracker.current()).toBeUndefined();
    await flush();
    expect(seen).toEqual([{ usageBytes: 1000, quotaBytes: 5000, persisted: true }]);
    expect(tracker.current()).toEqual(seen[0]);
    expect(scheduler.periods).toEqual([1234]);
    expect(document.count()).toBe(1);
  });

  it('uses a 5 minute slow timer by default', () => {
    const scheduler = mkScheduler();
    const t = new StorageTracker({
      navigator: { storage: mkStorage() },
      scheduler,
    });
    t.on('storageEstimate', () => {});
    expect(scheduler.periods).toEqual([300_000]);
  });

  it('works with the global timers when none is injected, and releases them', async () => {
    vi.useFakeTimers();
    try {
      const storage = mkStorage();
      const t = new StorageTracker({ navigator: { storage }, intervalMs: 100 });
      const off = t.on('storageEstimate', () => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(storage.estimate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(storage.estimate).toHaveBeenCalledTimes(2);
      off();
      await vi.advanceTimersByTimeAsync(1000);
      expect(storage.estimate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls again on each timer tick while visible, and on visibility->visible only', async () => {
    const storage = mkStorage();
    const { tracker, scheduler, document, clock } = setup(storage);
    tracker.on('storageEstimate', () => {});
    await flush();
    scheduler.tick();
    expect(storage.estimate).toHaveBeenCalledTimes(2);
    await flush();
    document.visibilityState = 'hidden';
    document.fire();
    expect(storage.estimate).toHaveBeenCalledTimes(2);
    scheduler.tick(); // hidden page: skipped
    expect(storage.estimate).toHaveBeenCalledTimes(2);
    clock.t += VISIBILITY_MIN_GAP_MS;
    document.visibilityState = 'visible';
    document.fire();
    expect(storage.estimate).toHaveBeenCalledTimes(3);
  });

  it('throttles visibility-triggered polls to one per VISIBILITY_MIN_GAP_MS (any poll counts)', async () => {
    const storage = mkStorage();
    const { tracker, document, clock, scheduler } = setup(storage);
    tracker.on('storageEstimate', () => {});
    await flush();
    document.fire(); // right after the activation poll
    expect(storage.estimate).toHaveBeenCalledTimes(1);
    clock.t += VISIBILITY_MIN_GAP_MS - 1;
    document.fire();
    expect(storage.estimate).toHaveBeenCalledTimes(1);
    clock.t += 1; // exactly the gap
    document.fire();
    expect(storage.estimate).toHaveBeenCalledTimes(2);
    document.fire(); // just polled
    expect(storage.estimate).toHaveBeenCalledTimes(2);
    scheduler.tick(); // the slow timer is NOT throttled
    expect(storage.estimate).toHaveBeenCalledTimes(3);
  });

  it('a backwards clock step does not suppress a visibility poll (negative elapsed = gap elapsed)', async () => {
    const storage = mkStorage();
    const { tracker, document, clock } = setup(storage);
    tracker.on('storageEstimate', () => {});
    await flush();
    clock.t -= 5_000;
    document.fire();
    expect(storage.estimate).toHaveBeenCalledTimes(2);
  });

  describe('failure reporting (once per streak)', () => {
    it('reports a persistent failure once, not every tick, and again after a success', async () => {
      const storage = mkStorage(1, 2);
      const { tracker, scheduler, onError } = setup(storage);
      const fail = (e: Error) => {
        storage.estimate.mockImplementation(() => Promise.reject(e));
      };
      const e1 = new Error('first');
      fail(e1);
      tracker.on('storageEstimate', () => {});
      await flush();
      scheduler.tick();
      await flush();
      scheduler.tick();
      await flush();
      expect(onError.mock.calls.map((c) => c[0])).toEqual([e1]);
      storage.estimate.mockImplementation(() => Promise.resolve({ usage: 1, quota: 2 }));
      scheduler.tick();
      await flush();
      const e2 = new Error('second streak');
      fail(e2);
      scheduler.tick();
      await flush();
      scheduler.tick();
      await flush();
      expect(onError.mock.calls.map((c) => c[0])).toEqual([e1, e2]);
    });

    it('a stale failing poll is neither reported nor does it start a streak', async () => {
      let rejectFirst!: (e: Error) => void;
      const storage = {
        estimate: vi
          .fn()
          .mockImplementationOnce(() => new Promise((_, rej) => (rejectFirst = rej)))
          .mockImplementation(() => Promise.resolve({ usage: 1, quota: 2 })),
        persisted: () => Promise.resolve(true),
      };
      const { tracker, scheduler, onError } = setup(storage as unknown as StorageManagerLike);
      tracker.on('storageEstimate', () => {});
      scheduler.tick(); // supersedes the first
      await flush();
      rejectFirst(new Error('late'));
      await flush();
      expect(onError).not.toHaveBeenCalled();
    });

    it('reset ends a streak', async () => {
      const storage = { ...mkStorage(), estimate: vi.fn(() => Promise.reject(new Error('x'))) };
      const { tracker, onError } = setup(storage);
      const off = tracker.on('storageEstimate', () => {});
      await flush();
      off();
      const again = tracker.on('storageEstimate', () => {});
      await flush();
      again();
      expect(onError).toHaveBeenCalledTimes(1); // same streak survives an unsubscribe
      tracker.reset();
      tracker.on('storageEstimate', () => {});
      await flush();
      expect(onError).toHaveBeenCalledTimes(2);
    });
  });

  describe('currentFresh (age of the retained estimate)', () => {
    it('is undefined before any estimate', () => {
      expect(setup().tracker.currentFresh()).toBeUndefined();
    });

    it('answers up to 2x the poll interval, then withholds it (current() still answers)', async () => {
      const { tracker, clock } = setup(); // intervalMs 1234
      const off = tracker.on('storageEstimate', () => {});
      await flush();
      off();
      const est = { usageBytes: 1000, quotaBytes: 5000, persisted: true };
      expect(tracker.currentFresh()).toEqual(est);
      clock.t += 2 * 1234;
      expect(tracker.currentFresh()).toEqual(est);
      clock.t += 1;
      expect(tracker.currentFresh()).toBeUndefined();
      expect(tracker.current()).toEqual(est);
    });

    it('uses the 5 minute default interval', async () => {
      const clock = { t: 0 };
      const t = new StorageTracker({
        navigator: { storage: mkStorage() },
        scheduler: mkScheduler(),
        now: () => clock.t,
      });
      const off = t.on('storageEstimate', () => {});
      await flush();
      off();
      expect(t.currentFresh()).toBeDefined();
      clock.t = 600_000;
      expect(t.currentFresh()).toBeDefined();
      clock.t = 600_001;
      expect(t.currentFresh()).toBeUndefined();
    });

    it('a backwards clock step makes the estimate stale (age must be >= 0)', async () => {
      const { tracker, clock } = setup();
      const off = tracker.on('storageEstimate', () => {});
      await flush();
      off();
      expect(tracker.currentFresh()).toBeDefined();
      clock.t -= 1;
      expect(tracker.currentFresh()).toBeUndefined();
      clock.t += 1; // back to age 0
      expect(tracker.currentFresh()).toBeDefined();
    });

    it('a fresh estimate resets the age; reset forgets it', async () => {
      const { tracker, clock, scheduler } = setup();
      tracker.on('storageEstimate', () => {});
      await flush();
      clock.t += 10_000;
      scheduler.tick();
      await flush();
      expect(tracker.currentFresh()).toBeDefined();
      tracker.reset();
      expect(tracker.currentFresh()).toBeUndefined();
    });

    it('works with the default Date.now clock', async () => {
      const t = new StorageTracker({
        navigator: { storage: mkStorage() },
        scheduler: mkScheduler(),
      });
      const off = t.on('storageEstimate', () => {});
      await flush();
      off();
      expect(t.currentFresh()).toBeDefined();
    });
  });

  it('polls on a timer tick when there is no document at all', () => {
    const storage = mkStorage();
    const scheduler = mkScheduler();
    const t = new StorageTracker({ navigator: { storage }, scheduler });
    t.on('storageEstimate', () => {});
    scheduler.tick();
    expect(storage.estimate).toHaveBeenCalledTimes(2);
  });

  it('omits non-finite, negative and non-number fields (never zero)', async () => {
    for (const [usage, quota, persisted, expected] of [
      [Number.NaN, 5000, 'yes', { quotaBytes: 5000 }],
      [-1, Number.POSITIVE_INFINITY, null, undefined],
      ['12', null, false, { persisted: false }],
      [0, 0, false, { usageBytes: 0, quotaBytes: 0, persisted: false }],
    ] as const) {
      const { tracker, seen } = setup(mkStorage(usage, quota, persisted));
      tracker.on('storageEstimate', (e) => seen.push(e));
      await flush();
      expect(seen).toEqual(expected === undefined ? [] : [expected]);
      expect(tracker.current()).toEqual(expected);
    }
  });

  it('a manager without estimate/persisted yields nothing and no error', async () => {
    const { tracker, seen, onError } = setup({});
    tracker.on('storageEstimate', (e) => seen.push(e));
    await flush();
    expect(seen).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('no navigator.storage (insecure context) is not sampled and arms no timer or listener', async () => {
    const { tracker, seen, onError, scheduler, document } = setup('none');
    tracker.on('storageEstimate', (e) => seen.push(e));
    await flush();
    expect(scheduler.live.size).toBe(0);
    expect(document.count()).toBe(0);
    expect(seen).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a null navigator.storage is not sampled', async () => {
    const scheduler = mkScheduler();
    const onError = vi.fn();
    const t = new StorageTracker(
      { navigator: { storage: null as unknown as undefined }, scheduler },
      onError,
    );
    const seen: StorageEstimate[] = [];
    const off = t.on('storageEstimate', (e) => seen.push(e));
    await flush();
    expect(scheduler.live.size).toBe(0);
    expect(onError).not.toHaveBeenCalled();
    off();
    expect(seen).toEqual([]);
  });

  it('a non-object navigator.storage is not sampled and arms nothing', () => {
    const scheduler = mkScheduler();
    const t = new StorageTracker({
      navigator: { storage: 'nope' as unknown as undefined },
      scheduler,
    });
    const off = t.on('storageEstimate', () => {});
    expect(scheduler.live.size).toBe(0);
    off();
  });

  it('a rejected estimate() is reported, persisted still published, never thrown', async () => {
    const boom = new Error('estimate denied');
    const storage = {
      ...mkStorage(),
      estimate: vi.fn(() => Promise.reject(boom)),
    };
    const { tracker, seen, onError } = setup(storage);
    tracker.on('storageEstimate', (e) => seen.push(e));
    await flush();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(seen).toEqual([{ persisted: true }]);
  });

  it('a rejected persisted() is reported and only costs that field', async () => {
    const boom = new Error('persisted denied');
    const storage = {
      ...mkStorage(10, 20),
      persisted: vi.fn(() => Promise.reject(boom)),
    };
    const { tracker, seen, onError } = setup(storage);
    tracker.on('storageEstimate', (e) => seen.push(e));
    await flush();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(seen).toEqual([{ usageBytes: 10, quotaBytes: 20 }]);
  });

  it('synchronously throwing estimate()/persisted() are reported', async () => {
    const a = new Error('sync estimate');
    const b = new Error('sync persisted');
    const storage = {
      estimate: () => {
        throw a;
      },
      persisted: () => {
        throw b;
      },
    };
    const { tracker, seen, onError } = setup(storage);
    expect(() => tracker.on('storageEstimate', (e) => seen.push(e))).not.toThrow();
    await flush();
    expect(onError.mock.calls.map((c) => c[0])).toEqual([a, b]);
    expect(seen).toEqual([]);
  });

  it('storage that disappears after activation just skips that poll', async () => {
    const navigator: { storage?: StorageManagerLike } = { storage: mkStorage() };
    const scheduler = mkScheduler();
    const onError = vi.fn();
    const t = new StorageTracker({ navigator, scheduler }, onError);
    t.on('storageEstimate', () => {});
    await flush();
    delete navigator.storage;
    expect(() => scheduler.tick()).not.toThrow();
    await flush();
    expect(t.current()).toBeDefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('a throwing navigator.storage getter is reported (host read) and not sampled', async () => {
    const err = new Error('torn down');
    const onError = vi.fn();
    const navigator = {
      get storage(): StorageManagerLike {
        throw err;
      },
    };
    const t = new StorageTracker({ navigator, scheduler: mkScheduler() }, onError);
    t.on('storageEstimate', () => {});
    await flush();
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('a throwing usage/quota getter costs only that field and is reported', async () => {
    const err = new Error('hostile usage');
    const raw = {
      get usage(): number {
        throw err;
      },
      quota: 99,
    };
    const storage = {
      estimate: () => Promise.resolve(raw),
      persisted: () => Promise.resolve(true),
    };
    const { tracker, seen, onError } = setup(storage);
    tracker.on('storageEstimate', (e) => seen.push(e));
    await flush();
    expect(onError).toHaveBeenCalledWith(err);
    expect(seen).toEqual([{ quotaBytes: 99, persisted: true }]);
  });

  it('a null estimate() answer is treated as unusable', async () => {
    const storage = {
      estimate: () => Promise.resolve(null as unknown as { usage?: unknown }),
      persisted: () => Promise.resolve(true),
    };
    const { tracker, seen } = setup(storage);
    tracker.on('storageEstimate', (e) => seen.push(e));
    await flush();
    expect(seen).toEqual([{ persisted: true }]);
  });

  it('a throwing listener never breaks the poll (failure isolated)', async () => {
    const { tracker, seen } = setup();
    tracker.on('storageEstimate', () => {
      throw new Error('listener');
    });
    tracker.on('storageEstimate', (e) => seen.push(e));
    await flush();
    expect(seen).toHaveLength(1);
  });

  it('a reporter that throws never escapes', async () => {
    const storage = {
      ...mkStorage(),
      estimate: () => Promise.reject(new Error('x')),
    };
    const t = new StorageTracker({ navigator: { storage }, scheduler: mkScheduler() }, () => {
      throw new Error('reporter');
    });
    t.on('storageEstimate', () => {});
    await flush();
    expect(t.current()).toEqual({ persisted: true });
  });

  describe('retention and stopping', () => {
    it('releases the timer and the visibility listener on the last unsubscribe, retains the estimate', async () => {
      const { tracker, scheduler, document } = setup();
      const offA = tracker.on('storageEstimate', () => {});
      const offB = tracker.on('storageEstimate', () => {});
      await flush();
      offA();
      expect(scheduler.live.size).toBe(1);
      expect(document.count()).toBe(1);
      offB();
      expect(scheduler.live.size).toBe(0);
      expect(document.count()).toBe(0);
      expect(tracker.current()).toEqual({
        usageBytes: 1000,
        quotaBytes: 5000,
        persisted: true,
      });
    });

    it('a later subscriber polls afresh and is told the new value; current() answers at once', async () => {
      const storage = mkStorage(1, 10);
      const { tracker, seen } = setup(storage);
      const off = tracker.on('storageEstimate', () => {});
      await flush();
      off();
      storage.estimate.mockImplementation(() => Promise.resolve({ usage: 2, quota: 10 }));
      tracker.on('storageEstimate', (e) => seen.push(e));
      expect(tracker.current()).toEqual({
        usageBytes: 1,
        quotaBytes: 10,
        persisted: true,
      });
      await flush();
      expect(storage.estimate).toHaveBeenCalledTimes(2);
      expect(seen).toEqual([{ usageBytes: 2, quotaBytes: 10, persisted: true }]);
    });

    it('a failed poll never erases the retained estimate', async () => {
      const storage = mkStorage(1, 10);
      const { tracker, scheduler } = setup(storage);
      tracker.on('storageEstimate', () => {});
      await flush();
      storage.estimate.mockImplementation(() => Promise.reject(new Error('later')));
      storage.persisted.mockImplementation(() => Promise.reject(new Error('later')));
      scheduler.tick();
      await flush();
      expect(tracker.current()).toEqual({
        usageBytes: 1,
        quotaBytes: 10,
        persisted: true,
      });
    });

    describe('partial polls merge into the retained estimate', () => {
      const first = { usageBytes: 1, quotaBytes: 10, persisted: true };

      it('a later estimate() rejection keeps usage/quota, takes the new persisted, and does not renew the age', async () => {
        const storage = mkStorage(1, 10, true);
        const { tracker, scheduler, clock, seen } = setup(storage);
        tracker.on('storageEstimate', (e) => seen.push(e));
        await flush();
        expect(tracker.current()).toEqual(first);
        storage.estimate.mockImplementation(() => Promise.reject(new Error('estimate down')));
        storage.persisted.mockImplementation(() => Promise.resolve(false));
        clock.t += 1234;
        scheduler.tick();
        await flush();
        expect(tracker.current()).toEqual({ usageBytes: 1, quotaBytes: 10, persisted: false });
        expect(seen.at(-1)).toEqual({ usageBytes: 1, quotaBytes: 10, persisted: false });
        // age is still that of the usage/quota refresh (t0), not of the persisted-only poll
        clock.t += 1234 + 1; // 2x1234 + 1 after t0
        expect(tracker.currentFresh()).toBeUndefined();
      });

      it('keeps each of usage and quota independently (only one was ever known)', async () => {
        for (const [known, other] of [
          [{ usage: 5, quota: null }, { usageBytes: 5 }],
          [{ usage: null, quota: 7 }, { quotaBytes: 7 }],
        ] as const) {
          const storage = {
            estimate: vi.fn(() => Promise.resolve(known)),
            persisted: vi.fn(() => Promise.resolve(true)),
          };
          const { tracker, scheduler } = setup(storage as unknown as StorageManagerLike);
          tracker.on('storageEstimate', () => {});
          await flush();
          storage.estimate.mockImplementation(() => Promise.reject(new Error('down')));
          scheduler.tick();
          await flush();
          expect(tracker.current()).toEqual({ ...other, persisted: true });
        }
      });

      it('refreshing only usage, or only quota, renews the age', async () => {
        for (const answer of [
          { usage: 3, quota: null },
          { usage: null, quota: 3 },
        ]) {
          const storage = mkStorage(1, 10, true);
          const { tracker, scheduler, clock } = setup(storage);
          tracker.on('storageEstimate', () => {});
          await flush();
          clock.t += 2 * 1234;
          storage.estimate.mockImplementation(() => Promise.resolve(answer));
          scheduler.tick();
          await flush();
          clock.t += 2 * 1234; // 2x after the refresh, 4x after the first poll
          expect(tracker.currentFresh()).toBeDefined();
        }
      });

      it('a later persisted() rejection keeps the retained persisted and takes the new usage/quota', async () => {
        const storage = mkStorage(1, 10, true);
        const { tracker, scheduler } = setup(storage);
        tracker.on('storageEstimate', () => {});
        await flush();
        storage.estimate.mockImplementation(() => Promise.resolve({ usage: 2, quota: 20 }));
        storage.persisted.mockImplementation(() => Promise.reject(new Error('persisted down')));
        scheduler.tick();
        await flush();
        expect(tracker.current()).toEqual({ usageBytes: 2, quotaBytes: 20, persisted: true });
      });

      it('an estimate() that ANSWERS with an unusable number drops that field rather than keeping the old one', async () => {
        const storage = mkStorage(1, 10, true);
        const { tracker, scheduler } = setup(storage);
        tracker.on('storageEstimate', () => {});
        await flush();
        storage.estimate.mockImplementation(() =>
          Promise.resolve({ usage: Number.NaN, quota: 20 }),
        );
        scheduler.tick();
        await flush();
        expect(tracker.current()).toEqual({ quotaBytes: 20, persisted: true });
      });

      it('an estimate() that answers with nothing usable does not renew the age or the usage/quota', async () => {
        const storage = mkStorage(1, 10, true);
        const { tracker, scheduler, clock } = setup(storage);
        tracker.on('storageEstimate', () => {});
        await flush();
        storage.estimate.mockImplementation(() => Promise.resolve({ usage: -1, quota: -1 }));
        clock.t += 2 * 1234 + 1;
        scheduler.tick();
        await flush();
        expect(tracker.current()).toEqual({ persisted: true });
        expect(tracker.currentFresh()).toBeUndefined();
      });
    });

    it('a poll in flight at the last unsubscribe is inert when it settles', async () => {
      let resolve!: (v: { usage: number; quota: number }) => void;
      const storage = {
        estimate: vi.fn(() => new Promise<{ usage: number; quota: number }>((r) => (resolve = r))),
        persisted: () => Promise.resolve(true),
      };
      const { tracker, seen } = setup(storage);
      const off = tracker.on('storageEstimate', (e) => seen.push(e));
      off();
      resolve({ usage: 1, quota: 2 });
      await flush();
      expect(seen).toEqual([]);
      expect(tracker.current()).toBeUndefined();
    });

    it('a stale poll from a previous activation cannot overwrite the new one', async () => {
      const resolvers: Array<(v: { usage: number; quota: number }) => void> = [];
      const storage = {
        estimate: vi.fn(
          () => new Promise<{ usage: number; quota: number }>((r) => resolvers.push(r)),
        ),
        persisted: () => Promise.resolve(true),
      };
      const { tracker, seen } = setup(storage);
      const off = tracker.on('storageEstimate', () => {});
      off();
      tracker.on('storageEstimate', (e) => seen.push(e));
      resolvers[1]?.({ usage: 2, quota: 2 });
      await flush();
      resolvers[0]?.({ usage: 1, quota: 1 });
      await flush();
      expect(seen).toEqual([{ usageBytes: 2, quotaBytes: 2, persisted: true }]);
    });

    it('an older poll superseded by a newer one is ignored even within one activation', async () => {
      const resolvers: Array<(v: { usage: number; quota: number }) => void> = [];
      const storage = {
        estimate: vi.fn(
          () => new Promise<{ usage: number; quota: number }>((r) => resolvers.push(r)),
        ),
        persisted: () => Promise.resolve(true),
      };
      const { tracker, seen, scheduler } = setup(storage);
      tracker.on('storageEstimate', (e) => seen.push(e));
      scheduler.tick();
      resolvers[1]?.({ usage: 2, quota: 2 });
      await flush();
      resolvers[0]?.({ usage: 1, quota: 1 });
      await flush();
      expect(seen).toEqual([{ usageBytes: 2, quotaBytes: 2, persisted: true }]);
    });

    it('reset forgets the estimate, releases everything and ignores in-flight work', async () => {
      const { tracker, scheduler, document, seen } = setup();
      tracker.on('storageEstimate', (e) => seen.push(e));
      tracker.reset();
      await flush();
      expect(seen).toEqual([]);
      expect(tracker.current()).toBeUndefined();
      expect(scheduler.live.size).toBe(0);
      expect(document.count()).toBe(0);
    });

    it('reset after a settled poll clears the retained estimate', async () => {
      const { tracker } = setup();
      tracker.on('storageEstimate', () => {});
      await flush();
      tracker.reset();
      expect(tracker.current()).toBeUndefined();
    });
  });

  describe('resource failures', () => {
    it('a throwing scheduler.setInterval is reported and the immediate poll still happens', async () => {
      const err = new Error('no timers');
      const storage = mkStorage();
      const onError = vi.fn();
      const t = new StorageTracker(
        {
          navigator: { storage },
          scheduler: {
            setInterval: () => {
              throw err;
            },
            clearInterval: () => {},
          },
        },
        onError,
      );
      const seen: StorageEstimate[] = [];
      expect(() => t.on('storageEstimate', (e) => seen.push(e))).not.toThrow();
      await flush();
      expect(onError).toHaveBeenCalledWith(err);
      expect(seen).toHaveLength(1);
    });

    it('a throwing clearInterval is reported and does not stop the release of the listener', () => {
      const err = new Error('no clear');
      const document = mkDocument();
      const onError = vi.fn();
      const t = new StorageTracker(
        {
          navigator: { storage: mkStorage() },
          document,
          scheduler: {
            setInterval: () => 1,
            clearInterval: () => {
              throw err;
            },
          },
        },
        onError,
      );
      const off = t.on('storageEstimate', () => {});
      off();
      expect(onError).toHaveBeenCalledWith(err);
      expect(document.count()).toBe(0);
    });

    it('a timer handle of undefined is still cleared', () => {
      const clear = vi.fn();
      const t = new StorageTracker({
        navigator: { storage: mkStorage() },
        scheduler: { setInterval: () => undefined, clearInterval: clear },
      });
      t.on('storageEstimate', () => {})();
      expect(clear).toHaveBeenCalledWith(undefined);
    });

    it('a throwing addEventListener is reported and the tracker still polls and keeps its timer', async () => {
      const err = new Error('no listener');
      const onError = vi.fn();
      const scheduler = mkScheduler();
      const document = {
        ...mkDocument(),
        addEventListener: () => {
          throw err;
        },
      };
      const t = new StorageTracker(
        { navigator: { storage: mkStorage() }, document, scheduler },
        onError,
      );
      const seen: StorageEstimate[] = [];
      const off = t.on('storageEstimate', (e) => seen.push(e));
      await flush();
      expect(onError).toHaveBeenCalledWith(err);
      expect(seen).toHaveLength(1);
      expect(scheduler.live.size).toBe(1);
      scheduler.tick();
      await flush();
      expect(seen).toHaveLength(2);
      off();
    });

    it('a throwing removeEventListener is swallowed', () => {
      const document = {
        ...mkDocument(),
        removeEventListener: () => {
          throw new Error('rm');
        },
      };
      const onError = vi.fn();
      const t = new StorageTracker(
        {
          navigator: { storage: mkStorage() },
          document,
          scheduler: mkScheduler(),
        },
        onError,
      );
      expect(() => t.on('storageEstimate', () => {})()).not.toThrow();
      expect(onError).not.toHaveBeenCalled();
    });

    it('a document without add/removeEventListener is tolerated', () => {
      const t = new StorageTracker({
        navigator: { storage: mkStorage() },
        document: { visibilityState: 'visible' },
        scheduler: mkScheduler(),
      });
      expect(() => t.on('storageEstimate', () => {})()).not.toThrow();
    });

    it('a throwing document getter is reported and the tracker still polls', async () => {
      const err = new Error('doc torn down');
      const onError = vi.fn();
      const env = {
        navigator: { storage: mkStorage() },
        scheduler: mkScheduler(),
        get document(): never {
          throw err;
        },
      };
      const t = new StorageTracker(env, onError);
      t.on('storageEstimate', () => {});
      await flush();
      expect(onError).toHaveBeenCalledWith(err);
      expect(t.current()).toBeDefined();
    });

    it('a throwing visibilityState is reported: the listener does not poll, the timer does', () => {
      const err = new Error('vis');
      const storage = mkStorage();
      const scheduler = mkScheduler();
      const onError = vi.fn();
      const listeners = new Set<() => void>();
      const document = {
        get visibilityState(): string {
          throw err;
        },
        addEventListener: (_t: string, l: () => void) => void listeners.add(l),
        removeEventListener: () => {},
      };
      const t = new StorageTracker({ navigator: { storage }, document, scheduler }, onError);
      t.on('storageEstimate', () => {});
      for (const l of [...listeners]) l();
      expect(storage.estimate).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(err);
      scheduler.tick(); // unreadable state is not "hidden": still polls
      expect(storage.estimate).toHaveBeenCalledTimes(2);
    });
  });

  describe('rebind', () => {
    it('a defined onError replaces the reporter; undefined keeps it', async () => {
      const first = vi.fn();
      const second = vi.fn();
      const storage = {
        ...mkStorage(),
        estimate: () => Promise.reject(new Error('e')),
      };
      const t = new StorageTracker({ navigator: { storage }, scheduler: mkScheduler() }, first);
      t.rebind({}, second);
      t.rebind({}, undefined);
      t.on('storageEstimate', () => {});
      await flush();
      expect(second).toHaveBeenCalled();
      expect(first).not.toHaveBeenCalled();
    });

    it('while idle the new seams replace ours; undefined ones never clobber', () => {
      const a = mkStorage();
      const b = mkStorage();
      const sched = mkScheduler();
      const t = new StorageTracker({
        navigator: { storage: a },
        scheduler: sched,
        intervalMs: 5,
      });
      t.rebind({ navigator: { storage: b }, intervalMs: 7 });
      const off = t.on('storageEstimate', () => {});
      expect(b.estimate).toHaveBeenCalledTimes(1);
      expect(a.estimate).not.toHaveBeenCalled();
      expect(sched.periods).toEqual([7]);
      off();
      t.rebind({});
      t.on('storageEstimate', () => {});
      expect(b.estimate).toHaveBeenCalledTimes(2);
    });

    it('rebinding the document and scheduler while idle takes effect on the next activation', () => {
      const doc1 = mkDocument();
      const doc2 = mkDocument();
      const s1 = mkScheduler();
      const s2 = mkScheduler();
      const t = new StorageTracker({
        navigator: { storage: mkStorage() },
        document: doc1,
        scheduler: s1,
      });
      t.rebind({ document: doc2, scheduler: s2 });
      t.on('storageEstimate', () => {});
      expect(doc1.count()).toBe(0);
      expect(doc2.count()).toBe(1);
      expect(s2.live.size).toBe(1);
      expect(s1.live.size).toBe(0);
    });

    it('while running the attached bindings are kept and the new seams apply on the next activation', async () => {
      const a = mkStorage();
      const b = mkStorage();
      const doc1 = mkDocument();
      const doc2 = mkDocument();
      const s1 = mkScheduler();
      const s2 = mkScheduler();
      const t = new StorageTracker({ navigator: { storage: a }, document: doc1, scheduler: s1 });
      const off = t.on('storageEstimate', () => {});
      t.rebind(
        { navigator: { storage: b }, document: doc2, scheduler: s2, intervalMs: 9 },
        vi.fn(),
      );
      s1.tick();
      expect(a.estimate).toHaveBeenCalledTimes(2);
      expect(b.estimate).not.toHaveBeenCalled();
      expect(s2.live.size + doc2.count()).toBe(0);
      off();
      expect(doc1.count()).toBe(0);
      expect(s1.live.size).toBe(0); // released from the scheduler it was armed on
      t.on('storageEstimate', () => {});
      expect(b.estimate).toHaveBeenCalledTimes(1);
      expect(a.estimate).toHaveBeenCalledTimes(2);
      expect(s2.periods).toEqual([9]);
      expect(s2.live.size).toBe(1);
      expect(doc2.count()).toBe(1);
      expect(s1.live.size + doc1.count()).toBe(0);
    });

    it('successive rebinds while running accumulate (an undefined seam never clobbers)', () => {
      const b = mkStorage();
      const s2 = mkScheduler();
      const t = new StorageTracker({
        navigator: { storage: mkStorage() },
        scheduler: mkScheduler(),
      });
      const off = t.on('storageEstimate', () => {});
      t.rebind({ navigator: { storage: b } });
      t.rebind({ scheduler: s2 });
      off();
      t.on('storageEstimate', () => {});
      expect(b.estimate).toHaveBeenCalledTimes(1);
      expect(s2.live.size).toBe(1);
    });

    it('rebinding the clock takes effect on the next activation', async () => {
      const clock = { t: 0 };
      const t = new StorageTracker({
        navigator: { storage: mkStorage() },
        scheduler: mkScheduler(),
      });
      t.rebind({ now: () => clock.t });
      const off = t.on('storageEstimate', () => {});
      await flush();
      off();
      expect(t.currentFresh()).toBeDefined();
      clock.t = 600_001; // 2 x the 5 minute default, on the REBOUND clock
      expect(t.currentFresh()).toBeUndefined();
    });
  });
});

describe('storageTrackerFor / resetStorageTracker', () => {
  it('is a singleton per window, distinct per window', () => {
    const w1 = {};
    const w2 = {};
    const a = storageTrackerFor({ window: w1 });
    expect(storageTrackerFor({ window: w1 })).toBe(a);
    expect(storageTrackerFor({ window: w2 })).not.toBe(a);
    resetStorageTracker({ window: w1 });
    resetStorageTracker({ window: w2 });
  });

  it('keys on the window, else the navigator, else the env object', () => {
    const nav = {};
    expect(storageTrackerFor({ navigator: nav })).toBe(storageTrackerFor({ navigator: nav }));
    const envA = {};
    const envB = {};
    expect(storageTrackerFor(envA)).not.toBe(storageTrackerFor(envB));
    expect(storageTrackerFor(envA)).toBe(storageTrackerFor(envA));
    // a window key wins over the navigator
    const w = {};
    expect(storageTrackerFor({ window: w, navigator: {} })).toBe(
      storageTrackerFor({ window: w, navigator: {} }),
    );
    resetStorageTracker({ navigator: nav });
    resetStorageTracker(envA);
    resetStorageTracker(envB);
    resetStorageTracker({ window: w });
  });

  it('a throwing window getter is reported and falls back to the navigator key', () => {
    const err = new Error('hostile');
    const nav = {};
    const onError = vi.fn();
    const env = {
      navigator: nav,
      get window(): never {
        throw err;
      },
    };
    const t = storageTrackerFor(env, onError);
    expect(onError).toHaveBeenCalledWith(err);
    expect(storageTrackerFor({ navigator: nav })).toBe(t);
    resetStorageTracker({ navigator: nav });
  });

  it('a relaunch hands the latest seams and onError to the shared tracker', async () => {
    const w = {};
    const first = vi.fn();
    const second = vi.fn();
    const storage = {
      ...mkStorage(),
      estimate: () => Promise.reject(new Error('x')),
    };
    const sched = mkScheduler();
    const a = storageTrackerFor({ window: w }, first);
    const b = storageTrackerFor({ window: w, navigator: { storage }, scheduler: sched }, second);
    expect(b).toBe(a);
    a.on('storageEstimate', () => {});
    await flush();
    expect(second).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    expect(sched.live.size).toBe(1);
    resetStorageTracker({ window: w });
    expect(sched.live.size).toBe(0); // reset released the timer
    expect(storageTrackerFor({ window: w })).not.toBe(a);
    resetStorageTracker({ window: w });
  });

  it('passes the clock through to the shared tracker', async () => {
    const w = {};
    const clock = { t: 0 };
    const t = storageTrackerFor({
      window: w,
      navigator: { storage: mkStorage() },
      scheduler: mkScheduler(),
      now: () => clock.t,
    });
    const off = t.on('storageEstimate', () => {});
    await flush();
    off();
    clock.t = 600_001;
    expect(t.currentFresh()).toBeUndefined();
    resetStorageTracker({ window: w });
  });

  it('resetting an unknown env is a no-op', () => {
    expect(() => resetStorageTracker({ window: {} })).not.toThrow();
  });

  it('passes document/intervalMs through', () => {
    const w = {};
    const doc = mkDocument();
    const sched = mkScheduler();
    storageTrackerFor({
      window: w,
      navigator: { storage: mkStorage() },
      document: doc,
      scheduler: sched,
      intervalMs: 42,
    }).on('storageEstimate', () => {});
    expect(sched.periods).toEqual([42]);
    expect(doc.count()).toBe(1);
    resetStorageTracker({ window: w });
  });
});
