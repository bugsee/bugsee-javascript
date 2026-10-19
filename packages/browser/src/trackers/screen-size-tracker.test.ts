import { describe, expect, it } from 'vitest';
import { ScreenSizeTracker } from './screen-size-tracker';

function mkWin(over: { screen?: unknown; dpr?: unknown } = {}) {
  const l = new Map<string, Set<() => void>>();
  const win: Record<string, unknown> = {
    devicePixelRatio: 'dpr' in over ? over.dpr : 2,
    addEventListener: (t: string, f: () => void) => {
      const s = l.get(t) ?? new Set<() => void>();
      s.add(f);
      l.set(t, s);
    },
    removeEventListener: (t: string, f: () => void) => void l.get(t)?.delete(f),
  };
  const screen = 'screen' in over ? over.screen : { width: 390, height: 844 };
  return {
    win: win as never,
    screen: screen as never,
    set: (k: string, v: unknown) => {
      win[k] = v;
    },
    fire: (t: string) =>
      l.get(t)?.forEach((f) => {
        f();
      }),
    count: () => [...l.values()].reduce((n, s) => n + s.size, 0),
    types: () =>
      [...l.entries()]
        .filter(([, s]) => s.size > 0)
        .map(([t]) => t)
        .sort(),
  };
}

describe('ScreenSizeTracker', () => {
  it('attaches nothing until the first subscriber, then resize + orientationchange on the injected window', () => {
    const w = mkWin();
    const t = new ScreenSizeTracker({ window: w.win, screen: w.screen });
    expect(w.count()).toBe(0);
    const off = t.on('state', () => {});
    expect(w.types()).toEqual(['orientationchange', 'resize']);
    off();
    expect(w.count()).toBe(0);
  });

  it('with a shared lifecycle, orientationchange comes from IT (no extra window listener); resize stays on the window', () => {
    const w = mkWin();
    const subs = new Set<() => void>();
    const lifecycle = {
      on: (type: string, fn: () => void) => {
        expect(type).toBe('orientationchange');
        subs.add(fn);
        return () => void subs.delete(fn);
      },
    };
    const t = new ScreenSizeTracker({
      lifecycle: lifecycle as never,
      window: w.win,
      screen: w.screen,
    });
    const got: unknown[] = [];
    const off = t.on('state', (s) => got.push(s));
    expect(w.types()).toEqual(['resize']);
    expect(subs.size).toBe(1);
    w.set('devicePixelRatio', 3);
    for (const f of subs) f();
    expect(got).toEqual([{ width: 390, height: 844, dpr: 3 }]);
    off();
    expect(subs.size).toBe(0);
    expect(w.count()).toBe(0);
  });

  it('current() reads {width, height, dpr} live', () => {
    const w = mkWin();
    const t = new ScreenSizeTracker({ window: w.win, screen: w.screen });
    expect(t.current()).toEqual({ width: 390, height: 844, dpr: 2 });
    w.set('devicePixelRatio', 3);
    expect(t.current()).toEqual({ width: 390, height: 844, dpr: 3 });
  });

  it('emits the new state on resize and on orientationchange', () => {
    const w = mkWin();
    const t = new ScreenSizeTracker({ window: w.win, screen: w.screen });
    const got: unknown[] = [];
    t.on('state', (s) => got.push(s));
    w.set('devicePixelRatio', 1.5);
    w.fire('resize');
    w.set('devicePixelRatio', 2);
    w.fire('orientationchange');
    expect(got).toEqual([
      { width: 390, height: 844, dpr: 1.5 },
      { width: 390, height: 844, dpr: 2 },
    ]);
  });

  it('omits (never 0 / NaN) when screen is absent or any value is not a finite positive number', () => {
    const bad: unknown[] = [0, -1, NaN, Infinity, '390', null, undefined];
    for (const v of bad) {
      for (const field of ['width', 'height'] as const) {
        const w = mkWin({ screen: { width: 390, height: 844, [field]: v } });
        expect(
          new ScreenSizeTracker({ window: w.win, screen: w.screen }).current(),
        ).toBeUndefined();
      }
      const w = mkWin({ dpr: v });
      expect(new ScreenSizeTracker({ window: w.win, screen: w.screen }).current()).toBeUndefined();
    }
    const noScreen = mkWin();
    expect(new ScreenSizeTracker({ window: noScreen.win }).current()).toBeUndefined();
    expect(new ScreenSizeTracker({}).current()).toBeUndefined();
  });

  it('an unreadable change emits nothing', () => {
    const w = mkWin();
    const t = new ScreenSizeTracker({ window: w.win, screen: w.screen });
    const got: unknown[] = [];
    t.on('state', (s) => got.push(s));
    w.set('devicePixelRatio', 0);
    w.fire('resize');
    expect(got).toEqual([]);
  });

  it('hostile getters are reported, never thrown (current and the event path)', () => {
    const errors: unknown[] = [];
    const hostile = {
      get width(): number {
        throw new Error('w');
      },
      height: 1,
    };
    const w = mkWin({ screen: hostile });
    const t = new ScreenSizeTracker({ window: w.win, screen: w.screen }, (e) => errors.push(e));
    expect(t.current()).toBeUndefined();
    expect(errors).toHaveLength(1);
    t.on('state', () => {});
    expect(() => w.fire('resize')).not.toThrow();
    expect(errors).toHaveLength(2);
    const dprBlocked = mkWin();
    Object.defineProperty(dprBlocked.win, 'devicePixelRatio', {
      get(): never {
        throw new Error('dpr');
      },
    });
    const t2 = new ScreenSizeTracker({ window: dprBlocked.win, screen: dprBlocked.screen }, (e) =>
      errors.push(e),
    );
    expect(t2.current()).toBeUndefined();
    expect((errors[2] as Error).message).toBe('dpr');
  });

  it('a throwing addEventListener is reported, and what attached is still released', () => {
    const errors: unknown[] = [];
    const w = mkWin();
    const real = (w.win as { addEventListener: (t: string, f: () => void) => void })
      .addEventListener;
    let n = 0;
    (w.win as { addEventListener: unknown }).addEventListener = (t: string, f: () => void) => {
      if (n++ === 1) throw new Error('add');
      real(t, f);
    };
    const t = new ScreenSizeTracker({ window: w.win, screen: w.screen }, (e) => errors.push(e));
    const off = t.on('state', () => {});
    expect((errors[0] as Error).message).toBe('add');
    expect(w.count()).toBe(1);
    off();
    expect(w.count()).toBe(0);
  });

  it('a throwing reporter never escapes on() or the event path', () => {
    const w = mkWin();
    (w.win as { addEventListener: unknown }).addEventListener = () => {
      throw new Error('add');
    };
    const t = new ScreenSizeTracker({ window: w.win, screen: w.screen }, () => {
      throw new Error('reporter');
    });
    expect(() => t.on('state', () => {})).not.toThrow();
    const hostile = mkWin({
      screen: {
        get width(): number {
          throw new Error('w');
        },
        height: 1,
      },
    });
    expect(
      new ScreenSizeTracker({ window: hostile.win, screen: hostile.screen }, () => {
        throw new Error('reporter');
      }).current(),
    ).toBeUndefined();
  });

  it('a throwing subscriber with a throwing reporter does not escape the event dispatch', () => {
    const w = mkWin();
    const t = new ScreenSizeTracker({ window: w.win, screen: w.screen }, () => {
      throw new Error('reporter');
    });
    t.on('state', () => {
      throw new Error('subscriber');
    });
    expect(() => w.fire('resize')).not.toThrow();
  });

  it('a throwing removeEventListener does not leak the other listener', () => {
    const w = mkWin();
    const real = (w.win as { removeEventListener: (t: string, f: () => void) => void })
      .removeEventListener;
    let first = true;
    (w.win as { removeEventListener: unknown }).removeEventListener = (
      t: string,
      f: () => void,
    ) => {
      if (first) {
        first = false;
        throw new Error('rm');
      }
      real(t, f);
    };
    const t = new ScreenSizeTracker({ window: w.win, screen: w.screen });
    const off = t.on('state', () => {});
    expect(() => off()).not.toThrow();
    expect(w.count()).toBe(1); // only the one whose removal threw stays
  });

  it('works on a window with no addEventListener (initial value only)', () => {
    const t = new ScreenSizeTracker({
      window: { devicePixelRatio: 1 },
      screen: { width: 1, height: 2 },
    });
    expect(() => t.on('state', () => {})).not.toThrow();
    expect(t.current()).toEqual({ width: 1, height: 2, dpr: 1 });
  });
});
