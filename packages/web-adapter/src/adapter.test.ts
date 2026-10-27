import type { Bugsee } from '@bugsee/browser';
import { BUGSEE_SDK_VERSION } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPerformanceApi,
  isObtainableViewName,
  reportError,
  resolveClient,
  setRouteName,
  setViewName,
} from './adapter';

function fakeClient() {
  const logException = vi.fn(
    (
      _error: unknown,
      _options?: { mechanism?: string; labels?: string[] },
    ): Promise<{ ok: true }> => Promise.resolve({ ok: true }),
  );
  const setRouteNameSpy = vi.fn();
  const ext = vi.fn((name: string) => {
    if (name === 'performance') return { setRouteName: setRouteNameSpy };
    throw new Error(`extension ${name} not registered`);
  });
  return {
    client: { logException, ext } as unknown as Bugsee,
    logException,
    setRouteName: setRouteNameSpy,
  };
}

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('resolveClient', () => {
  it('returns the injected client', () => {
    const { client } = fakeClient();
    expect(resolveClient(() => client)).toBe(client);
  });

  it('falls back to the carrier client when no resolver is given', () => {
    const { client } = fakeClient();
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { [BUGSEE_SDK_VERSION]: { client } };
    expect(resolveClient()).toBe(client);
  });

  it('returns undefined when nothing is resolvable', () => {
    expect(resolveClient()).toBeUndefined();
    expect(resolveClient(() => undefined)).toBeUndefined();
  });
});

describe('reportError', () => {
  it('reports via logException with the default `uncaught` mechanism', () => {
    const { client, logException } = fakeClient();
    const err = new Error('boom');
    reportError(err, { getClient: () => client });
    expect(logException).toHaveBeenCalledTimes(1);
    expect(logException.mock.calls[0]?.[0]).toBe(err);
    expect(logException.mock.calls[0]?.[1]?.mechanism).toBe('uncaught');
  });

  it('threads a mechanism override and labels through', () => {
    const { client, logException } = fakeClient();
    reportError(new Error('x'), {
      getClient: () => client,
      mechanism: 'programmatic',
      labels: ['a', 'b'],
    });
    const opts = logException.mock.calls[0]?.[1];
    expect(opts?.mechanism).toBe('programmatic');
    expect(opts?.labels).toEqual(['a', 'b']);
  });

  it('omits the labels key entirely when no labels are given', () => {
    const { client, logException } = fakeClient();
    reportError(new Error('x'), { getClient: () => client });
    expect('labels' in (logException.mock.calls[0]?.[1] ?? {})).toBe(false);
  });

  it('is a no-op when no client is resolvable', () => {
    // `not.toThrow()` alone cannot fail: `neverThrow` guarantees it whether or not the guard exists.
    // Deleting `if (client === undefined) return` calls `logException` on undefined, which throws INTO
    // neverThrow and reports an SDK-internal error for the ordinary "SDK not launched" case. `onError`
    // staying silent is what distinguishes a real no-op from a swallowed TypeError.
    const onError = vi.fn();
    expect(() =>
      reportError(new Error('x'), { getClient: () => undefined, onError }),
    ).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('getPerformanceApi', () => {
  it('returns the client`s performance extension', () => {
    const perfApi = { getActiveSpan: () => undefined };
    const client = {
      ext: (name: string) => {
        if (name === 'performance') return perfApi;
        throw new Error('nope');
      },
    } as unknown as Bugsee;
    expect(getPerformanceApi(() => client)).toBe(perfApi);
  });

  it('returns undefined when no client / the ext is not registered', () => {
    // NOTE, for anyone doing a teeth check here: `getPerformanceApi`'s own `client === undefined` guard is
    // a PROVEN EQUIVALENT MUTANT, like `setRouteName`'s — `tryGetPerf`'s internal `catch` absorbs the
    // undefined access and returns undefined either way. So there are FOUR no-client guards in this
    // package with TWO equivalent survivors, not three with one; a commit message of mine said otherwise,
    // and also named the wrong one of the pair. The two that DO have teeth are `reportError`'s and
    // `recordRenderSpan`'s, both pinned by `expect(onError).not.toHaveBeenCalled()`.
    expect(getPerformanceApi(() => undefined)).toBeUndefined();
    const noPerf = {
      ext: () => {
        throw new Error('not registered');
      },
    } as unknown as Bugsee;
    expect(getPerformanceApi(() => noPerf)).toBeUndefined();
  });
});

describe('setRouteName', () => {
  it('refines the active transaction via ext(performance).setRouteName', () => {
    const { client, setRouteName: spy } = fakeClient();
    setRouteName('/users/:id', { getClient: () => client });
    expect(spy).toHaveBeenCalledWith('/users/:id');
  });

  it('is a no-op when no client is resolvable', () => {
    // Same assertion as reportError's, for the same reason — though here the guard is provably EQUIVALENT
    // to no guard (`tryGetPerf`'s own catch absorbs the undefined access), so this pins the no-op contract
    // rather than the guard. Recorded so a future reader does not mistake it for a teeth check.
    const onError = vi.fn();
    expect(() => setRouteName('/x', { getClient: () => undefined, onError })).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });

  it('is a no-op when the performance extension is not registered (ext throws)', () => {
    // `not.toThrow()` alone cannot fail here either — `neverThrow` guarantees it. What has teeth is
    // `onError`: without `tryGetPerf(client)?.` the undefined perf API is called, which throws INTO
    // `neverThrow` and reports an SDK-internal error every time an app runs with `performanceMonitoring`
    // off. A real no-op reports nothing. (This assertion was missing; the `?.` mutant survived.)
    const client = {
      ext: () => {
        throw new Error('not registered');
      },
    } as unknown as Bugsee;
    const onError = vi.fn();
    expect(() => setRouteName('/x', { getClient: () => client, onError })).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });

  it('falls back to the carrier client when no getClient is injected', () => {
    const { client, setRouteName: spy } = fakeClient();
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { [BUGSEE_SDK_VERSION]: { client } };
    setRouteName('/dash');
    expect(spy).toHaveBeenCalledWith('/dash');
  });
});

describe('setRouteName: the route trace feed', () => {
  const withRoute = () => {
    const setRoute = vi.fn();
    const base = fakeClient();
    return {
      ...base,
      setRoute,
      client: { ...(base.client as object), setRoute } as unknown as Bugsee,
    };
  };

  it('feeds client.setRoute with the pattern, as well as the performance naming seam', () => {
    const { client, setRoute, setRouteName: perf } = withRoute();
    setRouteName('/users/:id', { getClient: () => client });
    expect(setRoute).toHaveBeenCalledExactlyOnceWith('/users/:id');
    expect(perf).toHaveBeenCalledWith('/users/:id');
  });

  it('feeds setRoute even without the performance extension (performanceMonitoring off)', () => {
    const setRoute = vi.fn();
    const onError = vi.fn();
    const client = {
      setRoute,
      ext: () => {
        throw new Error('not registered');
      },
    } as unknown as Bugsee;
    setRouteName('/a', { getClient: () => client, onError });
    expect(setRoute).toHaveBeenCalledWith('/a');
    expect(onError).not.toHaveBeenCalled();
  });

  it('a throwing setRoute is reported and does not stop the performance feed', () => {
    const { client: base, setRouteName: perf } = fakeClient();
    const boom = new Error('boom');
    const client = {
      ...(base as object),
      setRoute: () => {
        throw boom;
      },
    } as unknown as Bugsee;
    const onError = vi.fn();
    setRouteName('/a', { getClient: () => client, onError });
    expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
    expect(perf).toHaveBeenCalledWith('/a');
  });

  it('a throwing performance feed does not stop setRoute', () => {
    const setRoute = vi.fn();
    const client = {
      setRoute,
      ext: () => ({
        setRouteName: () => {
          throw new Error('perf');
        },
      }),
    } as unknown as Bugsee;
    const onError = vi.fn();
    setRouteName('/a', { getClient: () => client, onError });
    expect(setRoute).toHaveBeenCalledWith('/a');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('an older client without setRoute is not an error', () => {
    const { client } = fakeClient(); // no setRoute
    const onError = vi.fn();
    setRouteName('/a', { getClient: () => client, onError });
    expect(onError).not.toHaveBeenCalled();
  });

  it('a setRoute that is not a function (a foreign client shape) is ignored, not reported', () => {
    const client = {
      setRoute: 'nope',
      ext: () => {
        throw new Error('x');
      },
    } as unknown as Bugsee;
    const onError = vi.fn();
    setRouteName('/a', { getClient: () => client, onError });
    expect(onError).not.toHaveBeenCalled();
  });

  it('does nothing without a client', () => {
    const onError = vi.fn();
    setRouteName('/a', { getClient: () => undefined, onError });
    expect(onError).not.toHaveBeenCalled();
  });

  it('calls setRoute as a method of the client (this is kept)', () => {
    let self: unknown;
    const client = {
      ext: () => {
        throw new Error('x');
      },
      setRoute(this: unknown) {
        self = this;
      },
    } as unknown as Bugsee;
    setRouteName('/a', { getClient: () => client });
    expect(self).toBe(client);
  });
});

describe('isObtainableViewName', () => {
  it.each([
    ['OrderDetail', true],
    ['Cart', true],
    ['abc', true],
    ['  abc  ', true],
    ['ab', false],
    ['a', false],
    ['', false],
    ['   ', false],
    [' a ', false],
    [undefined, false],
    [null, false],
    [5, false],
    [{}, false],
  ])('%j -> %s', (name, expected) => {
    expect(isObtainableViewName(name)).toBe(expected);
  });
});

describe('setViewName: the best-effort view trace feed', () => {
  it('feeds client.setView with {name, type} (the adapter id)', () => {
    const setView = vi.fn();
    const client = { setView } as unknown as Bugsee;
    setViewName('  OrderDetail ', 'react', { getClient: () => client });
    expect(setView).toHaveBeenCalledExactlyOnceWith({ name: 'OrderDetail', type: 'react' });
  });

  it('writes nothing for an unobtainable (empty, minified, non-string) name', () => {
    const setView = vi.fn();
    const client = { setView } as unknown as Bugsee;
    for (const bad of ['', 'e', 'ab', undefined, null, 7, {}]) {
      setViewName(bad, 'vue', { getClient: () => client });
    }
    expect(setView).not.toHaveBeenCalled();
  });

  it('a throwing setView is reported, never rethrown', () => {
    const boom = new Error('boom');
    const client = {
      setView: () => {
        throw boom;
      },
    } as unknown as Bugsee;
    const onError = vi.fn();
    expect(() => setViewName('Detail', 'vue', { getClient: () => client, onError })).not.toThrow();
    expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
  });

  it('is silent without a client or with an older client that has no setView', () => {
    const onError = vi.fn();
    setViewName('Detail', 'vue', { getClient: () => undefined, onError });
    setViewName('Detail', 'vue', { getClient: () => ({}) as unknown as Bugsee, onError });
    expect(onError).not.toHaveBeenCalled();
  });

  it('calls setView as a method of the client, and falls back to the carrier client', () => {
    let self: unknown;
    const client = {
      setView(this: unknown) {
        self = this;
      },
    } as unknown as Bugsee;
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { [BUGSEE_SDK_VERSION]: { client } };
    setViewName('Detail', 'solid');
    expect(self).toBe(client);
  });
});

describe('setRouteName: one client resolution per call', () => {
  it('calls getClient once for both feeds', () => {
    const setRoute = vi.fn();
    const { client: base, setRouteName: perf } = fakeClient();
    const client = { ...(base as object), setRoute } as unknown as Bugsee;
    const getClient = vi.fn(() => client);
    setRouteName('/a', { getClient });
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(setRoute).toHaveBeenCalledWith('/a');
    expect(perf).toHaveBeenCalledWith('/a');
  });

  it('a throwing getClient is reported once, not once per feed', () => {
    const boom = new Error('boom');
    const onError = vi.fn();
    setRouteName('/a', {
      getClient: () => {
        throw boom;
      },
      onError,
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
  });
});

describe('isObtainableViewName: wrapper names are not view names', () => {
  it.each([
    'wrap', // solid-js lazy()
    'AsyncComponentWrapper', // vue defineAsyncComponent
    'Navigate',
    'RequireAuth',
    'Outlet',
    'Suspense',
    'Fragment',
    'anonymous',
    'Anonymous',
    '  wrap ',
  ])('%s is rejected', (name) => {
    expect(isObtainableViewName(name)).toBe(false);
  });

  it('keeps a real name that merely contains one', () => {
    expect(isObtainableViewName('RequireAuthPage')).toBe(true);
    expect(isObtainableViewName('Wrapped')).toBe(true);
    expect(isObtainableViewName('NavigateButton')).toBe(true);
  });

  it('setViewName writes nothing for a wrapper name', () => {
    const setView = vi.fn();
    setViewName('wrap', 'solid', { getClient: () => ({ setView }) as unknown as Bugsee });
    expect(setView).not.toHaveBeenCalled();
  });
});
