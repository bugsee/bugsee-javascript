import type { SystemEvent } from '@bugsee/capture';
import { EventName, eventParamProblems } from '@bugsee/protocol';
import { createMultiKeyEmitter, MultiKeyEmitterBase } from '@bugsee/trackers';
import {
  ApplicationTracker,
  connectivityTrackerFor,
  type EnvironmentEvents,
  environmentTrackerFor,
  resetApplicationTracker,
  resetConnectivityTracker,
  resetEnvironmentTracker,
} from '@bugsee/trackers/browser';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BrowserSystemEventsEnv, createBrowserSystemEventsSource } from './system-events';

const EXPECTED_EVENTS: readonly string[] = [
  EventName.PROCESS_STARTED,
  EventName.PROCESS_EXITING,
  EventName.APPLICATION_DID_BECOME_ACTIVE,
  EventName.APPLICATION_DID_ENTER_BACKGROUND,
  EventName.FREEZE,
  EventName.RESUME,
  EventName.ORIENTATION_CHANGED,
  EventName.DARK_MODE_CHANGED,
  EventName.DISPLAY_MODE_CHANGED,
  EventName.ONLINE,
  EventName.OFFLINE,
  EventName.LANGUAGE_CHANGED,
  EventName.TIMEZONE_CHANGED,
  EventName.PRIVATE_MODE_DETECTED,
];

// REGISTRY CONFORMANCE (code vs EVENT_PARAMS): every system event any test in this file makes the source emit is checked
// against the registry (no unregistered param key, no missing required key), and the family's events must ALL have been
// seen, so a renamed/dropped param or a silently dead event fails here and not in production.
const emittedEvents: SystemEvent[] = [];
const seenEventNames = new Set<string>();
let emitSpy: { mockRestore(): void } | undefined;
beforeEach(() => {
  const proto = MultiKeyEmitterBase.prototype as unknown as {
    emit(stage: string, payload: unknown): void;
  };
  const real = proto.emit;
  emitSpy = vi.spyOn(proto, 'emit').mockImplementation(function (
    this: unknown,
    stage: string,
    payload: unknown,
  ) {
    if (stage === 'event') emittedEvents.push(payload as SystemEvent);
    return real.call(this, stage, payload);
  });
});
afterEach(() => {
  emitSpy?.mockRestore();
  const problems = emittedEvents.flatMap((e) => eventParamProblems(e.name, e.params));
  for (const e of emittedEvents) seenEventNames.add(e.name);
  emittedEvents.length = 0;
  expect(problems).toEqual([]);
});
afterAll(() => {
  expect(EXPECTED_EVENTS.filter((n) => !seenEventNames.has(n))).toEqual([]);
});

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
  // `connect(false)` goes offline and announces it, as a browser does (the online/offline EVENTS do not read onLine).
  const nav = { onLine: true };
  const connect = (online: boolean) => {
    nav.onLine = online;
    win.emit(online ? 'online' : 'offline', {});
  };
  const document = {
    addEventListener: doc.addEventListener,
    removeEventListener: doc.removeEventListener,
    get visibilityState() {
      return state.visibilityState;
    },
  };
  const env: BrowserSystemEventsEnv = {
    window: Object.assign(win, { navigator: nav }),
    document,
    screen: { orientation },
    environment: inertEnvironment as never,
  };
  return { env, win, doc, state, orientation, nav, connect };
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

// One media list PER query, so display-mode (three queries) can be driven the way a browser answers it.
function fakeQueries(matching: Record<string, boolean> = {}) {
  const lists = new Map<
    string,
    { matches: boolean; listeners: Set<(e: { matches: boolean }) => void> }
  >();
  const list = (q: string) => {
    let l = lists.get(q);
    if (l === undefined) {
      l = { matches: matching[q] ?? false, listeners: new Set() };
      lists.set(q, l);
    }
    return l;
  };
  return {
    matchMedia: (q: string) => {
      const l = list(q);
      return {
        get matches() {
          return l.matches;
        },
        addEventListener: (_t: string, fn: (e: { matches: boolean }) => void) =>
          void l.listeners.add(fn),
        removeEventListener: (_t: string, fn: (e: { matches: boolean }) => void) =>
          void l.listeners.delete(fn),
      };
    },
    /** The page enters `mode` ('browser' = none of the three): flip the queries and notify the changed ones. */
    enter: (mode: 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser') => {
      const changed: Array<ReturnType<typeof list>> = [];
      for (const m of ['fullscreen', 'standalone', 'minimal-ui']) {
        const l = list(`(display-mode: ${m})`);
        const next = m === mode;
        if (l.matches === next) continue;
        l.matches = next;
        changed.push(l);
      }
      // the browser settles ALL the queries before any listener runs
      for (const l of changed) for (const fn of [...l.listeners]) fn({ matches: l.matches });
    },
    /** One query flips (e.g. `(prefers-color-scheme: dark)`) and its listeners are told. */
    set: (q: string, matches: boolean) => {
      const l = list(q);
      l.matches = matches;
      for (const fn of [...l.listeners]) fn({ matches });
    },
    listenerCount: () => [...lists.values()].reduce((n, l) => n + l.listeners.size, 0),
  };
}

describe('createBrowserSystemEventsSource: display_mode_changed', () => {
  it('never announces a mode equal to the one it already knows (a re-baselined tracker re-announcing), then still follows real changes', () => {
    const { env } = fakeEnv();
    let announce: ((state: { mode: string }) => void) | undefined;
    const ui = {
      current: () => ({ mode: 'standalone' }),
      on: (stage: string, cb: (state: never) => void) => {
        if (stage === 'displayMode') announce = cb as never;
        return () => {};
      },
    };
    const { events } = activate({ ...env, ui: ui as never });
    announce?.({ mode: 'standalone' });
    expect(events).toEqual([{ name: 'process_started' }]);
    announce?.({ mode: 'browser' });
    announce?.({ mode: 'browser' });
    expect(events.slice(1)).toEqual([
      { name: 'display_mode_changed', params: { mode: 'browser', previousMode: 'standalone' } },
    ]);
  });

  it('records display_mode_changed with the new mode and the previous one', () => {
    const { env } = fakeEnv();
    const q = fakeQueries();
    const { events } = activate({ ...env, matchMedia: q.matchMedia });
    q.enter('standalone');
    q.enter('fullscreen');
    q.enter('browser');
    expect(events.filter((e) => e.name === 'display_mode_changed')).toEqual([
      { name: 'display_mode_changed', params: { mode: 'standalone', previousMode: 'browser' } },
      { name: 'display_mode_changed', params: { mode: 'fullscreen', previousMode: 'standalone' } },
      { name: 'display_mode_changed', params: { mode: 'browser', previousMode: 'fullscreen' } },
    ]);
  });

  it('starts from the mode the page is already in (the baseline is state, not an event)', () => {
    const { env } = fakeEnv();
    const q = fakeQueries({ '(display-mode: standalone)': true });
    const { events } = activate({ ...env, matchMedia: q.matchMedia });
    expect(events).toEqual([{ name: 'process_started' }]);
    q.enter('minimal-ui');
    expect(events.at(-1)).toEqual({
      name: 'display_mode_changed',
      params: { mode: 'minimal-ui', previousMode: 'standalone' },
    });
  });

  it('is not announced twice for the same mode (several queries flip for one transition)', () => {
    const { env } = fakeEnv();
    const q = fakeQueries({ '(display-mode: standalone)': true });
    const { events } = activate({ ...env, matchMedia: q.matchMedia });
    q.enter('fullscreen'); // standalone goes false AND fullscreen goes true: two query changes, one transition
    expect(events.filter((e) => e.name === 'display_mode_changed')).toHaveLength(1);
  });

  it('omits previousMode when the mode before could not be read', () => {
    const { env } = fakeEnv();
    const lists: Array<(e: { matches: boolean }) => void> = [];
    let readable = false;
    const matchMedia = (q: string) => ({
      get matches(): boolean {
        // standalone is the only answer once readable; before that the query is unreadable (not a boolean)
        return (readable ? q.includes('standalone') : undefined) as never;
      },
      addEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => void lists.push(fn),
      removeEventListener: () => {},
    });
    const { events } = activate({ ...env, matchMedia });
    readable = true;
    for (const fn of lists) fn({ matches: true });
    expect(events.at(-1)).toStrictEqual({
      name: 'display_mode_changed',
      params: { mode: 'standalone' },
    });
  });

  it('subscribes lazily, goes through the per-window UiTracker, and releases on deactivate', () => {
    const { env } = fakeEnv();
    const q = fakeQueries();
    const source = createBrowserSystemEventsSource({ ...env, matchMedia: q.matchMedia });
    expect(q.listenerCount()).toBe(0); // built, not subscribed
    const off = source.onAny(() => {});
    expect(q.listenerCount()).toBe(4); // display-mode: fullscreen + standalone + minimal-ui, and prefers-color-scheme
    off();
    expect(q.listenerCount()).toBe(0);
  });

  it('emits nothing without matchMedia', () => {
    const { env } = fakeEnv();
    const { events } = activate(env);
    expect(events.map((e) => e.name)).not.toContain('display_mode_changed');
  });

  it('a hostile matchMedia (throws / non-boolean / null list) is reported and emits nothing', () => {
    for (const matchMedia of [
      () => {
        throw new Error('blocked');
      },
      () => null,
      () => ({ matches: 'yes' }),
    ]) {
      const { env } = fakeEnv();
      const errors: unknown[] = [];
      const { events } = activate({
        ...env,
        matchMedia: matchMedia as never,
        onError: (e) => errors.push(e),
      });
      expect(events.map((e) => e.name)).toEqual(['process_started']);
    }
  });
});

describe('createBrowserSystemEventsSource: dark mode, freeze and resume', () => {
  it('records DarkModeChanged with the new state from the injected matchMedia', () => {
    const { env } = fakeEnv();
    const m = fakeMedia();
    const { events } = activate({ ...env, matchMedia: m.matchMedia });
    expect(new Set(m.queries)).toEqual(
      new Set([
        '(prefers-color-scheme: dark)',
        '(display-mode: fullscreen)',
        '(display-mode: standalone)',
        '(display-mode: minimal-ui)',
      ]),
    ); // baseline reads + watches, for dark mode and display mode
    m.fire(true);
    m.fire(false);
    expect(events.filter((e) => e.name === 'DarkModeChanged')).toEqual([
      { name: 'DarkModeChanged', params: { dark: true } },
      { name: 'DarkModeChanged', params: { dark: false } },
    ]);
  });

  it('a throwing onError never escapes into the tracker-fed event dispatch', () => {
    const { env, win, orientation } = fakeEnv();
    const m = fakeMedia();
    const { events } = activate({
      ...env,
      matchMedia: m.matchMedia,
      onError: () => {
        throw new Error('reporter');
      },
    });
    const source = createBrowserSystemEventsSource({
      ...env,
      matchMedia: m.matchMedia,
      onError: () => {
        throw new Error('reporter');
      },
    });
    source.on('event', () => {
      throw new Error('consumer');
    });
    orientation.type = 'landscape-primary';
    orientation.angle = 90;
    expect(() => win.emit('orientationchange', {})).not.toThrow();
    expect(events.map((e) => e.name)).toContain('OrientationChanged');
  });

  it('removes the media listener on deactivate', () => {
    const { env } = fakeEnv();
    const m = fakeMedia();
    const { off } = activate({ ...env, matchMedia: m.matchMedia });
    expect(m.count()).toBe(2); // the dark-mode listener and the display-mode one (one function over its three queries)
    off();
    expect(m.count()).toBe(0);
  });

  it('without matchMedia (a WindowEvents fake) the source still starts and emits no dark-mode event', () => {
    const { env } = fakeEnv();
    const { events } = activate(env);
    expect(events.map((e) => e.name)).toEqual(['process_started']);
  });

  it('a matchMedia that throws is reported and does not abort the other signals', () => {
    const { env, connect } = fakeEnv();
    const errors: unknown[] = [];
    const { events } = activate({
      ...env,
      matchMedia: () => {
        throw new Error('matchMedia blocked');
      },
      onError: (e) => errors.push(e),
    });
    connect(false);
    expect(events.map((e) => e.name)).toEqual(['process_started', 'offline']);
    expect(errors.length).toBeGreaterThan(0);
    expect(new Set(errors.map((e) => (e as Error).message))).toEqual(
      new Set(['matchMedia blocked']),
    );
  });

  it('a media list without addEventListener is a plain absence: skipped silently, other signals unaffected', () => {
    const { env, connect } = fakeEnv();
    const errors: unknown[] = [];
    const { events } = activate({
      ...env,
      matchMedia: (() => ({ matches: false })) as never,
      onError: (e) => errors.push(e),
    });
    connect(false);
    expect(events.map((e) => e.name)).toEqual(['process_started', 'offline']);
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
    expect(win.count('online')).toBe(1); // the ConnectivityTracker's
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

  it('maps visibilitychange to UIApplicationDidEnterBackgroundNotification / UIApplicationDidBecomeActiveNotification from visibilityState', () => {
    const { env, doc, state } = fakeEnv();
    const { events } = activate(env);
    state.visibilityState = 'hidden';
    doc.emit('visibilitychange', {});
    state.visibilityState = 'visible';
    doc.emit('visibilitychange', {});
    expect(events.slice(1)).toEqual([
      { name: 'UIApplicationDidEnterBackgroundNotification' },
      { name: 'UIApplicationDidBecomeActiveNotification' },
    ]);
  });

  it('does not re-announce a foreground/background the page is already in (duplicate visibilitychange)', () => {
    const { env, doc, state } = fakeEnv();
    const { events } = activate(env);
    // Startup state is visible: a synthetic/duplicate visibilitychange(visible) changes nothing.
    doc.emit('visibilitychange', {});
    expect(events.slice(1)).toEqual([]);
    state.visibilityState = 'hidden';
    doc.emit('visibilitychange', {});
    doc.emit('visibilitychange', {});
    state.visibilityState = 'visible';
    doc.emit('visibilitychange', {});
    doc.emit('visibilitychange', {});
    expect(events.slice(1)).toEqual([
      { name: 'UIApplicationDidEnterBackgroundNotification' },
      { name: 'UIApplicationDidBecomeActiveNotification' },
    ]);
  });

  it('a page hidden at launch: a duplicate hidden visibilitychange emits nothing beyond process_started', () => {
    const { env, doc, state } = fakeEnv();
    state.visibilityState = 'hidden';
    const { events } = activate(env);
    doc.emit('visibilitychange', {});
    doc.emit('visibilitychange', {});
    expect(events).toEqual([{ name: 'process_started' }]);
    state.visibilityState = 'visible';
    doc.emit('visibilitychange', {});
    expect(events.slice(1)).toEqual([{ name: 'UIApplicationDidBecomeActiveNotification' }]);
  });

  it('emits online / offline on connectivity transitions', () => {
    const { env, connect } = fakeEnv();
    const { events } = activate(env);
    connect(false);
    connect(true);
    expect(events.slice(1)).toEqual([{ name: 'offline' }, { name: 'online' }]);
  });

  it('the activation baseline is state, not a transition: nothing is emitted for it', () => {
    const { env, nav } = fakeEnv();
    nav.onLine = false; // already offline when capture starts
    const { events } = activate(env);
    expect(events).toEqual([{ name: 'process_started' }]);
  });

  it('one event per DOM event, the kind taken from the event type: a flap that reads onLine true on both is not lost', () => {
    const { env, win } = fakeEnv(); // navigator.onLine stays true throughout
    const { events } = activate(env);
    win.emit('offline', {});
    win.emit('online', {});
    win.emit('offline', {});
    win.emit('offline', {}); // a repeat / synthetic dispatch is still an event
    expect(events.slice(1).map((e) => e.name)).toEqual(['offline', 'online', 'offline', 'offline']);
  });

  it('an absent navigator.onLine (or no navigator) does not drop online/offline events', () => {
    const { env, win } = fakeEnv();
    Object.assign(win, { navigator: {} });
    const { events } = activate(env);
    win.emit('offline', {});
    expect(events.slice(1)).toEqual([{ name: 'offline' }]);
  });

  it('goes through the per-window ConnectivityTracker: ONE online/offline listener shared with other consumers', () => {
    const { env, win, nav } = fakeEnv();
    const other = connectivityTrackerFor({ window: win, navigator: nav });
    const offOther = other.on('online', () => {});
    expect(win.count('online')).toBe(1);
    const { off, events } = activate(env);
    expect(win.count('online')).toBe(1);
    expect(win.count('offline')).toBe(1);
    // joining an already-running tracker announces nothing
    expect(events).toEqual([{ name: 'process_started' }]);
    win.emit('online', {});
    expect(events.at(-1)).toEqual({ name: 'online' });
    off();
    expect(win.count('online')).toBe(1); // still held by the other consumer
    offOther();
    expect(win.count('online')).toBe(0);
    resetConnectivityTracker({ window: win });
  });

  it('an injected connectivity tracker replaces the window singleton', () => {
    const { env, win } = fakeEnv();
    const on = vi.fn(() => () => {});
    const { events } = activate({
      ...env,
      connectivity: { on } as never,
    });
    expect(on).toHaveBeenCalledWith('transition', expect.any(Function));
    expect(win.count('online')).toBe(0);
    expect(events).toEqual([{ name: 'process_started' }]);
  });

  it("a navigator injected explicitly is the one read (not the window's)", () => {
    const { env, win } = fakeEnv();
    const nav = { onLine: true };
    const { events } = activate({ ...env, navigator: nav });
    nav.onLine = false;
    win.emit('offline', {});
    expect(events.slice(1)).toEqual([{ name: 'offline' }]);
    resetConnectivityTracker({ window: win });
  });

  it('a window whose navigator getter throws still announces online/offline (the event type is the evidence) and never throws', () => {
    const { env, win } = fakeEnv();
    Object.defineProperty(win, 'navigator', {
      get(): never {
        throw new Error('navigator blocked');
      },
    });
    const errors: unknown[] = [];
    const { events } = activate({ ...env, onError: (e) => errors.push(e) });
    expect(() => win.emit('offline', {})).not.toThrow();
    expect(events.slice(1)).toEqual([{ name: 'offline' }]);
    expect(errors.length).toBeGreaterThan(0); // the unreadable navigator is reported once
  });

  it('emits OrientationChanged with the current screen orientation type + angle', () => {
    const { env, win, orientation } = fakeEnv();
    const { events } = activate(env);
    orientation.type = 'landscape-primary';
    orientation.angle = 90;
    win.emit('orientationchange', {});
    expect(events.slice(1)).toEqual([
      {
        name: 'OrientationChanged',
        params: { current: 3, prev: 1, type: 'landscape-primary', angle: 90 },
      },
    ]);
    // `prev` is the value this source last announced, tracked across changes.
    orientation.type = 'portrait-primary';
    orientation.angle = 0;
    win.emit('orientationchange', {});
    expect(events.at(-1)).toEqual({
      name: 'OrientationChanged',
      params: { current: 1, prev: 3, type: 'portrait-primary', angle: 0 },
    });
  });

  it('OrientationChanged omits prev when the orientation before was unreadable, and keeps it across a bare event', () => {
    const { env, win } = fakeEnv();
    const screen: { orientation?: { type: OrientationType; angle: number } } = {};
    const { events } = activate({ ...env, screen });
    screen.orientation = { type: 'landscape-secondary', angle: 270 };
    win.emit('orientationchange', {});
    expect(events.at(-1)).toEqual({
      name: 'OrientationChanged',
      params: { current: 4, type: 'landscape-secondary', angle: 270 },
    });
    delete screen.orientation;
    win.emit('orientationchange', {}); // a bare event: no params, and the known orientation stays 4
    expect(events.at(-1)).toEqual({ name: 'OrientationChanged' });
    screen.orientation = { type: 'portrait-primary', angle: 0 };
    win.emit('orientationchange', {});
    expect(events.at(-1)).toEqual({
      name: 'OrientationChanged',
      params: { current: 1, prev: 4, type: 'portrait-primary', angle: 0 },
    });
  });

  it('OrientationChanged is announced only when the Android orientation int really changed (a raw {type, angle} change that maps to the same int is silent)', () => {
    const { env, win } = fakeEnv();
    const { events } = activate(env);
    const at = (orientation: { type: string; angle: number } | undefined) => {
      (env.screen as { orientation?: unknown }).orientation = orientation;
      win.emit('orientationchange', {});
    };
    at(undefined); // bare
    at({ type: 'portrait-primary', angle: 0 }); // the tracker already knows it: nothing
    at({ type: 'portrait-primary', angle: 180 }); // the raw state changed but the Android int (1) did not: no event
    expect(events.slice(1)).toEqual([{ name: 'OrientationChanged' }]);
    at({ type: 'portrait-secondary', angle: 180 }); // a 180-degree flip is a different int (1 -> 2)
    expect(events.at(-1)).toEqual({
      name: 'OrientationChanged',
      params: { current: 2, prev: 1, type: 'portrait-secondary', angle: 180 },
    });
    at({ type: 'portrait-secondary', angle: 180 }); // unchanged again
    expect(events).toHaveLength(3);
  });

  it('OrientationChanged is bare when only one of type / angle is readable (never a half-built current)', () => {
    const { env, win } = fakeEnv();
    const screen = {
      orientation: { type: 'portrait-primary', angle: 0 } as Record<string, unknown>,
    };
    const { events } = activate({ ...env, screen: screen as never });
    screen.orientation = { type: 'landscape-primary', angle: Number.NaN }; // type only
    win.emit('orientationchange', {});
    expect(events.at(-1)).toEqual({ name: 'OrientationChanged' });
    screen.orientation = { type: 5, angle: 90 }; // angle only
    win.emit('orientationchange', {});
    expect(events.at(-1)).toEqual({ name: 'OrientationChanged' });
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
      // a supplied lifecycle AND environment own the DOCUMENT (not read again); the window is still read for the UI tracker
      const none: unknown[] = [];
      createBrowserSystemEventsSource({
        lifecycle: { on: () => () => {} },
        environment: inertEnvironment as never,
        onError: (e) => none.push(e),
      });
      expect(none.map((e) => (e as Error).message)).toEqual(['window blocked', 'screen blocked']);
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
    win.emit('orientationchange', {}); // no screen → OrientationChanged carries no params
    expect(events.slice(1)).toEqual([{ name: 'OrientationChanged' }]);
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

  it('without an injected window the UI tracker gets the host window (and its screen), like the lifecycle tracker', () => {
    const win = target();
    const screen = { orientation: { type: 'portrait-primary', angle: 0 } };
    vi.stubGlobal('window', win);
    vi.stubGlobal('screen', screen);
    const source = createBrowserSystemEventsSource();
    const events: SystemEvent[] = [];
    const off = source.onAny((_s, e) => events.push(e));
    expect(win.count('orientationchange')).toBe(1);
    screen.orientation = { type: 'landscape-primary', angle: 90 };
    win.emit('orientationchange', {});
    expect(events.at(-1)).toEqual({
      name: 'OrientationChanged',
      params: { current: 3, prev: 1, type: 'landscape-primary', angle: 90 },
    });
    off();
    expect(win.count('orientationchange')).toBe(0);
  });

  it('an injected window never borrows the host window or screen', () => {
    const hostWin = target();
    vi.stubGlobal('window', hostWin);
    vi.stubGlobal('screen', { orientation: { type: 'portrait-primary', angle: 0 } });
    const injected = target();
    const { events, off } = activate({ window: injected as never });
    expect(hostWin.count('orientationchange')).toBe(0);
    injected.emit('orientationchange', {});
    expect(events.at(-1)).toEqual({ name: 'OrientationChanged' }); // the host's screen was not used
    off();
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
    const { env, win, doc, connect } = fakeEnv();
    const lifecycle = new ApplicationTracker({ window: win, document: env.document as never });
    const a = activate({ ...env, lifecycle });
    const b = activate({ ...env, lifecycle });
    // two sources over ONE tracker → one listener per type
    expect(win.count('pagehide')).toBe(1);
    expect(win.count('online')).toBe(1); // ConnectivityTracker, shared per window
    expect(doc.count('visibilitychange')).toBe(1);
    connect(false);
    expect(a.events.at(-1)).toEqual({ name: 'offline' });
    expect(b.events.at(-1)).toEqual({ name: 'offline' });
    a.off();
    expect(win.count('offline')).toBe(1); // still held by the other source
    b.off();
    expect(win.count('offline')).toBe(0);
    expect(win.count('pagehide')).toBe(0);
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
    const { env, win, connect } = fakeEnv();
    const lifecycle = new ApplicationTracker({ window: win, document: env.document as never });
    const source = createBrowserSystemEventsSource({ ...env, lifecycle });
    const events: SystemEvent[] = [];
    const first = source.onAny((_s, e) => events.push(e));
    first();
    expect(win.count('online')).toBe(0);
    const second = source.onAny((_s, e) => events.push(e));
    connect(false);
    expect(events).toEqual([
      { name: 'process_started' },
      { name: 'process_started' },
      { name: 'offline' },
    ]);
    second();
  });

  describe('conformance: every emitted event param key is camelCase', () => {
    it('derives the keys from the events the real source emits for every browser signal', () => {
      const { env, win, orientation, state, doc } = fakeEnv();
      const environment = createMultiKeyEmitter<EnvironmentEvents>();
      const m = fakeQueries();
      const { events } = activate({
        ...env,
        environment: environment as never,
        matchMedia: m.matchMedia,
      });
      win.emit('pagehide', { persisted: true });
      state.visibilityState = 'hidden';
      doc.emit('visibilitychange', {});
      orientation.type = 'landscape-primary';
      orientation.angle = 90;
      win.emit('orientationchange', {});
      m.set('(prefers-color-scheme: dark)', true);
      m.enter('standalone');
      environment.emit('language', {
        language: 'uk',
        languages: ['uk'],
        previous: { language: 'en' },
      });
      environment.emit('timezone', {
        timeZone: 'Asia/Tokyo',
        utcOffsetMinutes: 540,
        previous: { timeZone: 'Europe/Kyiv', utcOffsetMinutes: 120 },
      });
      environment.emit('privateMode', { private: 'yes', method: 'storage-quota' });
      const keys = new Set(events.flatMap((e) => Object.keys(e.params ?? {})));
      // the EXACT key surface (a dropped key must fail, not just a renamed one)
      expect([...keys].sort()).toEqual([
        'angle',
        'current',
        'dark',
        'language',
        'languages',
        'method',
        'mode',
        'persisted',
        'prev',
        'previousLanguage',
        'previousMode',
        'previousTimezone',
        'previousUtcOffsetMinutes',
        'timezone',
        'type',
        'utcOffsetMinutes',
      ]);
      expect([...keys].filter((k) => !/^[a-z][a-zA-Z0-9]*$/.test(k))).toEqual([]);
    });
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

    it('an opted-out source (detectPrivateMode: false) never forwards a yes, even if another consumer enabled detection on the shared tracker', async () => {
      const injected = createMultiKeyEmitter<EnvironmentEvents>();
      const out = activate({
        lifecycle: lifecycleStub as never,
        environment: injected,
        detectPrivateMode: false,
      });
      injected.emit('privateMode', { private: 'yes', method: 'storage-quota' });
      expect(out.events.map((e) => e.name)).toEqual(['process_started']);
      // and over the REAL window singleton, with a second consumer turning detection on
      const { env, win } = fakeEnv();
      const { environment: _inert, ...rest } = env;
      Object.assign(win, {
        navigator: {
          language: 'en-US',
          storage: { estimate: () => Promise.resolve({ quota: 10 }) },
        },
      });
      try {
        const off = activate({
          ...rest,
          lifecycle: lifecycleStub as never,
          detectPrivateMode: false,
        });
        const other = environmentTrackerFor({ window: win, detectPrivateMode: true });
        const unsub = other.onAny(() => {});
        await new Promise((r) => setTimeout(r, 0));
        expect(other.current().privateMode?.private).toBe('yes'); // the tracker did detect it
        expect(off.events.map((e) => e.name)).not.toContain('private_mode_detected');
        unsub();
        off.off();
      } finally {
        resetEnvironmentTracker({ window: win });
      }
      out.off();
    });

    it('a retained yes is re-delivered once to each new session (no re-probe); no / unknown stay silent; an opt-out stays silent', async () => {
      const { env, win } = fakeEnv();
      const { environment: _inert, ...rest } = env;
      const estimate = vi.fn(() => Promise.resolve({ quota: 10 }));
      Object.assign(win, { navigator: { language: 'en-US', storage: { estimate } } });
      try {
        const first = activate({ ...rest, lifecycle: lifecycleStub as never });
        await new Promise((r) => setTimeout(r, 0));
        expect(first.events.filter((e) => e.name === 'private_mode_detected')).toHaveLength(1);
        first.off();
        estimate.mockClear();
        // a later session on the same window (the tracker outlived the first one)
        const second = activate({ ...rest, lifecycle: lifecycleStub as never });
        await new Promise((r) => setTimeout(r, 0));
        expect(estimate).not.toHaveBeenCalled(); // not re-probed
        expect(second.events.filter((e) => e.name === 'private_mode_detected')).toEqual([
          { name: 'private_mode_detected', params: { method: 'storage-quota' } },
        ]);
        second.off();
        // an opted-out session never gets it from the retained answer
        const optedOut = activate({
          ...rest,
          lifecycle: lifecycleStub as never,
          detectPrivateMode: false,
        });
        await new Promise((r) => setTimeout(r, 0));
        expect(optedOut.events.map((e) => e.name)).not.toContain('private_mode_detected');
        optedOut.off();
      } finally {
        resetEnvironmentTracker({ window: win });
      }
    });

    it('a retained no is not delivered to a later session', async () => {
      const { env, win } = fakeEnv();
      const { environment: _inert, ...rest } = env;
      Object.assign(win, {
        navigator: {
          language: 'en-US',
          storage: { estimate: () => Promise.resolve({ quota: 2 * 1024 * 1024 * 1024 }) },
        },
      });
      try {
        const first = activate({ ...rest, lifecycle: lifecycleStub as never });
        await new Promise((r) => setTimeout(r, 0));
        expect(environmentTrackerFor({ window: win }).current().privateMode?.private).toBe('no');
        first.off();
        const second = activate({ ...rest, lifecycle: lifecycleStub as never });
        await new Promise((r) => setTimeout(r, 0));
        expect(second.events.map((e) => e.name)).not.toContain('private_mode_detected');
        second.off();
      } finally {
        resetEnvironmentTracker({ window: win });
      }
    });

    it('a retained yes read from the tracker is emitted on subscribe, once even if the activation also emits it; later answers still forward', () => {
      const injected = createMultiKeyEmitter<EnvironmentEvents>();
      const withCurrent = Object.assign(injected, {
        current: () => ({ privateMode: { private: 'yes' as const, method: 'storage-quota' } }),
      });
      const out = activate({ lifecycle: lifecycleStub as never, environment: withCurrent });
      expect(out.events.filter((e) => e.name === 'private_mode_detected')).toHaveLength(1);
      injected.emit('privateMode', { private: 'yes', method: 'storage-quota' });
      expect(out.events.filter((e) => e.name === 'private_mode_detected')).toHaveLength(2); // a new answer is still forwarded
      out.off();
      // the activation itself emits the same yes while subscribing: still one event
      const loud = createMultiKeyEmitter<EnvironmentEvents>();
      const onAny = loud.onAny.bind(loud);
      const sub = Object.assign(loud, {
        current: () => ({ privateMode: { private: 'yes' as const } }),
        onAny: ((listener: Parameters<typeof onAny>[0]) => {
          const off = onAny(listener);
          loud.emit('privateMode', { private: 'yes' });
          return off;
        }) as typeof onAny,
      });
      const two = activate({ lifecycle: lifecycleStub as never, environment: sub });
      expect(two.events.filter((e) => e.name === 'private_mode_detected')).toHaveLength(1);
      two.off();
      // an opted-out source never delivers a retained yes
      const quiet = createMultiKeyEmitter<EnvironmentEvents>();
      const held = Object.assign(quiet, {
        current: () => ({ privateMode: { private: 'yes' as const } }),
      });
      const optedOut = activate({
        lifecycle: lifecycleStub as never,
        environment: held,
        detectPrivateMode: false,
      });
      expect(optedOut.events.map((e) => e.name)).not.toContain('private_mode_detected');
      optedOut.off();
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

    it('an omitted detectPrivateMode means ON (opt-out), and an explicit false turns it OFF even after an earlier source turned it on for the window', async () => {
      const { env, win } = fakeEnv();
      const { environment: _inert, ...rest } = env;
      const estimate = vi.fn(() => Promise.resolve({ quota: 10 }));
      Object.assign(win, { navigator: { language: 'en-US', storage: { estimate } } });
      try {
        const on = activate({
          ...rest,
          lifecycle: lifecycleStub as never,
          detectPrivateMode: true,
        });
        await new Promise((r) => setTimeout(r, 0));
        expect(estimate).toHaveBeenCalledTimes(1);
        expect(on.events.at(-1)?.name).toBe('private_mode_detected');
        on.off();
        resetEnvironmentTracker({ window: win }); // forget the answer; keep nothing but the seam question
        const first = activate({
          ...rest,
          lifecycle: lifecycleStub as never,
          detectPrivateMode: true,
        });
        first.off();
        estimate.mockClear();
        const off = activate({
          ...rest,
          lifecycle: lifecycleStub as never,
          detectPrivateMode: false,
        });
        await new Promise((r) => setTimeout(r, 0));
        expect(estimate).not.toHaveBeenCalled();
        expect(off.events.map((e) => e.name)).not.toContain('private_mode_detected');
        off.off();
        resetEnvironmentTracker({ window: win });
        const dflt = activate({ ...rest, lifecycle: lifecycleStub as never }); // option omitted
        await new Promise((r) => setTimeout(r, 0));
        expect(estimate).toHaveBeenCalledTimes(1);
        expect(dflt.events.at(-1)?.name).toBe('private_mode_detected');
        dflt.off();
      } finally {
        resetEnvironmentTracker({ window: win });
      }
    });

    it('never queries permissions nor reads hints: nothing consumes them', async () => {
      const { env, win } = fakeEnv();
      const { environment: _inert, ...rest } = env;
      const query = vi.fn(() => Promise.resolve({ state: 'granted' }));
      Object.assign(win, {
        navigator: { language: 'en-US', cookieEnabled: true, permissions: { query } },
      });
      try {
        const a = activate({ ...rest, lifecycle: lifecycleStub as never });
        await new Promise((r) => setTimeout(r, 0));
        expect(query).not.toHaveBeenCalled();
        expect(environmentTrackerFor({ window: win }).current().hints).toBeUndefined();
        expect(environmentTrackerFor({ window: win }).current().permissions).toBeUndefined();
        a.off();
        // an earlier user of the window's tracker that asked for them does not leak into this source
        const tracker = environmentTrackerFor({
          window: win,
          observeHints: true,
          queryPermissions: true,
        });
        const off = tracker.onAny(() => {});
        await new Promise((r) => setTimeout(r, 0));
        expect(query).toHaveBeenCalled();
        off();
        query.mockClear();
        const b = activate({ ...rest, lifecycle: lifecycleStub as never });
        await new Promise((r) => setTimeout(r, 0));
        expect(query).not.toHaveBeenCalled();
        expect(environmentTrackerFor({ window: win }).current().hints).toBeUndefined();
        b.off();
      } finally {
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

    it('over the window singleton: a real languagechange and a time-zone tick become events; private mode is opt-out', async () => {
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
        // opted out: language/timezone on, private mode off
        const a = activate({
          ...rest,
          lifecycle: lifecycleStub as never,
          scheduler,
          detectPrivateMode: false,
        });
        nav.language = 'de-DE';
        win.emit('languagechange', {});
        expect(a.events.map((e) => e.name)).toEqual(['process_started', 'language_changed']);
        expect(nav.storage.estimate).not.toHaveBeenCalled();
        a.off();
        resetEnvironmentTracker({ window: win });
        // the default: a yes answer is an event
        const b = activate({ ...rest, lifecycle: lifecycleStub as never, scheduler });
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
