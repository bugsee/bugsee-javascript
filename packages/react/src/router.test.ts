import type { Bugsee } from '@bugsee/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  instrumentReactRouter,
  instrumentRouterMatches,
  type ReactDataRouterLike,
  type RouteMatchLike,
  routePatternFromMatches,
  setRouteName,
} from './router';

// A fake client exposing ext('performance').setRouteName; ext throws for any other extension (mirrors the
// real client, which throws when an extension is not registered).
function fakeClient() {
  const setRouteNameSpy = vi.fn();
  const ext = vi.fn((name: string) => {
    if (name === 'performance') return { setRouteName: setRouteNameSpy };
    throw new Error(`extension ${name} not registered`);
  });
  return { client: { ext } as unknown as Bugsee, setRouteName: setRouteNameSpy };
}

const match = (path: string | undefined): RouteMatchLike => ({ route: { path } });

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('routePatternFromMatches', () => {
  it('joins nested relative segments into a parameterized pattern', () => {
    expect(routePatternFromMatches([match('users'), match(':id')])).toBe('/users/:id');
  });

  it('skips pathless / layout / index routes (undefined or empty path)', () => {
    expect(routePatternFromMatches([match(undefined), match('teams'), match('')])).toBe('/teams');
  });

  it('normalizes leading/trailing slashes when joining', () => {
    expect(routePatternFromMatches([match('/orders/'), match('/:orderId')])).toBe(
      '/orders/:orderId',
    );
  });

  it('drops an all-slash segment so a root LAYOUT route + child does not double-slash', () => {
    // react-router commonly nests routes under a root layout whose path is '/'; that segment trims to ''
    // and must not contribute, else the join would yield '//users'.
    expect(routePatternFromMatches([match('/'), match('users')])).toBe('/users');
  });

  it('returns "/" for the root route', () => {
    expect(routePatternFromMatches([match('/')])).toBe('/');
  });

  it('returns undefined for no matches / no usable path', () => {
    expect(routePatternFromMatches([])).toBeUndefined();
    expect(routePatternFromMatches(null)).toBeUndefined();
    expect(routePatternFromMatches(undefined)).toBeUndefined();
    expect(routePatternFromMatches([match(undefined)])).toBeUndefined(); // only pathless routes
  });
});

describe('setRouteName', () => {
  it('refines the active transaction via ext(performance).setRouteName', () => {
    const { client, setRouteName: spy } = fakeClient();
    setRouteName('/users/:id', { getClient: () => client });
    expect(spy).toHaveBeenCalledWith('/users/:id');
  });

  it('is a no-op when no client is resolvable', () => {
    expect(() => setRouteName('/x', { getClient: () => undefined })).not.toThrow();
  });

  it('is a no-op when the performance extension is not registered (ext throws)', () => {
    const client = {
      ext: () => {
        throw new Error('not registered');
      },
    } as unknown as Bugsee;
    expect(() => setRouteName('/x', { getClient: () => client })).not.toThrow();
  });

  it('falls back to the carrier client when no getClient is injected', () => {
    const { client, setRouteName: spy } = fakeClient();
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { '0.0.0': { client } };
    setRouteName('/dash');
    expect(spy).toHaveBeenCalledWith('/dash');
  });
});

describe('instrumentRouterMatches', () => {
  it('computes the route pattern from matches and refines the active transaction', () => {
    const { client, setRouteName: spy } = fakeClient();
    instrumentRouterMatches([match('users'), match(':id')], { getClient: () => client });
    expect(spy).toHaveBeenCalledWith('/users/:id');
  });

  it('is a no-op when there is no usable route pattern (setRouteName not called)', () => {
    const { client, setRouteName: spy } = fakeClient();
    instrumentRouterMatches([], { getClient: () => client });
    expect(spy).not.toHaveBeenCalled();
  });
});

// A structural react-router DATA router fake: a mutable `state.matches` + a `subscribe` that records the
// listener and returns an unsubscribe spy. No react-router / renderer.
function fakeDataRouter(initial: readonly RouteMatchLike[] | undefined) {
  const listeners: Array<(state: { matches?: readonly RouteMatchLike[] }) => void> = [];
  const unsubscribe = vi.fn();
  const router: ReactDataRouterLike = {
    state: { matches: initial },
    subscribe: vi.fn((listener) => {
      listeners.push(listener);
      return unsubscribe;
    }),
  };
  // drive a navigation: update state.matches + notify every listener (mirrors react-router's data router).
  const navigate = (matches: readonly RouteMatchLike[] | undefined) => {
    router.state = { matches };
    for (const l of listeners) l(router.state);
  };
  return { router, navigate, unsubscribe };
}

describe('instrumentReactRouter', () => {
  it('names the CURRENT route immediately on instrument (from router.state.matches)', () => {
    const { client, setRouteName: spy } = fakeClient();
    const { router } = fakeDataRouter([match('users'), match(':id')]);
    instrumentReactRouter(router, { getClient: () => client });
    expect(spy).toHaveBeenCalledWith('/users/:id');
    expect(router.subscribe).toHaveBeenCalledTimes(1);
  });

  it('re-names the active transaction on each subsequent navigation (self-subscribing)', () => {
    const { client, setRouteName: spy } = fakeClient();
    const { router, navigate } = fakeDataRouter([match('/')]);
    instrumentReactRouter(router, { getClient: () => client });
    spy.mockClear();
    navigate([match('teams'), match(':teamId')]);
    expect(spy).toHaveBeenCalledWith('/teams/:teamId');
    navigate([match('settings')]);
    expect(spy).toHaveBeenCalledWith('/settings');
  });

  it('does not name when a navigation has no usable pattern', () => {
    const { client, setRouteName: spy } = fakeClient();
    const { router, navigate } = fakeDataRouter([match('home')]);
    instrumentReactRouter(router, { getClient: () => client });
    spy.mockClear();
    navigate([match(undefined)]); // only a pathless/layout route
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not name the initial route when the current state has no usable pattern', () => {
    const { client, setRouteName: spy } = fakeClient();
    const { router } = fakeDataRouter(undefined); // no matches yet
    instrumentReactRouter(router, { getClient: () => client });
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns the router unsubscribe function for teardown', () => {
    const { client } = fakeClient();
    const { router, unsubscribe } = fakeDataRouter([match('x')]);
    const teardown = instrumentReactRouter(router, { getClient: () => client });
    expect(teardown).toBe(unsubscribe);
  });
});
