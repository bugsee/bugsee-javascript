import type { Bugsee } from '@bugsee/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AfterNavigateLike,
  instrumentSvelteKitNavigation,
  routeIdFromNavigation,
  setRouteName,
} from './router';

function fakeClient() {
  const setRouteNameSpy = vi.fn();
  const ext = vi.fn((name: string) => {
    if (name === 'performance') return { setRouteName: setRouteNameSpy };
    throw new Error(`extension ${name} not registered`);
  });
  return { client: { ext } as unknown as Bugsee, setRouteName: setRouteNameSpy };
}

const nav = (id: string | null | undefined): AfterNavigateLike => ({ to: { route: { id } } });

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('routeIdFromNavigation', () => {
  it('reads the route id from the navigation target (SvelteKit pattern, e.g. /users/[id])', () => {
    expect(routeIdFromNavigation(nav('/users/[id]'))).toBe('/users/[id]');
  });

  it('returns undefined when there is no route id (null id, missing to/route)', () => {
    expect(routeIdFromNavigation(nav(null))).toBeUndefined();
    expect(routeIdFromNavigation(nav(''))).toBeUndefined();
    expect(routeIdFromNavigation({ to: null })).toBeUndefined();
    expect(routeIdFromNavigation({})).toBeUndefined();
  });
});

describe('setRouteName', () => {
  it('refines the active transaction via ext(performance).setRouteName', () => {
    const { client, setRouteName: spy } = fakeClient();
    setRouteName('/users/[id]', { getClient: () => client });
    expect(spy).toHaveBeenCalledWith('/users/[id]');
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

describe('instrumentSvelteKitNavigation', () => {
  it('returns an afterNavigate callback that refines the active transaction to the route id', () => {
    const { client, setRouteName: spy } = fakeClient();
    const onNavigate = instrumentSvelteKitNavigation({ getClient: () => client });
    onNavigate(nav('/orders/[orderId]'));
    expect(spy).toHaveBeenCalledWith('/orders/[orderId]');
  });

  it('does nothing for a navigation with no route id (setRouteName not called)', () => {
    const { client, setRouteName: spy } = fakeClient();
    const onNavigate = instrumentSvelteKitNavigation({ getClient: () => client });
    onNavigate(nav(null));
    expect(spy).not.toHaveBeenCalled();
  });
});
