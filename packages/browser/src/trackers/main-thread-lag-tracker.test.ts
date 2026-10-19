import type { Scheduler } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import { MainThreadLagTracker } from './main-thread-lag-tracker';

// A controllable page: a fake MessageChannel whose posted messages are delivered by hand (or automatically,
// synchronously, with `auto`), a manual clock, a visibility lifecycle and a manual interval.
function mkEnv(
  over: { visible?: boolean; noChannel?: boolean; noNow?: boolean; auto?: number } = {},
) {
  let now = 0;
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
  interface Chan {
    port1: { onmessage: ((e: unknown) => void) | null; close: () => void };
    port2: { postMessage: (m: unknown) => void; close: () => void };
    queue: number;
    posts: number;
    closed: number;
    deliver: () => void;
  }
  const channels: Chan[] = [];
  const control = { postFails: 0, ctorFails: 0, auto: over.auto };
  class FakeChannel {
    port1: Chan['port1'];
    port2: Chan['port2'];
    constructor() {
      if (control.ctorFails-- > 0) throw new Error('ctor');
      const chan: Chan = {
        queue: 0,
        posts: 0,
        closed: 0,
        port1: {
          onmessage: null,
          close: () => {
            chan.closed += 1;
          },
        },
        port2: {
          postMessage: () => {
            if (control.postFails-- > 0) throw new Error('post');
            chan.posts += 1;
            chan.queue += 1;
            if (control.auto !== undefined) {
              now += control.auto; // the round trip takes `auto` ms, delivered at once
              chan.deliver();
            }
          },
          close: () => {
            chan.closed += 1;
          },
        },
        deliver: () => {
          const n = chan.queue;
          chan.queue = 0;
          for (let i = 0; i < n; i++) chan.port1.onmessage?.({});
        },
      };
      this.port1 = chan.port1;
      this.port2 = chan.port2;
      channels.push(chan);
    }
  }
  const env = {
    document: doc,
    lifecycle: {
      on: (type: string, fn: (e: never) => void) => {
        expect(type).toBe('visibility');
        visListeners.add(fn as never);
        return () => void visListeners.delete(fn as never);
      },
    },
    ...(over.noChannel ? {} : { MessageChannel: FakeChannel as never }),
    ...(over.noNow ? {} : { now: () => now }),
    scheduler,
  };
  return {
    env,
    doc,
    timers,
    channels,
    control,
    posts: () => channels.reduce((n, c) => n + c.posts, 0),
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

const collect = (t: MainThreadLagTracker) => {
  const got: number[] = [];
  const off = t.on('lag', (v) => got.push(v));
  return { got, off };
};

describe('MainThreadLagTracker', () => {
  it('attaches nothing until the first subscriber', () => {
    const e = mkEnv();
    new MainThreadLagTracker(e.env);
    expect(e.channels).toHaveLength(0);
    expect(e.timers.set).toBe(0);
    expect(e.listeners()).toBe(0);
  });

  it('while visible: posts ONE ping at start; its receipt stores the delta, which is emitted on the NEXT tick', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    expect(e.posts()).toBe(1);
    e.advance(37);
    e.channels[0]?.deliver();
    expect(got).toEqual([]); // a receipt never posts and never emits by itself
    expect(e.posts()).toBe(1);
    e.advance(963);
    e.tick();
    expect(got).toEqual([37]);
    expect(e.posts()).toBe(2); // the tick re-armed with exactly one ping
  });

  it('a delta is emitted once (consumed); the tick after it with no new receipt reports the stall instead', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(8);
    e.channels[0]?.deliver();
    e.tick(); // emits 8, posts at t=8
    e.advance(1000);
    e.tick(); // the ping posted at the last tick has not come back for 1000 ms
    expect(got).toEqual([8, 1000]);
  });

  it('FLOOD GUARD: at most one post per tick however long it runs, with a channel that delivers instantly', () => {
    const e = mkEnv({ auto: 3 });
    const { got } = collect(new MainThreadLagTracker(e.env));
    expect(e.posts()).toBe(1); // a delivered ping does not post again by itself
    for (let i = 0; i < 50; i++) {
      e.advance(997);
      e.tick();
    }
    expect(e.posts()).toBe(51); // the start ping + one per tick, never more
    expect(got).toHaveLength(50);
    expect(got.every((v) => v === 3)).toBe(true);
  });

  it('a long task between post and receipt shows in the emitted value (receipt delivered before the tick)', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(300); // the main thread was blocked for 300 ms with the ping queued
    e.channels[0]?.deliver();
    e.advance(700);
    e.tick();
    expect(got).toEqual([300]);
  });

  it('a long task shows even when the TICK runs first: a ping still in flight reports its age and posts nothing', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(1300);
    e.tick(); // still in flight after 1.3 s
    expect(got).toEqual([1300]);
    expect(e.posts()).toBe(1);
    e.advance(500);
    e.tick();
    expect(got).toEqual([1300, 1800]); // the age keeps growing while blocked, and still one ping total
    expect(e.posts()).toBe(1);
    e.channels[0]?.deliver(); // the thread frees up
    e.tick();
    expect(got).toEqual([1300, 1800, 1800]); // the completed measurement, then re-armed
    expect(e.posts()).toBe(2);
  });

  it('a freshly started run with a ping in flight reports it only once the tick finds it still pending', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    expect(got).toEqual([]); // nothing measured and nothing emitted before the first tick
  });

  it('going hidden aborts the in-flight ping, CLEARS the delta, closes the channel and stops the timer', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(3);
    e.channels[0]?.deliver();
    e.setVisible(false);
    expect(e.timers.live).toBe(0);
    expect(e.channels[0]?.closed).toBe(2);
    expect(e.channels[0]?.port1.onmessage).toBeNull();
    e.tick(); // even a stray tick has nothing to say
    expect(got).toEqual([]);
  });

  it('a hidden completion is dropped: a late receipt neither writes nor posts', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    const chan = e.channels[0];
    const late = chan?.port1.onmessage;
    e.setVisible(false);
    e.advance(60_000); // a throttled hidden completion
    late?.({});
    expect(e.posts()).toBe(1);
    e.setVisible(true);
    e.advance(1000);
    e.tick();
    expect(got).toEqual([1000]); // aged from the NEW run's ping, never the 60 s hidden stretch
  });

  it('hide -> show: the first visible tick sees only the NEW run (no hidden-throttled sample, no stale number)', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    const stale = e.channels[0]?.port1.onmessage;
    e.advance(10);
    e.channels[0]?.deliver(); // a sample exists...
    e.setVisible(false); // ...and is cleared
    e.advance(60_000);
    e.setVisible(true);
    stale?.({}); // an aborted run's receipt arriving late
    e.advance(5);
    e.channels[1]?.deliver();
    e.advance(995);
    e.tick();
    expect(got).toEqual([5]); // measured entirely inside the visible run
  });

  it("a stale receipt from an aborted run cannot complete the NEW run's ping", () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    const stale = e.channels[0]?.port1.onmessage;
    e.setVisible(false);
    e.advance(60_000);
    e.setVisible(true);
    stale?.({});
    e.advance(1000);
    e.tick();
    expect(got).toEqual([1000]); // still in flight, aged from the new post (not a stale ~0 sample)
    expect(e.posts()).toBe(2);
  });

  it("hide -> show clears the previous run's sample: it is never emitted in the new run", () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(10);
    e.channels[0]?.deliver(); // sample 10 stored
    e.setVisible(false);
    e.setVisible(true);
    e.advance(1000);
    e.tick(); // the new ping is still pending: its age, not the old 10
    expect(got).toEqual([1000]);
  });

  it("a previous run's sample cannot resurface through a later DISCARDED receipt", () => {
    const e = mkEnv();
    let t = 0;
    const { got } = collect(new MainThreadLagTracker({ ...e.env, now: () => t }));
    t = 10;
    e.channels[0]?.deliver(); // sample 10 stored
    e.setVisible(false);
    t = 100;
    e.setVisible(true);
    t = 50; // backwards: the new run's receipt is discarded
    e.channels[1]?.deliver();
    e.tick();
    expect(got).toEqual([]);
  });

  it('a discarded (backwards-clock) receipt after an emitted sample does not re-emit the old sample', () => {
    const e = mkEnv();
    let t = 0;
    const { got } = collect(new MainThreadLagTracker({ ...e.env, now: () => t }));
    t = 20;
    e.channels[0]?.deliver();
    e.tick(); // emits 20, posts at t=20
    t = 5; // backwards
    e.channels[0]?.deliver(); // discarded
    e.tick();
    expect(got).toEqual([20]);
  });

  it('an unreadable age is not emitted: a backwards or infinite clock while a ping is pending', () => {
    const e = mkEnv();
    let t = 100;
    const { got } = collect(new MainThreadLagTracker({ ...e.env, now: () => t }));
    t = 50;
    e.tick();
    t = Number.POSITIVE_INFINITY;
    e.tick();
    expect(got).toEqual([]);
  });

  it('hidden at start: no channel, no timer, nothing emitted', () => {
    const e = mkEnv({ visible: false });
    const { got } = collect(new MainThreadLagTracker(e.env));
    expect(e.channels).toHaveLength(0);
    expect(e.timers.live).toBe(0);
    e.tick();
    expect(got).toEqual([]);
    e.setVisible(true);
    expect(e.channels).toHaveLength(1);
    expect(e.timers.live).toBe(1);
  });

  it('duplicate visible/hidden events do not stack channels or timers', () => {
    const e = mkEnv();
    collect(new MainThreadLagTracker(e.env));
    e.setVisible(true);
    e.setVisible(true);
    expect(e.channels).toHaveLength(1);
    expect(e.timers.live).toBe(1);
    e.setVisible(false);
    e.setVisible(false);
    expect(e.timers.live).toBe(0);
    expect(e.channels[0]?.closed).toBe(2);
  });

  it('the last unsubscribe stops everything; a re-subscribe restarts with a fresh channel', () => {
    const e = mkEnv();
    const t = new MainThreadLagTracker(e.env);
    const { off } = collect(t);
    expect(e.listeners()).toBe(1);
    off();
    expect(e.listeners()).toBe(0);
    expect(e.timers.live).toBe(0);
    expect(e.channels[0]?.closed).toBe(2);
    collect(t);
    expect(e.channels).toHaveLength(2);
    expect(e.timers.live).toBe(1);
  });

  it('a runtime without MessageChannel is omitted: no timer, no subscription, no error', () => {
    const e = mkEnv({ noChannel: true });
    const errors: unknown[] = [];
    const { got } = collect(new MainThreadLagTracker(e.env, (x) => errors.push(x)));
    expect(e.timers.set).toBe(0);
    expect(e.listeners()).toBe(0);
    e.tick();
    expect(got).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('without a clock it measures nothing (no host fallback, no wall-clock guess)', () => {
    const e = mkEnv({ noNow: true });
    collect(new MainThreadLagTracker(e.env));
    expect(e.channels).toHaveLength(0);
    expect(e.timers.set).toBe(0);
  });

  it('with no lifecycle it measures nothing: a hidden tab could not be gated', () => {
    const e = mkEnv();
    const { lifecycle: _l, ...rest } = e.env;
    const errors: unknown[] = [];
    collect(new MainThreadLagTracker(rest, (x) => errors.push(x)));
    expect(e.channels).toHaveLength(0);
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
    expect(e.channels).toHaveLength(0);
    expect((errors[0] as Error).message).toBe('vis');
  });

  it('a throwing MessageChannel constructor is reported and rolls the start back; the next visible event retries', () => {
    const e = mkEnv({ visible: false });
    const errors: unknown[] = [];
    collect(new MainThreadLagTracker(e.env, (x) => errors.push(x)));
    e.control.ctorFails = 1;
    e.setVisible(true);
    expect((errors[0] as Error).message).toBe('ctor');
    expect(e.timers.live).toBe(0);
    e.setVisible(true);
    expect(e.channels).toHaveLength(1);
    expect(e.timers.live).toBe(1);
  });

  it('a throwing postMessage at start is reported, rolls back, and closes the half-built channel', () => {
    const e = mkEnv({ visible: false });
    const errors: unknown[] = [];
    collect(new MainThreadLagTracker(e.env, (x) => errors.push(x)));
    e.control.postFails = 1;
    e.setVisible(true);
    expect((errors[0] as Error).message).toBe('post');
    expect(e.timers.live).toBe(0);
    expect(e.channels[0]?.closed).toBe(2);
    e.setVisible(true);
    expect(e.timers.live).toBe(1);
  });

  it('a throwing clock at start is reported and rolls back like any setup failure', () => {
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

  it('a postMessage that throws at a tick is reported, the stale delta is CLEARED, and the NEXT tick retries', () => {
    const e = mkEnv();
    const errors: unknown[] = [];
    const { got } = collect(new MainThreadLagTracker(e.env, (x) => errors.push(x)));
    e.advance(2);
    e.channels[0]?.deliver();
    e.control.postFails = 1;
    e.tick(); // emits 2, then fails to re-arm
    expect(got).toEqual([2]);
    expect((errors[0] as Error).message).toBe('post');
    e.advance(1000);
    e.tick(); // nothing in flight, nothing stored: it retries and does not invent a number
    expect(got).toEqual([2]);
    expect(e.posts()).toBe(2); // start + the retry
    e.advance(4);
    e.channels[0]?.deliver();
    e.tick();
    expect(got).toEqual([2, 4]);
  });

  it('a clock that throws at a tick is reported, drops that tick, and the next tick recovers', () => {
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
    expect(() => e.tick()).not.toThrow(); // in flight: the age cannot be read
    expect((errors[0] as Error).message).toBe('clock');
    expect(got).toEqual([]);
    boom = false;
    t = 40;
    e.tick();
    expect(got).toEqual([40]);
  });

  it('a clock that throws at receipt is reported, drops the sample and frees the next tick to retry', () => {
    const e = mkEnv();
    const errors: unknown[] = [];
    let calls = 0;
    const { got } = collect(
      new MainThreadLagTracker(
        {
          ...e.env,
          now: () => {
            if (++calls > 1) throw new Error('clock');
            return 0;
          },
        },
        (x) => errors.push(x),
      ),
    );
    expect(() => e.channels[0]?.deliver()).not.toThrow();
    expect((errors[0] as Error).message).toBe('clock');
    expect(got).toEqual([]);
  });

  it('a negative or non-finite delta is discarded, never reported as a lag', () => {
    const e = mkEnv();
    let t = 100;
    const { got } = collect(new MainThreadLagTracker({ ...e.env, now: () => t }));
    t = 90; // a backwards clock
    e.channels[0]?.deliver();
    e.tick();
    expect(got).toEqual([]);
  });

  it('an infinite delta is discarded too', () => {
    const e = mkEnv();
    let t = 0;
    const { got } = collect(new MainThreadLagTracker({ ...e.env, now: () => t }));
    t = Number.POSITIVE_INFINITY;
    e.channels[0]?.deliver();
    e.tick();
    expect(got).toEqual([]);
  });

  it('a throwing port close is swallowed on stop', () => {
    const e = mkEnv();
    collect(new MainThreadLagTracker(e.env));
    const chan = e.channels[0];
    if (chan !== undefined)
      chan.port1.close = () => {
        throw new Error('close');
      };
    expect(() => e.setVisible(false)).not.toThrow();
    expect(chan?.closed).toBe(1); // port2 was still closed
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
    new MainThreadLagTracker({ ...e.env, scheduler }).on('lag', () => {});
    new MainThreadLagTracker({ ...e.env, scheduler, intervalMs: 250 }).on('lag', () => {});
    expect(seen).toEqual([1000, 250]);
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
      now = 9;
      e.channels[0]?.deliver();
      vi.advanceTimersByTime(1000);
      expect(got).toEqual([9]);
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
    const t = new MainThreadLagTracker(e.env, () => {
      throw new Error('reporter');
    });
    t.on('lag', () => {});
    e.control.ctorFails = 1;
    expect(() => e.setVisible(true)).not.toThrow();
  });
});
