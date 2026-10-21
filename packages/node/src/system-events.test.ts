import process from 'node:process';
import type { SystemEvent } from '@bugsee/capture';
import { ProcessTracker } from '@bugsee/trackers/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessEvents } from './detection-providers';
import { releaseSignalToDefault } from './process-policy';
import { createNodeSystemEventsSource } from './system-events';

afterEach(() => {
  vi.restoreAllMocks();
});

// A fake process emitter: records listeners per event, lets the test fire them, reports presence/count.
function fakeProc() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const proc: ProcessEvents = {
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return undefined;
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener);
      return undefined;
    },
  };
  const fire = (event: string, ...args: unknown[]) => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      listener(...args);
    }
  };
  const has = (event: string) => (listeners.get(event)?.size ?? 0) > 0;
  const count = (event: string) => listeners.get(event)?.size ?? 0;
  return { proc, fire, has, count, listenerSet: (event: string) => listeners.get(event) };
}

function activate(proc: ProcessEvents) {
  const source = createNodeSystemEventsSource(proc);
  const events: SystemEvent[] = [];
  const off = source.onAny((_stage, event) => events.push(event)); // subscribing activates the source
  return { events, off };
}

// WAVE 6.1 — a REAL process fake: it can also enumerate listeners, and re-raising means killing itself,
// which is what the unified signal-disposition rule reads. The old `SignalControl` seam modelled those two
// facts as separate injectables and let them disagree with the listener list they were supposed to describe.
function realisticProc() {
  const base = fakeProc();
  const kill = vi.fn();
  const proc = Object.assign(base.proc, {
    listeners: (event: string) => [...(base.listenerSet(event) ?? [])],
    kill,
    pid: 4242,
  });
  return { ...base, proc: proc as ProcessEvents, kill };
}

describe('signal disposition survives a SECOND Bugsee listener', () => {
  // THE INTERACTION DEFECT. The flush-on-signal hook added for signal flushing is a second Bugsee listener on
  // SIGTERM. Under the old `listenerCount(signal) === 1` gate that made the count 2, which reads as "the
  // app has its own handler" — so this source stood down, the flush hook (which only re-raises when it is
  // last) also stood down, and NOBODY restored the default. A SIGTERM would have left the process running
  // forever: the exact hang the signal logic exists to prevent, caused by fixing an unrelated bug.
  it('re-raises EXACTLY ONCE when a second BUGSEE listener is present', () => {
    const { proc, fire, kill } = realisticProc();
    activate(proc);
    // The sibling is the real thing, not a stub: launch's flush-on-signal hook runs the same rule, so this
    // asserts the two converge rather than asserting what I hoped the other one does.
    const flushed: string[] = [];
    const sibling = (): void => {
      flushed.push('flush');
      releaseSignalToDefault(proc, 'SIGTERM', sibling);
    };
    proc.on('SIGTERM', sibling);
    fire('SIGTERM');
    expect(flushed).toEqual(['flush']); // the flush ran…
    expect(kill).toHaveBeenCalledTimes(1); // …and the process was still released to its default, once
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
  });

  it('re-raises only AFTER every Bugsee handler has run — flush before death', () => {
    // Order independence is the point: whichever of the two runs last is the one that re-raises, so the
    // flush can never be cut short by a sibling killing the process first.
    const { proc, fire, kill } = realisticProc();
    const order: string[] = [];
    const sibling = (): void => {
      order.push('flush');
      releaseSignalToDefault(proc, 'SIGTERM', sibling);
    };
    proc.on('SIGTERM', sibling); // registered BEFORE the source, so it runs first
    kill.mockImplementation(() => order.push('kill'));
    activate(proc);
    fire('SIGTERM');
    expect(order).toEqual(['flush', 'kill']);
  });

  it('re-raises with its own pid when it is the LAST listener', () => {
    const { proc, fire, kill } = realisticProc();
    activate(proc);
    fire('SIGTERM');
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-raise while the HOST still has a handler', () => {
    const { proc, fire, kill } = realisticProc();
    activate(proc);
    proc.on('SIGTERM', () => {});
    fire('SIGTERM');
    expect(kill).not.toHaveBeenCalled();
  });

  it('still emits the process_signal event either way — the canary', () => {
    const { proc, fire } = realisticProc();
    const { events } = activate(proc);
    proc.on('SIGTERM', () => {});
    fire('SIGTERM');
    expect(events.some((e) => e.name === 'process_signal')).toBe(true);
  });
});

describe('conformance: every emitted event param key is camelCase', () => {
  it('derives the keys from the events the real source emits and finds no non-camelCase one', () => {
    const { proc, fire } = realisticProc();
    const { events } = activate(proc);
    fire('exit', 1);
    fire('beforeExit', 2);
    fire('warning', new TypeError('deprecated'));
    fire('warning', 'plain');
    fire('SIGTERM');
    const keys = new Set(events.flatMap((e) => Object.keys(e.params ?? {})));
    expect([...keys].sort()).toEqual(['code', 'message', 'name', 'signal']); // not vacuous
    expect([...keys].filter((k) => !/^[a-z][a-zA-Z0-9]*$/.test(k))).toEqual([]);
  });
});

describe('createNodeSystemEventsSource', () => {
  it('emits process_started and registers exit/beforeExit/warning/signal listeners on activate', () => {
    const proc = fakeProc();
    const { events } = activate(proc.proc);
    expect(events).toEqual([{ name: 'process_started' }]);
    expect(proc.has('exit')).toBe(true);
    expect(proc.has('beforeExit')).toBe(true);
    expect(proc.has('warning')).toBe(true);
    expect(proc.has('SIGTERM')).toBe(true);
    expect(proc.has('SIGINT')).toBe(true);
  });

  it('emits process_exiting with the exit code (0 when none)', () => {
    const proc = fakeProc();
    const { events } = activate(proc.proc);
    proc.fire('exit', 3);
    proc.fire('exit'); // no code
    expect(events.slice(1)).toEqual([
      { name: 'process_exiting', params: { code: 3 } },
      { name: 'process_exiting', params: { code: 0 } },
    ]);
  });

  it('emits process_before_exit with the code (clean drain, distinct from exit)', () => {
    const proc = fakeProc();
    const { events } = activate(proc.proc);
    proc.fire('beforeExit', 5);
    proc.fire('beforeExit'); // no code → 0
    expect(events.slice(1)).toEqual([
      { name: 'process_before_exit', params: { code: 5 } },
      { name: 'process_before_exit', params: { code: 0 } },
    ]);
  });

  it('emits process_warning from an Error (name + message) or a non-Error (message)', () => {
    const proc = fakeProc();
    const { events } = activate(proc.proc);
    proc.fire('warning', new TypeError('deprecated API'));
    proc.fire('warning', 'plain string warning');
    expect(events.slice(1)).toEqual([
      { name: 'process_warning', params: { name: 'TypeError', message: 'deprecated API' } },
      { name: 'process_warning', params: { message: 'plain string warning' } },
    ]);
  });

  it('captures a signal and RE-RAISES it when the SDK is the sole handler (restores default exit)', () => {
    const { proc, fire, kill, has } = realisticProc();
    const { events } = activate(proc);
    fire('SIGTERM');
    expect(events.slice(1)).toEqual([{ name: 'process_signal', params: { signal: 'SIGTERM' } }]);
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM'); // re-raised to let the default termination happen
    expect(has('SIGTERM')).toBe(false); // removed itself before re-raising (no loop)
  });

  it('captures a signal but does NOT re-raise when the app also handles it (observe-only)', () => {
    const { proc, fire, kill, has } = realisticProc();
    const { events } = activate(proc);
    proc.on('SIGINT', () => {}); // the app registered its own handler too
    fire('SIGINT');
    expect(events.slice(1)).toEqual([{ name: 'process_signal', params: { signal: 'SIGINT' } }]);
    expect(kill).not.toHaveBeenCalled(); // the app owns shutdown; we only observed
    expect(has('SIGINT')).toBe(true); // the app's listener is untouched
  });

  it('defaults to the REAL process — re-raises through process.kill with the real pid', () => {
    // No `proc` injected at all, so the source reads and kills node:process itself. Asserts the production
    // wiring, which the old injected `SignalControl` seam let a test bypass entirely.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const source = createNodeSystemEventsSource();
    const events: SystemEvent[] = [];
    const off = source.onAny((_stage, event) => events.push(event));
    try {
      process.emit('SIGTERM');
      expect(events.slice(1)).toEqual([{ name: 'process_signal', params: { signal: 'SIGTERM' } }]);
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(process.listenerCount('SIGTERM')).toBe(0); // removed itself before re-raising
    } finally {
      off();
    }
  });

  it('removes the process listeners on deactivate (last unsubscribe)', () => {
    const proc = fakeProc();
    const { off } = activate(proc.proc);
    off();
    for (const e of ['exit', 'beforeExit', 'warning', 'SIGTERM', 'SIGINT']) {
      expect(proc.has(e)).toBe(false);
    }
  });

  it('defaults to the real process emitter', () => {
    const source = createNodeSystemEventsSource(); // default: node:process
    const events: SystemEvent[] = [];
    const off = source.onAny((_stage, event) => events.push(event));
    try {
      expect(events[0]?.name).toBe('process_started'); // activated against real process
    } finally {
      off(); // remove the real process listeners
    }
  });
});

describe('gc system event (C15)', () => {
  type GcListener = (g: { count: number; pauseMs: number; maxPauseMs: number }) => void;
  // A tracker double: records stage subscriptions so lazy attach/release is observable.
  function fakeTracker() {
    const listeners: GcListener[] = [];
    const subscribed: string[] = [];
    const tracker = {
      on: (stage: string, listener: GcListener) => {
        subscribed.push(stage);
        listeners.push(listener);
        return () => {
          listeners.splice(listeners.indexOf(listener), 1);
        };
      },
    };
    return {
      tracker: tracker as never,
      listeners,
      subscribed,
      fire: (g: Parameters<GcListener>[0]) => {
        for (const l of [...listeners]) l(g);
      },
    };
  }

  it('attaches NOTHING to the tracker until the first subscriber, and releases on the last unsubscribe', () => {
    const t = fakeTracker();
    const source = createNodeSystemEventsSource(fakeProc().proc, { processTracker: t.tracker });
    expect(t.subscribed).toEqual([]); // constructed: still nothing attached
    const off = source.onAny(() => {});
    expect(t.subscribed).toEqual(['gc']);
    expect(t.listeners).toHaveLength(1);
    off();
    expect(t.listeners).toHaveLength(0);
  });

  it('emits `gc` with camelCase {count, pauseMs, maxPauseMs} for an interval that had GC activity', () => {
    const t = fakeTracker();
    const { events } = activate2(t.tracker);
    t.fire({ count: 3, pauseMs: 12.5, maxPauseMs: 8 });
    expect(events.filter((e) => e.name === 'gc')).toEqual([
      { name: 'gc', params: { count: 3, pauseMs: 12.5, maxPauseMs: 8 } },
    ]);
  });

  it('rounds the pause figures to 3 decimals (the observer reports float noise like 21.458208084106445)', () => {
    const t = fakeTracker();
    const { events } = activate2(t.tracker);
    t.fire({ count: 2, pauseMs: 21.458208084106445, maxPauseMs: 10.0004999 });
    t.fire({ count: 1, pauseMs: 0.0005, maxPauseMs: 0.0004 });
    expect(events.filter((e) => e.name === 'gc').map((e) => e.params)).toEqual([
      { count: 2, pauseMs: 21.458, maxPauseMs: 10 },
      { count: 1, pauseMs: 0.001, maxPauseMs: 0 },
    ]);
  });

  it('a quiet interval (count 0) writes NOTHING: omit, never zero', () => {
    const t = fakeTracker();
    const { events } = activate2(t.tracker);
    t.fire({ count: 0, pauseMs: 0, maxPauseMs: 0 });
    expect(events.filter((e) => e.name === 'gc')).toEqual([]);
  });

  it('a subscription that throws is contained: the process events still work and onError hears it', () => {
    const errors: unknown[] = [];
    const proc = fakeProc();
    const source = createNodeSystemEventsSource(proc.proc, {
      processTracker: {
        on: () => {
          throw new Error('tracker down');
        },
      } as never,
      onError: (e) => void errors.push(e),
    });
    const events: SystemEvent[] = [];
    const off = source.onAny((_s, e) => events.push(e));
    expect(events).toEqual([{ name: 'process_started' }]);
    expect(proc.has('exit')).toBe(true);
    expect(errors).toHaveLength(1);
    off();
    expect(proc.has('exit')).toBe(false);
  });

  it('a gc release that throws is reported and the process listeners are still removed', () => {
    const errors: unknown[] = [];
    const proc = fakeProc();
    const source = createNodeSystemEventsSource(proc.proc, {
      processTracker: {
        on: () => () => {
          throw new Error('release failed');
        },
      } as never,
      onError: (e) => void errors.push(e),
    });
    const off = source.onAny(() => {});
    off();
    expect(errors).toHaveLength(1);
    expect(proc.has('exit')).toBe(false);
    expect(proc.has('SIGTERM')).toBe(false);
  });

  it('a throwing event listener is reported through onError (the emitter is wired to it)', () => {
    const t = fakeTracker();
    const errors: unknown[] = [];
    const source = createNodeSystemEventsSource(fakeProc().proc, {
      processTracker: t.tracker,
      onError: (e) => void errors.push(e),
    });
    const off = source.onAny((_s, e) => {
      if (e.name === 'gc') throw new Error('listener boom');
    });
    t.fire({ count: 1, pauseMs: 1, maxPauseMs: 1 });
    expect(errors).toHaveLength(1);
    off();
  });

  it('no tracker option: no gc subscription at all (captureSystemEvents:false never even builds one)', () => {
    const { events } = activate(fakeProc().proc);
    expect(events.map((e) => e.name)).toEqual(['process_started']);
  });

  it('end to end through a REAL ProcessTracker: one event per tick, observer armed only while subscribed', () => {
    let interval = { count: 2, pauseMs: 5, maxPauseMs: 4 };
    const calls: string[] = [];
    let tick: (() => void) | undefined;
    const tracker = new ProcessTracker({
      gc: {
        start: () => void calls.push('start'),
        stop: () => void calls.push('stop'),
        read: () => interval,
      },
      scheduler: {
        setInterval: (cb: () => void) => {
          tick = cb;
          return {};
        },
        clearInterval: () => {
          tick = undefined;
        },
      },
    });
    const source = createNodeSystemEventsSource(fakeProc().proc, { processTracker: tracker });
    expect(calls).toEqual([]);
    const events: SystemEvent[] = [];
    const off = source.onAny((_s, e) => events.push(e));
    expect(calls).toEqual(['start']);
    tick?.();
    interval = { count: 0, pauseMs: 0, maxPauseMs: 0 };
    tick?.();
    expect(events.filter((e) => e.name === 'gc')).toEqual([
      { name: 'gc', params: { count: 2, pauseMs: 5, maxPauseMs: 4 } },
    ]);
    off();
    expect(calls).toEqual(['start', 'stop']);
    expect(tick).toBeUndefined();
  });

  it('measuresGc:false on the tracker (Bun/Deno): the observer is never constructed and no gc event is ever emitted', () => {
    let constructed = 0;
    class Counting {
      constructor() {
        constructed += 1;
      }
      observe() {}
      disconnect() {}
    }
    let tick: (() => void) | undefined;
    const tracker = new ProcessTracker({
      measuresGc: false,
      performanceObserver: Counting as never,
      scheduler: {
        setInterval: (cb: () => void) => {
          tick = cb;
          return {};
        },
        clearInterval: () => {},
      },
    });
    const source = createNodeSystemEventsSource(fakeProc().proc, { processTracker: tracker });
    const events: SystemEvent[] = [];
    source.onAny((_s, e) => events.push(e))();
    expect(constructed).toBe(0);
    tick?.();
    expect(events.filter((e) => e.name === 'gc')).toEqual([]);
  });
});

function activate2(processTracker: never) {
  const source = createNodeSystemEventsSource(fakeProc().proc, { processTracker });
  const events: SystemEvent[] = [];
  const off = source.onAny((_s, e) => events.push(e));
  return { events, off };
}
