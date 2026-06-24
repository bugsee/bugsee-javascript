import type { Bugsee } from '@bugsee/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AngularRouterLike,
  type RouteSnapshotLike,
  routePatternFromSnapshot,
  setRouteName,
  setRouteNameFromRouter,
} from './router';

function fakeClient() {
  const setRouteNameSpy = vi.fn();
  const ext = vi.fn((name: string) => {
    if (name === 'performance') return { setRouteName: setRouteNameSpy };
    throw new Error(`extension ${name} not registered`);
  });
  return { client: { ext } as unknown as Bugsee, setRouteName: setRouteNameSpy };
}

// Build a snapshot chain (root → firstChild → …) from a list of route-config paths.
const chain = (...paths: Array<string | undefined>): RouteSnapshotLike => {
  let node: RouteSnapshotLike | undefined;
  for (let i = paths.length - 1; i >= 0; i--) {
    node = {
      routeConfig: paths[i] === undefined ? null : { path: paths[i] },
      firstChild: node ?? null,
    };
  }
  return node ?? { firstChild: null };
};

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('routePatternFromSnapshot', () => {
  it('joins the route-config path segments down the activated tree into the full pattern', () => {
    // root (no config) → 'users' → ':id'  ⇒  /users/:id
    expect(routePatternFromSnapshot(chain(undefined, 'users', ':id'))).toBe('/users/:id');
  });

  it('skips empty / pathless / componentless segments', () => {
    expect(routePatternFromSnapshot(chain(undefined, '', 'teams', ':teamId'))).toBe(
      '/teams/:teamId',
    );
  });

  it('returns undefined when there is no usable path (root only / empty tree)', () => {
    expect(routePatternFromSnapshot(chain(undefined))).toBeUndefined();
    expect(routePatternFromSnapshot(null)).toBeUndefined();
    expect(routePatternFromSnapshot(undefined)).toBeUndefined();
  });

  it('is bounded against a pathological self-referential tree (no infinite loop)', () => {
    const cyclic: RouteSnapshotLike = { routeConfig: { path: 'a' } };
    cyclic.firstChild = cyclic; // pathological
    expect(() => routePatternFromSnapshot(cyclic)).not.toThrow();
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

describe('setRouteNameFromRouter', () => {
  const routerWith = (root: RouteSnapshotLike): AngularRouterLike => ({
    routerState: { snapshot: { root } },
  });

  it('reads the current snapshot and refines the active transaction to the route pattern', () => {
    const { client, setRouteName: spy } = fakeClient();
    setRouteNameFromRouter(routerWith(chain(undefined, 'orders', ':orderId')), {
      getClient: () => client,
    });
    expect(spy).toHaveBeenCalledWith('/orders/:orderId');
  });

  it('does nothing when the current snapshot has no usable pattern', () => {
    const { client, setRouteName: spy } = fakeClient();
    setRouteNameFromRouter(routerWith(chain(undefined)), { getClient: () => client });
    expect(spy).not.toHaveBeenCalled();
  });
});
