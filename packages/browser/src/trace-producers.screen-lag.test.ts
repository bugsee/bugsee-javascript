import type { TraceProducer } from '@bugsee/capture';
import { describe, expect, it } from 'vitest';
import {
  browserTraceEnvFrom,
  createBrowserSystemTraceProducers,
  MainThreadLagProducer,
  ScreenSizeProducer,
} from './trace-producers';
import { MainThreadLagTracker } from './trackers/main-thread-lag-tracker';
import { PageLifecycleTracker } from './trackers/page-lifecycle-tracker';
import { ScreenSizeTracker } from './trackers/screen-size-tracker';

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

describe('ScreenSizeProducer', () => {
  const mk = (screen: unknown = { width: 390, height: 844 }) => {
    const win = Object.assign(mkTarget(), { devicePixelRatio: 2 });
    const tracker = new ScreenSizeTracker({ window: win, screen: screen as never });
    return { win, tracker };
  };

  it('emits {width,height,dpr} at start as a HELD step trace, then follows resize, de-duplicated', () => {
    const { win, tracker } = mk();
    const out: Emit[] = [];
    new ScreenSizeProducer(tracker).start(sinkOf(out));
    expect(out).toEqual([
      { name: 'screen_size', value: { width: 390, height: 844, dpr: 2 }, hold: true },
    ]);
    win.fire('resize'); // nothing moved
    expect(out).toHaveLength(1);
    win.devicePixelRatio = 3;
    win.fire('resize');
    win.fire('orientationchange');
    expect(out.map((o) => o.value)).toEqual([
      { width: 390, height: 844, dpr: 2 },
      { width: 390, height: 844, dpr: 3 },
    ]);
  });

  it('is omitted entirely when the screen is absent or unreadable (never 0)', () => {
    for (const screen of [undefined, { width: 0, height: 844 }, { width: 390 }]) {
      const win = Object.assign(mkTarget(), { devicePixelRatio: 2 });
      const out: Emit[] = [];
      new ScreenSizeProducer(
        new ScreenSizeTracker({ window: win, ...(screen ? { screen } : {}) }),
      ).start(sinkOf(out));
      expect(out).toEqual([]);
    }
  });

  it('stop() releases the window listeners and later events write nothing', () => {
    const { win, tracker } = mk();
    const out: Emit[] = [];
    const p = new ScreenSizeProducer(tracker);
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
    const lifecycle = new PageLifecycleTracker({ window: win, document: doc });
    let timer: (() => void) | undefined;
    let now = 0;
    const tracker = new MainThreadLagTracker({
      lifecycle,
      document: doc,
      now: () => now,
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

describe('createBrowserSystemTraceProducers: screen_size + main_thread_lag_ms', () => {
  it('are added with a lifecycle (same gate as app_state/fps) and absent without one', () => {
    const win = mkTarget();
    const lifecycle = new PageLifecycleTracker({ window: win });
    expect(names(createBrowserSystemTraceProducers({ lifecycle }))).toEqual(
      expect.arrayContaining(['screen-size', 'main-thread-lag']),
    );
    expect(names(createBrowserSystemTraceProducers({}))).not.toEqual(
      expect.arrayContaining(['screen-size']),
    );
    expect(names(createBrowserSystemTraceProducers({}))).not.toEqual(
      expect.arrayContaining(['main-thread-lag']),
    );
  });

  it('sensors:false builds the battery producer only', () => {
    const lifecycle = new PageLifecycleTracker({ window: mkTarget() });
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
    const lifecycle = new PageLifecycleTracker({
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
      if (p.name === 'screen-size' || p.name === 'main-thread-lag') p.start(sinkOf(out));
    expect(out).toEqual([
      { name: 'screen_size', value: { width: 100, height: 200, dpr: 2 }, hold: true },
    ]);
    t += 1000 + 33;
    timer?.();
    expect(out[1]).toEqual({ name: 'main_thread_lag_ms', value: 33, hold: false });
    expect(errors).toEqual([]);
  });

  it('a window without a performance clock starts no timer and reports nothing (no error)', () => {
    const win = Object.assign(mkTarget(), { screen: { width: 1, height: 1 }, devicePixelRatio: 1 });
    const doc = { visibilityState: 'visible' };
    const lifecycle = new PageLifecycleTracker({
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

describe('main_thread_lag_ms clock wiring', () => {
  it('a performance.now that is not a function omits the trace quietly (no timer, no error)', () => {
    const win = mkTarget();
    const doc = Object.assign(mkTarget(), { visibilityState: 'visible' });
    const lifecycle = new PageLifecycleTracker({ window: win, document: doc });
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
