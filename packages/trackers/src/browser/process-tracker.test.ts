import { describe, expect, it, vi } from 'vitest';
import {
  IDLE_PERIOD_CAP_MS,
  type ProcessEnv,
  ProcessTracker,
  processTrackerFor,
  resetProcessTracker,
  USER_IDLE_MIN_THRESHOLD_MS,
} from './process-tracker';

const flush = (): Promise<void> =>
  new Promise((r) =>
    (globalThis as unknown as { setTimeout(f: () => void, ms: number): void }).setTimeout(
      () => r(),
      0,
    ),
  );

function mkScheduler() {
  const timers = new Map<number, { cb: () => void; ms: number }>();
  let next = 1;
  const s = {
    setInterval: vi.fn((cb: () => void, ms: number) => {
      const h = next++;
      timers.set(h, { cb, ms });
      return h;
    }),
    clearInterval: vi.fn((h: unknown) => void timers.delete(h as number)),
    tick: () =>
      [...timers.values()].forEach((t) => {
        t.cb();
      }),
    /** Fire every timer ever armed, including ones whose clear "failed" (kept below). */
    live: () => timers.size,
    periods: () => [...timers.values()].map((t) => t.ms),
  };
  return s;
}

function mkLifecycle() {
  const subs = new Set<(p: { visible: boolean }) => void>();
  const unsub = vi.fn();
  return {
    on: vi.fn((_name: string, l: (p: { visible: boolean }) => void) => {
      subs.add(l);
      return () => {
        unsub();
        subs.delete(l);
      };
    }),
    emit: (visible: boolean) =>
      subs.forEach((l) => {
        l({ visible });
      }),
    count: () => subs.size,
    unsub,
  };
}

function mkClock(start = 1000) {
  let t = start;
  return {
    performance: { now: () => t },
    set: (v: number) => {
      t = v;
    },
    advance: (d: number) => {
      t += d;
    },
  };
}

const mem = (used: number, limit = 100) => ({
  usedJSHeapSize: used,
  totalJSHeapSize: limit / 2,
  jsHeapSizeLimit: limit,
});

type Env = ProcessEnv;
const asEnv = (e: unknown): Env => e as Env;

describe('ProcessTracker — activation', () => {
  it('constructs inert: no timer, no read, no subscription', () => {
    const s = mkScheduler();
    const lc = mkLifecycle();
    const read = vi.fn(() => mem(1));
    new ProcessTracker(
      asEnv({
        scheduler: s,
        lifecycle: lc as never,
        performance: {
          get memory() {
            return read();
          },
          now: () => 1,
        },
      }),
    );
    expect(s.setInterval).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(lc.on).not.toHaveBeenCalled();
  });

  it('arms ONLY the stage that has a listener, and releases it with the last one', () => {
    const s = mkScheduler();
    const lc = mkLifecycle();
    const clock = mkClock();
    const t = new ProcessTracker(
      asEnv({
        scheduler: s,
        lifecycle: lc as never,
        document: { visibilityState: 'visible' },
        performance: { memory: mem(1), now: clock.performance.now },
      }),
    );
    const off = t.on('heap', () => {});
    expect(s.setInterval).toHaveBeenCalledTimes(1);
    expect(lc.on).not.toHaveBeenCalled(); // lag/idle not armed
    const off2 = t.on('heap', () => {});
    expect(s.setInterval).toHaveBeenCalledTimes(1);
    off();
    expect(s.live()).toBe(1);
    off2();
    expect(s.live()).toBe(0);
  });

  it('an onAny listener arms every stage; start()/stop() do nothing by themselves', () => {
    const s = mkScheduler();
    const lc = mkLifecycle();
    const t = new ProcessTracker(
      asEnv({
        scheduler: s,
        lifecycle: lc as never,
        document: { visibilityState: 'visible' },
        requestIdleCallback: () => 1,
        performance: { memory: mem(1), now: () => 1 },
      }),
    );
    t.start();
    t.stop();
    expect(s.setInterval).not.toHaveBeenCalled();
    const off = t.onAny(() => {});
    // heap + uptime + lag (visible) + idle (visible)
    expect(s.live()).toBe(4);
    off();
    expect(s.live()).toBe(0);
    expect(lc.count()).toBe(0);
  });

  it('a throwing onError never escapes the emitter dispatch', () => {
    const s = mkScheduler();
    const t = new ProcessTracker(asEnv({ scheduler: s, performance: { memory: mem(1) } }), () => {
      throw new Error('reporter');
    });
    t.on('heap', () => {
      throw new Error('listener');
    });
    expect(() => s.tick()).not.toThrow();
  });

  it('retries an inert stage only after its listeners have all left', () => {
    let memory: unknown;
    const s = mkScheduler();
    const t = new ProcessTracker(
      asEnv({
        scheduler: s,
        performance: {
          get memory() {
            return memory;
          },
        },
      }),
    );
    const off = t.on('heap', () => {});
    expect(s.live()).toBe(0); // no performance.memory
    memory = mem(1);
    const other = t.on('uptime', () => {}); // an unrelated mutation does not re-probe heap
    expect(s.live()).toBe(0);
    other();
    off();
    t.on('heap', () => {});
    expect(s.live()).toBe(1);
  });
});

describe('ProcessTracker — heap', () => {
  it('polls on ONE shared timer at the default 1000 ms and emits {used, limit} per tick', () => {
    const s = mkScheduler();
    let used = 10;
    const t = new ProcessTracker(
      asEnv({
        scheduler: s,
        performance: {
          get memory() {
            return mem(used, 200);
          },
        },
      }),
    );
    const a: unknown[] = [];
    const b: unknown[] = [];
    t.on('heap', (m) => a.push(m));
    t.on('heap', (m) => b.push(m));
    expect(s.periods()).toEqual([1000]);
    used = 20;
    s.tick();
    expect(a).toEqual([{ used: 20, limit: 200 }]);
    expect(b).toEqual(a);
  });

  it('honours intervalMs', () => {
    const s = mkScheduler();
    const t = new ProcessTracker(
      asEnv({ scheduler: s, intervalMs: 250, performance: { memory: mem(1) } }),
    );
    t.on('heap', () => {});
    expect(s.periods()).toEqual([250]);
  });

  it('uses the global timers when no scheduler is injected', () => {
    vi.useFakeTimers();
    try {
      const t = new ProcessTracker(asEnv({ intervalMs: 10, performance: { memory: mem(5) } }));
      const out: unknown[] = [];
      const off = t.on('heap', (m) => out.push(m));
      vi.advanceTimersByTime(25);
      expect(out).toEqual([
        { used: 5, limit: 100 },
        { used: 5, limit: 100 },
      ]);
      off();
      vi.advanceTimersByTime(50);
      expect(out).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no performance.memory (or no performance) -> no timer, no emission', () => {
    const s = mkScheduler();
    const t = new ProcessTracker(asEnv({ scheduler: s, performance: {} }));
    t.on('heap', () => {});
    const u = new ProcessTracker(asEnv({ scheduler: s }));
    u.on('heap', () => {});
    expect(s.live()).toBe(0);
    expect(t.currentHeap()).toBeUndefined();
  });

  it('a memory read that THROWS is reported once and polling still starts (transient)', () => {
    const s = mkScheduler();
    const boom = new Error('getter');
    let fail = true;
    const onError = vi.fn();
    const t = new ProcessTracker(
      asEnv({
        scheduler: s,
        performance: {
          get memory() {
            if (fail) throw boom;
            return mem(7);
          },
        },
      }),
      onError,
    );
    const out: unknown[] = [];
    t.on('heap', (m) => out.push(m));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
    expect(s.live()).toBe(1);
    s.tick(); // still throwing: reported, nothing emitted, never thrown
    expect(out).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(2);
    fail = false;
    s.tick();
    expect(out).toEqual([{ used: 7, limit: 100 }]);
  });

  it('omits an unusable reading (never 0, never NaN) and reports a throwing field', () => {
    const s = mkScheduler();
    const onError = vi.fn();
    let reading: unknown = mem(1);
    const t = new ProcessTracker(
      asEnv({
        scheduler: s,
        performance: {
          get memory() {
            return reading;
          },
        },
      }),
      onError,
    );
    const out: unknown[] = [];
    t.on('heap', (m) => out.push(m));
    for (const bad of [
      { usedJSHeapSize: Number.NaN, jsHeapSizeLimit: 5 },
      { usedJSHeapSize: -1, jsHeapSizeLimit: 5 },
      { usedJSHeapSize: 1, jsHeapSizeLimit: Number.POSITIVE_INFINITY },
      { usedJSHeapSize: '1', jsHeapSizeLimit: 5 },
      {},
    ]) {
      reading = bad;
      s.tick();
    }
    expect(out).toEqual([]);
    reading = {
      get usedJSHeapSize(): number {
        throw new Error('field');
      },
      jsHeapSizeLimit: 5,
    };
    s.tick();
    expect(out).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    reading = mem(0, 5); // a real zero IS a measurement
    s.tick();
    expect(out).toEqual([{ used: 0, limit: 5 }]);
  });

  it('currentHeap reads live and is undefined when nothing is available', () => {
    let used = 3;
    const t = new ProcessTracker(
      asEnv({
        performance: {
          get memory() {
            return mem(used, 9);
          },
        },
      }),
    );
    expect(t.currentHeap()).toEqual({ used: 3, limit: 9 });
    used = 4;
    expect(t.currentHeap()).toEqual({ used: 4, limit: 9 });
    expect(new ProcessTracker({}).currentHeap()).toBeUndefined();
  });

  it('a throwing scheduler is reported, leaves the stage inert, and never leaks out of on()', () => {
    const boom = new Error('sched');
    const onError = vi.fn();
    const t = new ProcessTracker(
      asEnv({
        scheduler: {
          setInterval: () => {
            throw boom;
          },
          clearInterval: () => {},
        },
        performance: { memory: mem(1) },
      }),
      onError,
    );
    expect(() => t.on('heap', () => {})).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('a clearInterval that throws is reported, and that timer can never emit again', () => {
    const boom = new Error('clear');
    const onError = vi.fn();
    const cbs: Array<() => void> = [];
    const t = new ProcessTracker(
      asEnv({
        scheduler: {
          setInterval: (cb: () => void) => {
            cbs.push(cb);
            return 1;
          },
          clearInterval: () => {
            throw boom;
          },
        },
        performance: { memory: mem(1) },
      }),
      onError,
    );
    const out: unknown[] = [];
    const off = t.on('heap', (m) => out.push(m));
    off();
    expect(onError).toHaveBeenCalledWith(boom);
    cbs[0]?.(); // the leaked timer fires
    expect(out).toEqual([]);
  });
});

describe('ProcessTracker — uptime', () => {
  it('emits performance.now() each tick', () => {
    const s = mkScheduler();
    const clock = mkClock(5);
    const t = new ProcessTracker(asEnv({ scheduler: s, performance: clock.performance }));
    const out: unknown[] = [];
    t.on('uptime', (u) => out.push(u));
    clock.set(1500);
    s.tick();
    clock.set(2500);
    s.tick();
    expect(out).toEqual([{ uptimeMs: 1500 }, { uptimeMs: 2500 }]);
  });

  it('omitted without a clock; unusable readings are dropped, a throwing clock is reported', () => {
    const s = mkScheduler();
    const t = new ProcessTracker(asEnv({ scheduler: s, performance: {} }));
    t.on('uptime', () => {});
    expect(s.live()).toBe(0);
    const onError = vi.fn();
    let v: number = 1;
    let fail = false;
    const u = new ProcessTracker(
      asEnv({
        scheduler: s,
        performance: {
          now: () => {
            if (fail) throw new Error('clock');
            return v;
          },
        },
      }),
      onError,
    );
    const out: unknown[] = [];
    u.on('uptime', (x) => out.push(x));
    v = Number.NaN;
    s.tick();
    v = -5;
    s.tick();
    fail = true;
    s.tick();
    expect(out).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    fail = false;
    v = 0;
    s.tick();
    expect(out).toEqual([{ uptimeMs: 0 }]);
  });

  it('a hostile performance getter is reported and the stage stays inert', () => {
    const onError = vi.fn();
    const s = mkScheduler();
    const t = new ProcessTracker(
      asEnv({
        scheduler: s,
        get performance(): never {
          throw new Error('perf');
        },
      }),
      onError,
    );
    t.on('uptime', () => {});
    expect(onError).toHaveBeenCalled();
    expect(s.live()).toBe(0);
  });

  it('a hostile performance.now getter is reported and the stage stays inert', () => {
    const onError = vi.fn();
    const s = mkScheduler();
    const t = new ProcessTracker(
      asEnv({
        scheduler: s,
        performance: {
          get now(): never {
            throw new Error('now');
          },
        },
      }),
      onError,
    );
    t.on('uptime', () => {});
    expect(onError).toHaveBeenCalledTimes(1);
    expect(s.live()).toBe(0);
  });
});

function lagEnv(extra: Partial<Env> = {}, visible = 'visible') {
  const s = mkScheduler();
  const lc = mkLifecycle();
  const clock = mkClock(1000);
  const doc = { visibilityState: visible };
  const env = asEnv({
    scheduler: s,
    lifecycle: lc,
    document: doc,
    performance: clock.performance,
    ...extra,
  });
  return { s, lc, clock, doc, env };
}

describe('ProcessTracker — mainThreadLag (timer drift)', () => {
  it('a clock that is non-finite at the start gives no baseline: that tick emits nothing (never NaN), then it recovers', () => {
    const onError = vi.fn();
    let t = Number.NaN;
    const { s, env } = lagEnv({ performance: { now: () => t } });
    const tracker = new ProcessTracker(env, onError);
    const out: number[] = [];
    tracker.on('mainThreadLag', (l) => out.push(l.lagMs));
    t = 2000;
    s.tick(); // establishes the baseline only
    expect(out).toEqual([]);
    t = 3005;
    s.tick(); // 5 ms late against 2000 + 1000
    expect(out).toEqual([5]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a hostile performance.now getter is reported ONCE across stop/restart of the same stages', () => {
    const onError = vi.fn();
    const { env } = lagEnv({
      performance: {
        get now(): never {
          throw new Error('now');
        },
      },
    });
    const tracker = new ProcessTracker(env, onError);
    for (let i = 0; i < 3; i += 1) {
      const a = tracker.on('mainThreadLag', () => {});
      const b = tracker.on('uptime', () => {});
      a();
      b();
    }
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('first tick compares against start + interval; later ticks against the previous tick + interval', () => {
    const { s, clock, env } = lagEnv();
    const t = new ProcessTracker(env);
    const out: number[] = [];
    t.on('mainThreadLag', (l) => out.push(l.lagMs));
    clock.set(2000); // on time
    s.tick();
    clock.set(3003); // 3 ms late
    s.tick();
    clock.set(5500); // 1497 late (a block)
    s.tick();
    clock.set(6500); // measured from the late tick: on time -> 0 (a block is reported ONCE)
    s.tick();
    expect(out).toEqual([0, 3, 1497, 0]);
  });

  it('a hair EARLY clamps to 0, never negative', () => {
    const { s, clock, env } = lagEnv();
    const t = new ProcessTracker(env);
    const out: number[] = [];
    t.on('mainThreadLag', (l) => out.push(l.lagMs));
    clock.set(1999);
    s.tick();
    expect(out).toEqual([0]);
  });

  it('runs only while visible: hidden tears the timer down, visible starts a FRESH baseline', () => {
    const { s, lc, clock, doc, env } = lagEnv();
    const t = new ProcessTracker(env);
    const out: number[] = [];
    t.on('mainThreadLag', (l) => out.push(l.lagMs));
    expect(s.live()).toBe(1);
    doc.visibilityState = 'hidden';
    lc.emit(false);
    expect(s.live()).toBe(0);
    clock.set(900_000); // a long hidden stretch must never count as lag
    doc.visibilityState = 'visible';
    lc.emit(true);
    expect(s.live()).toBe(1);
    clock.set(901_000);
    s.tick();
    expect(out).toEqual([0]);
    lc.emit(true); // already running: no second timer
    expect(s.live()).toBe(1);
  });

  it('starts nothing on a hidden or unknown-visibility page, and the visible event starts it', () => {
    const hidden = lagEnv({}, 'hidden');
    const t = new ProcessTracker(hidden.env);
    t.on('mainThreadLag', () => {});
    expect(hidden.s.live()).toBe(0);
    expect(hidden.lc.count()).toBe(1);
    hidden.lc.emit(true);
    expect(hidden.s.live()).toBe(1);

    const unknown = lagEnv({ document: undefined });
    const u = new ProcessTracker(unknown.env);
    u.on('mainThreadLag', () => {});
    expect(unknown.s.live()).toBe(0);
  });

  it('a throwing visibility read counts as not visible and is reported', () => {
    const onError = vi.fn();
    const { s, env } = lagEnv({
      document: {
        get visibilityState(): never {
          throw new Error('doc');
        },
      },
    });
    new ProcessTracker(env, onError).on('mainThreadLag', () => {});
    expect(onError).toHaveBeenCalledTimes(1);
    expect(s.live()).toBe(0);
  });

  it('is omitted (inert, no subscription) without a clock or without a lifecycle', () => {
    const noClock = lagEnv({ performance: {} });
    new ProcessTracker(noClock.env).on('mainThreadLag', () => {});
    expect(noClock.lc.on).not.toHaveBeenCalled();
    expect(noClock.s.live()).toBe(0);
    const noLifecycle = lagEnv({ lifecycle: undefined });
    new ProcessTracker(noLifecycle.env).on('mainThreadLag', () => {});
    expect(noLifecycle.s.live()).toBe(0);
  });

  it('a hidden event while nothing is running is a no-op', () => {
    const { s, lc, env } = lagEnv({}, 'hidden');
    new ProcessTracker(env).on('mainThreadLag', () => {});
    expect(() => lc.emit(false)).not.toThrow();
    expect(s.live()).toBe(0);
  });

  it('stopping unsubscribes from the lifecycle and clears the timer', () => {
    const { s, lc, env } = lagEnv();
    const off = new ProcessTracker(env).on('mainThreadLag', () => {});
    off();
    expect(s.live()).toBe(0);
    expect(lc.unsub).toHaveBeenCalledTimes(1);
    expect(lc.count()).toBe(0);
  });

  it('a throwing clock at start rolls the run back, is reported, and a later visible start recovers', () => {
    const onError = vi.fn();
    let fail = true;
    const { s, lc, env } = lagEnv({
      performance: {
        now: () => {
          if (fail) throw new Error('clock');
          return 1000;
        },
      },
    });
    new ProcessTracker(env, onError).on('mainThreadLag', () => {});
    expect(onError).toHaveBeenCalledTimes(1);
    expect(s.live()).toBe(0);
    fail = false;
    lc.emit(true);
    expect(s.live()).toBe(1);
  });

  it('a throwing scheduler at start rolls back and is reported', () => {
    const onError = vi.fn();
    const boom = new Error('sched');
    const { env } = lagEnv({
      scheduler: {
        setInterval: () => {
          throw boom;
        },
        clearInterval: () => {},
      },
    });
    new ProcessTracker(env, onError).on('mainThreadLag', () => {});
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('a throwing or non-finite clock at a tick skips the tick without reading the gap as lag', () => {
    const onError = vi.fn();
    let mode: 'ok' | 'throw' | 'nan' = 'ok';
    let now = 1000;
    const { s, env } = lagEnv({
      performance: {
        now: () => {
          if (mode === 'throw') throw new Error('clock');
          return mode === 'nan' ? Number.NaN : now;
        },
      },
    });
    const t = new ProcessTracker(env, onError);
    const out: number[] = [];
    t.on('mainThreadLag', (l) => out.push(l.lagMs));
    mode = 'throw';
    s.tick();
    expect(onError).toHaveBeenCalledTimes(1);
    mode = 'nan';
    s.tick();
    mode = 'ok';
    now = 4500; // expectedAt advanced past both skipped ticks (start 1000 + 3 intervals = 4000)
    s.tick();
    expect(out).toEqual([500]);
  });

  it('a lifecycle that throws on subscribe is reported and leaves the stage inert', () => {
    const onError = vi.fn();
    const boom = new Error('lc');
    const { s, env } = lagEnv({
      lifecycle: {
        on: () => {
          throw boom;
        },
      } as never,
    });
    expect(() => new ProcessTracker(env, onError).on('mainThreadLag', () => {})).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(s.live()).toBe(0);
  });

  it('a teardown that throws while hidden is reported', () => {
    const onError = vi.fn();
    const lc = mkLifecycle();
    const { env } = lagEnv({
      lifecycle: lc as never,
      scheduler: {
        setInterval: () => 1,
        clearInterval: () => {
          throw new Error('clear');
        },
      },
    });
    new ProcessTracker(env, onError).on('mainThreadLag', () => {});
    lc.emit(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

function idleEnv(extra: Partial<Env> = {}, visible = 'visible') {
  const base = lagEnv({}, visible);
  const callbacks = new Map<number, (d: { timeRemaining(): number }) => void>();
  let next = 1;
  const ric = vi.fn((cb: (d: { timeRemaining(): number }) => void) => {
    const h = next++;
    callbacks.set(h, cb);
    return h;
  });
  const cancel = vi.fn((h: number) => void callbacks.delete(h));
  const env = asEnv({
    ...base.env,
    requestIdleCallback: ric,
    cancelIdleCallback: cancel,
    ...extra,
  });
  const grant = (remaining: number | (() => number)) => {
    const entries = [...callbacks.entries()];
    callbacks.clear();
    for (const [, cb] of entries) {
      cb({ timeRemaining: typeof remaining === 'function' ? remaining : () => remaining });
    }
  };
  return { ...base, env, ric, cancel, grant, callbacks };
}

describe('ProcessTracker — idle (requestIdleCallback probe)', () => {
  it('probes ONCE per tick, emits timeRemaining clamped to 50 ms, and never stacks probes', () => {
    const { s, env, ric, grant } = idleEnv();
    const t = new ProcessTracker(env);
    const out: number[] = [];
    t.on('idle', (i) => out.push(i.idleMs));
    expect(ric).not.toHaveBeenCalled(); // nothing at activation: only per tick
    s.tick();
    s.tick(); // previous probe still pending: no second one
    expect(ric).toHaveBeenCalledTimes(1);
    grant(12.5);
    expect(out).toEqual([12.5]);
    s.tick();
    grant(500); // a deadline can be larger than the spec cap
    expect(out).toEqual([12.5, IDLE_PERIOD_CAP_MS]);
    s.tick();
    grant(0); // a granted zero is a real zero
    expect(out).toEqual([12.5, 50, 0]);
  });

  it('a busy page that never grants the callback produces NO sample (not 0)', () => {
    const { s, env, ric } = idleEnv();
    const out: number[] = [];
    new ProcessTracker(env).on('idle', (i) => out.push(i.idleMs));
    s.tick();
    s.tick();
    s.tick();
    expect(ric).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
  });

  it('omits invalid timeRemaining values and reports a throwing one', () => {
    const onError = vi.fn();
    const { s, env, grant } = idleEnv();
    const out: number[] = [];
    new ProcessTracker(env, onError).on('idle', (i) => out.push(i.idleMs));
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      s.tick();
      grant(bad);
    }
    expect(out).toEqual([]);
    s.tick();
    grant(() => {
      throw new Error('tr');
    });
    expect(onError).toHaveBeenCalledTimes(1);
    s.tick(); // a thrown read left no probe stuck pending
    grant(5);
    expect(out).toEqual([5]);
  });

  it('is omitted where requestIdleCallback is absent (Safari) or without a lifecycle', () => {
    const noRic = idleEnv({ requestIdleCallback: undefined });
    new ProcessTracker(noRic.env).on('idle', () => {});
    expect(noRic.lc.on).not.toHaveBeenCalled();
    expect(noRic.s.live()).toBe(0);
    const noLc = idleEnv({ lifecycle: undefined });
    new ProcessTracker(noLc.env).on('idle', () => {});
    expect(noLc.s.live()).toBe(0);
  });

  it('a hostile requestIdleCallback getter is reported and the stage is inert', () => {
    const onError = vi.fn();
    const { s, env } = idleEnv();
    Object.defineProperty(env, 'requestIdleCallback', {
      get(): never {
        throw new Error('ric');
      },
    });
    new ProcessTracker(env, onError).on('idle', () => {});
    expect(onError).toHaveBeenCalledTimes(1);
    expect(s.live()).toBe(0);
  });

  it('is gated to visible pages: hidden cancels the outstanding probe and the timer', () => {
    const { s, lc, env, ric, cancel, doc } = idleEnv();
    const out: number[] = [];
    new ProcessTracker(env).on('idle', (i) => out.push(i.idleMs));
    s.tick();
    expect(ric).toHaveBeenCalledTimes(1);
    doc.visibilityState = 'hidden';
    lc.emit(false);
    expect(cancel).toHaveBeenCalledWith(1);
    expect(s.live()).toBe(0);
    lc.emit(true);
    expect(s.live()).toBe(1);
    s.tick();
    expect(ric).toHaveBeenCalledTimes(2);
  });

  it('a callback that fires after teardown (cancel ignored) is inert', () => {
    const { s, env, callbacks } = idleEnv({ cancelIdleCallback: () => {} });
    const out: number[] = [];
    const off = new ProcessTracker(env).on('idle', (i) => out.push(i.idleMs));
    s.tick();
    const stale = [...callbacks.values()][0];
    off();
    stale?.({ timeRemaining: () => 9 });
    expect(out).toEqual([]);
  });

  it('a stale callback from a torn-down run neither emits to nor unblocks the next run', () => {
    const { s, env, ric, callbacks } = idleEnv({ cancelIdleCallback: () => {} });
    const t = new ProcessTracker(env);
    const out: number[] = [];
    const off = t.on('idle', () => {});
    s.tick();
    const stale = [...callbacks.values()][0];
    off();
    t.on('idle', (i) => out.push(i.idleMs));
    s.tick(); // the new run's own probe is pending
    expect(ric).toHaveBeenCalledTimes(2);
    stale?.({ timeRemaining: () => 9 });
    expect(out).toEqual([]);
    s.tick(); // the stale callback did not clear the new run's pending probe
    expect(ric).toHaveBeenCalledTimes(2);
  });

  it('works without cancelIdleCallback, and reports a throwing cancel (timer still released)', () => {
    const noCancel = idleEnv({ cancelIdleCallback: undefined });
    const off = new ProcessTracker(noCancel.env).on('idle', () => {});
    noCancel.s.tick();
    expect(() => off()).not.toThrow();
    expect(noCancel.s.live()).toBe(0);

    const onError = vi.fn();
    const boom = idleEnv({
      cancelIdleCallback: () => {
        throw new Error('cancel');
      },
    });
    const off2 = new ProcessTracker(boom.env, onError).on('idle', () => {});
    boom.s.tick();
    off2();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(boom.s.live()).toBe(0);
  });

  it('tearing down with NO pending probe cancels nothing and reports nothing', () => {
    const onError = vi.fn();
    const { s, env } = idleEnv();
    const cancel = env.cancelIdleCallback as ReturnType<typeof vi.fn>;
    const off = new ProcessTracker(env, onError).on('idle', () => {});
    expect(s.live()).toBe(1); // armed, but no tick has queued a probe
    off();
    expect(cancel).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(s.live()).toBe(0);
  });

  it('a throwing requestIdleCallback is reported by the tick and does not wedge later probes', () => {
    const onError = vi.fn();
    let fail = true;
    const { s, env, grant } = idleEnv({
      requestIdleCallback: ((cb: (d: { timeRemaining(): number }) => void) => {
        if (fail) throw new Error('ric');
        cb({ timeRemaining: () => 3 });
        return 1;
      }) as never,
    });
    const out: number[] = [];
    new ProcessTracker(env, onError).on('idle', (i) => out.push(i.idleMs));
    s.tick();
    expect(onError).toHaveBeenCalledTimes(1);
    fail = false;
    s.tick();
    expect(out).toEqual([3]);
    void grant;
  });

  it('a timer whose clear failed does not probe', () => {
    const { env, ric } = idleEnv();
    const cbs: Array<() => void> = [];
    const e = asEnv({
      ...env,
      scheduler: {
        setInterval: (cb: () => void) => {
          cbs.push(cb);
          return 1;
        },
        clearInterval: () => {
          throw new Error('clear');
        },
      },
    });
    const onError = vi.fn();
    const off = new ProcessTracker(e, onError).on('idle', () => {});
    off();
    cbs[0]?.();
    expect(ric).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});

// ---- userIdle --------------------------------------------------------------------------------------------------

function mkDetector() {
  const listeners = new Set<() => void>();
  const d = {
    userState: 'active' as unknown,
    screenState: 'unlocked' as unknown,
    startCalls: [] as Array<{ threshold: number; signal: unknown }>,
    startResult: () => Promise.resolve(undefined as unknown),
    start(options: { threshold: number; signal: unknown }) {
      d.startCalls.push(options);
      return d.startResult();
    },
    addEventListener: vi.fn((_t: string, l: () => void) => void listeners.add(l)),
    removeEventListener: vi.fn((_t: string, l: () => void) => void listeners.delete(l)),
    fire: () =>
      listeners.forEach((l) => {
        l();
      }),
    listenerCount: () => listeners.size,
  };
  return d;
}

function mkPermission(state: unknown) {
  const listeners = new Set<() => void>();
  const status = {
    state,
    addEventListener: vi.fn((_t: string, l: () => void) => void listeners.add(l)),
    removeEventListener: vi.fn((_t: string, l: () => void) => void listeners.delete(l)),
    set(next: unknown) {
      status.state = next;
      listeners.forEach((l) => {
        l();
      });
    },
    listenerCount: () => listeners.size,
  };
  return status;
}

function userEnv(
  opts: { state?: unknown; detector?: ReturnType<typeof mkDetector> } & Partial<Env> = {},
) {
  const status = mkPermission('state' in opts ? opts.state : 'granted');
  const detector = opts.detector ?? mkDetector();
  const requestPermission = vi.fn();
  const aborts: Array<{ signal: object; abort: ReturnType<typeof vi.fn> }> = [];
  class FakeDetector {
    static requestPermission = requestPermission;
    userState: unknown;
    screenState: unknown;
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: a test double hands the shared fake detector back from `new`.
      return detector as unknown as FakeDetector;
    }
  }
  class FakeAbort {
    signal = {};
    abort = vi.fn();
    constructor() {
      aborts.push(this);
    }
  }
  const query = vi.fn((_d: { name: string }) => Promise.resolve(status));
  const { state: _s, detector: _d, ...rest } = opts;
  const env = asEnv({
    navigator: { permissions: { query } },
    IdleDetector: FakeDetector,
    AbortController: FakeAbort,
    ...rest,
  });
  return { env, status, detector, query, requestPermission, aborts };
}

describe('ProcessTracker — userIdle (Idle Detection, never prompts)', () => {
  it('starts the detector ONLY when idle-detection is already granted; never requests permission', async () => {
    const { env, detector, query, requestPermission, aborts } = userEnv();
    const t = new ProcessTracker(env);
    const out: unknown[] = [];
    t.on('userIdle', (u) => out.push(u));
    expect(query).toHaveBeenCalledWith({ name: 'idle-detection' });
    await flush();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(detector.startCalls).toEqual([
      { threshold: USER_IDLE_MIN_THRESHOLD_MS, signal: aborts[0]?.signal },
    ]);
    expect(out).toEqual([{ userState: 'active', screenState: 'unlocked' }]);
    expect(t.currentUserIdle()).toEqual({ userState: 'active', screenState: 'unlocked' });
    detector.userState = 'idle';
    detector.screenState = 'locked';
    detector.fire();
    expect(out.at(-1)).toEqual({ userState: 'idle', screenState: 'locked' });
  });

  it.each([
    'prompt',
    'denied',
    undefined,
    'garbage',
  ])('permission %s: no detector, no emission, no trace', async (state) => {
    const { env, detector, requestPermission } = userEnv({ state });
    const t = new ProcessTracker(env);
    const out: unknown[] = [];
    t.on('userIdle', (u) => out.push(u));
    await flush();
    expect(detector.startCalls).toEqual([]);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(out).toEqual([]);
    expect(t.currentUserIdle()).toBeUndefined();
  });

  it('honours a larger threshold but floors anything lower (or invalid) at 60 s', async () => {
    for (const [asked, expected] of [
      [120_000, 120_000],
      [5_000, 60_000],
      [Number.NaN, 60_000],
      [undefined, 60_000],
    ] as const) {
      const { env, detector } = userEnv({
        ...(asked !== undefined ? { userIdleThresholdMs: asked } : {}),
      });
      new ProcessTracker(env).on('userIdle', () => {});
      await flush();
      expect(detector.startCalls[0]?.threshold).toBe(expected);
    }
  });

  it('is inert when any piece is missing, or when the engine does not know the permission', async () => {
    const e = userEnv();
    for (const missing of ['navigator', 'IdleDetector', 'AbortController'] as const) {
      const env = asEnv({ ...e.env, [missing]: undefined });
      const t = new ProcessTracker(env);
      t.on('userIdle', () => {});
      await flush();
      expect(e.detector.startCalls).toEqual([]);
    }
    const noQuery = asEnv({ ...e.env, navigator: { permissions: {} } });
    new ProcessTracker(noQuery).on('userIdle', () => {});
    // query() rejects (unknown permission name, e.g. Firefox/Safari): silent, nothing emitted
    const onError = vi.fn();
    const rejecting = asEnv({
      ...e.env,
      navigator: { permissions: { query: () => Promise.reject(new TypeError('unknown')) } },
    });
    new ProcessTracker(rejecting, onError).on('userIdle', () => {});
    // query() throws synchronously: the same
    const throwing = asEnv({
      ...e.env,
      navigator: {
        permissions: {
          query: () => {
            throw new TypeError('unknown');
          },
        },
      },
    });
    new ProcessTracker(throwing, onError).on('userIdle', () => {});
    await flush();
    expect(e.detector.startCalls).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports hostile host getters and stays inert', () => {
    const onError = vi.fn();
    const env = asEnv({
      get navigator(): never {
        throw new Error('nav');
      },
    });
    new ProcessTracker(env, onError).on('userIdle', () => {});
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('stopping aborts the detector, removes its listener, and ignores a late permission answer', async () => {
    const { env, detector, status, aborts } = userEnv();
    const t = new ProcessTracker(env);
    const off = t.on('userIdle', () => {});
    await flush();
    expect(detector.listenerCount()).toBe(1);
    expect(status.listenerCount()).toBe(1);
    off();
    expect(aborts[0]?.abort).toHaveBeenCalledTimes(1);
    expect(detector.listenerCount()).toBe(0);
    expect(status.listenerCount()).toBe(0);

    // a permission answer that lands AFTER stop starts nothing
    let resolve: (s: unknown) => void = () => {};
    const slow = userEnv();
    const env2 = asEnv({
      ...slow.env,
      navigator: {
        permissions: {
          query: () =>
            new Promise((r) => {
              resolve = r;
            }),
        },
      },
    });
    const t2 = new ProcessTracker(env2);
    const off2 = t2.on('userIdle', () => {});
    off2();
    resolve(mkPermission('granted'));
    await flush();
    expect(slow.detector.startCalls).toEqual([]);
  });

  it('retains the last state across a stop; re-activation re-queries the permission', async () => {
    const { env, status, query } = userEnv();
    const t = new ProcessTracker(env);
    const off = t.on('userIdle', () => {});
    await flush();
    off();
    expect(t.currentUserIdle()).toEqual({ userState: 'active', screenState: 'unlocked' });
    status.state = 'denied';
    t.on('userIdle', () => {});
    expect(query).toHaveBeenCalledTimes(2);
    await flush();
    expect(t.currentUserIdle()).toBeUndefined(); // no longer entitled: the snapshot is dropped
  });

  it('a permission that becomes granted later starts the detector; one that is revoked aborts it', async () => {
    const { env, status, detector, aborts } = userEnv({ state: 'prompt' });
    const t = new ProcessTracker(env);
    const out: unknown[] = [];
    t.on('userIdle', (u) => out.push(u));
    await flush();
    expect(detector.startCalls).toEqual([]);
    status.set('granted');
    await flush();
    expect(detector.startCalls).toHaveLength(1);
    expect(out).toHaveLength(1);
    status.set('granted'); // already running: no second detector
    expect(detector.startCalls).toHaveLength(1);
    status.set('denied');
    expect(aborts[0]?.abort).toHaveBeenCalledTimes(1);
    expect(detector.listenerCount()).toBe(0);
    expect(t.currentUserIdle()).toBeUndefined();
  });

  it('omits an unusable userState, and drops a bogus screenState but keeps the user state', async () => {
    const detector = mkDetector();
    detector.userState = 'bogus';
    const { env } = userEnv({ detector });
    const t = new ProcessTracker(env);
    const out: unknown[] = [];
    t.on('userIdle', (u) => out.push(u));
    await flush();
    expect(out).toEqual([]);
    detector.userState = 'idle';
    detector.screenState = 'sideways';
    detector.fire();
    expect(out).toEqual([{ userState: 'idle' }]);
  });

  it('reports a throwing detector getter (host read) and never throws into the event dispatch', async () => {
    const onError = vi.fn();
    const detector = mkDetector();
    const { env } = userEnv({ detector });
    const t = new ProcessTracker(env, onError);
    t.on('userIdle', () => {});
    await flush();
    Object.defineProperty(detector, 'userState', {
      get(): never {
        throw new Error('state');
      },
    });
    expect(() => detector.fire()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a start() that REJECTS ends that detector quietly; a later grant retries', async () => {
    const onError = vi.fn();
    const detector = mkDetector();
    detector.startResult = () => Promise.reject(new Error('NotAllowedError'));
    const { env, status, aborts } = userEnv({ detector });
    const t = new ProcessTracker(env, onError);
    t.on('userIdle', () => {});
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expect(aborts[0]?.abort).toHaveBeenCalled();
    expect(detector.listenerCount()).toBe(0);
    detector.startResult = () => Promise.resolve(undefined);
    status.set('granted');
    await flush();
    expect(detector.startCalls).toHaveLength(2);
    expect(t.currentUserIdle()).toBeDefined();
  });

  it('a start() settling after the run ended does not publish', async () => {
    const detector = mkDetector();
    let settle: () => void = () => {};
    detector.startResult = () =>
      new Promise((r) => {
        settle = () => r(undefined);
      });
    const { env } = userEnv({ detector });
    const t = new ProcessTracker(env);
    const out: unknown[] = [];
    const off = t.on('userIdle', (u) => out.push(u));
    await flush();
    off();
    settle();
    await flush();
    expect(out).toEqual([]);
    expect(t.currentUserIdle()).toBeUndefined();
  });

  it('a detector that cannot be built, started or listened to is reported and cleaned up', async () => {
    const onError = vi.fn();
    const boom = new Error('ctor');
    const e = userEnv();
    const env = asEnv({
      ...e.env,
      IdleDetector: class {
        constructor() {
          throw boom;
        }
      },
    });
    new ProcessTracker(env, onError).on('userIdle', () => {});
    await flush();
    expect(onError).toHaveBeenCalledWith(boom);

    // start() returns a non-promise: `.then` throws -> reported
    const detector = mkDetector();
    (detector as unknown as { start: () => unknown }).start = () => undefined;
    const bad = userEnv({ detector });
    const onError2 = vi.fn();
    new ProcessTracker(bad.env, onError2).on('userIdle', () => {});
    await flush();
    expect(onError2).toHaveBeenCalledTimes(1);
    expect(bad.aborts[0]?.abort).toHaveBeenCalled();
  });

  it('reports abort() and permission-listener failures, and tolerates throwing removeEventListener', async () => {
    const onError = vi.fn();
    const detector = mkDetector();
    detector.removeEventListener.mockImplementation(() => {
      throw new Error('remove');
    });
    const { env, status, aborts } = userEnv({ detector });
    status.removeEventListener.mockImplementation(() => {
      throw new Error('remove2');
    });
    const t = new ProcessTracker(env, onError);
    const off = t.on('userIdle', () => {});
    await flush();
    (aborts[0]?.abort as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('abort');
    });
    expect(() => off()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a permission status that cannot be listened to or read is reported', async () => {
    const onError = vi.fn();
    const { env, status } = userEnv();
    status.addEventListener.mockImplementation(() => {
      throw new Error('listen');
    });
    new ProcessTracker(env, onError).on('userIdle', () => {});
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);

    const onError2 = vi.fn();
    const e = userEnv();
    Object.defineProperty(e.status, 'state', {
      get(): never {
        throw new Error('state');
      },
    });
    new ProcessTracker(e.env, onError2).on('userIdle', () => {});
    await flush();
    expect(onError2).toHaveBeenCalledTimes(1);
  });

  it('a status without addEventListener still works (no live watching)', async () => {
    const e = userEnv();
    const bare = { state: 'granted' };
    const env = asEnv({
      ...e.env,
      navigator: { permissions: { query: () => Promise.resolve(bare) } },
    });
    const off = new ProcessTracker(env).on('userIdle', () => {});
    await flush();
    expect(e.detector.startCalls).toHaveLength(1);
    expect(() => off()).not.toThrow();
  });

  it('a stale change/start/permission event after the run ended is ignored even when removal failed', async () => {
    // detector listener removal throws: the stale onChange is still reachable
    const d1 = mkDetector();
    d1.removeEventListener.mockImplementation(() => {
      throw new Error('remove');
    });
    const e = userEnv({ detector: d1 });
    const t = new ProcessTracker(e.env);
    const out: unknown[] = [];
    t.on('userIdle', (u) => out.push(u));
    await flush();
    e.status.set('denied'); // ends the detector
    out.length = 0;
    d1.fire();
    expect(out).toEqual([]);

    // a start() that settles after the detector was ended (permission revoked) does not publish
    const d2 = mkDetector();
    let settle: () => void = () => {};
    d2.startResult = () =>
      new Promise((r) => {
        settle = () => r(undefined);
      });
    const e2 = userEnv({ detector: d2 });
    const t2 = new ProcessTracker(e2.env);
    const out2: unknown[] = [];
    t2.on('userIdle', (u) => out2.push(u));
    await flush();
    e2.status.set('denied');
    settle();
    await flush();
    expect(out2).toEqual([]);

    // a permission change after teardown (its listener could not be removed) starts nothing
    const e3 = userEnv();
    e3.status.removeEventListener.mockImplementation(() => {
      throw new Error('remove');
    });
    const t3 = new ProcessTracker(e3.env);
    const off3 = t3.on('userIdle', () => {});
    await flush();
    off3();
    e3.status.set('granted');
    await flush();
    expect(e3.detector.startCalls).toHaveLength(1); // only the original start
  });

  it('a detector without addEventListener/removeEventListener is tolerated', async () => {
    const detector = mkDetector();
    (detector as unknown as { addEventListener?: unknown }).addEventListener = undefined;
    (detector as unknown as { removeEventListener?: unknown }).removeEventListener = undefined;
    const { env } = userEnv({ detector });
    const off = new ProcessTracker(env).on('userIdle', () => {});
    await flush();
    expect(() => off()).not.toThrow();
  });
});

// ---- registry / rebind ----------------------------------------------------------------------------------------

describe('processTrackerFor / rebind', () => {
  it('is a singleton per window and a different window gets its own', () => {
    const w1 = {};
    const w2 = {};
    const a = processTrackerFor({ window: w1 });
    expect(processTrackerFor({ window: w1 })).toBe(a);
    expect(processTrackerFor({ window: w2 })).not.toBe(a);
    resetProcessTracker({ window: w1 });
    resetProcessTracker({ window: w2 });
    expect(processTrackerFor({ window: w1 })).not.toBe(a);
    resetProcessTracker({ window: w1 });
  });

  it('keys by window, else performance, else the env object; a hostile getter is reported', () => {
    const perf = { now: () => 1 };
    const a = processTrackerFor({ performance: perf });
    expect(processTrackerFor({ performance: perf })).toBe(a);
    const env = {};
    expect(processTrackerFor(env)).toBe(processTrackerFor(env));
    expect(processTrackerFor({})).not.toBe(processTrackerFor({}));
    const onError = vi.fn();
    const hostile = {
      get window(): never {
        throw new Error('w');
      },
      get performance(): never {
        throw new Error('p');
      },
    };
    expect(() => processTrackerFor(hostile, onError)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(3); // window (key), performance (seam), performance (key)
    resetProcessTracker({ performance: perf });
    resetProcessTracker(env);
    resetProcessTracker({ window: undefined });
  });

  it('rebind merges (an undefined seam never clobbers), swaps onError, and a throwing reporter is isolated', () => {
    const w = {};
    const first = vi.fn();
    const second = vi.fn();
    const boom = new Error('heap');
    const s = mkScheduler();
    const t = processTrackerFor(
      {
        window: w,
        scheduler: s,
        performance: {
          get memory(): never {
            throw boom;
          },
        },
      },
      first,
    );
    // a relaunch that brings NO scheduler/performance keeps the earlier ones
    expect(processTrackerFor({ window: w }, second)).toBe(t);
    t.on('heap', () => {});
    expect(s.live()).toBe(1); // the kept scheduler armed the stage
    // onError replaced: the failing heap read (kept performance) reports to `second` only
    expect(second).toHaveBeenCalledWith(boom);
    expect(first).not.toHaveBeenCalled();
    // a reporter that itself throws is isolated: neither the tick nor the tracker call escapes
    const throwing = vi.fn(() => {
      throw new Error('reporter');
    });
    processTrackerFor({ window: w }, throwing);
    expect(() => s.tick()).not.toThrow();
    expect(throwing).toHaveBeenCalled();
    resetProcessTracker({ window: w });
  });

  it('rebind replaces onError and keeps it when undefined', () => {
    const first = vi.fn();
    const second = vi.fn();
    const boom = new Error('x');
    const s = mkScheduler();
    const env = {
      scheduler: s,
      performance: {
        get memory(): never {
          throw boom;
        },
      },
    };
    const w = {};
    const t = processTrackerFor({ window: w, ...env }, first);
    processTrackerFor({ window: w }, second);
    t.on('heap', () => {});
    expect(second).toHaveBeenCalledWith(boom);
    expect(first).not.toHaveBeenCalled();
    processTrackerFor({ window: w }); // undefined keeps `second`
    s.tick();
    expect(second.mock.calls.length).toBeGreaterThan(1);
    expect(first).not.toHaveBeenCalled();
    resetProcessTracker({ window: w });
  });

  it('a seam change on a RUNNING tracker detaches with the OLD seams, then restarts on the NEW ones', () => {
    const oldS = mkScheduler();
    const newS = mkScheduler();
    const w = {};
    const t = processTrackerFor({
      window: w,
      scheduler: oldS,
      performance: { memory: mem(1) },
    });
    const out: unknown[] = [];
    t.on('heap', (m) => out.push(m));
    expect(oldS.live()).toBe(1);
    const t2 = processTrackerFor({
      window: w,
      scheduler: newS,
      performance: { memory: mem(9) },
    });
    expect(t2).toBe(t);
    expect(oldS.clearInterval).toHaveBeenCalledTimes(1); // OLD scheduler cleared its OWN handle
    expect(oldS.live()).toBe(0);
    expect(newS.live()).toBe(1);
    newS.tick();
    expect(out).toEqual([{ used: 9, limit: 100 }]);
    resetProcessTracker({ window: w });
    expect(newS.live()).toBe(0);
  });

  it('processTrackerFor forwards intervalMs, userIdleThresholdMs and now to the tracker', async () => {
    const s = mkScheduler();
    const { env, detector } = userEnv();
    const w = {};
    let at = 0;
    const t = processTrackerFor({
      window: w,
      ...env,
      scheduler: s,
      performance: { memory: mem(1) },
      intervalMs: 250,
      userIdleThresholdMs: 90_000,
      now: () => at,
    });
    t.on('heap', () => {});
    const off = t.on('userIdle', () => {});
    await flush();
    expect(s.periods()).toEqual([250]);
    expect(detector.startCalls[0]?.threshold).toBe(90_000);
    off();
    at = 180_000; // 2 x 90 s
    expect(t.currentUserIdleFresh()).toBeDefined();
    at = 180_001;
    expect(t.currentUserIdleFresh()).toBeUndefined();
    resetProcessTracker({ window: w });
  });

  it('an unchanged relaunch does not restart anything', () => {
    const s = mkScheduler();
    const perf = { memory: mem(1) };
    const w = {};
    const t = processTrackerFor({ window: w, scheduler: s, performance: perf });
    t.on('heap', () => {});
    processTrackerFor({ window: w, scheduler: s, performance: perf });
    expect(s.setInterval).toHaveBeenCalledTimes(1);
    expect(s.clearInterval).not.toHaveBeenCalled();
    resetProcessTracker({ window: w });
  });

  it('a rebind lets a previously inert stage start (e.g. a lifecycle arrives later)', () => {
    const { s, lc, env } = lagEnv();
    const w = {};
    const { lifecycle: _l, ...noLifecycle } = env;
    const t = processTrackerFor({ window: w, ...noLifecycle });
    t.on('mainThreadLag', () => {});
    expect(s.live()).toBe(0);
    processTrackerFor({ window: w, lifecycle: lc as never });
    expect(s.live()).toBe(1);
    resetProcessTracker({ window: w });
  });

  it('reset() releases every stage, forgets the retained state, and teardown failures are reported', async () => {
    const onError = vi.fn();
    const e = userEnv();
    const s = mkScheduler();
    const t = new ProcessTracker(
      asEnv({ ...e.env, scheduler: s, performance: { memory: mem(1) } }),
      onError,
    );
    t.on('heap', () => {});
    t.on('userIdle', () => {});
    await flush();
    expect(t.currentUserIdle()).toBeDefined();
    t.reset();
    expect(s.live()).toBe(0);
    expect(t.currentUserIdle()).toBeUndefined();
    expect(e.aborts[0]?.abort).toHaveBeenCalled();
  });

  it('reset() reports a teardown that throws (to onError) and still releases the other stages', async () => {
    const onError = vi.fn();
    const e = userEnv();
    const s = mkScheduler();
    const boom = new Error('clear failed');
    s.clearInterval.mockImplementationOnce(() => {
      throw boom;
    });
    const t = new ProcessTracker(
      asEnv({ ...e.env, scheduler: s, performance: { memory: mem(1) } }),
      onError,
    );
    t.on('heap', () => {});
    t.on('userIdle', () => {});
    await flush();
    expect(() => t.reset()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(e.aborts[0]?.abort).toHaveBeenCalled(); // the stage after the failing one was still torn down
    expect(t.currentUserIdle()).toBeUndefined();
  });

  it('a throwing reporter does not escape a failing teardown (reset stays total)', () => {
    const s = mkScheduler();
    s.clearInterval.mockImplementation(() => {
      throw new Error('clear failed');
    });
    const reporter = vi.fn(() => {
      throw new Error('reporter failed');
    });
    const t = new ProcessTracker(
      asEnv({ scheduler: s, performance: { memory: mem(1) } }),
      reporter,
    );
    t.on('heap', () => {});
    expect(() => t.reset()).not.toThrow();
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it('a late rejection from an OLD detector does not end the NEWER run', async () => {
    const onError = vi.fn();
    const status = mkPermission('granted');
    const detectors: Array<ReturnType<typeof mkDetector>> = [];
    const rejectOld: Array<(e: unknown) => void> = [];
    const aborts: Array<{ abort: ReturnType<typeof vi.fn> }> = [];
    class FreshDetector {
      constructor() {
        const d = mkDetector();
        if (detectors.length === 0) {
          d.startResult = () =>
            new Promise((_, reject) => {
              rejectOld.push(reject);
            });
        }
        detectors.push(d);
        // biome-ignore lint/correctness/noConstructorReturn: a test double hands a fresh fake detector back from `new`.
        return d as unknown as FreshDetector;
      }
    }
    class FakeAbort {
      signal = {};
      abort = vi.fn();
      constructor() {
        aborts.push(this);
      }
    }
    const t = new ProcessTracker(
      asEnv({
        navigator: { permissions: { query: () => Promise.resolve(status) } },
        IdleDetector: FreshDetector,
        AbortController: FakeAbort,
      }),
      onError,
    );
    const out: unknown[] = [];
    t.on('userIdle', (u) => out.push(u));
    await flush();
    expect(detectors).toHaveLength(1);
    status.set('denied'); // run 1's detector is ended while its start() is still pending
    expect(aborts[0]?.abort).toHaveBeenCalledTimes(1);
    status.set('granted'); // a NEWER detector starts
    await flush();
    expect(detectors).toHaveLength(2);
    expect(out).toHaveLength(1);
    const newer = detectors[1] as ReturnType<typeof mkDetector>;
    rejectOld[0]?.(new Error('AbortError')); // the OLD one settles late
    await flush();
    expect(aborts[1]?.abort).not.toHaveBeenCalled(); // the newer run was NOT ended
    expect(newer.removeEventListener).not.toHaveBeenCalled();
    newer.userState = 'idle';
    newer.fire();
    expect(out).toHaveLength(2); // and it still publishes
    expect(onError).not.toHaveBeenCalled();
  });

  it('currentUserIdleFresh() hands the state out only within 2 thresholds and never on an untrustworthy clock', async () => {
    let at = 1_000_000;
    const { env } = userEnv({ now: () => at });
    const t = new ProcessTracker(env);
    expect(t.currentUserIdleFresh()).toBeUndefined(); // nothing read yet
    const off = t.on('userIdle', () => {});
    await flush();
    off();
    const state = { userState: 'active', screenState: 'unlocked' };
    expect(t.currentUserIdle()).toEqual(state);
    expect(t.currentUserIdleFresh()).toEqual(state); // age 0
    at += 2 * USER_IDLE_MIN_THRESHOLD_MS;
    expect(t.currentUserIdleFresh()).toEqual(state); // exactly at the bound
    at += 1;
    expect(t.currentUserIdleFresh()).toBeUndefined(); // one ms past it
    expect(t.currentUserIdle()).toEqual(state); // the plain retained read is unchanged
    at = 1_000_000 - 1;
    expect(t.currentUserIdleFresh()).toBeUndefined(); // clock stepped backwards
    at = Number.NaN;
    expect(t.currentUserIdleFresh()).toBeUndefined();
    t.reset();
    at = 1_000_000;
    expect(t.currentUserIdleFresh()).toBeUndefined();
  });

  it('the freshness bound scales with the configured threshold', async () => {
    let at = 0;
    const { env } = userEnv({ now: () => at, userIdleThresholdMs: 300_000 });
    const t = new ProcessTracker(env);
    const off = t.on('userIdle', () => {});
    await flush();
    off();
    at = 600_000;
    expect(t.currentUserIdleFresh()).toBeDefined();
    at = 600_001;
    expect(t.currentUserIdleFresh()).toBeUndefined();
  });

  it('an unreadable clock is reported and never vouches for freshness (stamp and age)', async () => {
    const onError = vi.fn();
    let broken = true;
    const { env } = userEnv({
      now: () => {
        if (broken) throw new Error('clock');
        return 5;
      },
    });
    const t = new ProcessTracker(env, onError);
    const off = t.on('userIdle', () => {});
    await flush();
    off();
    expect(onError).toHaveBeenCalledTimes(1); // the stamp failed
    expect(t.currentUserIdle()).toBeDefined();
    expect(t.currentUserIdleFresh()).toBeUndefined(); // no timestamp -> never fresh
    // a stamped state whose age cannot be read
    broken = false;
    const off2 = t.on('userIdle', () => {});
    await flush();
    off2();
    expect(t.currentUserIdleFresh()).toBeDefined();
    broken = true;
    expect(t.currentUserIdleFresh()).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('a revoked permission drops the retained state AND its age', async () => {
    const { env, status } = userEnv({ now: () => 1 });
    const t = new ProcessTracker(env);
    t.on('userIdle', () => {});
    await flush();
    expect(t.currentUserIdleFresh()).toBeDefined();
    status.set('denied');
    expect(t.currentUserIdle()).toBeUndefined();
    expect(t.currentUserIdleFresh()).toBeUndefined();
  });

  it('an unsubscribe that throws still closes the gated run (no timer left armed)', () => {
    const { s, lc, env } = lagEnv();
    lc.on.mockImplementationOnce(() => () => {
      throw new Error('unsubscribe failed');
    });
    const off = new ProcessTracker(env).on('mainThreadLag', () => {});
    expect(s.live()).toBe(1);
    // the stage teardown rethrows into #stop, which reports it; the run itself must be closed regardless
    expect(() => off()).not.toThrow();
    expect(s.live()).toBe(0);
  });
});
