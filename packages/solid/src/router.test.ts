import type { Bugsee } from '@bugsee/browser';
import { BUGSEE_SDK_VERSION } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  routePatternFromSolidMatches,
  type SolidRouteMatchLike,
  setRouteName,
  setRouteNameFromSolidMatches,
  viewNameFromSolidMatches,
} from './router';

function fakeClient() {
  const setRouteNameSpy = vi.fn();
  const ext = vi.fn((name: string) => {
    if (name === 'performance') return { setRouteName: setRouteNameSpy };
    throw new Error(`extension ${name} not registered`);
  });
  return { client: { ext } as unknown as Bugsee, setRouteName: setRouteNameSpy };
}

const matches = (...patterns: Array<string | undefined>): SolidRouteMatchLike[] =>
  patterns.map((pattern) => ({ route: pattern === undefined ? {} : { pattern } }));

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('routePatternFromSolidMatches', () => {
  it('uses the DEEPEST match`s route pattern (the full parameterized route)', () => {
    expect(routePatternFromSolidMatches(matches('/users', '/users/:id'))).toBe('/users/:id');
  });

  it('returns undefined when there is no match or no pattern', () => {
    expect(routePatternFromSolidMatches([])).toBeUndefined();
    expect(routePatternFromSolidMatches(null)).toBeUndefined();
    expect(routePatternFromSolidMatches(undefined)).toBeUndefined();
    expect(routePatternFromSolidMatches(matches(undefined))).toBeUndefined();
    expect(routePatternFromSolidMatches(matches(''))).toBeUndefined();
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
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { [BUGSEE_SDK_VERSION]: { client } };
    setRouteName('/dash');
    expect(spy).toHaveBeenCalledWith('/dash');
  });
});

describe('setRouteNameFromSolidMatches', () => {
  it('refines the active transaction to the matched route pattern', () => {
    const { client, setRouteName: spy } = fakeClient();
    setRouteNameFromSolidMatches(matches('/orders', '/orders/:orderId'), {
      getClient: () => client,
    });
    expect(spy).toHaveBeenCalledWith('/orders/:orderId');
  });

  it('does nothing when there is no usable route pattern', () => {
    const { client, setRouteName: spy } = fakeClient();
    setRouteNameFromSolidMatches([], { getClient: () => client });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the route and view traces from Solid Router matches', () => {
  function OrderDetail() {
    return null;
  }
  const page = (component: unknown): SolidRouteMatchLike[] => [
    { route: { pattern: '/orders', component: () => null } },
    { route: { pattern: '/orders/:id', component } },
  ];

  it('viewNameFromSolidMatches reads the deepest match component: displayName, else name', () => {
    expect(viewNameFromSolidMatches(page(OrderDetail))).toBe('OrderDetail');
    expect(
      viewNameFromSolidMatches(page(Object.assign(() => null, { displayName: 'Pretty' }))),
    ).toBe('Pretty');
  });

  it('viewNameFromSolidMatches is undefined for no component, a non-function, a nameless function or no matches', () => {
    expect(viewNameFromSolidMatches(page(undefined))).toBeUndefined();
    expect(viewNameFromSolidMatches(page({ name: 'NotAFunction' }))).toBeUndefined();
    expect(viewNameFromSolidMatches(page('Str'))).toBeUndefined();
    expect(
      viewNameFromSolidMatches(page(Object.defineProperty(() => null, 'name', { value: '' }))),
    ).toBeUndefined();
    expect(viewNameFromSolidMatches([])).toBeUndefined();
    expect(viewNameFromSolidMatches(null)).toBeUndefined();
    expect(viewNameFromSolidMatches(undefined)).toBeUndefined();
    expect(viewNameFromSolidMatches([{}])).toBeUndefined();
  });

  it('viewNameFromSolidMatches reads only the deepest match', () => {
    expect(
      viewNameFromSolidMatches([
        { route: { component: OrderDetail } },
        { route: { pattern: '/x' } },
      ]),
    ).toBeUndefined();
  });

  it('setRouteNameFromSolidMatches writes the route and the view {name, type: "solid"}', () => {
    const setRoute = vi.fn();
    const setView = vi.fn();
    const { client } = fakeClient();
    const full = { ...(client as object), setRoute, setView } as unknown as Bugsee;
    setRouteNameFromSolidMatches(page(OrderDetail), { getClient: () => full });
    expect(setRoute).toHaveBeenCalledExactlyOnceWith('/orders/:id');
    expect(setView).toHaveBeenCalledExactlyOnceWith({ name: 'OrderDetail', type: 'solid' });
  });

  it('writes no view for a minified name, but still the route', () => {
    const setRoute = vi.fn();
    const setView = vi.fn();
    const full = {
      setRoute,
      setView,
      ext: () => ({ setRouteName: () => {} }),
    } as unknown as Bugsee;
    setRouteNameFromSolidMatches(page(Object.assign(() => null, { displayName: 'q' })), {
      getClient: () => full,
    });
    expect(setRoute).toHaveBeenCalledTimes(1);
    expect(setView).not.toHaveBeenCalled();
  });

  it('a solid-js lazy() component is not a view (its function is the wrapper `wrap`, carrying `preload`)', () => {
    const lazyShaped = Object.assign(
      function wrap() {
        return null;
      },
      { preload: () => Promise.resolve() },
    );
    expect(viewNameFromSolidMatches(page(lazyShaped))).toBeUndefined();
    // even when a build kept a real-looking name, a function carrying `preload` is lazy()'s wrapper
    const named = Object.assign(
      function Dashboard() {
        return null;
      },
      { preload: () => Promise.resolve() },
    );
    expect(viewNameFromSolidMatches(page(named))).toBeUndefined();
  });

  it('a component with a non-function `preload` is still named', () => {
    const odd = Object.assign(function Dashboard() {}, { preload: true });
    expect(viewNameFromSolidMatches(page(odd))).toBe('Dashboard');
  });

  it('end to end: a lazy route writes its route but no view', () => {
    const setRoute = vi.fn();
    const setView = vi.fn();
    const full = {
      setRoute,
      setView,
      ext: () => ({ setRouteName: () => {} }),
    } as unknown as Bugsee;
    const lazyShaped = Object.assign(function wrap() {}, { preload: () => Promise.resolve() });
    setRouteNameFromSolidMatches(page(lazyShaped), { getClient: () => full });
    expect(setRoute).toHaveBeenCalledExactlyOnceWith('/orders/:id');
    expect(setView).not.toHaveBeenCalled();
  });
});
