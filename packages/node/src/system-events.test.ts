import type { SystemEvent } from '@bugsee/capture';
import { describe, expect, it } from 'vitest';
import type { ProcessEvents } from './detection-providers';
import { createNodeSystemEventsSource } from './system-events';

// A fake process emitter: records listeners per event, lets the test fire them, and reports presence.
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
  return { proc, fire, has };
}

function activate(proc: ProcessEvents) {
  const source = createNodeSystemEventsSource(proc);
  const events: SystemEvent[] = [];
  const off = source.onAny((_stage, event) => events.push(event)); // subscribing activates the source
  return { events, off };
}

describe('createNodeSystemEventsSource', () => {
  it('emits process_started and registers exit/warning listeners on activate', () => {
    const proc = fakeProc();
    const { events } = activate(proc.proc);
    expect(events).toEqual([{ name: 'process_started' }]);
    expect(proc.has('exit')).toBe(true);
    expect(proc.has('warning')).toBe(true);
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

  it('removes the process listeners on deactivate (last unsubscribe)', () => {
    const proc = fakeProc();
    const { off } = activate(proc.proc);
    off();
    expect(proc.has('exit')).toBe(false);
    expect(proc.has('warning')).toBe(false);
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
