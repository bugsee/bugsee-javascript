import type { TraceProducer } from '@bugsee/capture';
import { describe, expect, it } from 'vitest';
import {
  AppStateProducer,
  browserTraceEnvFrom,
  createBrowserSystemTraceProducers,
  FpsProducer,
} from './trace-producers';
import { FpsTracker } from './trackers/fps-tracker';
import { PageLifecycleTracker } from './trackers/page-lifecycle-tracker';

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
  const lifecycle = new PageLifecycleTracker({ window: win, document: doc });
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
      new AppStateProducer(page.lifecycle, page.doc).start(sinkOf(out));
      expect(out).toEqual([{ name: 'app_state', value: want, hold: true }]);
    }
  });

  it('follows visibility changes, held and de-duplicated', () => {
    const page = mkPage();
    const out: Emit[] = [];
    new AppStateProducer(page.lifecycle, page.doc).start(sinkOf(out));
    page.setVisible(false);
    page.setVisible(false);
    page.setVisible(true);
    expect(out.map((o) => o.value)).toEqual(['foreground', 'background', 'foreground']);
    expect(out.every((o) => o.hold === true)).toBe(true);
  });

  it('with no document there is no initial value, but changes still report', () => {
    const page = mkPage();
    const out: Emit[] = [];
    new AppStateProducer(page.lifecycle, undefined).start(sinkOf(out));
    expect(out).toEqual([]);
    page.setVisible(false);
    expect(out.map((o) => o.value)).toEqual(['background']);
  });

  it('a throwing visibilityState read yields no initial value', () => {
    const page = mkPage();
    const doc = {};
    Object.defineProperty(doc, 'visibilityState', {
      get(): never {
        throw new Error('vis');
      },
    });
    const out: Emit[] = [];
    expect(() => new AppStateProducer(page.lifecycle, doc).start(sinkOf(out))).not.toThrow();
    expect(out).toEqual([]);
  });

  it('stop() releases the lifecycle subscription', () => {
    const page = mkPage();
    const out: Emit[] = [];
    const p = new AppStateProducer(page.lifecycle, page.doc);
    p.start(sinkOf(out));
    expect(page.doc.count()).toBe(1);
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
    const tracker = new FpsTracker({
      lifecycle: page.lifecycle,
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
    expect(page.doc.count()).toBe(1); // subscribed to visibility
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
