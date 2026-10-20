import { describe, expect, it, vi } from 'vitest';
import { resetUiTracker, type UiEnv, UiTracker, uiTrackerFor } from './ui-tracker';

function mkTarget() {
  const listeners = new Map<string, Set<(e?: unknown) => void>>();
  const set = (t: string) => {
    let s = listeners.get(t);
    if (s === undefined) {
      s = new Set();
      listeners.set(t, s);
    }
    return s;
  };
  return {
    addEventListener: (t: string, l: (e?: unknown) => void) => void set(t).add(l),
    removeEventListener: (t: string, l: (e?: unknown) => void) => void listeners.get(t)?.delete(l),
    fire: (t: string, e?: unknown) =>
      void [...(listeners.get(t) ?? [])].forEach((l) => {
        l(e);
      }),
    count: (t: string) => listeners.get(t)?.size ?? 0,
    total: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

function mkWorld(init: { visible?: boolean } = {}) {
  const win = Object.assign(mkTarget(), { devicePixelRatio: 2, innerWidth: 800, innerHeight: 600 });
  const orientation = Object.assign(mkTarget(), { type: 'portrait-primary', angle: 0 });
  const screen = Object.assign(mkTarget(), { width: 1000, height: 2000, orientation });
  const doc = Object.assign(mkTarget(), {
    visibilityState: init.visible === false ? 'hidden' : 'visible',
  });
  const queries = new Map<string, ReturnType<typeof mkMql>>();
  const mkMql = () => Object.assign(mkTarget(), { matches: false });
  const matchMedia = vi.fn((q: string) => {
    let m = queries.get(q);
    if (m === undefined) {
      m = mkMql();
      queries.set(q, m);
    }
    return m;
  });
  let t = 0;
  const frames: Array<() => void> = [];
  const intervals: Array<() => void> = [];
  const cleared: unknown[] = [];
  const env = {
    window: win,
    screen,
    document: doc,
    matchMedia: matchMedia as unknown as NonNullable<UiEnv['matchMedia']>,
    requestAnimationFrame: vi.fn((cb: (t: number) => void) => frames.push(() => cb(0))),
    cancelAnimationFrame: vi.fn(),
    now: () => t,
    scheduler: {
      setInterval: vi.fn((cb: () => void) => intervals.push(cb)),
      clearInterval: vi.fn((h: unknown) => void cleared.push(h)),
    },
  } satisfies UiEnv;
  return {
    env,
    win,
    screen,
    orientation,
    doc,
    queries,
    advance: (ms: number) => {
      t += ms;
    },
    frame: () =>
      void frames.splice(0).forEach((f) => {
        f();
      }),
    pendingFrames: () => frames.length,
    tick: () =>
      void intervals.forEach((f) => {
        f();
      }),
    cleared,
  };
}

/** The media query list the tracker asked `matchMedia` for (a missing one is a test failure, not an undefined). */
function q(w: ReturnType<typeof mkWorld>, query: string) {
  const list = w.queries.get(query);
  if (list === undefined) throw new Error(`no query ${query}`);
  return list;
}

describe('UiTracker orientation', () => {
  it('reads live, emits on screen.orientation change and orientationchange, deduped', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    expect(t.current('orientation')).toEqual({ type: 'portrait-primary', angle: 0 });
    const got: unknown[] = [];
    const off = t.on('orientation', (s) => got.push(s));
    expect(w.orientation.count('change')).toBe(1);
    expect(w.win.count('orientationchange')).toBe(1);
    w.orientation.type = 'landscape-primary';
    w.orientation.angle = 90;
    w.orientation.fire('change');
    w.win.fire('orientationchange'); // double delivery collapses
    expect(got).toEqual([{ type: 'landscape-primary', angle: 90 }]);
    off();
    expect(w.orientation.total() + w.win.total()).toBe(0);
  });

  it('omits invalid fields; emits a bare {} only when nothing is readable', () => {
    const w = mkWorld();
    const t = new UiTracker({
      ...w.env,
      screen: { orientation: { type: 3, angle: Number.NaN } } as never,
    });
    expect(t.current('orientation')).toBeUndefined();
    const got: unknown[] = [];
    t.on('orientation', (s) => got.push(s));
    w.win.fire('orientationchange');
    w.win.fire('orientationchange');
    expect(got).toEqual([{}, {}]);
    const t2 = new UiTracker({ screen: { orientation: { type: 'x', angle: Infinity } } as never });
    expect(t2.current('orientation')).toEqual({ type: 'x' });
    const t3 = new UiTracker({ screen: { orientation: { type: 1, angle: 5 } } as never });
    expect(t3.current('orientation')).toEqual({ angle: 5 });
    expect(new UiTracker({ screen: {} }).current('orientation')).toBeUndefined();
  });

  it('re-reads the baseline on re-attach so a change made while idle is not swallowed', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    const got: unknown[] = [];
    const off = t.on('orientation', (s) => got.push(s));
    w.orientation.angle = 90;
    w.win.fire('orientationchange');
    off();
    w.orientation.angle = 0; // changed while idle, back to the first value
    t.on('orientation', (s) => got.push(s));
    w.orientation.angle = 90;
    w.win.fire('orientationchange');
    expect(got).toEqual([
      { type: 'portrait-primary', angle: 90 },
      { type: 'portrait-primary', angle: 90 },
    ]);
  });
});

describe('UiTracker screenSize and viewport', () => {
  it('emits on resize, orientationchange and screen change; deduped; only subscribed stages', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    const sizes: unknown[] = [];
    const views: unknown[] = [];
    const offSize = t.on('screenSize', (s) => sizes.push(s));
    expect(w.win.count('resize')).toBe(1);
    expect(w.screen.count('change')).toBe(1);
    w.win.fire('resize'); // nothing moved
    expect(sizes).toEqual([]);
    w.win.devicePixelRatio = 3;
    w.win.fire('resize');
    w.screen.width = 1200;
    w.screen.fire('change');
    w.screen.height = 1;
    w.win.fire('orientationchange');
    expect(sizes).toEqual([
      { width: 1000, height: 2000, dpr: 3 },
      { width: 1200, height: 2000, dpr: 3 },
      { width: 1200, height: 1, dpr: 3 },
    ]);
    expect(views).toEqual([]); // viewport had no listener: not computed
    const offView = t.on('viewport', (s) => views.push(s));
    w.win.innerWidth = 500;
    w.win.fire('resize');
    expect(views).toEqual([{ width: 500, height: 600 }]);
    offSize();
    expect(w.screen.count('change')).toBe(0);
    expect(w.win.count('resize')).toBe(1);
    offView();
    expect(w.win.total()).toBe(0);
  });

  it('omits an unusable reading, never zero', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    w.win.devicePixelRatio = 0;
    w.win.innerHeight = Number.NaN;
    expect(t.current('screenSize')).toBeUndefined();
    expect(t.current('viewport')).toBeUndefined();
    w.win.devicePixelRatio = 2;
    w.screen.width = Infinity;
    expect(t.current('screenSize')).toBeUndefined();
    expect(new UiTracker({}).current('screenSize')).toBeUndefined();
    expect(new UiTracker({}).current('viewport')).toBeUndefined();
    const got: unknown[] = [];
    t.on('screenSize', (s) => got.push(s));
    w.win.fire('resize');
    expect(got).toEqual([]);
  });
});

describe('UiTracker visualViewport stage', () => {
  const mkVv = () =>
    Object.assign(mkTarget(), {
      scale: 1,
      offsetLeft: 0,
      offsetTop: 0,
      width: 800,
      height: 600,
    });

  it('reads the pinch state live, emits on visualViewport resize and scroll, deduped', () => {
    const w = mkWorld();
    const vv = mkVv();
    const t = new UiTracker({ ...w.env, visualViewport: vv });
    expect(t.current('visualViewport')).toEqual({
      scale: 1,
      offsetLeft: 0,
      offsetTop: 0,
      width: 800,
      height: 600,
    });
    const got: unknown[] = [];
    const off = t.on('visualViewport', (s) => got.push(s));
    expect(vv.count('resize')).toBe(1);
    expect(vv.count('scroll')).toBe(1);
    vv.fire('resize'); // nothing moved
    expect(got).toEqual([]);
    vv.scale = 2;
    vv.fire('resize');
    vv.offsetLeft = 30;
    vv.fire('scroll');
    expect(got).toEqual([
      { scale: 2, offsetLeft: 0, offsetTop: 0, width: 800, height: 600 },
      { scale: 2, offsetLeft: 30, offsetTop: 0, width: 800, height: 600 },
    ]);
    off();
    expect(vv.total()).toBe(0);
  });

  it('does not touch the window or compute anything for other stages', () => {
    const w = mkWorld();
    const vv = mkVv();
    const t = new UiTracker({ ...w.env, visualViewport: vv });
    t.on('visualViewport', () => {});
    expect(w.win.total()).toBe(0);
    expect(w.screen.total()).toBe(0);
  });

  it('omits invalid fields, and is undefined when none is readable or there is no visualViewport', () => {
    const w = mkWorld();
    const t = new UiTracker({
      ...w.env,
      visualViewport: {
        scale: Number.NaN,
        offsetLeft: 5,
        offsetTop: 'x',
        width: 0,
        height: 9,
      } as never,
    });
    expect(t.current('visualViewport')).toEqual({ offsetLeft: 5, height: 9 });
    const t2 = new UiTracker({ visualViewport: { scale: 'x' } as never });
    expect(t2.current('visualViewport')).toBeUndefined();
    // an infinite offset is not a position
    expect(
      new UiTracker({ visualViewport: { offsetTop: Infinity } as never }).current('visualViewport'),
    ).toBeUndefined();
    expect(new UiTracker({}).current('visualViewport')).toBeUndefined();
    const got: unknown[] = [];
    t2.on('visualViewport', (s) => got.push(s));
    expect(got).toEqual([]);
  });

  it('a hostile visualViewport getter is reported, never thrown', () => {
    const errors: unknown[] = [];
    const t = new UiTracker(
      {
        get visualViewport(): never {
          throw new Error('blocked');
        },
      } as unknown as UiEnv,
      (e) => errors.push(e),
    );
    expect(errors).toHaveLength(1);
    expect(t.current('visualViewport')).toBeUndefined();
    expect(() => t.on('visualViewport', () => {})).not.toThrow();
  });

  it("defaults to the window's own visualViewport when the env supplies none (read live)", () => {
    const w = mkWorld();
    const vv = mkVv();
    const win = Object.assign(w.win, { visualViewport: vv });
    const t = new UiTracker({ window: win });
    expect(t.current('visualViewport')).toMatchObject({ scale: 1, width: 800 });
    const got: unknown[] = [];
    t.on('visualViewport', (s) => got.push(s));
    expect(vv.count('resize')).toBe(1);
    expect(vv.count('scroll')).toBe(1);
    vv.scale = 3;
    vv.fire('resize');
    expect(got).toHaveLength(1);
  });

  it("an injected visualViewport wins over the window's; a null one on the window is no viewport", () => {
    const w = mkWorld();
    const own = mkVv();
    const injected = mkVv();
    injected.scale = 4;
    const t = new UiTracker({
      window: Object.assign(w.win, { visualViewport: own }),
      visualViewport: injected,
    });
    expect(t.current('visualViewport')).toMatchObject({ scale: 4 });
    expect(
      new UiTracker({ window: { visualViewport: null } as never }).current('visualViewport'),
    ).toBeUndefined();
  });

  it('a hostile window.visualViewport getter is reported once per read, never thrown', () => {
    const errors: unknown[] = [];
    const win = {
      get visualViewport(): never {
        throw new Error('blocked');
      },
    };
    const t = new UiTracker({ window: win as never }, (e) => errors.push(e));
    expect(t.current('visualViewport')).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it.each([
    'scale',
    'offsetLeft',
    'offsetTop',
    'width',
    'height',
  ] as const)('a throwing %s getter is reported and only that field is omitted', (field) => {
    const errors: unknown[] = [];
    const vv = {
      scale: 2,
      offsetLeft: 1,
      offsetTop: 2,
      width: 3,
      height: 4,
    } as Record<string, unknown>;
    Object.defineProperty(vv, field, {
      get(): never {
        throw new Error(`${field} blocked`);
      },
    });
    const t = new UiTracker({ visualViewport: vv as never }, (e) => errors.push(e));
    const expected: Record<string, number> = {
      scale: 2,
      offsetLeft: 1,
      offsetTop: 2,
      width: 3,
      height: 4,
    };
    delete expected[field];
    expect(t.current('visualViewport')).toEqual(expected);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe(`${field} blocked`);
  });

  it('a zero or negative scale / size is omitted, but a zero or negative offset is a position', () => {
    const t = new UiTracker({
      visualViewport: { scale: 0, offsetLeft: -5, offsetTop: 0, width: -1, height: 0 } as never,
    });
    expect(t.current('visualViewport')).toEqual({ offsetLeft: -5, offsetTop: 0 });
    expect(
      new UiTracker({ visualViewport: { scale: -2, width: 0 } as never }).current('visualViewport'),
    ).toBeUndefined();
  });

  it('a rebind to another visualViewport moves the listeners', () => {
    const vv1 = mkVv();
    const vv2 = mkVv();
    const t = new UiTracker({ visualViewport: vv1 });
    t.on('visualViewport', () => {});
    t.rebind({ visualViewport: vv2 });
    expect(vv1.total()).toBe(0);
    expect(vv2.count('resize')).toBe(1);
  });
});

describe('UiTracker media-query stages', () => {
  it('colorScheme and reducedMotion: live read, change events, listeners only while subscribed', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    expect(t.current('colorScheme')).toEqual({ dark: false });
    expect(t.current('reducedMotion')).toEqual({ reduce: false });
    const dark: unknown[] = [];
    const reduce: unknown[] = [];
    const offD = t.on('colorScheme', (s) => dark.push(s));
    const offR = t.on('reducedMotion', (s) => reduce.push(s));
    const d = q(w, '(prefers-color-scheme: dark)');
    const r = q(w, '(prefers-reduced-motion: reduce)');
    expect(d.count('change')).toBe(1);
    d.fire('change', { matches: true });
    d.fire('change', { matches: true });
    d.fire('change', { matches: 'x' }); // invalid: omitted
    r.fire('change', { matches: 7 }); // invalid: omitted
    r.fire('change', { matches: true });
    expect(dark).toEqual([{ dark: true }]);
    expect(reduce).toEqual([{ reduce: true }]);
    offD();
    offR();
    expect(d.count('change') + r.count('change')).toBe(0);
  });

  it('displayMode resolves the matching mode, else browser; undefined when nothing answers', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    expect(t.current('displayMode')).toEqual({ mode: 'browser' });
    q(w, '(display-mode: standalone)').matches = true;
    expect(t.current('displayMode')).toEqual({ mode: 'standalone' });
    const got: unknown[] = [];
    const off = t.on('displayMode', (s) => got.push(s));
    q(w, '(display-mode: fullscreen)').matches = true;
    q(w, '(display-mode: fullscreen)').fire('change', {});
    q(w, '(display-mode: fullscreen)').fire('change', {});
    expect(got).toEqual([{ mode: 'fullscreen' }]);
    off();
    expect(
      ['fullscreen', 'standalone', 'minimal-ui'].every(
        (m) => q(w, `(display-mode: ${m})`).count('change') === 0,
      ),
    ).toBe(true);
    expect(new UiTracker({}).current('displayMode')).toBeUndefined();
    const bad = new UiTracker({ matchMedia: () => ({ matches: 'no' }) });
    expect(bad.current('displayMode')).toBeUndefined();
    expect(bad.current('colorScheme')).toBeUndefined();
    expect(
      new UiTracker({ matchMedia: () => null as never }).current('colorScheme'),
    ).toBeUndefined();
  });

  it('a query list without addEventListener attaches nothing (and does not throw)', () => {
    const t = new UiTracker({ matchMedia: () => ({ matches: true }) });
    const off = t.on('colorScheme', () => {});
    expect(() => off()).not.toThrow();
    t.on('displayMode', () => {});
  });
});

describe('UiTracker frameRate', () => {
  it('counts rAF frames per window while visible; emits nothing before the first frame', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    const got: number[] = [];
    t.on('frameRate', (f) => got.push(f));
    expect(w.doc.count('visibilitychange')).toBe(1);
    w.advance(1000);
    w.tick(); // no frame yet
    expect(got).toEqual([]);
    for (let i = 0; i < 3; i++) w.frame();
    w.advance(1000);
    w.tick();
    expect(got).toEqual([3]);
    w.advance(1000);
    w.tick(); // first frameless window after frames: 0
    w.advance(1000);
    w.tick(); // continuing stall: quiet
    expect(got).toEqual([3, 0]);
  });

  it('rounds to one decimal and skips a zero-length window', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    const got: number[] = [];
    t.on('frameRate', (f) => got.push(f));
    w.frame();
    w.frame();
    w.frame();
    w.tick(); // elapsed 0
    expect(got).toEqual([]);
    w.advance(900);
    w.tick();
    expect(got).toEqual([3.3]);
  });

  it('tears the loop down on hidden and starts a fresh window on visible', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    const got: number[] = [];
    t.on('frameRate', (f) => got.push(f));
    w.frame();
    w.doc.visibilityState = 'hidden';
    w.doc.fire('visibilitychange');
    expect(w.env.cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(w.env.scheduler.clearInterval).toHaveBeenCalledTimes(1);
    w.advance(60_000);
    w.doc.visibilityState = 'visible';
    w.doc.fire('visibilitychange');
    w.doc.fire('visibilitychange'); // already running: no second loop
    expect(w.env.scheduler.setInterval).toHaveBeenCalledTimes(2);
    w.frame();
    w.advance(1000);
    w.tick();
    expect(got).toEqual([1]);
  });

  it('a frame in flight from a stopped loop neither counts nor re-arms', () => {
    const w = mkWorld();
    const t = new UiTracker({ ...w.env, cancelAnimationFrame: undefined });
    const off = t.on('frameRate', () => {});
    off(); // loop stopped, one frame callback still queued
    const before = w.env.requestAnimationFrame.mock.calls.length;
    w.frame();
    expect(w.env.requestAnimationFrame.mock.calls.length).toBe(before);
  });

  it('starts nothing while hidden, without rAF, or without a visibility source; releases on unsubscribe', () => {
    const hidden = mkWorld({ visible: false });
    new UiTracker(hidden.env).on('frameRate', () => {});
    expect(hidden.env.scheduler.setInterval).not.toHaveBeenCalled();
    expect(hidden.doc.count('visibilitychange')).toBe(1);
    const noRaf = mkWorld();
    new UiTracker({ ...noRaf.env, requestAnimationFrame: undefined }).on('frameRate', () => {});
    expect(noRaf.doc.total()).toBe(0);
    const noDoc = mkWorld();
    new UiTracker({ ...noDoc.env, document: {} }).on('frameRate', () => {});
    expect(noDoc.env.requestAnimationFrame).not.toHaveBeenCalled();
    const w = mkWorld();
    const off = new UiTracker(w.env).on('frameRate', () => {});
    off();
    expect(w.doc.total()).toBe(0);
    expect(w.env.cancelAnimationFrame).toHaveBeenCalled();
    expect(w.env.scheduler.clearInterval).toHaveBeenCalled();
  });

  it('rolls back a start whose clock throws, reports it, and can start again', () => {
    const w = mkWorld();
    const errors: unknown[] = [];
    let broken = true;
    const t = new UiTracker(
      {
        ...w.env,
        now: () => {
          if (broken) throw new Error('clock');
          return 0;
        },
      },
      (e) => errors.push(e),
    );
    t.on('frameRate', () => {});
    expect(errors).toHaveLength(1);
    broken = false;
    w.doc.fire('visibilitychange');
    expect(w.env.scheduler.setInterval).toHaveBeenCalledTimes(1);
  });

  it('reports a throwing clock at a tick and skips the window; a throwing rAF re-arm is reported', () => {
    const w = mkWorld();
    const errors: unknown[] = [];
    let broken = false;
    let armFails = false;
    const t = new UiTracker(
      {
        ...w.env,
        now: () => {
          if (broken) throw new Error('clock');
          return 0;
        },
        requestAnimationFrame: (cb: (t: number) => void) => {
          if (armFails) throw new Error('raf');
          return w.env.requestAnimationFrame(cb);
        },
      },
      (e) => errors.push(e),
    );
    t.on('frameRate', () => {});
    broken = true;
    w.tick();
    expect(errors).toHaveLength(1);
    armFails = true;
    w.frame();
    expect(errors).toHaveLength(2);
  });

  it('uses the default scheduler and clock when none are injected, and tolerates a failing clearInterval/cancel', () => {
    vi.useFakeTimers();
    try {
      const w = mkWorld();
      const t = new UiTracker({
        ...w.env,
        scheduler: undefined,
        now: undefined,
        intervalMs: 50,
        cancelAnimationFrame: () => {
          throw new Error('cancel');
        },
      });
      const got: number[] = [];
      const off = t.on('frameRate', (f) => got.push(f));
      w.frame();
      vi.advanceTimersByTime(50);
      expect(got).toHaveLength(1);
      expect(() => off()).not.toThrow();
      const t2 = new UiTracker({
        ...w.env,
        scheduler: {
          setInterval: () => 1,
          clearInterval: () => {
            throw new Error('clear');
          },
        },
      });
      const off2 = t2.on('frameRate', () => {});
      expect(() => off2()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to Date.now when performance.now is absent', () => {
    vi.useFakeTimers();
    const perf = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    Object.defineProperty(globalThis, 'performance', { value: undefined, configurable: true });
    try {
      const w = mkWorld();
      const t = new UiTracker({ ...w.env, scheduler: undefined, now: undefined, intervalMs: 100 });
      const got: number[] = [];
      t.on('frameRate', (f) => got.push(f));
      w.frame();
      vi.advanceTimersByTime(100);
      expect(got).toEqual([10]);
    } finally {
      if (perf !== undefined) Object.defineProperty(globalThis, 'performance', perf);
      vi.useRealTimers();
    }
  });
});

describe('UiTracker failure isolation', () => {
  it('guards every read: a hostile env is reported, nothing throws', () => {
    const errors: unknown[] = [];
    const boom = (): never => {
      throw new Error('hostile');
    };
    const hostile = {
      get window() {
        return boom();
      },
      get screen() {
        return boom();
      },
      get matchMedia() {
        return boom();
      },
    } as unknown as UiEnv;
    const t = new UiTracker(hostile, (e) => errors.push(e));
    for (const s of [
      'orientation',
      'screenSize',
      'viewport',
      'colorScheme',
      'displayMode',
    ] as const) {
      expect(t.current(s)).toBeUndefined();
    }
    expect(errors).toHaveLength(3); // the three hostile fields, reported once at the copy
    for (const s of [
      'orientation',
      'screenSize',
      'viewport',
      'colorScheme',
      'reducedMotion',
      'displayMode',
    ] as const) {
      expect(() => t.on(s, () => {})).not.toThrow();
    }
  });

  it('guards the inner reads (getters on the window/screen/orientation/query list) and a throwing matchMedia call', () => {
    const errors: unknown[] = [];
    const boom = (): never => {
      throw new Error('hostile');
    };
    const t = new UiTracker(
      {
        window: {
          get devicePixelRatio() {
            return boom();
          },
          get innerWidth() {
            return boom();
          },
          get innerHeight() {
            return boom();
          },
        },
        screen: {
          get width() {
            return boom();
          },
          get height() {
            return boom();
          },
          orientation: {
            get type() {
              return boom();
            },
            get angle() {
              return boom();
            },
          },
        },
        matchMedia: boom,
      },
      (e) => errors.push(e),
    );
    for (const s of ['orientation', 'screenSize', 'viewport', 'colorScheme'] as const) {
      expect(t.current(s)).toBeUndefined();
    }
    expect(errors.length).toBeGreaterThanOrEqual(7);
    const t2 = new UiTracker(
      {
        matchMedia: () => ({
          get matches() {
            return boom();
          },
        }),
      },
      (e) => errors.push(e),
    );
    expect(t2.current('colorScheme')).toBeUndefined();
  });

  it('a throwing onError never escapes (read, DOM listener, and attach paths)', () => {
    const w = mkWorld();
    const t = new UiTracker(
      {
        ...w.env,
        window: Object.assign(mkTarget(), {
          devicePixelRatio: 1,
          addEventListener: () => {
            throw new Error('attach');
          },
        }) as never,
      },
      () => {
        throw new Error('reporter');
      },
    );
    expect(() => t.on('screenSize', () => {})).not.toThrow();
    const w2 = mkWorld();
    const t2 = new UiTracker(w2.env, () => {
      throw new Error('reporter');
    });
    t2.on('orientation', () => {
      throw new Error('consumer');
    });
    w2.orientation.angle = 90;
    expect(() => w2.win.fire('orientationchange')).not.toThrow();
    // a throwing read inside a DOM listener is reported, not thrown
    t2.on('viewport', () => {});
    Object.defineProperty(w2.win, 'innerWidth', {
      get() {
        throw new Error('read');
      },
    });
    expect(() => w2.win.fire('resize')).not.toThrow();
    // a listener body that itself throws (screen getter in refresh) is caught by the wrapper
    const t3 = new UiTracker(w2.env, () => {});
    t3.on('screenSize', () => {});
    expect(() => w2.win.fire('resize')).not.toThrow();
  });

  it('the guarded wrapper reports a throw from inside the listener body', () => {
    const w = mkWorld();
    const errors: unknown[] = [];
    const t = new UiTracker(w.env, (e) => errors.push(e));
    t.on('colorScheme', () => {});
    const d = q(w, '(prefers-color-scheme: dark)');
    d.fire('change', null); // event.matches on null throws inside the guarded listener
    expect(errors).toHaveLength(1);
  });

  it('removal failures are swallowed and do not leak the other listeners', () => {
    const w = mkWorld();
    const removed: string[] = [];
    const win = {
      devicePixelRatio: 1,
      addEventListener: () => {},
      removeEventListener: (type: string) => {
        removed.push(type);
        throw new Error('remove');
      },
    };
    const t = new UiTracker({ ...w.env, window: win });
    const off = t.on('orientation', () => {});
    expect(() => off()).not.toThrow();
    expect(removed).toEqual(['orientationchange']);
  });
});

describe('UiTracker reset and listener hooks', () => {
  it('reset releases everything (listeners, timers) and forgets baselines', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    t.on('frameRate', () => {});
    t.on('orientation', () => {});
    t.reset();
    expect(w.doc.total() + w.win.total() + w.orientation.total()).toBe(0);
    expect(w.env.scheduler.clearInterval).toHaveBeenCalled();
  });

  it('onAny and once participate in per-stage activation', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    const off = t.onAny(() => {});
    expect(w.win.count('resize')).toBe(1);
    expect(w.doc.count('visibilitychange')).toBe(1);
    off();
    expect(w.win.total()).toBe(0);
    const offOnce = t.once('viewport', () => {});
    expect(w.win.count('resize')).toBe(1);
    offOnce();
    expect(w.win.count('resize')).toBe(0);
  });
});

describe('uiTrackerFor registry + rebind', () => {
  it('is a singleton per window; latest onError wins; env merges not drops', () => {
    const w = mkWorld();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const a = uiTrackerFor({ window: w.win }, (e) => first.push(e));
    const b = uiTrackerFor({ window: w.win, screen: w.screen }, (e) => second.push(e));
    expect(a).toBe(b);
    expect(b.current('screenSize')).toEqual({ width: 1000, height: 2000, dpr: 2 });
    const c = uiTrackerFor({ window: w.win }); // partial relaunch: keeps screen and the reporter
    expect(c.current('screenSize')).toBeDefined();
    resetUiTracker({ window: w.win });
    expect(uiTrackerFor({ window: w.win })).not.toBe(a);
  });

  it('rebind of an attached tracker re-attaches the changed source to the new object', () => {
    const w = mkWorld();
    const t = uiTrackerFor({ window: w.win, screen: w.screen });
    const got: unknown[] = [];
    t.on('screenSize', (s) => got.push(s));
    const screen2 = Object.assign(mkTarget(), { width: 4, height: 6 });
    uiTrackerFor({ window: w.win, screen: screen2 });
    expect(w.screen.count('change')).toBe(0);
    expect(screen2.count('change')).toBe(1);
    screen2.width = 5;
    screen2.fire('change');
    expect(got).toEqual([{ width: 5, height: 6, dpr: 2 }]);
    uiTrackerFor({ window: w.win, screen: screen2 }); // identical env: nothing re-attached
    expect(screen2.count('change')).toBe(1);
    resetUiTracker({ window: w.win });
    expect(screen2.count('change')).toBe(0);
  });

  it('keys on the screen without a window, and privately on a bare env', () => {
    const screen = Object.assign(mkTarget(), { width: 1, height: 1 });
    expect(uiTrackerFor({ screen })).toBe(uiTrackerFor({ screen }));
    resetUiTracker({ screen });
    const env = {};
    expect(uiTrackerFor(env)).toBe(uiTrackerFor(env));
    expect(uiTrackerFor({})).not.toBe(uiTrackerFor({}));
    resetUiTracker(env);
  });

  it('keying survives a throwing window/screen read (reported)', () => {
    const errors: unknown[] = [];
    const env = {
      get window(): never {
        throw new Error('w');
      },
      get screen(): never {
        throw new Error('s');
      },
    } as unknown as UiEnv;
    expect(uiTrackerFor(env, (e) => errors.push(e))).toBeInstanceOf(UiTracker);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('UiTracker review fixes', () => {
  const mkScheduler = () => {
    const cbs: Array<() => void> = [];
    const cleared: number[] = [];
    return {
      cbs,
      cleared,
      scheduler: {
        setInterval: (cb: () => void) => cbs.push(cb) - 1,
        clearInterval: (h: unknown) => void cleared.push(h as number),
      },
    };
  };

  it('a rebind that swaps the scheduler clears the OLD interval on the OLD scheduler and runs one interval', () => {
    const w = mkWorld();
    const a = mkScheduler();
    const b = mkScheduler();
    const t = uiTrackerFor({ ...w.env, scheduler: a.scheduler });
    const got: number[] = [];
    t.on('frameRate', (f) => got.push(f));
    expect(a.cbs).toHaveLength(1);
    uiTrackerFor({ window: w.win, scheduler: b.scheduler });
    expect(a.cleared).toEqual([0]); // cleared with the handle A handed out, on A
    expect(b.cleared).toEqual([]);
    expect(b.cbs).toHaveLength(1);
    w.frame();
    w.frame();
    w.advance(1000);
    a.cbs[0]?.(); // a stale tick from the old interval is ignored (loop guard)
    expect(got).toEqual([]);
    b.cbs[0]?.();
    expect(got).toEqual([2]);
    resetUiTracker({ window: w.win });
  });

  it('a stale interval whose clear failed never touches the live window', () => {
    const w = mkWorld();
    const cbs: Array<() => void> = [];
    const t = new UiTracker({
      ...w.env,
      scheduler: { setInterval: (cb) => cbs.push(cb), clearInterval: () => {} },
    });
    const got: number[] = [];
    const off = t.on('frameRate', (f) => got.push(f));
    off();
    t.on('frameRate', (f) => got.push(f));
    w.frame();
    w.advance(1000);
    cbs[0]?.(); // old loop's tick: ignored
    expect(got).toEqual([]);
    cbs[1]?.();
    expect(got).toEqual([1]);
  });

  it('a tick from a loop stopped by a hidden page is ignored even when the clear is a no-op (running guard)', () => {
    const w = mkWorld();
    const cbs: Array<() => void> = [];
    const t = new UiTracker({
      ...w.env,
      scheduler: { setInterval: (cb) => cbs.push(cb), clearInterval: () => {} },
    });
    const got: number[] = [];
    t.on('frameRate', (f) => got.push(f)); // stays subscribed
    w.frame();
    w.doc.visibilityState = 'hidden';
    w.doc.fire('visibilitychange'); // the loop stops; the interval callback is still callable
    w.advance(1000);
    cbs[0]?.();
    expect(got).toEqual([]);
  });

  it('a stage whose re-read yields nothing forgets its baseline', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    const got: unknown[] = [];
    const off = t.on('screenSize', (s) => got.push(s));
    off();
    w.screen.width = Number.NaN; // unreadable while nobody listens
    t.on('screenSize', (s) => got.push(s)); // baseline re-read: nothing -> forgotten
    w.screen.width = 1000; // back to the value the OLD baseline held
    w.win.fire('resize');
    expect(got).toEqual([{ width: 1000, height: 2000, dpr: 2 }]);
  });

  it('frameRate with a document that cannot deliver visibilitychange never starts a loop', () => {
    const w = mkWorld();
    new UiTracker({ ...w.env, document: { visibilityState: 'visible' } }).on('frameRate', () => {});
    expect(w.env.requestAnimationFrame).not.toHaveBeenCalled();
    expect(w.env.scheduler.setInterval).not.toHaveBeenCalled();
  });

  it('reset() forgets which stages were listened, so a later subscriber re-baselines', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    const got: unknown[] = [];
    t.on('orientation', (s) => got.push(s)); // stays subscribed across the reset
    t.reset();
    t.on('viewport', () => {}); // any listener change re-syncs: orientation re-attaches
    w.win.fire('orientationchange'); // nothing moved
    expect(got).toEqual([]);
  });

  it('repeated uiTrackerFor calls with FRESH function closures do not reset a running fps window', () => {
    const w = mkWorld();
    const fresh = () => ({
      window: w.win,
      screen: w.screen,
      document: w.doc,
      scheduler: w.env.scheduler,
      matchMedia: (q: string) => w.env.matchMedia(q),
      requestAnimationFrame: (cb: (t: number) => void) => w.env.requestAnimationFrame(cb),
      cancelAnimationFrame: (h: number) => w.env.cancelAnimationFrame(h),
      now: () => w.env.now(),
    });
    const t = uiTrackerFor(fresh());
    const got: number[] = [];
    t.on('frameRate', (f) => got.push(f));
    w.frame();
    uiTrackerFor(fresh());
    uiTrackerFor(fresh());
    expect(w.env.scheduler.setInterval).toHaveBeenCalledTimes(1);
    expect(w.env.scheduler.clearInterval).not.toHaveBeenCalled();
    w.frame();
    w.advance(1000);
    w.tick();
    expect(got).toEqual([2]); // the frame counted before the relaunches is kept
    expect(w.doc.count('visibilitychange')).toBe(1);
    resetUiTracker({ window: w.win });
  });

  it('a rebind onto new sources re-baselines from them (no spurious announcement of the swap)', () => {
    const w = mkWorld();
    const t = uiTrackerFor({ window: w.win, screen: w.screen });
    const got: unknown[] = [];
    t.on('screenSize', (s) => got.push(s));
    const screen2 = Object.assign(mkTarget(), { width: 4, height: 6 });
    uiTrackerFor({ window: w.win, screen: screen2 });
    screen2.fire('change'); // nothing moved on the NEW screen
    expect(got).toEqual([]);
    resetUiTracker({ window: w.win });
  });

  it('a swapped function seam is used from then on (no re-attach)', () => {
    const w = mkWorld();
    const t = uiTrackerFor({ window: w.win, screen: w.screen });
    t.on('colorScheme', () => {});
    const swapped = vi.fn(() => ({ matches: true }));
    uiTrackerFor({ window: w.win, matchMedia: swapped });
    expect(t.current('colorScheme')).toEqual({ dark: true });
    resetUiTracker({ window: w.win });
  });

  it('a stage that gains its first listener re-baselines even when its source is attached for a sibling', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    t.on('orientation', () => {}); // the orientation source is attached; screenSize is NOT being computed
    w.screen.width = 1;
    w.win.fire('orientationchange');
    const sizes: unknown[] = [];
    t.on('screenSize', (s) => sizes.push(s)); // baseline is now width 1
    w.screen.width = 1000; // back to the value it had before the first listener
    w.win.fire('orientationchange');
    expect(sizes).toEqual([{ width: 1000, height: 2000, dpr: 2 }]);
  });

  it('screenSize/viewport siblings on the shared resize source re-baseline too', () => {
    const w = mkWorld();
    const t = new UiTracker(w.env);
    t.on('screenSize', () => {});
    w.win.innerWidth = 500;
    w.win.fire('resize'); // viewport has no listener: not computed
    const views: unknown[] = [];
    t.on('viewport', (v) => views.push(v));
    w.win.innerWidth = 800;
    w.win.fire('resize');
    expect(views).toEqual([{ width: 800, height: 600 }]);
  });

  it('a stage without listeners is not even read on an event of a sibling source', () => {
    const w = mkWorld();
    const reads = vi.fn(() => 600);
    Object.defineProperty(w.win, 'innerHeight', { get: reads });
    const t = new UiTracker(w.env);
    t.on('screenSize', () => {});
    const before = reads.mock.calls.length;
    w.win.devicePixelRatio = 3;
    w.win.fire('resize');
    expect(reads.mock.calls.length).toBe(before);
  });

  it('displayMode is omitted when a query failed and none of the answered ones matched', () => {
    const w = mkWorld();
    let failing = true;
    const t = new UiTracker({
      matchMedia: (q) => {
        if (failing && q.includes('standalone')) throw new Error('q');
        return w.env.matchMedia(q);
      },
    });
    expect(t.current('displayMode')).toBeUndefined();
    q(w, '(display-mode: fullscreen)').matches = true;
    expect(t.current('displayMode')).toEqual({ mode: 'fullscreen' });
    failing = false;
    q(w, '(display-mode: fullscreen)').matches = false;
    expect(t.current('displayMode')).toEqual({ mode: 'browser' });
  });

  it('only a visible document runs the frame loop (prerender / missing state do not)', () => {
    for (const state of ['prerender', 'hidden', undefined]) {
      const w = mkWorld();
      Object.assign(w.doc, { visibilityState: state });
      new UiTracker(w.env).on('frameRate', () => {});
      expect(w.env.scheduler.setInterval).not.toHaveBeenCalled();
      expect(w.doc.count('visibilitychange')).toBe(1); // still gated on later changes
    }
  });

  it('latest onError wins; a relaunch without one keeps it', () => {
    const w = mkWorld();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const win = mkTarget();
    Object.defineProperty(win, 'devicePixelRatio', {
      get(): never {
        throw new Error('dpr');
      },
    });
    const t = uiTrackerFor({ window: win, screen: w.screen }, (e) => first.push(e));
    t.current('screenSize');
    expect(first).toHaveLength(1);
    uiTrackerFor({ window: win }, (e) => second.push(e));
    t.current('screenSize');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    uiTrackerFor({ window: win }); // undefined onError keeps the second
    t.current('screenSize');
    expect(second).toHaveLength(2);
    resetUiTracker({ window: win });
  });
});
