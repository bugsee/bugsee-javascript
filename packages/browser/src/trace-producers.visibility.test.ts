import type { TraceProducer } from '@bugsee/capture';
import {
  ApplicationTracker,
  resetUiTracker,
  UiTracker,
  uiTrackerFor,
} from '@bugsee/trackers/browser';
import { describe, expect, it } from 'vitest';
import {
  AppStateProducer,
  browserTraceEnvFrom,
  createBrowserSystemTraceProducers,
  defaultBrowserTraceEnv,
  FpsProducer,
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
    fire: (t: string, e: unknown = {}) =>
      l.get(t)?.forEach((f) => {
        f(e);
      }),
    count: () => [...l.values()].reduce((n, s) => n + s.size, 0),
  };
}
function mkPage(visible = true) {
  const win = mkTarget();
  const doc = Object.assign(mkTarget(), { visibilityState: visible ? 'visible' : 'hidden' });
  const lifecycle = new ApplicationTracker({ window: win, document: doc });
  return {
    win,
    doc,
    lifecycle,
    setVisible: (v: boolean) => {
      doc.visibilityState = v ? 'visible' : 'hidden';
      doc.fire('visibilitychange');
    },
  };
}
type Emit = { name: string; value: unknown; hold: boolean | undefined };
const sinkOf = (out: Emit[]) => ({
  emit: (name: string, value: unknown, _d?: number, o?: { hold?: boolean }) =>
    void out.push({ name, value, hold: o?.hold }),
});

describe('AppStateProducer', () => {
  it('emits the Android vocabulary (foreground/background) from the document at start, never visible/hidden', () => {
    for (const [vis, want] of [
      ['visible', 'foreground'],
      ['hidden', 'background'],
      ['prerender', 'background'],
    ] as const) {
      const page = mkPage();
      page.doc.visibilityState = vis;
      const out: Emit[] = [];
      new AppStateProducer(page.lifecycle).start(sinkOf(out));
      expect(out).toEqual([{ name: 'app_state', value: want, hold: true }]);
    }
  });

  it('follows visibility changes, held and de-duplicated', () => {
    const page = mkPage();
    const out: Emit[] = [];
    new AppStateProducer(page.lifecycle).start(sinkOf(out));
    page.setVisible(false);
    page.setVisible(false);
    page.setVisible(true);
    expect(out.map((o) => o.value)).toEqual(['foreground', 'background', 'foreground']);
    expect(out.every((o) => o.hold === true)).toBe(true);
  });

  it('with no readable state there is no initial value, but changes still report', () => {
    const doc = mkTarget(); // no visibilityState at all
    const lifecycle = new ApplicationTracker({ window: mkTarget(), document: doc });
    const out: Emit[] = [];
    new AppStateProducer(lifecycle).start(sinkOf(out));
    expect(out).toEqual([]);
    Object.assign(doc, { visibilityState: 'hidden' });
    doc.fire('visibilitychange');
    expect(out.map((o) => o.value)).toEqual(['background']);
  });

  it('a throwing visibilityState read yields no initial value and never throws', () => {
    const doc = mkTarget();
    Object.defineProperty(doc, 'visibilityState', {
      get(): never {
        throw new Error('vis');
      },
    });
    const errors: unknown[] = [];
    const lifecycle = new ApplicationTracker({ document: doc }, (e) => errors.push(e));
    const out: Emit[] = [];
    expect(() => new AppStateProducer(lifecycle).start(sinkOf(out))).not.toThrow();
    expect(out).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('a producer started after a hidden gap reports the CURRENT state, not a stale one', () => {
    const page = mkPage();
    const first = new AppStateProducer(page.lifecycle);
    const out: Emit[] = [];
    first.start(sinkOf(out));
    first.stop();
    page.doc.visibilityState = 'hidden'; // while nobody listened
    const out2: Emit[] = [];
    new AppStateProducer(page.lifecycle).start(sinkOf(out2));
    expect(out2.map((o) => o.value)).toEqual(['background']);
  });

  it('stop() releases the lifecycle subscription', () => {
    const page = mkPage();
    const out: Emit[] = [];
    const p = new AppStateProducer(page.lifecycle);
    p.start(sinkOf(out));
    expect(page.doc.count()).toBe(3); // visibilitychange + freeze + resume (the shared lifecycle's document listeners)
    p.stop();
    expect(page.doc.count()).toBe(0);
    page.setVisible(false);
    expect(out).toHaveLength(1);
  });
});

describe('FpsProducer', () => {
  it('emits the tracker fps every window as a polled value (never held, no baseline)', () => {
    const page = mkPage();
    let timer: (() => void) | undefined;
    let now = 0;
    const cbs: Array<() => void> = [];
    const tracker = new UiTracker({
      document: page.doc,
      requestAnimationFrame: (cb) => {
        cbs.push(() => cb(0));
        return cbs.length;
      },
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
    const p = new FpsProducer(tracker);
    p.start(sinkOf(out));
    expect(out).toEqual([]);
    now = 1000;
    cbs[0]?.();
    timer?.();
    expect(out).toEqual([{ name: 'fps', value: 1, hold: false }]);
    expect(page.doc.count()).toBe(1); // subscribed: the tracker's own visibilitychange (no page-lifecycle tracker)
    p.stop();
    expect(page.doc.count()).toBe(0); // the tracker was released with the last subscriber
    now = 2000;
    timer?.();
    expect(out).toHaveLength(1);
  });
});

describe('createBrowserSystemTraceProducers: visibility families', () => {
  const names = (ps: TraceProducer[]) => ps.map((p) => p.name);

  it('adds app_state and fps when a lifecycle is wired, and neither without one', () => {
    const page = mkPage();
    const withLifecycle = createBrowserSystemTraceProducers({
      lifecycle: page.lifecycle,
      document: page.doc,
      requestAnimationFrame: () => 1,
    });
    expect(names(withLifecycle)).toEqual(expect.arrayContaining(['app-state', 'fps']));
    expect(names(createBrowserSystemTraceProducers({}))).not.toEqual(
      expect.arrayContaining(['app-state']),
    );
    expect(names(createBrowserSystemTraceProducers({}))).not.toEqual(
      expect.arrayContaining(['fps']),
    );
  });

  it('sensors:false builds the battery producer only', () => {
    const page = mkPage();
    expect(
      names(createBrowserSystemTraceProducers({ lifecycle: page.lifecycle, sensors: false })),
    ).toEqual(['battery']);
  });
});

describe('browserTraceEnvFrom', () => {
  it('derives every surface from THAT window (no fallback to globals), rAF bound to it', () => {
    const calls: unknown[] = [];
    const win = {
      performance: {
        memory: { usedJSHeapSize: 1, totalJSHeapSize: 2, jsHeapSizeLimit: 3 },
        now: () => 5,
      },
      navigator: { onLine: true },
      screen: { orientation: { type: 'portrait-primary', angle: 0 } },
      requestAnimationFrame(this: unknown, cb: (t: number) => void) {
        calls.push(this);
        cb(0);
        return 7;
      },
      cancelAnimationFrame(this: unknown) {
        calls.push(this);
      },
    };
    const doc = { visibilityState: 'visible' };
    const env = browserTraceEnvFrom(win, doc);
    expect(env.performance).toBe(win.performance);
    expect(env.navigator).toBe(win.navigator);
    expect(env.screen).toBe(win.screen);
    expect(env.window).toBe(win);
    expect(env.document).toBe(doc);
    expect(env.requestAnimationFrame?.(() => {})).toBe(7);
    env.cancelAnimationFrame?.(1);
    expect(calls).toEqual([win, win]);
  });

  it('a window whose getters throw (cross-origin proxy, torn-down frame) never throws: each surface is omitted and reported', () => {
    const win = {};
    for (const key of [
      'navigator',
      'performance',
      'screen',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ]) {
      Object.defineProperty(win, key, {
        get(): never {
          throw new Error(`${key} blocked`);
        },
      });
    }
    const errors: unknown[] = [];
    let env: ReturnType<typeof browserTraceEnvFrom> | undefined;
    expect(() => {
      env = browserTraceEnvFrom(win, undefined, (e) => errors.push(e));
    }).not.toThrow();
    expect(Object.keys(env ?? {})).toEqual(['window']);
    expect(errors.map((e) => (e as Error).message).sort()).toEqual([
      'cancelAnimationFrame blocked',
      'navigator blocked',
      'performance blocked',
      'requestAnimationFrame blocked',
      'screen blocked',
    ]);
  });

  it("matchMedia is the window's own, bound to it; absent or throwing means none", () => {
    const calls: unknown[] = [];
    const win = {
      matchMedia(this: unknown, query: string) {
        calls.push(this, query);
        return { matches: true };
      },
    };
    const env = browserTraceEnvFrom(win, undefined);
    expect(env.matchMedia?.('(x)')).toEqual({ matches: true });
    expect(calls).toEqual([win, '(x)']);
    expect(browserTraceEnvFrom({}, undefined).matchMedia).toBeUndefined();
    const errors: unknown[] = [];
    const hostile = {};
    Object.defineProperty(hostile, 'matchMedia', {
      get(): never {
        throw new Error('matchMedia blocked');
      },
    });
    expect(
      browserTraceEnvFrom(hostile, undefined, (e) => errors.push(e)).matchMedia,
    ).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("createBrowserSystemTraceProducers hands the env's matchMedia/screen to the window's UiTracker", () => {
    const win = { addEventListener() {}, removeEventListener() {} };
    createBrowserSystemTraceProducers({
      window: win,
      matchMedia: () => ({ matches: true }),
    });
    expect(uiTrackerFor({ window: win }).current('colorScheme')).toEqual({ dark: true });
    resetUiTracker({ window: win });
  });

  it('one throwing surface does not take the others with it, and onError is optional', () => {
    const screen = { orientation: { type: 'portrait-primary', angle: 0 } };
    const win = { screen };
    Object.defineProperty(win, 'performance', {
      get(): never {
        throw new Error('perf blocked');
      },
    });
    const env = browserTraceEnvFrom(win, undefined);
    expect(env.screen).toBe(screen);
    expect(env.performance).toBeUndefined();
  });

  it('a navigator whose getBattery getter throws loses only the battery', () => {
    const navigator = { onLine: true };
    Object.defineProperty(navigator, 'getBattery', {
      get(): never {
        throw new Error('battery blocked');
      },
    });
    const errors: unknown[] = [];
    const env = browserTraceEnvFrom({ navigator }, undefined, (e) => errors.push(e));
    expect(env.navigator).toBe(navigator);
    expect(env.getBattery).toBeUndefined();
    expect((errors[0] as Error).message).toBe('battery blocked');
  });

  it('a throwing global window getter does not break defaultBrowserTraceEnv', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      get(): never {
        throw new Error('window blocked');
      },
    });
    try {
      const errors: unknown[] = [];
      expect(() => defaultBrowserTraceEnv((e) => errors.push(e))).not.toThrow();
      expect((errors[0] as Error).message).toBe('window blocked');
      expect(() => defaultBrowserTraceEnv()).not.toThrow(); // no reporter
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, 'window', original);
      else delete (globalThis as { window?: unknown }).window;
    }
  });

  it('the default env reports a throwing global navigator/performance/screen read and omits only that surface', () => {
    const keys = ['navigator', 'performance', 'screen'];
    const saved = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    for (const k of keys) {
      Object.defineProperty(globalThis, k, {
        configurable: true,
        get(): never {
          throw new Error(`${k} blocked`);
        },
      });
    }
    try {
      const errors: unknown[] = [];
      let env: ReturnType<typeof defaultBrowserTraceEnv> | undefined;
      expect(() => {
        env = defaultBrowserTraceEnv((e) => errors.push(e));
      }).not.toThrow();
      expect(env?.navigator).toBeUndefined();
      expect(errors.map((e) => (e as Error).message).sort()).toEqual([
        'navigator blocked',
        'performance blocked',
        'screen blocked',
      ]);
    } finally {
      for (const [k, d] of saved) {
        if (d !== undefined) Object.defineProperty(globalThis, k, d);
        else delete (globalThis as Record<string, unknown>)[k];
      }
    }
  });

  it('a performance whose now getter throws costs only the fps clock: the producers still build and report', () => {
    const page = mkPage();
    const performance = {};
    Object.defineProperty(performance, 'now', {
      get(): never {
        throw new Error('now blocked');
      },
    });
    const errors: unknown[] = [];
    let built: TraceProducer[] = [];
    expect(() => {
      built = createBrowserSystemTraceProducers(
        {
          lifecycle: page.lifecycle,
          performance,
          document: page.doc,
          requestAnimationFrame: () => 1,
        },
        (e) => errors.push(e),
      );
    }).not.toThrow();
    expect(built.map((p) => p.name)).toContain('fps');
    expect(errors.some((e) => (e as Error).message === 'now blocked')).toBe(true);
  });

  it('omits what the window lacks (a missing performance.memory is not borrowed from the global)', () => {
    const env = browserTraceEnvFrom({}, undefined);
    expect(Object.keys(env)).toEqual(['window']);
  });

  it('only includes getBattery when the window navigator has it, called on that navigator', async () => {
    let self: unknown;
    const navigator = {
      getBattery() {
        self = this;
        return Promise.resolve({ level: 1, charging: false } as never);
      },
    };
    const env = browserTraceEnvFrom({ navigator }, undefined);
    await env.getBattery?.();
    expect(self).toBe(navigator);
  });
});
