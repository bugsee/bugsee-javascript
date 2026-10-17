import type { SystemEvent } from '@bugsee/capture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrowserSystemEventsEnv, createBrowserSystemEventsSource } from './system-events';
import { PageLifecycleTracker } from './trackers/page-lifecycle-tracker';

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

  it('blocked host globals (window / document / screen getters that throw) never throw out of the factory', () => {
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const key of ['window', 'document', 'screen']) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        configurable: true,
        get(): never {
          throw new Error(`${key} blocked`);
        },
      });
    }
    try {
      let source: ReturnType<typeof createBrowserSystemEventsSource> | undefined;
      expect(() => {
        source = createBrowserSystemEventsSource({});
      }).not.toThrow();
      const events: SystemEvent[] = [];
      const off = source?.on('event', (e) => events.push(e));
      expect(events.map((e) => e.name)).toEqual(['process_started']);
      off?.();
    } finally {
      for (const [key, d] of originals) {
        if (d !== undefined) Object.defineProperty(globalThis, key, d);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
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

  it('subscribes to an injected shared lifecycle tracker instead of attaching its own listeners', () => {
    const { env, win, doc } = fakeEnv();
    const lifecycle = new PageLifecycleTracker({ window: win, document: env.document as never });
    const a = activate({ ...env, lifecycle });
    const b = activate({ ...env, lifecycle });
    // two sources over ONE tracker → one listener per type
    expect(win.count('online')).toBe(1);
    expect(doc.count('visibilitychange')).toBe(1);
    win.emit('offline', {});
    expect(a.events.at(-1)).toEqual({ name: 'offline' });
    expect(b.events.at(-1)).toEqual({ name: 'offline' });
    a.off();
    expect(win.count('offline')).toBe(1); // still held by the other source
    b.off();
    expect(win.count('offline')).toBe(0);
  });

  it('reports a lifecycle failure to the injected onError, not into event dispatch', () => {
    const { env, win, doc } = fakeEnv();
    const onError = vi.fn();
    Object.defineProperty(env.document, 'visibilityState', {
      get(): never {
        throw new Error('getter');
      },
    });
    const { off } = activate({ ...env, onError });
    expect(() => doc.emit('visibilitychange', {})).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(win.count('pagehide')).toBe(1);
    off();
  });

  it('over a shared tracker, re-subscribing after a full release re-emits process_started and resubscribes', () => {
    const { env, win } = fakeEnv();
    const lifecycle = new PageLifecycleTracker({ window: win, document: env.document as never });
    const source = createBrowserSystemEventsSource({ ...env, lifecycle });
    const events: SystemEvent[] = [];
    const first = source.onAny((_s, e) => events.push(e));
    first();
    expect(win.count('online')).toBe(0);
    const second = source.onAny((_s, e) => events.push(e));
    win.emit('online', {});
    expect(events).toEqual([
      { name: 'process_started' },
      { name: 'process_started' },
      { name: 'online' },
    ]);
    second();
  });
});
