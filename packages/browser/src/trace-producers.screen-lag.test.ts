import type { TraceProducer } from '@bugsee/capture';
import { ApplicationTracker, ProcessTracker, UiTracker } from '@bugsee/trackers/browser';
import { describe, expect, it } from 'vitest';
import {
  browserTraceEnvFrom,
  createBrowserSystemTraceProducers,
  DisplaysProducer,
  MainThreadLagProducer,
} from './trace-producers';

function mkTarget() {
  const l = new Map<string, Set<(e: unknown) => void>>();
  return {
    addEventListener: (t: string, f: (e: unknown) => void) => {
      const s = l.get(t) ?? new Set<(e: unknown) => void>();
      s.add(f);
      l.set(t, s);
    },
    removeEventListener: (t: string, f: (e: unknown) => void) => void l.get(t)?.delete(f),
    fire: (t: string) =>
      l.get(t)?.forEach((f) => {
        f({});
      }),
    count: () => [...l.values()].reduce((n, s) => n + s.size, 0),
  };
}
type Emit = { name: string; value: unknown; hold: boolean | undefined };
const sinkOf = (out: Emit[]) => ({
  emit: (name: string, value: unknown, _d?: number, o?: { hold?: boolean }) =>
    void out.push({ name, value, hold: o?.hold }),
});
const names = (ps: TraceProducer[]) => ps.map((p) => p.name);

describe('DisplaysProducer', () => {
  const mk = (screen: unknown = { width: 390, height: 844 }) => {
    const win = Object.assign(mkTarget(), { devicePixelRatio: 2 });
    const tracker = new UiTracker({ window: win, screen: screen as never });
    return { win, tracker };
  };

  it('emits the one-entry mobile list at start (device pixels, scale, state on) as a HELD step trace, then follows resize, de-duplicated', () => {
    const { win, tracker } = mk();
    const out: Emit[] = [];
    new DisplaysProducer(tracker).start(sinkOf(out));
    expect(out).toEqual([
      {
        name: 'displays',
        value: [{ id: 0, state: 'on', width: 780, height: 1688, scale: 2 }],
        hold: true,
      },
    ]);
    win.fire('resize'); // nothing moved
    expect(out).toHaveLength(1);
    win.devicePixelRatio = 3;
    win.fire('resize');
    win.fire('orientationchange');
    expect(out.map((o) => o.value)).toEqual([
      [{ id: 0, state: 'on', width: 780, height: 1688, scale: 2 }],
      [{ id: 0, state: 'on', width: 1170, height: 2532, scale: 3 }],
    ]);
  });

  it('page zoom: width/height/scale use the recovered device scale (no drift) and zoom is written', () => {
    // Chrome 156 shape at 144%, device scale 2: screen fixed, dpr 2.88, inner = outer / 1.44
    const win = Object.assign(mkTarget(), {
      devicePixelRatio: 2.88,
      outerWidth: 1440,
      innerWidth: 1000,
    });
    const out: Emit[] = [];
    new DisplaysProducer(
      new UiTracker({ window: win, screen: { width: 1440, height: 900 } as never }),
    ).start(sinkOf(out));
    expect(out[0]?.value).toEqual([
      { id: 0, state: 'on', width: 2880, height: 1800, scale: 2, zoom: 1.44 },
    ]);
    // back to 100%: the physical size is unchanged, only zoom moves
    Object.assign(win, { devicePixelRatio: 2, innerWidth: 1440 });
    win.fire('resize');
    expect(out.map((o) => o.value)).toEqual([
      [{ id: 0, state: 'on', width: 2880, height: 1800, scale: 2, zoom: 1.44 }],
      [{ id: 0, state: 'on', width: 2880, height: 1800, scale: 2, zoom: 1 }],
    ]);
  });

  it('without a derivable zoom the entry has no zoom key and uses devicePixelRatio', () => {
    const win = Object.assign(mkTarget(), { devicePixelRatio: 2, outerWidth: 0, innerWidth: 800 });
    const out: Emit[] = [];
    new DisplaysProducer(
      new UiTracker({ window: win, screen: { width: 400, height: 300 } as never }),
    ).start(sinkOf(out));
    expect(out[0]?.value).toStrictEqual([
      { id: 0, state: 'on', width: 800, height: 600, scale: 2 },
    ]);
  });

  it('rounds the device pixels from a fractional ratio and records the ratio used in scale', () => {
    const win = Object.assign(mkTarget(), { devicePixelRatio: 1.25 });
    const out: Emit[] = [];
    new DisplaysProducer(
      new UiTracker({ window: win, screen: { width: 1366, height: 768 } as never }),
    ).start(sinkOf(out));
    expect(out[0]?.value).toEqual([{ id: 0, state: 'on', width: 1708, height: 960, scale: 1.25 }]);
  });

  it('rounds height too (844.8 -> 845, not floored) and records the ratio used', () => {
    const win = Object.assign(mkTarget(), { devicePixelRatio: 1.1 });
    const out: Emit[] = [];
    new DisplaysProducer(
      new UiTracker({ window: win, screen: { width: 1000, height: 768 } as never }),
    ).start(sinkOf(out));
    expect(out[0]?.value).toEqual([{ id: 0, state: 'on', width: 1100, height: 845, scale: 1.1 }]);
  });

  it('writes nothing when EITHER side rounds to zero (each side alone)', () => {
    for (const screen of [
      { width: 0.4, height: 100 },
      { width: 100, height: 0.4 },
    ]) {
      const win = Object.assign(mkTarget(), { devicePixelRatio: 1 });
      const out: Emit[] = [];
      new DisplaysProducer(new UiTracker({ window: win, screen: screen as never })).start(
        sinkOf(out),
      );
      expect(out).toEqual([]);
    }
  });

  it('rounds the zoom-polluted ratio to 2 decimals and de-duplicates on the rounded value', () => {
    const win = Object.assign(mkTarget(), { devicePixelRatio: 1.100000023841858 });
    const out: Emit[] = [];
    new DisplaysProducer(
      new UiTracker({ window: win, screen: { width: 1000, height: 1000 } as never }),
    ).start(sinkOf(out));
    expect(out[0]?.value).toEqual([{ id: 0, state: 'on', width: 1100, height: 1100, scale: 1.1 }]);
    win.devicePixelRatio = 1.1;
    win.fire('resize');
    expect(out).toHaveLength(1);
  });

  it('writes rotation as quarter turns of the orientation angle, omits it without a usable angle, and follows an orientation change', () => {
    const win = Object.assign(mkTarget(), { devicePixelRatio: 2 });
    const screen = { width: 390, height: 844, orientation: { type: 'portrait-primary', angle: 0 } };
    const out: Emit[] = [];
    const tracker = new UiTracker({ window: win, screen: screen as never });
    new DisplaysProducer(tracker).start(sinkOf(out));
    const rot = () => (out.at(-1)?.value as Array<{ rotation?: number }>)[0]?.rotation;
    expect(rot()).toBe(0);
    for (const [angle, turns] of [
      [90, 1],
      [180, 2],
      [270, 3],
      [-90, 3],
      [360, 0],
    ] as const) {
      screen.orientation.angle = angle;
      win.fire('orientationchange');
      expect(rot()).toBe(turns);
    }
    screen.orientation.angle = 45; // not a quarter turn: omitted, not rounded
    win.fire('orientationchange');
    expect(out.at(-1)?.value).toEqual([{ id: 0, state: 'on', width: 780, height: 1688, scale: 2 }]);
    const noAngle: Emit[] = [];
    new DisplaysProducer(
      new UiTracker({
        window: Object.assign(mkTarget(), { devicePixelRatio: 2 }),
        screen: { width: 390, height: 844 } as never,
      }),
    ).start(sinkOf(noAngle));
    expect(noAngle[0]?.value).toEqual([{ id: 0, state: 'on', width: 780, height: 1688, scale: 2 }]);
  });

  it('a size that rounds to 0 device pixels is omitted (never 0)', () => {
    const win = Object.assign(mkTarget(), { devicePixelRatio: 0.001 });
    const out: Emit[] = [];
    new DisplaysProducer(
      new UiTracker({ window: win, screen: { width: 100, height: 100 } as never }),
    ).start(sinkOf(out));
    expect(out).toEqual([]);
  });

  it('is omitted entirely when the screen is absent or unreadable (never 0)', () => {
    for (const screen of [undefined, { width: 0, height: 844 }, { width: 390 }]) {
      const win = Object.assign(mkTarget(), { devicePixelRatio: 2 });
      const out: Emit[] = [];
      new DisplaysProducer(new UiTracker({ window: win, ...(screen ? { screen } : {}) })).start(
        sinkOf(out),
      );
      expect(out).toEqual([]);
    }
  });

  it('stop() releases the window listeners and later events write nothing', () => {
    const { win, tracker } = mk();
    const out: Emit[] = [];
    const p = new DisplaysProducer(tracker);
    p.start(sinkOf(out));
    expect(win.count()).toBeGreaterThan(0);
    p.stop();
    expect(win.count()).toBe(0);
    win.devicePixelRatio = 5;
    win.fire('resize');
    expect(out).toHaveLength(1);
  });
});

describe('MainThreadLagProducer', () => {
  it('emits each tick drift as a POLLED value (hold:false), including a true 0, and releases on stop', () => {
    const win = mkTarget();
    const doc = Object.assign(mkTarget(), { visibilityState: 'visible' });
    const lifecycle = new ApplicationTracker({ window: win, document: doc });
    let timer: (() => void) | undefined;
    let now = 0;
    const tracker = new ProcessTracker({
      lifecycle,
      document: doc,
      performance: { now: () => now },
      scheduler: {
        setInterval: (cb) => {
          timer = cb;
          return 1;
        },
        clearInterval: () => {},
      },
    });
    const out: Emit[] = [];
    const p = new MainThreadLagProducer(tracker);
    expect(doc.count()).toBe(0);
    p.start(sinkOf(out));
    expect(out).toEqual([]); // nothing before the first tick
    now = 1000;
    timer?.();
    now = 2000 + 120; // a 120 ms block spanning the second tick
    timer?.();
    expect(out).toEqual([
      { name: 'main_thread_lag_ms', value: 0, hold: false },
      { name: 'main_thread_lag_ms', value: 120, hold: false },
    ]);
    expect(doc.count()).toBeGreaterThan(0); // the lifecycle attached its document listeners for us
    p.stop();
    expect(doc.count()).toBe(0);
    timer?.();
    expect(out).toHaveLength(2);
  });
});

describe('createBrowserSystemTraceProducers: displays + main_thread_lag_ms', () => {
  it('are added with a lifecycle (same gate as app_state/fps) and absent without one', () => {
    const win = mkTarget();
    const lifecycle = new ApplicationTracker({ window: win });
    expect(names(createBrowserSystemTraceProducers({ lifecycle }))).toEqual(
      expect.arrayContaining(['displays', 'main-thread-lag']),
    );
    expect(names(createBrowserSystemTraceProducers({}))).not.toEqual(
      expect.arrayContaining(['displays']),
    );
    expect(names(createBrowserSystemTraceProducers({}))).not.toEqual(
      expect.arrayContaining(['main-thread-lag']),
    );
  });

  it('sensors:false builds the battery producer only', () => {
    const lifecycle = new ApplicationTracker({ window: mkTarget() });
    expect(names(createBrowserSystemTraceProducers({ lifecycle, sensors: false }))).toEqual([
      'battery',
    ]);
  });

  it('wires the env window/screen/document/clock/scheduler into the trackers, nothing from globals', () => {
    let t = 777_000; // a distinctive clock value: only the INJECTED window's performance can produce it
    const win = Object.assign(mkTarget(), {
      devicePixelRatio: 2,
      screen: { width: 100, height: 200 },
      performance: { now: () => t },
    });
    const doc = { visibilityState: 'visible' };
    const lifecycle = new ApplicationTracker({
      window: win,
      document: Object.assign(mkTarget(), doc),
    });
    let timer: (() => void) | undefined;
    const errors: unknown[] = [];
    const ps = createBrowserSystemTraceProducers(
      {
        ...browserTraceEnvFrom(win, doc),
        lifecycle,
        scheduler: {
          setInterval: (cb) => {
            timer = cb;
            return 1;
          },
          clearInterval: () => {},
        },
      },
      (e) => errors.push(e),
    );
    const out: Emit[] = [];
    for (const p of ps)
      if (p.name === 'displays' || p.name === 'main-thread-lag') p.start(sinkOf(out));
    expect(out).toEqual([
      {
        name: 'displays',
        value: [{ id: 0, state: 'on', width: 200, height: 400, scale: 2 }],
        hold: true,
      },
    ]);
    t += 1000 + 33;
    timer?.();
    expect(out[1]).toEqual({ name: 'main_thread_lag_ms', value: 33, hold: false });
    expect(errors).toEqual([]);
  });

  it('a non-array hostOwnedTraces never throws and never suppresses (a string is not a substring match)', () => {
    const lifecycle = new ApplicationTracker({ window: mkTarget() });
    for (const bad of ['displays', 'displays-x', 7, { includes: () => true }]) {
      expect(
        names(createBrowserSystemTraceProducers({ lifecycle, hostOwnedTraces: bad as never })),
      ).toContain('displays');
    }
  });

  it('hostOwnedTraces: [displays] drops ONLY the displays producer (the host writes it)', () => {
    const win = mkTarget();
    const lifecycle = new ApplicationTracker({ window: win });
    const all = names(createBrowserSystemTraceProducers({ lifecycle }));
    const owned = names(
      createBrowserSystemTraceProducers({ lifecycle, hostOwnedTraces: ['displays'] }),
    );
    expect(all).toContain('displays');
    expect(owned).toEqual(all.filter((n) => n !== 'displays'));
    // an unrelated host-owned name does not drop it
    expect(
      names(createBrowserSystemTraceProducers({ lifecycle, hostOwnedTraces: ['capture'] })),
    ).toEqual(all);
  });

  it('a window without a performance clock starts no timer and reports nothing (no error)', () => {
    const win = Object.assign(mkTarget(), { screen: { width: 1, height: 1 }, devicePixelRatio: 1 });
    const doc = { visibilityState: 'visible' };
    const lifecycle = new ApplicationTracker({
      window: win,
      document: Object.assign(mkTarget(), doc),
    });
    let timers = 0;
    const errors: unknown[] = [];
    const lag = createBrowserSystemTraceProducers(
      {
        ...browserTraceEnvFrom(win, doc),
        lifecycle,
        scheduler: {
          setInterval: () => {
            timers += 1;
            return 1;
          },
          clearInterval: () => {},
        },
      },
      (e) => errors.push(e),
    ).find((p) => p.name === 'main-thread-lag');
    const out: Emit[] = [];
    expect(() => lag?.start(sinkOf(out))).not.toThrow();
    expect(out).toEqual([]);
    expect(errors).toEqual([]);
    // the other lifecycle trace that needs a clock (fps) also uses its own timer; only count the lag producer's
    expect(timers).toBe(0);
  });
});

describe('performance.now wiring (lag and fps)', () => {
  // `now` throws unless it is invoked as a method of THIS performance object, like a real Performance.
  const mkPerf = () => {
    const perf = {
      t: 0,
      reads: 0,
      now(this: unknown): number {
        if (this !== perf) throw new TypeError('Illegal invocation');
        perf.reads += 1;
        return perf.t;
      },
    };
    return perf;
  };
  const mkLifecycle = () => {
    const doc = Object.assign(mkTarget(), { visibilityState: 'visible' });
    return { doc, lifecycle: new ApplicationTracker({ window: mkTarget(), document: doc }) };
  };

  it('the lag and fps clocks are called as performance.now() (this === performance), with no error', () => {
    const perf = mkPerf();
    const { doc, lifecycle } = mkLifecycle();
    const errors: unknown[] = [];
    const ticks: Array<() => void> = [];
    const ps = createBrowserSystemTraceProducers(
      {
        lifecycle,
        document: doc,
        performance: perf,
        requestAnimationFrame: () => 1,
        scheduler: {
          setInterval: (cb) => {
            ticks.push(cb);
            return 1;
          },
          clearInterval: () => {},
        },
      },
      (e) => errors.push(e),
    );
    const out: Emit[] = [];
    for (const p of ps) if (p.name === 'main-thread-lag' || p.name === 'fps') p.start(sinkOf(out));
    perf.t = 1000 + 12;
    for (const tick of ticks) tick();
    expect(errors).toEqual([]);
    expect(out.find((o) => o.name === 'main_thread_lag_ms')?.value).toBe(12);
    expect(perf.reads).toBeGreaterThanOrEqual(2); // fps and lag both read it at start
  });

  it('a performance.now getter that throws is reported ONCE, not once per consumer', () => {
    const { doc, lifecycle } = mkLifecycle();
    const perf = {};
    Object.defineProperty(perf, 'now', {
      get(): never {
        throw new Error('now blocked');
      },
    });
    const errors: unknown[] = [];
    const ps = createBrowserSystemTraceProducers(
      { lifecycle, document: doc, performance: perf },
      (e) => errors.push(e),
    );
    const out: Emit[] = [];
    // The factory reads silently; the tracker reports the persistent failure ONCE (not once per activation: errors used
    // to grow 1,2,3 across start/stop/restart), and nothing is reported before a lag/uptime stage activates.
    expect(errors).toEqual([]);
    const rounds: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      for (const p of ps) p.start(sinkOf(out));
      for (const p of ps) p.stop();
      rounds.push(errors.length);
    }
    expect(rounds).toEqual([1, 1, 1]);
    expect(errors.every((e) => (e as Error).message === 'now blocked')).toBe(true);
    expect(out.filter((o) => o.name === 'main_thread_lag_ms')).toEqual([]);
  });
});

describe('main_thread_lag_ms clock wiring', () => {
  it('a performance.now that is not a function omits the trace quietly (no timer, no error)', () => {
    const win = mkTarget();
    const doc = Object.assign(mkTarget(), { visibilityState: 'visible' });
    const lifecycle = new ApplicationTracker({ window: win, document: doc });
    let timers = 0;
    const errors: unknown[] = [];
    const lag = createBrowserSystemTraceProducers(
      {
        lifecycle,
        document: doc,
        performance: { now: 5 as never },
        scheduler: {
          setInterval: () => {
            timers += 1;
            return 1;
          },
          clearInterval: () => {},
        },
      },
      (e) => errors.push(e),
    ).find((p) => p.name === 'main-thread-lag');
    const out: Emit[] = [];
    lag?.start(sinkOf(out));
    expect(timers).toBe(0);
    expect(errors).toEqual([]);
    expect(out).toEqual([]);
  });
});
