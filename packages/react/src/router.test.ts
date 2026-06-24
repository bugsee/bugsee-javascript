import type { Bugsee } from '@bugsee/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  instrumentRouterMatches,
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
