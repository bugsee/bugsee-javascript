import process from 'node:process';
import type { SystemEvent } from '@bugsee/capture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessEvents } from './detection-providers';
import { createNodeSystemEventsSource, type SignalControl } from './system-events';

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
  return { proc, fire, has, count };
}

// A signal-control fake: listenerCount reports the SDK's own count by default; reRaise is recorded.
const fakeSignalControl = (count: (signal: string) => number) => {
  const reRaised: string[] = [];
  const control: SignalControl = { listenerCount: count, reRaise: (s) => reRaised.push(s) };
  return { control, reRaised };
};

function activate(proc: ProcessEvents, signalControl?: SignalControl) {
  const source = createNodeSystemEventsSource(proc, signalControl ? { signalControl } : {});
  const events: SystemEvent[] = [];
  const off = source.onAny((_stage, event) => events.push(event)); // subscribing activates the source
  return { events, off };
}

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
    const proc = fakeProc();
    // listenerCount reports the SDK's own listener count for the signal (1 = sole handler).
    const sig = fakeSignalControl((s) => proc.count(s));
    const { events } = activate(proc.proc, sig.control);
    proc.fire('SIGTERM');
    expect(events.slice(1)).toEqual([{ name: 'process_signal', params: { signal: 'SIGTERM' } }]);
    expect(sig.reRaised).toEqual(['SIGTERM']); // re-raised to let the default termination happen
    expect(proc.has('SIGTERM')).toBe(false); // removed itself before re-raising (no loop)
  });

  it('captures a signal but does NOT re-raise when the app also handles it (observe-only)', () => {
    const proc = fakeProc();
    // Pretend the app registered its own SIGINT handler too → count 2.
    const sig = fakeSignalControl(() => 2);
    const { events } = activate(proc.proc, sig.control);
    proc.fire('SIGINT');
    expect(events.slice(1)).toEqual([{ name: 'process_signal', params: { signal: 'SIGINT' } }]);
    expect(sig.reRaised).toEqual([]); // the app owns shutdown; we only observed
    expect(proc.has('SIGINT')).toBe(true); // listener kept
  });

  it('default signal control counts real listeners and re-raises via process.kill', () => {
    const proc = fakeProc();
    vi.spyOn(process, 'listenerCount').mockReturnValue(1); // pretend the SDK is the sole handler
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { events } = activate(proc.proc); // no signalControl injected → the real default
    proc.fire('SIGTERM');
    expect(events.slice(1)).toEqual([{ name: 'process_signal', params: { signal: 'SIGTERM' } }]);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM'); // re-raised through process.kill
    expect(proc.has('SIGTERM')).toBe(false); // removed itself first
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
