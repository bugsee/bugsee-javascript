import type { Scheduler } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import { MainThreadLagTracker } from './main-thread-lag-tracker';

// A controllable page. Tests are REAL-ORDER aware: a main-thread block is modelled as "advance the clock by N ms
// between two tick callbacks" — the late tick then fires after the block, exactly as a real timer does.
function mkEnv(over: { visible?: boolean; noNow?: boolean } = {}) {
  let now = 0;
  const doc = { visibilityState: over.visible === false ? 'hidden' : 'visible' };
  const visListeners = new Set<(e: { visible: boolean }) => void>();
  let timerCb: (() => void) | undefined;
  const timers = { set: 0, cleared: 0, live: 0 };
  const control = { setFails: 0 };
  const scheduler: Scheduler = {
    setInterval: (cb) => {
      if (control.setFails-- > 0) throw new Error('timer');
      timerCb = cb;
      timers.set += 1;
      timers.live += 1;
      return { id: timers.set };
    },
    clearInterval: () => {
      timers.cleared += 1;
      timers.live -= 1;
    },
  };
  const env = {
    document: doc,
    lifecycle: {
      on: (type: string, fn: (e: never) => void) => {
        expect(type).toBe('visibility');
        visListeners.add(fn as never);
        return () => void visListeners.delete(fn as never);
      },
    },
    ...(over.noNow ? {} : { now: () => now }),
    scheduler,
  };
  return {
    env,
    timers,
    control,
    advance: (ms: number) => {
      now += ms;
    },
    setNow: (ms: number) => {
      now = ms;
    },
    tick: () => timerCb?.(),
    setVisible: (visible: boolean) => {
      doc.visibilityState = visible ? 'visible' : 'hidden';
      for (const l of [...visListeners]) l({ visible });
    },
    listeners: () => visListeners.size,
  };
}

const collect = (t: MainThreadLagTracker) => {
  const got: number[] = [];
  const off = t.on('lag', (v) => got.push(v));
  return { got, off };
};

describe('MainThreadLagTracker (timer drift)', () => {
  it('attaches nothing until the first subscriber', () => {
    const e = mkEnv();
    new MainThreadLagTracker(e.env);
    expect(e.timers.set).toBe(0);
    expect(e.listeners()).toBe(0);
  });

  it('two ticks exactly on time report 0 (a measured zero is a value, and is emitted)', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(1000);
    e.tick();
    e.advance(1000);
    e.tick();
    expect(got).toEqual([0, 0]);
  });

  it('a block spanning a due tick shows as the lateness of that tick, once; the next on-time tick reads 0', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(1000);
    e.tick(); // on time
    e.advance(1000 + 700); // a 700 ms synchronous block, then the overdue tick fires
    e.tick();
    expect(got).toEqual([0, 700]);
    e.advance(1000); // and the NEXT interval is measured from the late tick, so the block is not counted twice
    e.tick();
    expect(got).toEqual([0, 700, 0]);
  });

  it('a block shorter than the interval that crosses no due tick reads exactly 0 (the documented limit)', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(100); // a 100 ms block mid-interval...
    e.advance(900); // ...the tick still fires on schedule
    e.tick();
    expect(got).toEqual([0]);
  });

  it('the first tick is measured against the run start + interval', () => {
    const e = mkEnv();
    e.setNow(5000);
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.setNow(5000 + 1000 + 250);
    e.tick();
    expect(got).toEqual([250]);
  });

  it('a tick that fires a hair early is on time (never a negative lag)', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(998);
    e.tick();
    expect(got).toEqual([0]);
  });

  it('honors intervalMs (default 1000) as both the timer period and the drift baseline', () => {
    const seen: number[] = [];
    const scheduler: Scheduler = {
      setInterval: (_cb, ms) => {
        seen.push(ms);
        return 1;
      },
      clearInterval: () => {},
    };
    const e = mkEnv();
    new MainThreadLagTracker({ ...e.env, scheduler }).on('lag', () => {});
    new MainThreadLagTracker({ ...e.env, scheduler, intervalMs: 250 }).on('lag', () => {});
    expect(seen).toEqual([1000, 250]);
    const f = mkEnv();
    const { got } = collect(new MainThreadLagTracker({ ...f.env, intervalMs: 250 }));
    f.advance(250);
    f.tick();
    f.advance(250 + 40);
    f.tick();
    expect(got).toEqual([0, 40]);
  });

  it('uses the INJECTED clock: its distinctive value, and nothing else, decides the drift', () => {
    const e = mkEnv();
    const reads: number[] = [];
    let t = 123_456;
    const { got } = collect(
      new MainThreadLagTracker({
        ...e.env,
        now: () => {
          reads.push(t);
          return t;
        },
      }),
    );
    t = 123_456 + 1000 + 77;
    e.tick();
    expect(got).toEqual([77]);
    expect(reads).toEqual([123_456, 123_456 + 1077]);
  });

  it('hidden: the timer is torn down and nothing is emitted, even by a stray tick', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.setVisible(false);
    expect(e.timers.live).toBe(0);
    e.advance(1000);
    e.tick();
    expect(got).toEqual([]);
  });

  it('a hidden stretch never counts as lag: hide 60 s, show, the first tick reports ~0 — a FRESH baseline', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(1000);
    e.tick();
    e.setVisible(false);
    e.advance(60_000);
    e.setVisible(true);
    e.advance(1000);
    e.tick();
    expect(got).toEqual([0, 0]);
  });

  it('hidden at start: no timer, nothing emitted; the first visible event starts a run', () => {
    const e = mkEnv({ visible: false });
    const { got } = collect(new MainThreadLagTracker(e.env));
    expect(e.timers.live).toBe(0);
    e.tick();
    expect(got).toEqual([]);
    e.setVisible(true);
    expect(e.timers.live).toBe(1);
  });

  it('duplicate visible/hidden events do not stack timers', () => {
    const e = mkEnv();
    collect(new MainThreadLagTracker(e.env));
    e.setVisible(true);
    e.setVisible(true);
    expect(e.timers.live).toBe(1);
    e.setVisible(false);
    e.setVisible(false);
    expect(e.timers.live).toBe(0);
    expect(e.timers.cleared).toBe(1);
  });

  it('the last unsubscribe stops the timer and the subscription; a re-subscribe restarts with a fresh baseline', () => {
    const e = mkEnv();
    const t = new MainThreadLagTracker(e.env);
    const { off } = collect(t);
    expect(e.listeners()).toBe(1);
    off();
    expect(e.listeners()).toBe(0);
    expect(e.timers.live).toBe(0);
    e.advance(30_000);
    const { got } = collect(t);
    expect(e.timers.live).toBe(1);
    e.advance(1000);
    e.tick();
    expect(got).toEqual([0]);
  });

  it('without a clock it measures nothing: no timer, no subscription, no error (no wall-clock guess)', () => {
    const e = mkEnv({ noNow: true });
    const errors: unknown[] = [];
    const { got } = collect(new MainThreadLagTracker(e.env, (x) => errors.push(x)));
    expect(e.timers.set).toBe(0);
    expect(e.listeners()).toBe(0);
    e.tick();
    expect(got).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('with no lifecycle it measures nothing: a hidden tab could not be gated', () => {
    const e = mkEnv();
    const { lifecycle: _l, ...rest } = e.env;
    const errors: unknown[] = [];
    collect(new MainThreadLagTracker(rest, (x) => errors.push(x)));
    expect(e.timers.set).toBe(0);
    expect(errors).toEqual([]);
  });

  it('an unreadable visibilityState counts as hidden and is reported', () => {
    const e = mkEnv();
    const errors: unknown[] = [];
    const doc = {};
    Object.defineProperty(doc, 'visibilityState', {
      get(): never {
        throw new Error('vis');
      },
    });
    collect(new MainThreadLagTracker({ ...e.env, document: doc }, (x) => errors.push(x)));
    expect(e.timers.set).toBe(0);
    expect((errors[0] as Error).message).toBe('vis');
  });

  it('a throwing clock at start is reported and rolls back; the next visible event retries', () => {
    const e = mkEnv({ visible: false });
    const errors: unknown[] = [];
    let boom = true;
    collect(
      new MainThreadLagTracker(
        {
          ...e.env,
          now: () => {
            if (boom) throw new Error('clock');
            return 0;
          },
        },
        (x) => errors.push(x),
      ),
    );
    e.setVisible(true);
    expect((errors[0] as Error).message).toBe('clock');
    expect(e.timers.live).toBe(0);
    boom = false;
    e.setVisible(true);
    expect(e.timers.live).toBe(1);
  });

  it('a throwing scheduler is reported and rolls back; the next visible event retries', () => {
    const e = mkEnv({ visible: false });
    const errors: unknown[] = [];
    collect(new MainThreadLagTracker(e.env, (x) => errors.push(x)));
    e.control.setFails = 1;
    e.setVisible(true);
    expect((errors[0] as Error).message).toBe('timer');
    expect(e.timers.live).toBe(0);
    e.setVisible(true);
    expect(e.timers.live).toBe(1);
  });

  it('a clock that throws at a tick is reported, skips it, and the next tick does not read the skipped interval as lag', () => {
    const e = mkEnv();
    const errors: unknown[] = [];
    let boom = false;
    let t = 0;
    const { got } = collect(
      new MainThreadLagTracker(
        {
          ...e.env,
          now: () => {
            if (boom) throw new Error('clock');
            return t;
          },
        },
        (x) => errors.push(x),
      ),
    );
    boom = true;
    t = 1000;
    expect(() => e.tick()).not.toThrow();
    expect((errors[0] as Error).message).toBe('clock');
    expect(got).toEqual([]);
    boom = false;
    t = 2000;
    e.tick();
    expect(got).toEqual([0]); // not ~1000
    t = 3000 + 90;
    e.tick();
    expect(got).toEqual([0, 90]);
  });

  it('a non-finite clock reading is dropped without poisoning the baseline', () => {
    const e = mkEnv();
    let t = 0;
    const { got } = collect(new MainThreadLagTracker({ ...e.env, now: () => t }));
    t = Number.NaN;
    e.tick();
    t = Number.POSITIVE_INFINITY;
    e.tick();
    expect(got).toEqual([]);
    t = 3000 + 5; // three intervals elapsed in total, two of them skipped
    e.tick();
    expect(got).toEqual([5]);
  });

  it('uses the global timers by default, and releases them on the last unsubscribe', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const e = mkEnv();
      const { scheduler: _s, ...rest } = e.env;
      let now = 0;
      const t = new MainThreadLagTracker({ ...rest, now: () => now });
      const got: number[] = [];
      const off = t.on('lag', (v) => got.push(v));
      now = 1000;
      vi.advanceTimersByTime(1000);
      expect(got).toEqual([0]);
      off();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a lifecycle that throws on subscribe is reported, not thrown out of on()', () => {
    const e = mkEnv();
    const errors: unknown[] = [];
    const t = new MainThreadLagTracker(
      {
        ...e.env,
        lifecycle: {
          on: () => {
            throw new Error('lifecycle');
          },
        },
      },
      (x) => errors.push(x),
    );
    expect(() => t.on('lag', () => {})).not.toThrow();
    expect((errors[0] as Error).message).toBe('lifecycle');
  });

  it('a throwing reporter never escapes', () => {
    const e = mkEnv({ visible: false });
    const t = new MainThreadLagTracker(
      {
        ...e.env,
        now: () => {
          throw new Error('clock');
        },
      },
      () => {
        throw new Error('reporter');
      },
    );
    t.on('lag', () => {});
    expect(() => e.setVisible(true)).not.toThrow();
  });
});
