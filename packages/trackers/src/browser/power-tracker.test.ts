import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BatteryManagerLike,
  type BatteryState,
  PowerTracker,
  powerTrackerFor,
  resetPowerTracker,
} from './power-tracker';

function mkManager(level = 0.5, charging = false) {
  const listeners = new Map<string, Set<() => void>>();
  const set = (t: string): Set<() => void> => {
    let s = listeners.get(t);
    if (s === undefined) {
      s = new Set();
      listeners.set(t, s);
    }
    return s;
  };
  return {
    level,
    charging,
    addEventListener: (t: string, l: () => void) => {
      set(t).add(l);
    },
    removeEventListener: (t: string, l: () => void) => void listeners.get(t)?.delete(l),
    fire: (t: string) =>
      listeners.get(t)?.forEach((l) => {
        l();
      }),
    has: (t: string) => (listeners.get(t)?.size ?? 0) > 0,
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

const flush = (): Promise<void> =>
  new Promise((r) =>
    (globalThis as unknown as { setTimeout(f: () => void, ms: number): void }).setTimeout(
      () => r(),
      0,
    ),
  );

describe('PowerTracker', () => {
  it('does not call getBattery at construction', () => {
    const getBattery = vi.fn();
    new PowerTracker({ getBattery });
    expect(getBattery).not.toHaveBeenCalled();
  });

  it('calls getBattery once on the first subscriber only, then attaches listeners and emits state', async () => {
    const m = mkManager(0.5, true);
    const getBattery = vi.fn(() => Promise.resolve(m));
    const t = new PowerTracker({ getBattery });
    const a: BatteryState[] = [];
    const b: BatteryState[] = [];
    t.on('state', (s) => a.push(s));
    t.on('state', (s) => b.push(s));
    expect(getBattery).toHaveBeenCalledTimes(1);
    expect(t.current()).toBeUndefined();
    await flush();
    expect(m.has('levelchange')).toBe(true);
    expect(m.has('chargingchange')).toBe(true);
    expect(m.has('chargingtimechange')).toBe(true);
    expect(m.has('dischargingtimechange')).toBe(true);
    expect(a).toEqual([{ level: 0.5, charging: true }]);
    expect(b).toEqual(a);
    expect(t.current()).toEqual({ level: 0.5, charging: true });
  });

  it('re-emits the new state on levelchange and chargingchange', async () => {
    const m = mkManager(0.5, false);
    const t = new PowerTracker({ getBattery: () => Promise.resolve(m) });
    const seen: BatteryState[] = [];
    t.on('state', (s) => seen.push(s));
    await flush();
    m.level = 0.4;
    m.fire('levelchange');
    m.charging = true;
    m.fire('chargingchange');
    expect(seen).toEqual([
      { level: 0.5, charging: false },
      { level: 0.4, charging: false },
      { level: 0.4, charging: true },
    ]);
    expect(t.current()).toEqual({ level: 0.4, charging: true });
  });

  it('last unsubscribe removes all four listeners but RETAINS current()', async () => {
    const m = mkManager();
    const t = new PowerTracker({ getBattery: () => Promise.resolve(m) });
    const off1 = t.on('state', () => {});
    const off2 = t.on('state', () => {});
    await flush();
    off1();
    expect(m.count()).toBe(4);
    off2();
    expect(m.count()).toBe(0);
    expect(t.current()).toEqual({ level: 0.5, charging: false });
  });

  it('stop before resolve: the late resolve attaches nothing and emits nothing', async () => {
    const m = mkManager();
    let resolve: (v: BatteryManagerLike) => void = () => {};
    const t = new PowerTracker({ getBattery: () => new Promise((r) => (resolve = r)) });
    const seen: BatteryState[] = [];
    const off = t.on('state', (s) => seen.push(s));
    off();
    resolve(m);
    await flush();
    expect(m.count()).toBe(0);
    expect(seen).toEqual([]);
    expect(t.current()).toBeUndefined();
  });

  it('stop -> start: the old promise resolving late is ignored, the new one applies', async () => {
    const oldM = mkManager(0.1);
    const newM = mkManager(0.9);
    const resolvers: Array<(v: BatteryManagerLike) => void> = [];
    const t = new PowerTracker({
      getBattery: () => new Promise((r) => resolvers.push(r)),
    });
    const seen: BatteryState[] = [];
    t.on('state', (s) => seen.push(s))();
    t.on('state', (s) => seen.push(s));
    expect(resolvers).toHaveLength(2);
    resolvers[1]?.(newM);
    await flush();
    resolvers[0]?.(oldM);
    await flush();
    expect(oldM.count()).toBe(0);
    expect(newM.count()).toBe(4);
    expect(seen).toEqual([{ level: 0.9, charging: false }]);
  });

  it('a rejecting getBattery neither throws nor emits', async () => {
    const t = new PowerTracker({ getBattery: () => Promise.reject(new Error('denied')) });
    const seen: BatteryState[] = [];
    expect(() => t.on('state', (s) => seen.push(s))).not.toThrow();
    await flush();
    expect(seen).toEqual([]);
    expect(t.current()).toBeUndefined();
  });

  it('a synchronously throwing getBattery neither throws nor emits', () => {
    const t = new PowerTracker({
      getBattery: () => {
        throw new Error('SecurityError');
      },
    });
    const seen: BatteryState[] = [];
    expect(() => t.on('state', (s) => seen.push(s))).not.toThrow();
    expect(seen).toEqual([]);
  });

  it('an env without getBattery is inert', () => {
    const t = new PowerTracker({});
    expect(() => t.on('state', () => {})).not.toThrow();
    expect(t.current()).toBeUndefined();
  });

  it('a manager without addEventListener still emits the one baseline', async () => {
    const t = new PowerTracker({
      getBattery: () => Promise.resolve({ level: 0.3, charging: true }),
    });
    const seen: BatteryState[] = [];
    const off = t.on('state', (s) => seen.push(s));
    await flush();
    expect(seen).toEqual([{ level: 0.3, charging: true }]);
    expect(() => off()).not.toThrow();
  });

  it('a subscriber that leaves synchronously during the baseline publish leaves nothing attached', async () => {
    const m = mkManager(0.5, false);
    const t = new PowerTracker({ getBattery: () => Promise.resolve(m) });
    const off = t.on('state', () => off());
    await flush();
    expect(m.count()).toBe(0);
  });

  it('a throwing removeEventListener on the last unsubscribe does not throw out of off()', async () => {
    const m = mkManager();
    const t = new PowerTracker({ getBattery: () => Promise.resolve(m) });
    const off = t.on('state', () => {});
    await flush();
    m.removeEventListener = () => {
      throw new Error('remove refused');
    };
    expect(() => off()).not.toThrow();
  });

  describe('a throw AFTER getBattery() resolves (inside the fulfilment)', () => {
    // A throw inside the .then() callback rejects the derived promise, which nothing handles.
    // The suite runs on Node: its process-level hook is the observable for an unhandled rejection.
    const proc = (
      globalThis as unknown as {
        process: {
          on(event: string, fn: (reason: unknown) => void): void;
          off(event: string, fn: (reason: unknown) => void): void;
        };
      }
    ).process;
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    beforeEach(() => {
      rejections.length = 0;
      proc.on('unhandledRejection', onRejection);
    });
    afterEach(() => {
      proc.off('unhandledRejection', onRejection);
    });
    const settle = async (): Promise<void> => {
      await flush();
      await flush(); // unhandledRejection is emitted after a macrotask turn
    };

    it('addEventListener throwing: onError, no unhandled rejection, no baseline, nothing left attached; a later re-activation works', async () => {
      const m = mkManager(0.7, true);
      const realAdd = m.addEventListener;
      let refuse = true;
      m.addEventListener = (t: string, l: () => void) => {
        if (refuse && t === 'chargingchange') throw new Error('add refused');
        realAdd(t, l);
      };
      const errors: unknown[] = [];
      const t = new PowerTracker({ getBattery: () => Promise.resolve(m) }, (e) => errors.push(e));
      const seen: BatteryState[] = [];
      const off = t.on('state', (s) => seen.push(s));
      await settle();
      expect(rejections).toEqual([]);
      expect((errors[0] as Error).message).toBe('add refused');
      expect(seen).toEqual([]);
      expect(t.current()).toBeUndefined();
      expect(m.count()).toBe(0); // the levelchange listener attached before the throw was removed
      const realRemove = m.removeEventListener;
      let removes = 0;
      m.removeEventListener = (type: string, l: () => void) => {
        removes += 1;
        realRemove(type, l);
      };
      off();
      expect(removes).toBe(0); // already detached: the deactivation finds nothing left to remove
      refuse = false;
      t.on('state', (s) => seen.push(s));
      await settle();
      expect(seen).toEqual([{ level: 0.7, charging: true }]);
      expect(m.count()).toBe(4);
      expect(errors).toHaveLength(1);
    });

    it('a level getter throwing: onError, no unhandled rejection, no baseline, listeners removed', async () => {
      const m = mkManager();
      let broken = true;
      Object.defineProperty(m, 'level', {
        get: () => {
          if (broken) throw new Error('level boom');
          return 0.25;
        },
      });
      const errors: unknown[] = [];
      const t = new PowerTracker({ getBattery: () => Promise.resolve(m) }, (e) => errors.push(e));
      const seen: BatteryState[] = [];
      const off = t.on('state', (s) => seen.push(s));
      await settle();
      expect(rejections).toEqual([]);
      expect((errors[0] as Error).message).toBe('level boom');
      expect(seen).toEqual([]);
      expect(t.current()).toBeUndefined();
      expect(m.count()).toBe(0);
      off();
      broken = false;
      t.on('state', (s) => seen.push(s));
      await settle();
      expect(seen).toEqual([{ level: 0.25, charging: false }]);
    });

    it('a throwing removeEventListener during the unwind is swallowed; without onError nothing escapes', async () => {
      const m = mkManager();
      m.addEventListener = (t: string) => {
        if (t === 'chargingchange') throw new Error('add refused');
      };
      m.removeEventListener = () => {
        throw new Error('remove refused');
      };
      const t = new PowerTracker({ getBattery: () => Promise.resolve(m) });
      const seen: BatteryState[] = [];
      t.on('state', (s) => seen.push(s));
      await settle();
      expect(rejections).toEqual([]);
      expect(seen).toEqual([]);
    });

    it('a getter throwing on a LATER levelchange is reported, never thrown into the event dispatch', async () => {
      const m = mkManager(0.5, false);
      const errors: unknown[] = [];
      const t = new PowerTracker({ getBattery: () => Promise.resolve(m) }, (e) => errors.push(e));
      const seen: BatteryState[] = [];
      t.on('state', (s) => seen.push(s));
      await settle();
      Object.defineProperty(m, 'level', {
        get: () => {
          throw new Error('late boom');
        },
      });
      expect(() => m.fire('levelchange')).not.toThrow();
      expect((errors[0] as Error).message).toBe('late boom');
      expect(seen).toEqual([{ level: 0.5, charging: false }]);
      expect(t.current()).toEqual({ level: 0.5, charging: false }); // last good state kept
    });
  });

  describe('full Battery Status API', () => {
    const seenOf = async (m: ReturnType<typeof mkManager>, extra: object = {}) => {
      Object.assign(m, extra);
      const t = new PowerTracker({ getBattery: () => Promise.resolve(m) });
      const seen: BatteryState[] = [];
      t.on('state', (s) => seen.push(s));
      await flush();
      return { t, seen };
    };

    it('includes finite non-negative times (seconds) in the snapshot', async () => {
      const { seen } = await seenOf(mkManager(0.5, true), {
        chargingTime: 600,
        dischargingTime: 90,
      });
      expect(seen).toEqual([
        { level: 0.5, charging: true, chargingTimeS: 600, dischargingTimeS: 90 },
      ]);
    });

    it.each([
      Infinity,
      -Infinity,
      NaN,
      -1,
      '5',
      null,
      undefined,
    ])('omits a time of %s', async (bad) => {
      const { seen } = await seenOf(mkManager(0.5, false), {
        chargingTime: bad,
        dischargingTime: bad,
      });
      expect(seen).toEqual([{ level: 0.5, charging: false }]);
      expect(Object.keys(seen[0] as object)).toEqual(['level', 'charging']);
    });

    it('omits one bad time and keeps the other', async () => {
      const { seen } = await seenOf(mkManager(0.5, false), {
        chargingTime: Infinity,
        dischargingTime: 90,
      });
      expect(seen).toEqual([{ level: 0.5, charging: false, dischargingTimeS: 90 }]);
    });

    it.each([
      ['levelchange', 'level', 0.25],
      ['chargingchange', 'charging', true],
      ['chargingtimechange', 'chargingTime', 120],
      ['dischargingtimechange', 'dischargingTime', 3000],
    ])('%s publishes a fresh snapshot', async (event, field, value) => {
      const m = mkManager(0.5, false);
      const { t, seen } = await seenOf(m, { chargingTime: Infinity, dischargingTime: Infinity });
      (m as unknown as Record<string, unknown>)[field] = value;
      m.fire(event);
      expect(seen).toHaveLength(2);
      expect(seen[1]).toEqual(t.current());
      const expected: Record<string, unknown> = {
        level: field === 'level' ? value : 0.5,
        charging: field === 'charging' ? value : false,
      };
      if (field === 'chargingTime') expected.chargingTimeS = value;
      if (field === 'dischargingTime') expected.dischargingTimeS = value;
      expect(seen[1]).toEqual(expected);
    });

    it('a time that becomes Infinity disappears from the next snapshot', async () => {
      const m = Object.assign(mkManager(0.5, true), { chargingTime: 100 });
      const { seen } = await seenOf(m);
      m.chargingTime = Infinity;
      m.fire('chargingtimechange');
      expect(seen[1]).toEqual({ level: 0.5, charging: true });
    });

    it('a throwing dischargingTime getter is reported and costs only that field', async () => {
      const m = mkManager(0.5, false);
      Object.defineProperty(m, 'dischargingTime', {
        get: () => {
          throw new Error('dtime boom');
        },
      });
      Object.assign(m, { chargingTime: 10 });
      const errors: unknown[] = [];
      const t = new PowerTracker({ getBattery: () => Promise.resolve(m) }, (e) => errors.push(e));
      const seen: BatteryState[] = [];
      t.on('state', (s) => seen.push(s));
      await flush();
      expect(seen).toEqual([{ level: 0.5, charging: false, chargingTimeS: 10 }]);
      expect((errors[0] as Error).message).toBe('dtime boom');
    });

    it('a throwing time getter is reported and costs only that field', async () => {
      const m = mkManager(0.5, false);
      Object.defineProperty(m, 'chargingTime', {
        get: () => {
          throw new Error('time boom');
        },
      });
      Object.assign(m, { dischargingTime: 10 });
      const errors: unknown[] = [];
      const t = new PowerTracker({ getBattery: () => Promise.resolve(m) }, (e) => errors.push(e));
      const seen: BatteryState[] = [];
      t.on('state', (s) => seen.push(s));
      await flush();
      expect(seen).toEqual([{ level: 0.5, charging: false, dischargingTimeS: 10 }]);
      expect((errors[0] as Error).message).toBe('time boom');
    });
  });

  describe('retention', () => {
    it('keeps the manager and snapshot across last-unsubscribe / re-subscribe: no second getBattery, fresh snapshot, listeners re-attached', async () => {
      const m = mkManager(0.5, false);
      const getBattery = vi.fn(() => Promise.resolve(m));
      const t = new PowerTracker({ getBattery });
      const seen: BatteryState[] = [];
      const off = t.on('state', (s) => seen.push(s));
      await flush();
      off();
      expect(m.count()).toBe(0);
      expect(t.current()).toEqual({ level: 0.5, charging: false });
      m.level = 0.4; // changed while nobody listened
      const seen2: BatteryState[] = [];
      t.on('state', (s) => seen2.push(s));
      expect(getBattery).toHaveBeenCalledTimes(1);
      expect(m.count()).toBe(4);
      expect(seen2).toEqual([{ level: 0.4, charging: false }]); // synchronous, fresh
      expect(t.current()).toEqual({ level: 0.4, charging: false });
    });

    it('a rejected getBattery is retried on the next activation', async () => {
      const m = mkManager(0.5, false);
      const getBattery = vi
        .fn<() => Promise<BatteryManagerLike>>()
        .mockRejectedValueOnce(new Error('denied'))
        .mockResolvedValue(m);
      const t = new PowerTracker({ getBattery });
      const off = t.on('state', () => {});
      await flush(); // rejection settled while still subscribed
      off();
      const seen: BatteryState[] = [];
      t.on('state', (s) => seen.push(s));
      await flush();
      expect(getBattery).toHaveBeenCalledTimes(2);
      expect(seen).toHaveLength(1);
    });

    it('a late resolve after the last unsubscribe is ignored and NOT retained (next activation asks again)', async () => {
      const m = mkManager(0.5, false);
      const resolvers: Array<(v: BatteryManagerLike) => void> = [];
      const getBattery = vi.fn(() => new Promise<BatteryManagerLike>((r) => resolvers.push(r)));
      const t = new PowerTracker({ getBattery });
      t.on('state', () => {})();
      resolvers[0]?.(m);
      await flush();
      expect(m.count()).toBe(0);
      expect(t.current()).toBeUndefined();
      t.on('state', () => {});
      expect(getBattery).toHaveBeenCalledTimes(2);
    });

    it('reset() releases listeners and forgets the manager and snapshot', async () => {
      const m = mkManager(0.5, false);
      const getBattery = vi.fn(() => Promise.resolve(m));
      const t = new PowerTracker({ getBattery });
      const off = t.on('state', () => {});
      await flush();
      t.reset();
      expect(m.count()).toBe(0);
      expect(t.current()).toBeUndefined();
      off();
      t.on('state', () => {});
      expect(getBattery).toHaveBeenCalledTimes(2);
    });

    it('a failed attach on re-activation keeps the manager and reports', async () => {
      const m = mkManager(0.5, false);
      const getBattery = vi.fn(() => Promise.resolve(m));
      const errors: unknown[] = [];
      const t = new PowerTracker({ getBattery }, (e) => errors.push(e));
      const off = t.on('state', () => {});
      await flush();
      off();
      Object.defineProperty(m, 'level', {
        get: () => {
          throw new Error('stale boom');
        },
      });
      t.on('state', () => {});
      expect(errors).toHaveLength(1);
      expect(t.current()).toBeUndefined();
      expect(m.count()).toBe(0);
      expect(getBattery).toHaveBeenCalledTimes(1);
    });
  });

  describe('powerTrackerFor (singleton per key)', () => {
    it('returns the same tracker for the same window and distinct ones for distinct windows', () => {
      const w1 = {};
      const w2 = {};
      const a = powerTrackerFor({ window: w1 });
      expect(
        powerTrackerFor({ window: w1, getBattery: () => Promise.reject(new Error('x')) }),
      ).toBe(a);
      expect(powerTrackerFor({ window: w2 })).not.toBe(a);
      resetPowerTracker({ window: w1 });
      expect(powerTrackerFor({ window: w1 })).not.toBe(a);
    });

    it('falls back to the navigator, then to the env object itself', () => {
      const nav = {};
      expect(powerTrackerFor({ navigator: nav })).toBe(powerTrackerFor({ navigator: nav }));
      const env = {};
      expect(powerTrackerFor(env)).toBe(powerTrackerFor(env));
      expect(powerTrackerFor({})).not.toBe(powerTrackerFor({}));
    });

    it('a hostile window getter falls back instead of throwing', () => {
      const env = {};
      Object.defineProperty(env, 'window', {
        get: () => {
          throw new Error('blocked');
        },
      });
      expect(() => powerTrackerFor(env)).not.toThrow();
      expect(powerTrackerFor(env)).toBe(powerTrackerFor(env));
    });

    it('reset releases the old tracker listeners', async () => {
      const w = {};
      const m = mkManager();
      const t = powerTrackerFor({ window: w, getBattery: () => Promise.resolve(m) });
      t.on('state', () => {});
      await flush();
      expect(m.count()).toBe(4);
      resetPowerTracker({ window: w });
      expect(m.count()).toBe(0);
    });
  });

  describe('honest values', () => {
    const snap = async (m: ReturnType<typeof mkManager>) => {
      const t = new PowerTracker({ getBattery: () => Promise.resolve(m) });
      const seen: BatteryState[] = [];
      t.on('state', (s) => seen.push(s));
      await flush();
      return seen;
    };

    it('omits a zero charging time when full and charging (battery-less desktop), keeps it otherwise', async () => {
      expect(await snap(Object.assign(mkManager(1, true), { chargingTime: 0 }))).toEqual([
        { level: 1, charging: true },
      ]);
      expect(await snap(Object.assign(mkManager(0.99, true), { chargingTime: 0 }))).toEqual([
        { level: 0.99, charging: true, chargingTimeS: 0 },
      ]);
      expect(await snap(Object.assign(mkManager(1, false), { chargingTime: 0 }))).toEqual([
        { level: 1, charging: false, chargingTimeS: 0 },
      ]);
    });

    it('omits a zero discharging time', async () => {
      expect(await snap(Object.assign(mkManager(0.5, false), { dischargingTime: 0 }))).toEqual([
        { level: 0.5, charging: false },
      ]);
    });

    it.each([NaN, Infinity, -0.1, 1.01, '0.5'])('omits an unusable level %s', async (bad) => {
      const seen = await snap(mkManager(bad as unknown as number, false));
      expect(seen).toEqual([{ charging: false }]);
      expect('level' in (seen[0] as object)).toBe(false);
    });

    it('accepts the boundary levels 0 and 1', async () => {
      expect((await snap(mkManager(0, false)))[0]?.level).toBe(0);
      expect((await snap(mkManager(1, false)))[0]?.level).toBe(1);
    });
  });

  describe('relaunch rebinding', () => {
    it('a relaunch on the SAME window reports to the NEW onError, not the dead one', async () => {
      const w = {};
      const m = mkManager();
      m.addEventListener = () => {
        throw new Error('add refused');
      };
      const a = vi.fn();
      const b = vi.fn();
      const getBattery = () => Promise.resolve(m);
      powerTrackerFor({ window: w, getBattery }, a);
      const t = powerTrackerFor({ window: w, getBattery }, b);
      t.on('state', () => {});
      await flush();
      expect(a).not.toHaveBeenCalled();
      expect((b.mock.calls[0]?.[0] as Error).message).toBe('add refused');
      resetPowerTracker({ window: w });
    });

    it('an undefined onError on relaunch keeps the previous reporter', async () => {
      const w = {};
      const m = mkManager();
      m.addEventListener = () => {
        throw new Error('add refused');
      };
      const a = vi.fn();
      const getBattery = () => Promise.resolve(m);
      powerTrackerFor({ window: w, getBattery }, a);
      powerTrackerFor({ window: w, getBattery }).on('state', () => {});
      await flush();
      expect(a).toHaveBeenCalledTimes(1);
    });

    it('a first env WITHOUT getBattery does not leave the window inert: the relaunch that has it works (tracker running or idle)', async () => {
      for (const subscribeFirst of [false, true]) {
        const w = {};
        const m = mkManager(0.5, false);
        const getBattery = vi.fn(() => Promise.resolve(m));
        const t = powerTrackerFor({ window: w });
        const seen: BatteryState[] = [];
        if (subscribeFirst) t.on('state', (s) => seen.push(s));
        powerTrackerFor({ window: w, getBattery });
        if (!subscribeFirst) expect(getBattery).not.toHaveBeenCalled(); // idle: nothing asks until a subscriber arrives
        if (!subscribeFirst) t.on('state', (s) => seen.push(s));
        await flush();
        expect(seen).toEqual([{ level: 0.5, charging: false }]);
        resetPowerTracker({ window: w });
      }
    });

    it('a throwing subscriber is isolated and reported to the CURRENT onError', async () => {
      const w = {};
      const m = mkManager(0.5, false);
      const a = vi.fn();
      const b = vi.fn();
      const getBattery = () => Promise.resolve(m);
      powerTrackerFor({ window: w, getBattery }, a);
      const t = powerTrackerFor({ window: w, getBattery }, b);
      const seen: BatteryState[] = [];
      t.on('state', () => {
        throw new Error('subscriber boom');
      });
      t.on('state', (s) => seen.push(s));
      await flush();
      expect(seen).toHaveLength(1); // the other subscriber still got it
      expect(a).not.toHaveBeenCalled();
      expect((b.mock.calls[0]?.[0] as Error).message).toBe('subscriber boom');
      resetPowerTracker({ window: w });
    });

    it('a relaunch WITHOUT getBattery never clobbers the one we have', async () => {
      const w = {};
      const getBattery = vi.fn(() => Promise.resolve(mkManager()));
      const t = powerTrackerFor({ window: w, getBattery });
      powerTrackerFor({ window: w });
      t.on('state', () => {});
      expect(getBattery).toHaveBeenCalledTimes(1);
      resetPowerTracker({ window: w });
    });

    it('a later getBattery replaces an unresolved one, but never a retained manager', async () => {
      const w = {};
      const m1 = mkManager(0.5, false);
      const m2 = mkManager(0.9, false);
      const g1 = vi.fn(() => Promise.reject(new Error('denied')));
      const g2 = vi.fn(() => Promise.resolve(m1));
      const g3 = vi.fn(() => Promise.resolve(m2));
      const t = powerTrackerFor({ window: w, getBattery: g1 });
      const off = t.on('state', () => {});
      await flush();
      off();
      powerTrackerFor({ window: w, getBattery: g2 }); // no resolved manager: replaced
      const seen: BatteryState[] = [];
      t.on('state', (s) => seen.push(s));
      await flush();
      expect(g1).toHaveBeenCalledTimes(1);
      expect(g2).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([{ level: 0.5, charging: false }]);
      powerTrackerFor({ window: w, getBattery: g3 }); // manager resolved: retained, g3 never used
      expect(g3).not.toHaveBeenCalled();
      resetPowerTracker({ window: w });
    });

    it('a throwing window getter on the key is reported', () => {
      const env = {};
      Object.defineProperty(env, 'window', {
        get: () => {
          throw new Error('blocked');
        },
      });
      const onError = vi.fn();
      powerTrackerFor(env, onError);
      expect((onError.mock.calls[0]?.[0] as Error).message).toBe('blocked');
    });

    it('a throwing navigator getter on the key is reported', () => {
      const env = {};
      Object.defineProperty(env, 'navigator', {
        get: () => {
          throw new Error('nav blocked');
        },
      });
      const onError = vi.fn();
      powerTrackerFor(env, onError);
      expect((onError.mock.calls[0]?.[0] as Error).message).toBe('nav blocked');
    });
  });
});
