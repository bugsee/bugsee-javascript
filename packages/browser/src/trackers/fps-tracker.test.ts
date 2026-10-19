import type { Scheduler } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import { FpsTracker } from './fps-tracker';

// A controllable page: manual rAF queue, manual clock, a visibility lifecycle, a manual interval.
function mkEnv(over: { visible?: boolean; noRaf?: boolean; noCancel?: boolean } = {}) {
  let now = 0;
  let nextId = 1;
  const rafs = new Map<number, (t: number) => void>();
  const cancelled: number[] = [];
  const doc = { visibilityState: over.visible === false ? 'hidden' : 'visible' };
  const visListeners = new Set<(e: { visible: boolean }) => void>();
  let timerCb: (() => void) | undefined;
  const timers = { set: 0, cleared: 0, live: 0 };
  const scheduler: Scheduler = {
    setInterval: (cb) => {
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
    ...(over.noRaf
      ? {}
      : {
          requestAnimationFrame: (cb: (t: number) => void) => {
            const id = nextId++;
            rafs.set(id, cb);
            return id;
          },
        }),
    ...(over.noCancel
      ? {}
      : {
          cancelAnimationFrame: (id: number) => {
            cancelled.push(id);
            rafs.delete(id);
          },
        }),
    now: () => now,
    scheduler,
  };
  const frame = () => {
    // run the pending callbacks (each re-arms itself)
    const cbs = [...rafs.entries()];
    rafs.clear();
    for (const [, cb] of cbs) cb(now);
  };
  return {
    env,
    doc,
    cancelled,
    timers,
    rafs,
    frame,
    advance: (ms: number) => {
      now += ms;
    },
    tick: () => timerCb?.(),
    setVisible: (visible: boolean) => {
      doc.visibilityState = visible ? 'visible' : 'hidden';
      for (const l of [...visListeners]) l({ visible });
    },
    listeners: () => visListeners.size,
  };
}

describe('FpsTracker', () => {
  it('attaches nothing until the first subscriber', () => {
    const e = mkEnv();
    new FpsTracker(e.env);
    expect(e.rafs.size).toBe(0);
    expect(e.timers.set).toBe(0);
    expect(e.listeners()).toBe(0);
  });

  it('while visible: counts frames and reports frames/second over the window on each tick', () => {
    const e = mkEnv();
    const t = new FpsTracker(e.env);
    const got: number[] = [];
    t.on('fps', (v) => got.push(v));
    expect(e.rafs.size).toBe(1);
    for (let i = 0; i < 30; i++) {
      e.advance(1000 / 60);
      e.frame();
    }
    e.advance(1);
    e.tick(); // 30 frames over ~501 ms
    expect(got).toHaveLength(1);
    expect(got[0]).toBeCloseTo(59.9, 1);
    // the window restarts: 2 frames in the next 1000 ms
    e.advance(500);
    e.frame();
    e.advance(500);
    e.frame();
    e.tick();
    expect(got[1]).toBe(2);
  });

  it('once frames have been seen, a window with none is a true 0 (the main thread stopped painting)', () => {
    const e = mkEnv();
    const t = new FpsTracker(e.env);
    const got: number[] = [];
    t.on('fps', (v) => got.push(v));
    e.advance(500);
    e.frame();
    e.advance(500);
    e.tick();
    e.advance(1000);
    e.tick();
    expect(got).toEqual([1, 0]);
  });

  it('a mid-run rAF pause reports the drop to 0 ONCE, not a run of zeros, and measuring resumes cleanly', () => {
    const e = mkEnv();
    const t = new FpsTracker(e.env);
    const got: number[] = [];
    t.on('fps', (v) => got.push(v));
    e.advance(1000);
    for (let i = 0; i < 60; i++) e.frame(); // 60 frames in the first second
    e.tick();
    e.advance(1000);
    e.tick(); // the first frameless window: reported as the drop
    e.advance(1000);
    e.tick(); // still frameless: paused, not a fresh zero
    e.advance(1000);
    e.tick();
    expect(got).toEqual([60, 0]);
    // rAF resumes after the stall: the first report covers only the time since the last tick, not the stall
    e.advance(500);
    for (let i = 0; i < 30; i++) e.frame();
    e.advance(500);
    e.tick();
    expect(got).toEqual([60, 0, 30]);
  });

  it('frameless ticks before the first frame move the window forward, so the stall never dilutes the first measurement', () => {
    const e = mkEnv();
    const t = new FpsTracker(e.env);
    const got: number[] = [];
    t.on('fps', (v) => got.push(v));
    for (let i = 0; i < 3; i++) {
      e.advance(1000);
      e.tick(); // nothing yet
    }
    for (let i = 0; i < 60; i++) e.frame();
    e.advance(1000);
    e.tick();
    expect(got).toEqual([60]); // not 15 (60 frames over 4000 ms)
  });

  it('a visible page that has never produced a frame reports nothing (rAF can be paused while visibility stays visible)', () => {
    const e = mkEnv();
    const t = new FpsTracker(e.env);
    const got: number[] = [];
    t.on('fps', (v) => got.push(v));
    e.advance(1000);
    e.tick();
    e.advance(1000);
    e.tick();
    expect(got).toEqual([]);
  });

  it('a hide/show restarts that rule: no frame yet in the new run means nothing is reported', () => {
    const e = mkEnv();
    const t = new FpsTracker(e.env);
    const got: number[] = [];
    t.on('fps', (v) => got.push(v));
    e.advance(500);
    e.frame();
    e.setVisible(false);
    e.setVisible(true);
    e.advance(1000);
    e.tick();
    expect(got).toEqual([]);
  });

  it('a stale frame callback from before a hide never joins the loop started after the show (no cancelAnimationFrame)', () => {
    const e = mkEnv({ noCancel: true });
    const t = new FpsTracker(e.env);
    const got: number[] = [];
    t.on('fps', (v) => got.push(v));
    const stale = [...e.rafs.values()];
    e.setVisible(false);
    e.setVisible(true);
    e.rafs.delete(1); // the first loop's handle is not cancellable: it stays queued in a real browser
    for (const cb of stale) cb(0); // the old frame fires after the restart
    expect(e.rafs.size).toBe(1); // only the NEW loop's frame is pending: the old one did not re-arm
    e.advance(1000);
    e.frame();
    e.tick();
    expect(got).toEqual([1]);
  });

  it('a zero-length window reports nothing (never a division by zero)', () => {
    const e = mkEnv();
    const t = new FpsTracker(e.env);
    const got: number[] = [];
    t.on('fps', (v) => got.push(v));
    e.tick();
    expect(got).toEqual([]);
  });

  it('hidden at start: no rAF loop, no timer, nothing emitted', () => {
    const e = mkEnv({ visible: false });
    const t = new FpsTracker(e.env);
    const got: number[] = [];
    t.on('fps', (v) => got.push(v));
    expect(e.rafs.size).toBe(0);
    expect(e.timers.live).toBe(0);
    e.advance(1000);
    e.tick();
    expect(got).toEqual([]);
  });

  it('going hidden cancels the pending frame and the timer; showing again starts a FRESH window', () => {
    const e = mkEnv();
    const t = new FpsTracker(e.env);
    const got: number[] = [];
    t.on('fps', (v) => got.push(v));
    e.advance(400);
    e.frame();
    e.setVisible(false);
    expect(e.rafs.size).toBe(0);
    expect(e.cancelled).toHaveLength(1);
    expect(e.timers.live).toBe(0);
    e.advance(60_000); // a long hidden stretch must not leak into the next window
    e.setVisible(true);
    expect(e.timers.live).toBe(1);
    expect(e.rafs.size).toBe(1);
    e.advance(500);
    e.frame();
    e.advance(500);
    e.tick();
    expect(got).toEqual([1]);
  });

  it('a duplicate visible/hidden event does not stack loops or timers', () => {
    const e = mkEnv();
    const t = new FpsTracker(e.env);
    t.on('fps', () => {});
    e.setVisible(true);
    e.setVisible(true);
    expect(e.timers.live).toBe(1);
    expect(e.rafs.size).toBe(1);
    e.setVisible(false);
    e.setVisible(false);
    expect(e.timers.live).toBe(0);
    expect(e.cancelled).toHaveLength(1);
  });

  it('the last unsubscribe stops the loop, the timer and the visibility subscription; a re-subscribe restarts', () => {
    const e = mkEnv();
    const t = new FpsTracker(e.env);
    const off = t.on('fps', () => {});
    expect(e.listeners()).toBe(1);
    off();
    expect(e.rafs.size).toBe(0);
    expect(e.timers.live).toBe(0);
    expect(e.listeners()).toBe(0);
    t.on('fps', () => {});
    expect(e.rafs.size).toBe(1);
    expect(e.timers.live).toBe(1);
  });

  it('a frame callback that fires after the loop stopped is ignored and does not re-arm', () => {
    const e = mkEnv({ noCancel: true });
    const t = new FpsTracker(e.env);
    const off = t.on('fps', () => {});
    const pending = [...e.rafs.values()];
    off();
    e.rafs.clear();
    for (const cb of pending) cb(0);
    expect(e.rafs.size).toBe(0);
  });

  it('a runtime without requestAnimationFrame is omitted: no timer, no subscription', () => {
    const e = mkEnv({ noRaf: true });
    const t = new FpsTracker(e.env);
    const got: number[] = [];
    t.on('fps', (v) => got.push(v));
    expect(e.timers.set).toBe(0);
    e.advance(1000);
    e.tick();
    expect(got).toEqual([]);
  });

  it('works without cancelAnimationFrame', () => {
    const e = mkEnv({ noCancel: true });
    const t = new FpsTracker(e.env);
    t.on('fps', () => {});
    expect(() => e.setVisible(false)).not.toThrow();
  });

  it('with no lifecycle it measures nothing: without visibility events a hidden tab could not be gated', () => {
    const e = mkEnv();
    const { lifecycle: _l, ...rest } = e.env;
    const errors: unknown[] = [];
    const t = new FpsTracker(rest, (err) => errors.push(err));
    t.on('fps', () => {});
    expect(e.rafs.size).toBe(0);
    expect(e.timers.set).toBe(0);
    expect(errors).toEqual([]); // a deliberate omission, not a failure
  });

  it('a throwing requestAnimationFrame is reported and the tracker stays usable', () => {
    const errors: unknown[] = [];
    const e = mkEnv();
    const t = new FpsTracker(
      {
        ...e.env,
        requestAnimationFrame: () => {
          throw new Error('raf');
        },
      },
      (err) => errors.push(err),
    );
    expect(() => t.on('fps', () => {})).not.toThrow();
    expect((errors[0] as Error).message).toBe('raf');
    expect(() => e.setVisible(false)).not.toThrow();
  });

  it('a start that failed halfway is cleaned up, so the next visible event can start the loop again', () => {
    const e = mkEnv({ visible: false });
    let failures = 1;
    const errors: unknown[] = [];
    const t = new FpsTracker(
      {
        ...e.env,
        requestAnimationFrame: (cb) => {
          if (failures-- > 0) throw new Error('raf once');
          return e.env.requestAnimationFrame?.(cb) ?? 0;
        },
      },
      (err) => errors.push(err),
    );
    t.on('fps', () => {});
    e.setVisible(true); // fails: nothing may be left half started
    expect(errors).toHaveLength(1);
    expect(e.timers.live).toBe(0);
    e.setVisible(true); // the next event (no hide in between) starts it properly
    expect(e.rafs.size).toBe(1);
    expect(e.timers.live).toBe(1);
  });

  it('samples every second by default and honors intervalMs', () => {
    const seen: number[] = [];
    const scheduler: Scheduler = {
      setInterval: (_cb, ms) => {
        seen.push(ms);
        return 1;
      },
      clearInterval: () => {},
    };
    const e = mkEnv();
    new FpsTracker({ ...e.env, scheduler }).on('fps', () => {});
    new FpsTracker({ ...e.env, scheduler, intervalMs: 250 }).on('fps', () => {});
    expect(seen).toEqual([1000, 250]);
  });

  it('a lifecycle that throws on subscribe is reported, not thrown out of on()', () => {
    const errors: unknown[] = [];
    const e = mkEnv();
    const t = new FpsTracker(
      {
        ...e.env,
        lifecycle: {
          on: () => {
            throw new Error('lifecycle');
          },
        },
      },
      (err) => errors.push(err),
    );
    expect(() => t.on('fps', () => {})).not.toThrow();
    expect((errors[0] as Error).message).toBe('lifecycle');
  });

  it('a requestAnimationFrame that throws while re-arming is reported, not thrown into the frame callback', () => {
    const errors: unknown[] = [];
    const e = mkEnv();
    let calls = 0;
    const t = new FpsTracker(
      {
        ...e.env,
        requestAnimationFrame: (cb) => {
          calls += 1;
          if (calls > 1) throw new Error('rearm');
          return e.env.requestAnimationFrame?.(cb) ?? 0;
        },
      },
      (err) => errors.push(err),
    );
    t.on('fps', () => {});
    expect(() => e.frame()).not.toThrow();
    expect((errors[0] as Error).message).toBe('rearm');
  });

  it('a clock that throws skips that window (reported) and the next one recovers', () => {
    const errors: unknown[] = [];
    const e = mkEnv();
    let boom = false;
    const t = new FpsTracker(
      {
        ...e.env,
        now: () => {
          if (boom) throw new Error('clock');
          return e.env.now();
        },
      },
      (err) => errors.push(err),
    );
    const got: number[] = [];
    t.on('fps', (v) => got.push(v));
    e.advance(500);
    e.frame();
    boom = true;
    expect(() => e.tick()).not.toThrow();
    expect((errors[0] as Error).message).toBe('clock');
    expect(got).toEqual([]);
    boom = false;
    e.advance(500);
    e.tick();
    expect(got).toEqual([1]); // the failed window was not consumed: its 1 frame counts over the full 1000 ms
  });

  it('a clock that throws while the loop starts rolls the start back, so the next visible event can start it', () => {
    const errors: unknown[] = [];
    const e = mkEnv({ visible: false });
    let boom = true;
    const t = new FpsTracker(
      {
        ...e.env,
        now: () => {
          if (boom) throw new Error('clock at start');
          return e.env.now();
        },
      },
      (err) => errors.push(err),
    );
    t.on('fps', () => {});
    e.setVisible(true); // the clock throws: nothing may be left half started
    expect((errors[0] as Error).message).toBe('clock at start');
    expect(e.rafs.size).toBe(0);
    expect(e.timers.live).toBe(0);
    boom = false;
    e.setVisible(true); // no hide in between: the tracker is not wedged in `running`
    expect(e.rafs.size).toBe(1);
    expect(e.timers.live).toBe(1);
  });

  it('a throwing visibilityState read is treated as hidden and reported', () => {
    const errors: unknown[] = [];
    const e = mkEnv();
    const doc = {};
    Object.defineProperty(doc, 'visibilityState', {
      get(): never {
        throw new Error('vis');
      },
    });
    const t = new FpsTracker({ ...e.env, document: doc }, (err) => errors.push(err));
    t.on('fps', () => {});
    expect(e.rafs.size).toBe(0);
    expect((errors[0] as Error).message).toBe('vis');
  });

  it('a throwing consumer or reporter never breaks the tick', () => {
    const e = mkEnv();
    const t = new FpsTracker(e.env, () => {
      throw new Error('reporter');
    });
    t.on('fps', () => {
      throw new Error('consumer');
    });
    e.advance(1000);
    expect(() => e.tick()).not.toThrow();
  });

  it('falls back to the wall clock when the runtime has no performance.now', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.stubGlobal('performance', {});
    try {
      vi.setSystemTime(0);
      const frames: Array<() => void> = [];
      const t = new FpsTracker({
        lifecycle: { on: () => () => {} },
        document: { visibilityState: 'visible' },
        requestAnimationFrame: (cb) => {
          frames.push(() => cb(0));
          return frames.length;
        },
      });
      const got: number[] = [];
      t.on('fps', (v) => got.push(v));
      frames[0]?.();
      vi.advanceTimersByTime(1000);
      expect(got).toEqual([1]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('uses performance.now and the global timers by default', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let ms = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => ms);
    try {
      const frames: Array<() => void> = [];
      const t = new FpsTracker({
        lifecycle: { on: () => () => {} },
        document: { visibilityState: 'visible' },
        requestAnimationFrame: (cb) => {
          frames.push(() => cb(0));
          return frames.length;
        },
      });
      const got: number[] = [];
      const off = t.on('fps', (v) => got.push(v));
      frames[0]?.();
      ms = 500;
      vi.advanceTimersByTime(1000);
      expect(got).toEqual([2]); // 1 frame over a 500 ms performance.now window
      off();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
