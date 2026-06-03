import type { SystemEvent } from '@bugsee/capture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WindowEvents } from './detection-providers';
import { createBrowserSystemEventsSource } from './system-events';

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeWindow() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const win: WindowEvents = {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    win,
    emit: (type: string, event: unknown) => {
      for (const l of listeners.get(type) ?? []) {
        l(event as Event);
      }
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

function activate(win: WindowEvents) {
  const source = createBrowserSystemEventsSource(win);
  const events: SystemEvent[] = [];
  const off = source.onAny((_stage, event) => events.push(event)); // subscribing activates the source
  return { events, off };
}

describe('createBrowserSystemEventsSource', () => {
  it('emits process_started and registers a pagehide listener on activate', () => {
    const w = fakeWindow();
    const { events } = activate(w.win);
    expect(events).toEqual([{ name: 'process_started' }]);
    expect(w.count('pagehide')).toBe(1);
  });

  it('emits process_exiting with the pagehide persisted flag', () => {
    const w = fakeWindow();
    const { events } = activate(w.win);
    w.emit('pagehide', { persisted: true });
    w.emit('pagehide', { persisted: false });
    expect(events.slice(1)).toEqual([
      { name: 'process_exiting', params: { persisted: true } },
      { name: 'process_exiting', params: { persisted: false } },
    ]);
  });

  it('removes the pagehide listener on deactivate (last subscriber gone)', () => {
    const w = fakeWindow();
    const { off } = activate(w.win);
    off();
    expect(w.count('pagehide')).toBe(0);
  });

  it('defaults to the global window', () => {
    const w = fakeWindow();
    vi.stubGlobal('window', w.win);
    const source = createBrowserSystemEventsSource();
    const off = source.onAny(() => {});
    expect(w.count('pagehide')).toBe(1);
    off();
  });
});
