import type { SystemEvent } from '@bugsee/capture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrowserSystemEventsEnv, createBrowserSystemEventsSource } from './system-events';

afterEach(() => {
  vi.unstubAllGlobals();
});

function target() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    addEventListener(type: string, listener: (event: Event) => void) {
      const set = listeners.get(type) ?? new Set<(event: Event) => void>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
    emit(type: string, event: unknown) {
      for (const l of listeners.get(type) ?? []) {
        l(event as Event);
      }
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

function fakeEnv() {
  const win = target();
  const doc = target();
  const state = { visibilityState: 'visible' as DocumentVisibilityState };
  const orientation = { type: 'portrait-primary' as OrientationType, angle: 0 };
  const document = {
    addEventListener: doc.addEventListener,
    removeEventListener: doc.removeEventListener,
    get visibilityState() {
      return state.visibilityState;
    },
  };
  const env: BrowserSystemEventsEnv = { window: win, document, screen: { orientation } };
  return { env, win, doc, state, orientation };
}

function activate(env: BrowserSystemEventsEnv) {
  const source = createBrowserSystemEventsSource(env);
  const events: SystemEvent[] = [];
  const off = source.onAny((_stage, event) => events.push(event)); // subscribing activates the source
  return { events, off };
}

describe('createBrowserSystemEventsSource', () => {
  it('emits process_started and registers every lifecycle listener on activate', () => {
    const { env, win, doc } = fakeEnv();
    const { events } = activate(env);
    expect(events).toEqual([{ name: 'process_started' }]);
    expect(win.count('pagehide')).toBe(1);
    expect(win.count('online')).toBe(1);
    expect(win.count('offline')).toBe(1);
    expect(win.count('orientationchange')).toBe(1);
    expect(doc.count('visibilitychange')).toBe(1);
  });

  it('emits process_exiting with the pagehide persisted flag', () => {
    const { env, win } = fakeEnv();
    const { events } = activate(env);
    win.emit('pagehide', { persisted: true });
    win.emit('pagehide', { persisted: false });
    expect(events.slice(1)).toEqual([
      { name: 'process_exiting', params: { persisted: true } },
      { name: 'process_exiting', params: { persisted: false } },
    ]);
  });

  it('maps visibilitychange to process_background / process_foreground from visibilityState', () => {
    const { env, doc, state } = fakeEnv();
    const { events } = activate(env);
    state.visibilityState = 'hidden';
    doc.emit('visibilitychange', {});
    state.visibilityState = 'visible';
    doc.emit('visibilitychange', {});
    expect(events.slice(1)).toEqual([
      { name: 'process_background' },
      { name: 'process_foreground' },
    ]);
  });

  it('emits online / offline on connectivity transitions', () => {
    const { env, win } = fakeEnv();
    const { events } = activate(env);
    win.emit('online', {});
    win.emit('offline', {});
    expect(events.slice(1)).toEqual([{ name: 'online' }, { name: 'offline' }]);
  });

  it('emits orientation_changed with the current screen orientation type + angle', () => {
    const { env, win, orientation } = fakeEnv();
    const { events } = activate(env);
    orientation.type = 'landscape-primary';
    orientation.angle = 90;
    win.emit('orientationchange', {});
    expect(events.slice(1)).toEqual([
      { name: 'orientation_changed', params: { type: 'landscape-primary', angle: 90 } },
    ]);
  });

  it('removes every listener on deactivate (last subscriber gone)', () => {
    const { env, win, doc } = fakeEnv();
    const { off } = activate(env);
    off();
    expect(win.count('pagehide')).toBe(0);
    expect(win.count('online')).toBe(0);
    expect(win.count('offline')).toBe(0);
    expect(win.count('orientationchange')).toBe(0);
    expect(doc.count('visibilitychange')).toBe(0);
  });

  it('degrades gracefully when document is absent (no visibility events/listener)', () => {
    const { win } = fakeEnv();
    const { events, off } = activate({ window: win, document: undefined, screen: undefined });
    expect(events).toEqual([{ name: 'process_started' }]); // still starts
    win.emit('orientationchange', {}); // no screen → orientation_changed carries no params
    expect(events.slice(1)).toEqual([{ name: 'orientation_changed' }]);
    off();
  });

  it('emits only process_started when no window/document/screen is available (non-DOM context)', () => {
    // env defaults to the (absent) node globals → the source activates but registers nothing.
    const source = createBrowserSystemEventsSource();
    const events: SystemEvent[] = [];
    source.onAny((_stage, event) => events.push(event));
    expect(events).toEqual([{ name: 'process_started' }]);
  });

  it('defaults to the global window/document/screen', () => {
    const win = target();
    const doc = target();
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', { ...doc, visibilityState: 'visible' });
    vi.stubGlobal('screen', { orientation: { type: 'portrait-primary', angle: 0 } });
    const source = createBrowserSystemEventsSource();
    const off = source.onAny(() => {});
    expect(win.count('pagehide')).toBe(1);
    expect(doc.count('visibilitychange')).toBe(1);
    off();
  });
});
