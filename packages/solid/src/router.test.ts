import type { Bugsee } from '@bugsee/browser';
import { BUGSEE_SDK_VERSION } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  routePatternFromSolidMatches,
  type SolidRouteMatchLike,
  setRouteName,
  setRouteNameFromSolidMatches,
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
