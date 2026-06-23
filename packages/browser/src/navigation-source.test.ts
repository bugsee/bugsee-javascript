import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserNavigationSource,
  type NavigationDetail,
  type NavigationEnv,
} from './navigation-source';

// A fake browser env: a History whose pushState/replaceState are spies, a window whose listeners can be
// fired, and a mutable location (a real browser updates location BEFORE our patch reads it).
function fakeEnv(over: Partial<NavigationEnv> = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const origPush = vi.fn();
  const origReplace = vi.fn();
  const history = { pushState: origPush, replaceState: origReplace };
  const location = { pathname: '/initial' };
  const target = {
    addEventListener: vi.fn((t: string, l: () => void) => {
      (listeners.get(t) ?? listeners.set(t, new Set()).get(t))?.add(l);
    }),
    removeEventListener: vi.fn((t: string, l: () => void) => {
      listeners.get(t)?.delete(l);
    }),
  };
  const fire = (t: string) => {
    for (const l of listeners.get(t) ?? []) l();
  };
  const env: NavigationEnv = { history, target, location, ...over };
  return { env, history, origPush, origReplace, location, target, fire };
}

const collect = (source: ReturnType<typeof createBrowserNavigationSource>) => {
  const events: NavigationDetail[] = [];
  const off = source.on('navigate', (d) => events.push(d)); // subscribing activates the source
  return { events, off };
};

describe('createBrowserNavigationSource', () => {
  it('patches history.pushState on activation and restores it on deactivation', () => {
    const { env, history, origPush } = fakeEnv();
    const source = createBrowserNavigationSource(env);
    const { off } = collect(source);
    expect(history.pushState).not.toBe(origPush); // patched
    off(); // dropping the last subscriber deactivates
    expect(history.pushState).toBe(origPush); // restored
  });

  it('emits a `push` navigation when the app calls the patched pushState — original called FIRST', () => {
    const { env, history, origPush, location } = fakeEnv();
    const source = createBrowserNavigationSource(env);
    const { events } = collect(source);
    location.pathname = '/page-b'; // the browser updated the URL …
    history.pushState({ s: 1 }, '', '/page-b'); // … then the app navigated through the patched method
    expect(origPush).toHaveBeenCalledWith({ s: 1 }, '', '/page-b'); // the app's nav is NOT blocked
    expect(events).toEqual([{ to: '/page-b', navigationType: 'push', source: 'url' }]);
  });

  it('emits a `replace` navigation for replaceState', () => {
    const { env, history, location } = fakeEnv();
    const { events } = collect(createBrowserNavigationSource(env));
    location.pathname = '/replaced';
    history.replaceState({}, '', '/replaced');
    expect(events).toEqual([{ to: '/replaced', navigationType: 'replace', source: 'url' }]);
  });

  it('emits `traverse` on popstate (back/forward) and `hash` on hashchange', () => {
    const { env, location, fire } = fakeEnv();
    const { events } = collect(createBrowserNavigationSource(env));
    location.pathname = '/back';
    fire('popstate');
    location.pathname = '/anchor';
    fire('hashchange');
    expect(events).toEqual([
      { to: '/back', navigationType: 'traverse', source: 'url' },
      { to: '/anchor', navigationType: 'hash', source: 'url' },
    ]);
  });

  it('startNavigation emits a programmatic (URL-less) navigation an adapter supplies', () => {
    const { env } = fakeEnv();
    const source = createBrowserNavigationSource(env);
    const { events } = collect(source);
    source.startNavigation({ name: '/users/:id', source: 'route' });
    source.startNavigation({ name: 'wizard:step-2' }); // default source = custom
    expect(events).toEqual([
      { to: '/users/:id', navigationType: 'programmatic', source: 'route' },
      { to: 'wizard:step-2', navigationType: 'programmatic', source: 'custom' },
    ]);
  });

  it('uses the Navigation API when present (NOT History); maps types/paths; unsubscribes on deactivate', () => {
    let navHandler: ((e: unknown) => void) | undefined;
    const navigation = {
      addEventListener: vi.fn((_t: string, l: (e: unknown) => void) => {
        navHandler = l;
      }),
      removeEventListener: vi.fn(),
    };
    const { env, history, origPush } = fakeEnv({ navigation: navigation as never });
    const source = createBrowserNavigationSource(env);
    const events: NavigationDetail[] = [];
    const off = source.on('navigate', (d) => events.push(d));
    expect(history.pushState).toBe(origPush); // History NOT patched (the Navigation API covers it)
    expect(navigation.addEventListener).toHaveBeenCalledWith('navigate', expect.any(Function));
    // a full URL → path only; a known type passes through.
    navHandler?.({
      navigationType: 'replace',
      destination: { url: 'https://app.test/dashboard?q=1' },
    });
    // a relative/unparseable url is used as-is; a missing/unknown type defaults to 'push'.
    navHandler?.({ destination: { url: '/orders/42' } });
    // a navigate event with NO destination url (e.g. a reload) → nothing to emit; the `reload` type maps as-is.
    navHandler?.({ navigationType: 'reload' });
    expect(events).toEqual([
      { to: '/dashboard', navigationType: 'replace', source: 'url' },
      { to: '/orders/42', navigationType: 'push', source: 'url' },
    ]);
    off(); // dropping the last subscriber deactivates → the navigate listener is removed
    expect(navigation.removeEventListener).toHaveBeenCalledWith('navigate', expect.any(Function));
  });

  it('self-skips when the globals are absent (SSR/worker): activating throws nothing, emits nothing', () => {
    const source = createBrowserNavigationSource({
      history: undefined,
      target: undefined,
      location: undefined,
      navigation: undefined,
    });
    const { events } = collect(source);
    expect(() => source.startNavigation({ name: 'x' })).not.toThrow();
    // startNavigation still emits (it has no global dependency); the BUILT-IN detectors are simply inert.
    expect(events).toEqual([{ to: 'x', navigationType: 'programmatic', source: 'custom' }]);
  });

  it('a throwing location getter never breaks the patched History method (observe-only)', () => {
    const { env, history, origPush } = fakeEnv({
      location: {
        get pathname(): string {
          throw new Error('hostile location');
        },
      },
    });
    const source = createBrowserNavigationSource(env);
    collect(source);
    // The read runs AFTER the original pushState; its throw must not propagate back into the app.
    expect(() => history.pushState({}, '', '/x')).not.toThrow();
    expect(origPush).toHaveBeenCalled(); // the app's navigation completed
  });

  it('a throwing navigate-event getter never breaks the Navigation API listener (observe-only)', () => {
    let navHandler: ((e: unknown) => void) | undefined;
    const navigation = {
      addEventListener: vi.fn((_t: string, l: (e: unknown) => void) => {
        navHandler = l;
      }),
      removeEventListener: vi.fn(),
    };
    const { env } = fakeEnv({ navigation: navigation as never });
    const { events } = collect(createBrowserNavigationSource(env));
    const hostile = {
      navigationType: 'push',
      get destination(): { url: string } {
        throw new Error('hostile destination');
      },
    };
    expect(() => navHandler?.(hostile)).not.toThrow();
    expect(events).toEqual([]); // nothing emitted, nothing thrown
  });
});
