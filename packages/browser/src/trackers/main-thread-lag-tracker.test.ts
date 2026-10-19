import type { Scheduler } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import { MainThreadLagTracker } from './main-thread-lag-tracker';

// A controllable page: a fake MessageChannel whose posted messages are delivered by hand, a manual clock,
// a visibility lifecycle and a manual interval.
function mkEnv(over: { visible?: boolean; noChannel?: boolean; noNow?: boolean } = {}) {
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
    closed: number;
    deliver: () => void;
  }
  const channels: Chan[] = [];
  const control = { postFails: 0, ctorFails: 0 };
  class FakeChannel {
    port1: Chan['port1'];
    port2: Chan['port2'];
    constructor() {
      if (control.ctorFails-- > 0) throw new Error('ctor');
      const chan: Chan = {
        queue: 0,
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
            chan.queue += 1;
          },
          close: () => {
            chan.closed += 1;
          },
        },
        deliver: () => {
          // a message already in flight can still be delivered after close() in a real engine
          const n = chan.queue; // a re-arm posts a NEW message; it is delivered by the next call
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

  it('while visible: posts one ping, and the delta is the clock distance between post and receipt', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    expect(e.channels).toHaveLength(1);
    expect(e.channels[0]?.queue).toBe(1);
    e.advance(37);
    e.channels[0]?.port1.onmessage?.({});
    e.tick();
    expect(got).toEqual([37]);
  });

  it('omits until a ping has completed in this run (never 0 before the first receipt)', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(1000);
    e.tick();
    e.advance(1000);
    e.tick();
    expect(got).toEqual([]);
  });

  it('RE-ARMS on every receipt, so the number tracks the main thread for the whole session', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    const chan = e.channels[0];
    e.advance(5);
    chan?.deliver();
    expect(chan?.queue).toBe(1); // posted again
    e.tick();
    e.advance(250); // the main thread blocked for a quarter second
    chan?.port1.onmessage?.({});
    e.tick();
    expect(got).toEqual([5, 250]);
    expect(e.channels).toHaveLength(1); // one channel per run, not one per ping
  });

  it('a polled trace: the latest delta is emitted on EVERY tick (not consumed)', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(8);
    e.channels[0]?.port1.onmessage?.({});
    e.tick();
    e.tick();
    expect(got).toEqual([8, 8]);
  });

  it('going hidden aborts the in-flight ping, CLEARS the delta, closes the channel and stops the timer', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(3);
    e.channels[0]?.port1.onmessage?.({});
    e.setVisible(false);
    expect(e.timers.live).toBe(0);
    expect(e.channels[0]?.closed).toBe(2);
    expect(e.channels[0]?.port1.onmessage).toBeNull();
    e.tick(); // even a stray tick has nothing to say
    expect(got).toEqual([]);
  });

  it('does NOT re-arm while hidden: a late receipt neither writes nor posts again', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    const chan = e.channels[0];
    const late = chan?.port1.onmessage;
    e.setVisible(false);
    e.advance(60_000); // a throttled hidden completion
    late?.({});
    expect(chan?.queue).toBe(1); // only the original post; no re-arm
    expect(e.channels).toHaveLength(1);
    e.setVisible(true);
    e.tick();
    expect(got).toEqual([]); // the hidden completion never became a sample
  });

  it('a late receipt from an aborted run can never write into the NEW run (generation guard)', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    const stale = e.channels[0]?.port1.onmessage;
    e.setVisible(false);
    e.advance(60_000);
    e.setVisible(true);
    expect(e.channels).toHaveLength(2);
    stale?.({}); // arrives after the new run started
    e.tick();
    expect(got).toEqual([]);
    expect(e.channels[1]?.queue).toBe(1); // and did not post on the new run's behalf
    e.advance(4);
    e.channels[1]?.port1.onmessage?.({});
    e.tick();
    expect(got).toEqual([4]);
  });

  it('hide -> show: omits until a ping that STARTED and completed in the visible run lands', () => {
    const e = mkEnv();
    const { got } = collect(new MainThreadLagTracker(e.env));
    e.advance(10);
    e.channels[0]?.port1.onmessage?.({});
    e.tick();
    e.setVisible(false);
    e.setVisible(true);
    e.tick();
    expect(got).toEqual([10]); // nothing from the previous run's state
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

  it('a throwing postMessage is reported, rolls back, and closes the half-built channel', () => {
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

  it('a clock that throws at receipt is reported, drops the sample and stops re-arming', () => {
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
    expect(() => e.channels[0]?.port1.onmessage?.({})).not.toThrow();
    e.tick();
    expect((errors[0] as Error).message).toBe('clock');
    expect(got).toEqual([]);
    expect(e.channels[0]?.queue).toBe(1); // no re-arm
  });

  it('a postMessage that throws while re-arming is reported and the stale delta is CLEARED', () => {
    const e = mkEnv();
    const errors: unknown[] = [];
    const { got } = collect(new MainThreadLagTracker(e.env, (x) => errors.push(x)));
    e.advance(2);
    e.channels[0]?.port1.onmessage?.({});
    e.tick();
    e.control.postFails = 1;
    e.advance(2);
    expect(() => e.channels[0]?.port1.onmessage?.({})).not.toThrow();
    expect((errors[0] as Error).message).toBe('post');
    e.tick();
    expect(got).toEqual([2]); // not a frozen last number
  });

  it('a negative or non-finite delta is discarded, never reported as a lag', () => {
    const e = mkEnv();
    let t = 100;
    const { got } = collect(new MainThreadLagTracker({ ...e.env, now: () => t }));
    t = 90; // a backwards clock
    e.channels[0]?.port1.onmessage?.({});
    e.tick();
    t = Number.NaN;
    e.channels[0]?.port1.onmessage?.({});
    e.tick();
    expect(got).toEqual([]);
  });

  it('an infinite delta is discarded too', () => {
    const e = mkEnv();
    let t = 0;
    const { got } = collect(new MainThreadLagTracker({ ...e.env, now: () => t }));
    t = Number.POSITIVE_INFINITY;
    e.channels[0]?.port1.onmessage?.({});
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
      e.channels[0]?.port1.onmessage?.({});
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
