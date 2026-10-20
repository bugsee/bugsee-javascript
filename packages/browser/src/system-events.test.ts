import type { SystemEvent } from '@bugsee/capture';
import { createMultiKeyEmitter } from '@bugsee/trackers';
import {
  ApplicationTracker,
  type EnvironmentEvents,
  resetApplicationTracker,
  resetEnvironmentTracker,
} from '@bugsee/trackers/browser';
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

// The environment tracker has its own listeners (languagechange, visibilitychange); tests of the LIFECYCLE wiring
// inject an inert one so they count only the lifecycle's. The environment events are tested separately below.
const inertEnvironment = { onAny: () => () => {} };

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
  const env: BrowserSystemEventsEnv = {
    window: win,
    document,
    screen: { orientation },
    environment: inertEnvironment as never,
  };
  return { env, win, doc, state, orientation };
}

function activate(env: BrowserSystemEventsEnv) {
  const source = createBrowserSystemEventsSource(env);
  const events: SystemEvent[] = [];
  const off = source.onAny((_stage, event) => events.push(event)); // subscribing activates the source
  return { events, off };
}

function fakeMedia(initial = false) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const queries: string[] = [];
  const list = {
    matches: initial,
    addEventListener: (_t: string, l: (e: { matches: boolean }) => void) => void listeners.add(l),
    removeEventListener: (_t: string, l: (e: { matches: boolean }) => void) =>
      void listeners.delete(l),
  };
  return {
    matchMedia: (q: string) => {
      queries.push(q);
      return list;
    },
    fire: (matches: boolean) => {
      for (const l of [...listeners]) l({ matches });
    },
    fireRaw: (e: { matches: boolean }) => {
      for (const l of [...listeners]) l(e);
    },
    count: () => listeners.size,
    queries,
  };
}

describe('createBrowserSystemEventsSource: dark mode, freeze and resume', () => {
  it('records dark_mode_changed with the new state from the injected matchMedia', () => {
    const { env } = fakeEnv();
    const m = fakeMedia();
    const { events } = activate({ ...env, matchMedia: m.matchMedia });
    expect(m.queries).toEqual(['(prefers-color-scheme: dark)']);
    m.fire(true);
    m.fire(false);
    expect(events.filter((e) => e.name === 'dark_mode_changed')).toEqual([
      { name: 'dark_mode_changed', params: { dark: true } },
      { name: 'dark_mode_changed', params: { dark: false } },
    ]);
  });

  it('removes the media listener on deactivate', () => {
    const { env } = fakeEnv();
    const m = fakeMedia();
    const { off } = activate({ ...env, matchMedia: m.matchMedia });
    expect(m.count()).toBe(1);
    off();
    expect(m.count()).toBe(0);
  });

  it('without matchMedia (a WindowEvents fake) the source still starts and emits no dark-mode event', () => {
    const { env } = fakeEnv();
    const { events } = activate(env);
    expect(events.map((e) => e.name)).toEqual(['process_started']);
  });

  it('a matchMedia that throws is reported and does not abort the other signals', () => {
    const { env, win } = fakeEnv();
    const errors: unknown[] = [];
    const { events } = activate({
      ...env,
      matchMedia: () => {
        throw new Error('matchMedia blocked');
      },
      onError: (e) => errors.push(e),
    });
    win.emit('online', {});
    expect(events.map((e) => e.name)).toEqual(['process_started', 'online']);
    expect(errors.map((e) => (e as Error).message)).toEqual(['matchMedia blocked']);
  });

  it('a media list without addEventListener is a plain absence: skipped silently, other signals unaffected', () => {
    const { env, win } = fakeEnv();
    const errors: unknown[] = [];
    const { events } = activate({
      ...env,
      matchMedia: (() => ({ matches: false })) as never,
      onError: (e) => errors.push(e),
    });
    win.emit('online', {});
    expect(events.map((e) => e.name)).toEqual(['process_started', 'online']);
    expect(errors).toEqual([]);
  });

  it('a change event whose matches getter throws is reported, never thrown into the browser dispatch', () => {
    const { env } = fakeEnv();
    const m = fakeMedia();
    const errors: unknown[] = [];
    const { events } = activate({
      ...env,
      matchMedia: m.matchMedia,
      onError: (e) => errors.push(e),
    });
    const hostile = {};
    Object.defineProperty(hostile, 'matches', {
      get(): never {
        throw new Error('matches blocked');
      },
    });
    expect(() => m.fireRaw(hostile as { matches: boolean })).not.toThrow();
    expect((errors[0] as Error).message).toBe('matches blocked');
    expect(events.map((e) => e.name)).toEqual(['process_started']);
  });

  it('records freeze and resume from the document (not the window)', () => {
    const { env, win, doc } = fakeEnv();
    const { events } = activate(env);
    win.emit('freeze', {});
    expect(events.map((e) => e.name)).toEqual(['process_started']);
    doc.emit('freeze', {});
    doc.emit('resume', {});
    expect(events.map((e) => e.name)).toEqual(['process_started', 'freeze', 'resume']);
  });
});

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
      // the failures are reported (each global read once), not swallowed silently
      const errors: unknown[] = [];
      createBrowserSystemEventsSource({ onError: (e) => errors.push(e) });
      expect(errors.map((e) => (e as Error).message).sort()).toEqual([
        'document blocked',
        'screen blocked',
        'window blocked',
      ]);
      // a supplied lifecycle AND environment own the window/document: they are not read (or reported) again
      const none: unknown[] = [];
      createBrowserSystemEventsSource({
        lifecycle: { on: () => () => {} },
        environment: inertEnvironment as never,
        onError: (e) => none.push(e),
      });
      expect(none.map((e) => (e as Error).message)).toEqual(['screen blocked']); // only screen is still read
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
    // the lifecycle tracker's listener AND the environment tracker's (time-zone re-read on visible)
    expect(doc.count('visibilitychange')).toBe(2);
    expect(win.count('languagechange')).toBe(1);
    off();
    expect(doc.count('visibilitychange')).toBe(0);
    expect(win.count('languagechange')).toBe(0);
  });

  it('without an injected tracker, two sources over the same document share the registry singleton (one listener set)', () => {
    const { env, win, doc } = fakeEnv();
    const a = activate({ ...env, window: win as never });
    const b = activate({ ...env, window: win as never });
    expect(doc.count('visibilitychange')).toBe(1);
    a.off();
    expect(doc.count('visibilitychange')).toBe(1);
    b.off();
    expect(doc.count('visibilitychange')).toBe(0);
    resetApplicationTracker({ document: env.document as never });
  });

  it('an injected window without a document never borrows the host document (nor binds its singleton)', () => {
    const hostWin = target();
    const hostDoc = target();
    vi.stubGlobal('window', hostWin);
    vi.stubGlobal('document', { ...hostDoc, visibilityState: 'visible' });
    const injected = target();
    const off = createBrowserSystemEventsSource({ window: injected as never }).onAny(() => {});
    expect(injected.count('pagehide')).toBe(1);
    expect(hostDoc.count('visibilitychange')).toBe(0);
    expect(hostWin.count('pagehide')).toBe(0);
    off();
  });

  it('an injected document without a window never borrows the host window', () => {
    const hostWin = target();
    vi.stubGlobal('window', hostWin);
    const doc = target();
    const off = createBrowserSystemEventsSource({
      document: { ...doc, visibilityState: 'visible' } as never,
    }).onAny(() => {});
    expect(hostWin.count('pagehide')).toBe(0);
    off();
  });

  it('subscribes to an injected shared lifecycle tracker instead of attaching its own listeners', () => {
    const { env, win, doc } = fakeEnv();
    const lifecycle = new ApplicationTracker({ window: win, document: env.document as never });
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
    expect(onError).toHaveBeenCalledTimes(2); // the activation read + the event read, each reported once
    expect(win.count('pagehide')).toBe(1);
    off();
  });

  it('over a shared tracker, re-subscribing after a full release re-emits process_started and resubscribes', () => {
    const { env, win } = fakeEnv();
    const lifecycle = new ApplicationTracker({ window: win, document: env.document as never });
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

  describe('environment events', () => {
    const lifecycleStub = { on: () => () => {} };

    it('maps the language / timezone stages to language_changed / timezone_changed, omitting unknown fields', () => {
      const environment = createMultiKeyEmitter<EnvironmentEvents>();
      const { events } = activate({ lifecycle: lifecycleStub as never, environment });
      environment.emit('language', {
        language: 'uk-UA',
        languages: ['uk-UA', 'en'],
        previous: { language: 'en-US' },
      });
      environment.emit('language', { languages: ['fr'], previous: {} });
      environment.emit('timezone', {
        timeZone: 'Asia/Tokyo',
        utcOffsetMinutes: 540,
        previous: { timeZone: 'Europe/Kyiv', utcOffsetMinutes: 120 },
      });
      environment.emit('timezone', { utcOffsetMinutes: 60, previous: {} });
      expect(events.slice(1)).toStrictEqual([
        {
          name: 'language_changed',
          params: { language: 'uk-UA', languages: ['uk-UA', 'en'], previousLanguage: 'en-US' },
        },
        { name: 'language_changed', params: { languages: ['fr'] } },
        {
          name: 'timezone_changed',
          params: {
            timezone: 'Asia/Tokyo',
            utcOffsetMinutes: 540,
            previousTimezone: 'Europe/Kyiv',
            previousUtcOffsetMinutes: 120,
          },
        },
        { name: 'timezone_changed', params: { utcOffsetMinutes: 60 } },
      ]);
    });

    it('private_mode_detected only for a yes answer (never for no / unknown), with the method', () => {
      const environment = createMultiKeyEmitter<EnvironmentEvents>();
      const { events } = activate({ lifecycle: lifecycleStub as never, environment });
      environment.emit('privateMode', { private: 'no', method: 'storage-quota' });
      environment.emit('privateMode', { private: 'unknown' });
      expect(events.slice(1)).toEqual([]);
      environment.emit('privateMode', { private: 'yes', method: 'storage-quota' });
      environment.emit('privateMode', { private: 'yes' });
      expect(events.slice(1)).toEqual([
        { name: 'private_mode_detected', params: { method: 'storage-quota' } },
        { name: 'private_mode_detected', params: {} },
      ]);
    });

    it('a language AND time-zone change while the source was stopped are BOTH reported on restart', () => {
      const { env, win } = fakeEnv();
      const { environment: _inert, ...rest } = env;
      const nav = { language: 'en-US' };
      Object.assign(win, { navigator: nav });
      const real = new Date().getTimezoneOffset();
      try {
        const first = activate({ ...rest, lifecycle: lifecycleStub as never });
        first.off(); // the tracker retains its readings
        nav.language = 'de-DE';
        vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(real - 60);
        const second = activate({ ...rest, lifecycle: lifecycleStub as never });
        expect(second.events.map((e) => e.name)).toEqual([
          'process_started',
          'language_changed',
          'timezone_changed',
        ]);
        second.off();
      } finally {
        vi.restoreAllMocks();
        resetEnvironmentTracker({ window: win });
      }
    });

    it('stops listening to the environment tracker on deactivate', () => {
      const environment = createMultiKeyEmitter<EnvironmentEvents>();
      const { events, off } = activate({ lifecycle: lifecycleStub as never, environment });
      off();
      environment.emit('language', { language: 'x', previous: {} });
      expect(events).toEqual([{ name: 'process_started' }]);
    });

    it('over the window singleton: a real languagechange and a time-zone tick become events; private mode is opt-in', async () => {
      const { env, win } = fakeEnv();
      const { environment: _inert, ...rest } = env;
      const nav = {
        language: 'en-US',
        storage: { estimate: vi.fn(() => Promise.resolve({ quota: 10 })) },
      };
      Object.assign(win, { navigator: nav });
      const noTick = () => {};
      let tick: () => void = noTick;
      const scheduler = {
        setInterval: (cb: () => void) => {
          tick = cb;
          return 1;
        },
        clearInterval: () => {},
      };
      try {
        // default: language/timezone on, private mode off
        const a = activate({ ...rest, lifecycle: lifecycleStub as never, scheduler });
        nav.language = 'de-DE';
        win.emit('languagechange', {});
        expect(a.events.map((e) => e.name)).toEqual(['process_started', 'language_changed']);
        expect(nav.storage.estimate).not.toHaveBeenCalled();
        a.off();
        resetEnvironmentTracker({ window: win });
        // opted in: a yes answer is an event
        const b = activate({
          ...rest,
          lifecycle: lifecycleStub as never,
          scheduler,
          detectPrivateMode: true,
        });
        await new Promise((r) => setTimeout(r, 0));
        expect(b.events.at(-1)).toEqual({
          name: 'private_mode_detected',
          params: { method: 'storage-quota' },
        });
        expect(tick).not.toBe(noTick); // the injected scheduler reached the singleton's slow timer
        const before = b.events.length;
        const real = new Date().getTimezoneOffset();
        vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(real - 60); // zone moved 1 h east
        tick();
        expect(b.events.slice(before)).toEqual([
          {
            name: 'timezone_changed',
            params: {
              timezone: expect.any(String),
              utcOffsetMinutes: -(real - 60) + 0,
              previousTimezone: expect.any(String),
              previousUtcOffsetMinutes: -real + 0,
            },
          },
        ]);
        b.off();
      } finally {
        vi.restoreAllMocks();
        resetEnvironmentTracker({ window: win });
      }
    });
  });
});
