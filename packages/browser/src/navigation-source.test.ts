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

// A fake Navigation API: a mutable `currentEntry` (the source reads `currentEntry.url` post-commit) + a
// captured `currententrychange` listener. `change(url, type)` simulates a committed same-document navigation
// (set the new currentEntry URL, then fire the event); `fire(type)` fires without touching currentEntry.
function fakeNavigation() {
  let handler: ((e: unknown) => void) | undefined;
  const navigation = {
    currentEntry: { url: undefined } as { url?: string } | null,
    addEventListener: vi.fn((_t: string, l: (e: unknown) => void) => {
      handler = l;
    }),
    removeEventListener: vi.fn(),
  };
  const change = (url: string | undefined, navigationType: string | null | undefined) => {
    navigation.currentEntry = { url };
    handler?.({ navigationType });
  };
  const fire = (navigationType: string | null | undefined) => handler?.({ navigationType });
  return { navigation, change, fire };
}

describe('createBrowserNavigationSource', () => {
  it('patches history.pushState on activation and restores it on deactivation', () => {
    const { env, history, origPush } = fakeEnv();
    const source = createBrowserNavigationSource(env);
    const { off } = collect(source);
    expect(history.pushState).not.toBe(origPush); // patched
    off(); // dropping the last subscriber deactivates
    expect(history.pushState).toBe(origPush); // restored
  });

  it('removes the popstate + hashchange listeners on deactivation (no leak across launch/stop)', () => {
    const { env, target } = fakeEnv();
    const { off } = collect(createBrowserNavigationSource(env));
    expect(target.addEventListener).toHaveBeenCalledWith('popstate', expect.any(Function));
    expect(target.addEventListener).toHaveBeenCalledWith('hashchange', expect.any(Function));
    off(); // dropping the last subscriber deactivates
    expect(target.removeEventListener).toHaveBeenCalledWith('popstate', expect.any(Function));
    expect(target.removeEventListener).toHaveBeenCalledWith('hashchange', expect.any(Function));
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

  it('uses the Navigation API (currententrychange) when present (NOT History); maps types/paths; unsubscribes', () => {
    const { navigation, change } = fakeNavigation();
    const { env, history, origPush } = fakeEnv({ navigation: navigation as never });
    const source = createBrowserNavigationSource(env);
    const events: NavigationDetail[] = [];
    const off = source.on('navigate', (d) => events.push(d));
    expect(history.pushState).toBe(origPush); // History NOT patched (the Navigation API covers it)
    expect(navigation.addEventListener).toHaveBeenCalledWith(
      'currententrychange',
      expect.any(Function),
    );
    // currentEntry holds the already-committed URL; a full URL → path only; a known type passes through.
    change('https://app.test/dashboard?q=1', 'replace');
    change('/orders/42', 'weird-unknown-type'); // an unknown type defaults to 'push'
    change('/home', 'push'); // the `push`, `traverse`, `reload` arms map through as-is
    change('/back', 'traverse');
    change('/r', 'reload');
    expect(events).toEqual([
      {
        to: '/dashboard',
        navigationType: 'replace',
        source: 'url',
        href: 'https://app.test/dashboard?q=1',
      },
      { to: '/orders/42', navigationType: 'push', source: 'url' },
      { to: '/home', navigationType: 'push', source: 'url' },
      { to: '/back', navigationType: 'traverse', source: 'url' },
      { to: '/r', navigationType: 'reload', source: 'url' },
    ]);
    off(); // dropping the last subscriber deactivates → the listener is removed
    expect(navigation.removeEventListener).toHaveBeenCalledWith(
      'currententrychange',
      expect.any(Function),
    );
    // it must remove the SAME bound handler it added (a fresh closure would leak the listener forever).
    expect(navigation.removeEventListener.mock.calls[0]?.[1]).toBe(
      navigation.addEventListener.mock.calls[0]?.[1],
    );
  });

  it('skips a state-only entry change (navigationType null = updateCurrentEntry) or one with no type', () => {
    const { navigation, change } = fakeNavigation();
    const { env } = fakeEnv({ navigation: navigation as never });
    const { events } = collect(createBrowserNavigationSource(env));
    change('/state-only', null); // updateCurrentEntry() — a state edit, not a navigation
    change('/no-type', undefined); // an event with no navigationType
    expect(events).toEqual([]);
    change('/real', 'push'); // a genuine navigation still emits
    expect(events).toEqual([{ to: '/real', navigationType: 'push', source: 'url' }]);
  });

  it('emits nothing when the current entry has no URL or is absent', () => {
    const { navigation, change, fire } = fakeNavigation();
    const { env } = fakeEnv({ navigation: navigation as never });
    const { events } = collect(createBrowserNavigationSource(env));
    change(undefined, 'push'); // currentEntry.url undefined → nothing to emit
    navigation.currentEntry = null; // currentEntry absent entirely
    fire('push');
    expect(events).toEqual([]);
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

  it('a throwing currentEntry getter never breaks the Navigation API listener (observe-only)', () => {
    let navHandler: ((e: unknown) => void) | undefined;
    const navigation = {
      get currentEntry(): { url?: string } {
        throw new Error('hostile currentEntry');
      },
      addEventListener: vi.fn((_t: string, l: (e: unknown) => void) => {
        navHandler = l;
      }),
      removeEventListener: vi.fn(),
    };
    const { env } = fakeEnv({ navigation: navigation as never });
    const { events } = collect(createBrowserNavigationSource(env));
    // The currentEntry read (a hostile getter) throws inside the handler — it must be swallowed, not thrown.
    expect(() => navHandler?.({ navigationType: 'push' })).not.toThrow();
    expect(events).toEqual([]); // nothing emitted, nothing thrown
  });

  describe('href (the absolute address, for the `url` trace)', () => {
    it('History path: carries location.href after the app navigated', () => {
      const { env, history, location } = fakeEnv();
      const { events } = collect(createBrowserNavigationSource(env));
      (location as { href?: string }).href = 'https://a.com/x?y=1#z';
      location.pathname = '/x';
      history.pushState({}, '', '/x');
      expect(events).toEqual([
        { to: '/x', navigationType: 'push', source: 'url', href: 'https://a.com/x?y=1#z' },
      ]);
    });

    it('History path: popstate and hashchange carry it too', () => {
      const { env, location, fire } = fakeEnv();
      const { events } = collect(createBrowserNavigationSource(env));
      (location as { href?: string }).href = 'https://a.com/p';
      fire('popstate');
      fire('hashchange');
      expect(events.map((e) => e.href)).toEqual(['https://a.com/p', 'https://a.com/p']);
    });

    it('History path: no key at all when the location has no href (or it is not a string)', () => {
      const { env, location, fire } = fakeEnv();
      const { events } = collect(createBrowserNavigationSource(env));
      fire('popstate');
      (location as { href?: unknown }).href = 42;
      fire('popstate');
      expect(events).toHaveLength(2);
      for (const e of events) expect('href' in e).toBe(false);
    });

    it('History path: a throwing href getter loses only the href, never the navigation', () => {
      const { env, fire } = fakeEnv({
        location: {
          pathname: '/ok',
          get href(): string {
            throw new Error('hostile');
          },
        },
      });
      const { events } = collect(createBrowserNavigationSource(env));
      fire('popstate');
      expect(events).toEqual([{ to: '/ok', navigationType: 'traverse', source: 'url' }]);
    });

    it('Navigation API path: carries currentEntry.url', () => {
      const { navigation, change } = fakeNavigation();
      const { events } = collect(createBrowserNavigationSource({ navigation }));
      change('https://a.com/n?q=1', 'push');
      expect(events).toEqual([
        { to: '/n', navigationType: 'push', source: 'url', href: 'https://a.com/n?q=1' },
      ]);
    });

    it('an adapter-emitted navigation has no href', () => {
      const { env } = fakeEnv();
      const source = createBrowserNavigationSource(env);
      const { events } = collect(source);
      source.startNavigation({ name: '/orders/:id', source: 'route' });
      expect('href' in (events[0] as object)).toBe(false);
    });
  });

  it('isolated: uses only the given surfaces, never the host globals', () => {
    const pushState = vi.fn();
    vi.stubGlobal('history', { pushState, replaceState: vi.fn() });
    try {
      const source = createBrowserNavigationSource({
        isolated: true,
        location: { pathname: '/p' },
      });
      const { events, off } = collect(source); // activates: no history, no target, no navigation
      expect((globalThis as { history: { pushState: unknown } }).history.pushState).toBe(pushState);
      expect(events).toEqual([]);
      off();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('not isolated: an omitted surface falls back to the host global', () => {
    const pushState = vi.fn();
    vi.stubGlobal('history', { pushState, replaceState: vi.fn() });
    try {
      const { off } = collect(createBrowserNavigationSource({ navigation: undefined }));
      expect((globalThis as { history: { pushState: unknown } }).history.pushState).not.toBe(
        pushState,
      );
      off();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('history patching is order-safe (C23)', () => {
    // One shared fake History + location; each source wraps what it finds, as two consumers on one page would.
    const sharedEnv = () => {
      const orig = {
        push: vi.fn(),
        replace: vi.fn(),
      };
      const history = { pushState: orig.push, replaceState: orig.replace };
      const location = { pathname: '/p', href: 'https://a.com/p' };
      const mk = () => createBrowserNavigationSource({ history, location, isolated: true });
      return { history, orig, mk, location };
    };
    const thirdParty = (history: { pushState: unknown; replaceState: unknown }) => {
      const inner = history.pushState as (...a: unknown[]) => unknown;
      const calls: unknown[][] = [];
      const wrapper = (...args: unknown[]) => {
        calls.push(args);
        return inner(...args);
      };
      history.pushState = wrapper;
      return { wrapper, calls };
    };

    it('two sources stopped in the order they started leave history exactly as found', () => {
      const { history, orig, mk } = sharedEnv();
      const a = collect(mk());
      const b = collect(mk());
      a.off(); // not the top wrapper: becomes a pass-through
      b.off(); // top: restores, and unwinds the dead pass-through beneath it
      expect(history.pushState).toBe(orig.push);
      expect(history.replaceState).toBe(orig.replace);
    });

    it('two sources stopped in reverse order leave history exactly as found', () => {
      const { history, orig, mk } = sharedEnv();
      const a = collect(mk());
      const b = collect(mk());
      b.off();
      a.off();
      expect(history.pushState).toBe(orig.push);
      expect(history.replaceState).toBe(orig.replace);
    });

    it('the surviving source still emits after the other one stops (its wrapper was not dropped)', () => {
      const { history, mk, location } = sharedEnv();
      const a = collect(mk());
      const b = collect(mk());
      a.off();
      location.pathname = '/next';
      history.pushState({}, '', '/next');
      expect(b.events.map((e) => e.to)).toEqual(['/next']);
      expect(a.events).toEqual([]); // a stopped: pass-through, no emit
      b.off();
    });

    it("a third party's wrapper installed AFTER the source survives its stop, and navigation still works", () => {
      const { history, orig, mk } = sharedEnv();
      const a = collect(mk());
      const tp = thirdParty(history);
      a.off();
      expect(history.pushState).toBe(tp.wrapper); // not restored over the third party
      history.pushState({}, '', '/x');
      expect(tp.calls).toHaveLength(1);
      expect(orig.push).toHaveBeenCalledTimes(1); // the chain reached the real method through our pass-through
      expect(a.events).toEqual([]); // and our dead wrapper emits nothing
    });

    it('restarting while the old wrapper is still in the chain reuses it (no double emit)', () => {
      const { history, mk, location } = sharedEnv();
      const source = mk();
      const first = collect(source);
      const tp = thirdParty(history);
      first.off();
      const second = collect(source);
      location.pathname = '/again';
      history.pushState({}, '', '/again');
      expect(tp.calls).toHaveLength(1);
      expect(second.events.map((e) => e.to)).toEqual(['/again']); // once
      second.off();
    });

    it('restarting after a clean stop wraps afresh', () => {
      const { history, orig, mk, location } = sharedEnv();
      const source = mk();
      collect(source).off();
      expect(history.pushState).toBe(orig.push);
      const again = collect(source);
      expect(history.pushState).not.toBe(orig.push);
      location.pathname = '/z';
      history.pushState({}, '', '/z');
      expect(again.events.map((e) => e.to)).toEqual(['/z']);
      again.off();
      expect(history.pushState).toBe(orig.push);
    });

    it('a stopped source in the chain does no work: its pass-through never reads the location', () => {
      const { history, orig } = sharedEnv();
      let reads = 0;
      const location = {
        get pathname() {
          reads += 1;
          return '/p';
        },
        href: 'https://a.com/p',
      };
      const source = createBrowserNavigationSource({ history, location, isolated: true });
      const a = collect(source);
      thirdParty(history);
      a.off();
      reads = 0;
      history.pushState({}, '', '/x');
      expect(reads).toBe(0);
      expect(orig.push).toHaveBeenCalledTimes(1);
    });

    it('a restart right after a clean stop wraps afresh on the restored original', () => {
      const { history, mk } = sharedEnv();
      const source = mk();
      const first = collect(source);
      const wrapper = history.pushState;
      first.off(); // outermost: restored
      const second = collect(source);
      expect(history.pushState).not.toBe(wrapper); // restored, then wrapped afresh
      second.off();
    });

    it('a third party that RESTORED the original after our stop does not cost a restart its detection (regression)', () => {
      const { history, orig, mk, location } = sharedEnv();
      const source = mk();
      const first = collect(source);
      const tp = thirdParty(history); // wraps over us
      first.off(); // ours stays as a pass-through under the third party
      history.pushState = orig.push; // the third party takes everything off again
      const second = collect(source);
      location.pathname = '/two';
      history.pushState({}, '', '/two');
      expect(second.events.map((e) => e.to)).toEqual(['/two']);
      expect(tp.calls).toHaveLength(0);
      second.off();
    });

    it('a restart under a live third-party wrapper wraps afresh and emits exactly once', () => {
      const { history, mk, location } = sharedEnv();
      const source = mk();
      const first = collect(source);
      const tp = thirdParty(history);
      first.off();
      const second = collect(source);
      location.pathname = '/again';
      history.pushState({}, '', '/again');
      expect(second.events.map((e) => e.to)).toEqual(['/again']); // the retired wrapper beneath stays inert
      expect(tp.calls).toHaveLength(1);
      second.off();
    });

    it('a deleted method is wrapped afresh on restart', () => {
      const { history, mk } = sharedEnv();
      const source = mk();
      const first = collect(source);
      first.off();
      const replacement = vi.fn();
      history.pushState = replacement;
      const second = collect(source);
      expect(history.pushState).not.toBe(replacement);
      history.pushState({}, '', '/q');
      expect(replacement).toHaveBeenCalledTimes(1);
      second.off();
    });

    it('stopping the top source does NOT unwind a live source beneath it', () => {
      const { history, orig, mk, location } = sharedEnv();
      const a = collect(mk());
      const b = collect(mk());
      b.off();
      expect(history.pushState).not.toBe(orig.push); // a is still wrapped and live
      location.pathname = '/still-a';
      history.pushState({}, '', '/still-a');
      expect(a.events.map((e) => e.to)).toEqual(['/still-a']);
      a.off();
      expect(history.pushState).toBe(orig.push);
    });

    it('a source that was unwound beneath another restarts with a fresh wrapper', () => {
      const { history, orig, mk, location } = sharedEnv();
      const sourceA = mk();
      const a = collect(sourceA);
      const b = collect(mk());
      a.off();
      b.off(); // unwinds a's dead wrapper: history is the original again
      expect(history.pushState).toBe(orig.push);
      const again = collect(sourceA);
      location.pathname = '/again';
      history.pushState({}, '', '/again');
      expect(again.events.map((e) => e.to)).toEqual(['/again']);
      again.off();
    });

    it('pushState and replaceState are released independently', () => {
      const { history, orig, mk } = sharedEnv();
      const a = collect(mk());
      const wrappedReplace = history.replaceState as (...a: unknown[]) => unknown;
      const tpReplace = vi.fn((...args: unknown[]) => wrappedReplace(...args));
      history.replaceState = tpReplace;
      a.off();
      expect(history.pushState).toBe(orig.push); // ours was on top: restored
      expect(history.replaceState).toBe(tpReplace); // the third party's stays
    });
  });
});
