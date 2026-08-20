import type { Bugsee } from '@bugsee/browser';
import { BUGSEE_SDK_VERSION } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  instrumentVueRouter,
  routePatternFromVueRoute,
  setRouteName,
  type VueRouteLike,
  type VueRouterLike,
} from './router';

function fakeClient() {
  const setRouteNameSpy = vi.fn();
  const ext = vi.fn((name: string) => {
    if (name === 'performance') return { setRouteName: setRouteNameSpy };
    throw new Error(`extension ${name} not registered`);
  });
  return { client: { ext } as unknown as Bugsee, setRouteName: setRouteNameSpy };
}

const route = (matched: Array<{ path?: string }>): VueRouteLike => ({ matched });

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('routePatternFromVueRoute', () => {
  it('uses the DEEPEST matched record path (the full parameterized pattern)', () => {
    // vue-router normalizes nested children to absolute paths, so the last record carries the full pattern.
    expect(routePatternFromVueRoute(route([{ path: '/users' }, { path: '/users/:id' }]))).toBe(
      '/users/:id',
    );
  });

  it('returns undefined when there is no matched record or no pattern', () => {
    expect(routePatternFromVueRoute(route([]))).toBeUndefined();
    expect(routePatternFromVueRoute({})).toBeUndefined();
    expect(routePatternFromVueRoute(route([{ path: '' }]))).toBeUndefined();
    expect(routePatternFromVueRoute(route([{}]))).toBeUndefined();
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

describe('instrumentVueRouter', () => {
  it('registers an afterEach that refines the active transaction to the matched route pattern', () => {
    const { client, setRouteName: spy } = fakeClient();
    let guard: ((to: VueRouteLike) => void) | undefined;
    const router: VueRouterLike = {
      afterEach: (g) => {
        guard = g;
      },
    };
    instrumentVueRouter(router, { getClient: () => client });
    guard?.(route([{ path: '/orders/:orderId' }])); // a navigation resolves
    expect(spy).toHaveBeenCalledWith('/orders/:orderId');
  });

  it('does nothing for a navigation with no usable route pattern (setRouteName not called)', () => {
    const { client, setRouteName: spy } = fakeClient();
    let guard: ((to: VueRouteLike) => void) | undefined;
    instrumentVueRouter(
      {
        afterEach: (g) => {
          guard = g;
        },
      },
      { getClient: () => client },
    );
    guard?.(route([])); // no matched record
    expect(spy).not.toHaveBeenCalled();
  });
});
