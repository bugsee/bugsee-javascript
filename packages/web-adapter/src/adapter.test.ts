import type { Bugsee } from '@bugsee/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPerformanceApi, reportError, resolveClient, setRouteName } from './adapter';

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
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { '0.0.0': { client } };
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
    expect(() => reportError(new Error('x'), { getClient: () => undefined })).not.toThrow();
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
