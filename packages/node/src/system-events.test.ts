import process from 'node:process';
import type { SystemEvent } from '@bugsee/capture';
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

describe('signal disposition survives a SECOND Bugsee listener (Wave 6.1)', () => {
  // THE INTERACTION DEFECT. The flush-on-signal hook added in Wave 6.1 is a second Bugsee listener on
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
