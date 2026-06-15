import type { Bugsee, RequestContextStore } from '@bugsee/node';
import { describe, expect, it, vi } from 'vitest';
import {
  buildContext,
  defaultGetClient,
  defaultShouldReport,
  headerValue,
  httpExceptionStatus,
  isServerError,
  matchedRoute,
  type NestHttpRequest,
  reportErrorOnce,
  requestName,
  resolveStore,
  tryGetPerf,
} from './shared';

// ── Fakes (injection-first; structural casts to the real upstream types) ──
const fakeStore = (): RequestContextStore & { setAttribute: ReturnType<typeof vi.fn> } =>
  ({
    getCurrent: vi.fn(),
    run: vi.fn(),
    enterWith: vi.fn(),
    setAttribute: vi.fn(),
    setTrace: vi.fn(),
  }) as unknown as RequestContextStore & { setAttribute: ReturnType<typeof vi.fn> };

const fakeClient = (opts: {
  store?: RequestContextStore;
  perf?: unknown;
  perfThrows?: boolean;
  logException?: ReturnType<typeof vi.fn>;
}): Bugsee =>
  ({
    getServiceProvider: () => ({ getImmediate: () => opts.store ?? undefined }),
    ext: () => {
      if (opts.perfThrows) throw new Error('no performance extension');
      return opts.perf;
    },
    logException: opts.logException ?? vi.fn(() => Promise.resolve()),
  }) as unknown as Bugsee;

const req = (over: Partial<NestHttpRequest> = {}): NestHttpRequest => ({
  headers: {},
  ...over,
});

describe('headerValue', () => {
  it('returns a string header verbatim', () => {
    expect(headerValue({ traceparent: 'abc' }, 'traceparent')).toBe('abc');
  });
  it('returns the first element of an array header', () => {
    expect(headerValue({ traceparent: ['first', 'second'] }, 'traceparent')).toBe('first');
  });
  it('returns undefined for a missing header', () => {
    expect(headerValue({}, 'traceparent')).toBeUndefined();
  });
});

describe('matchedRoute', () => {
  it('returns the express route path', () => {
    expect(matchedRoute(req({ route: { path: '/users/:id' } }))).toBe('/users/:id');
  });
  it('returns the fastify routeOptions url', () => {
    expect(matchedRoute(req({ routeOptions: { url: '/items/:id' } }))).toBe('/items/:id');
  });
  it('prefers the express route path over the fastify routeOptions url', () => {
    expect(
      matchedRoute(req({ route: { path: '/express' }, routeOptions: { url: '/fastify' } })),
    ).toBe('/express');
  });
  it('returns undefined before routing (neither present)', () => {
    expect(matchedRoute(req())).toBeUndefined();
  });
});

describe('requestName', () => {
  it('combines method and the matched route', () => {
    expect(requestName(req({ method: 'POST', route: { path: '/users/:id' } }))).toBe(
      'POST /users/:id',
    );
  });
  it('falls back to originalUrl then url when no route matched', () => {
    expect(requestName(req({ method: 'GET', originalUrl: '/raw?q=1' }))).toBe('GET /raw?q=1');
    expect(requestName(req({ method: 'GET', url: '/u' }))).toBe('GET /u');
  });
  it('defaults the method to GET and the path to empty', () => {
    expect(requestName(req())).toBe('GET ');
  });
});

describe('buildContext', () => {
  it('uses newContextId and stamps http.method/http.url attributes', () => {
    const ctx = buildContext(req({ method: 'PUT', originalUrl: '/a' }), () => 'cid-1', undefined);
    expect(ctx.contextId).toBe('cid-1');
    expect(ctx.attributes).toEqual({ 'http.method': 'PUT', 'http.url': '/a' });
    expect(ctx.user).toBeUndefined();
    // the `user` key is OMITTED (not present-but-undefined) when no user is resolved
    expect('user' in ctx).toBe(false);
  });
  it('includes the user when provided', () => {
    const ctx = buildContext(req(), () => 'cid', 'alice@example.com');
    expect(ctx.user).toBe('alice@example.com');
  });
  it('defaults method to GET and url from url then empty', () => {
    expect(buildContext(req({ url: '/x' }), () => 'c', undefined).attributes).toEqual({
      'http.method': 'GET',
      'http.url': '/x',
    });
    expect(buildContext(req(), () => 'c', undefined).attributes).toEqual({
      'http.method': 'GET',
      'http.url': '',
    });
  });
});

describe('defaultGetClient', () => {
  it('returns undefined when no carrier client is launched', () => {
    expect(defaultGetClient()).toBeUndefined();
  });
});

describe('resolveStore', () => {
  it('returns the store the client provides', () => {
    const store = fakeStore();
    expect(resolveStore(fakeClient({ store }))).toBe(store);
  });
  it('returns undefined when the provider yields none', () => {
    expect(resolveStore(fakeClient({}))).toBeUndefined();
  });
});

describe('tryGetPerf', () => {
  it('returns the performance extension when present', () => {
    const perf = { startTransaction: vi.fn() };
    expect(tryGetPerf(fakeClient({ perf }))).toBe(perf);
  });
  it('returns undefined when ext() throws (extension not registered)', () => {
    expect(tryGetPerf(fakeClient({ perfThrows: true }))).toBeUndefined();
  });
});

describe('httpExceptionStatus', () => {
  it('returns the numeric status of an HttpException-like error', () => {
    expect(httpExceptionStatus({ getStatus: () => 404 })).toBe(404);
    expect(httpExceptionStatus({ getStatus: () => 500 })).toBe(500);
  });
  it('returns undefined for a non-HttpException (no getStatus function)', () => {
    expect(httpExceptionStatus(new Error('x'))).toBeUndefined();
    expect(httpExceptionStatus('boom')).toBeUndefined();
    expect(httpExceptionStatus(null)).toBeUndefined();
    expect(httpExceptionStatus(undefined)).toBeUndefined();
    expect(httpExceptionStatus({ getStatus: 500 })).toBeUndefined();
  });
  it('returns undefined when getStatus does not return a number', () => {
    expect(httpExceptionStatus({ getStatus: () => 'oops' })).toBeUndefined();
  });
});

describe('defaultShouldReport', () => {
  it('reports a plain Error', () => {
    expect(defaultShouldReport(new Error('boom'))).toBe(true);
  });
  it('skips any HttpException (4xx AND 5xx — control flow)', () => {
    expect(defaultShouldReport({ getStatus: () => 404 })).toBe(false);
    expect(defaultShouldReport({ getStatus: () => 500 })).toBe(false);
  });
  it('reports a string / null / undefined', () => {
    expect(defaultShouldReport('boom')).toBe(true);
    expect(defaultShouldReport(null)).toBe(true);
    expect(defaultShouldReport(undefined)).toBe(true);
  });
  it('reports an object whose getStatus is not a function', () => {
    expect(defaultShouldReport({ getStatus: 500 })).toBe(true);
  });
});

describe('isServerError', () => {
  it('is true for a non-HttpException (genuine unhandled error → transaction ERROR)', () => {
    expect(isServerError(new Error('boom'))).toBe(true);
    expect(isServerError('boom')).toBe(true);
  });
  it('is true for a 5xx HttpException', () => {
    expect(isServerError({ getStatus: () => 500 })).toBe(true);
    expect(isServerError({ getStatus: () => 503 })).toBe(true);
  });
  it('is false for a 4xx HttpException (client control flow → transaction OK)', () => {
    expect(isServerError({ getStatus: () => 404 })).toBe(false);
    expect(isServerError({ getStatus: () => 400 })).toBe(false);
  });
});

describe('reportErrorOnce', () => {
  const always = () => true;
  it('does not report when shouldReport returns false', () => {
    const logException = vi.fn(() => Promise.resolve());
    const reported = reportErrorOnce(fakeClient({ logException }), new Error('x'), {
      shouldReport: () => false,
    });
    expect(reported).toBe(false);
    expect(logException).not.toHaveBeenCalled();
  });
  it('reports with mechanism http-error and returns true', () => {
    const logException = vi.fn(() => Promise.resolve());
    const err = new Error('boom');
    const reported = reportErrorOnce(fakeClient({ logException }), err, { shouldReport: always });
    expect(reported).toBe(true);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
  });
  it('sets http.route on the store before reporting when a route is given', () => {
    const store = fakeStore();
    const logException = vi.fn(() => Promise.resolve());
    reportErrorOnce(fakeClient({ store, logException }), new Error('boom'), {
      shouldReport: always,
      route: '/users/:id',
    });
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/users/:id');
  });
  it('does not touch the store when no route is given', () => {
    const store = fakeStore();
    reportErrorOnce(
      fakeClient({ store, logException: vi.fn(() => Promise.resolve()) }),
      new Error('x'),
      {
        shouldReport: always,
      },
    );
    expect(store.setAttribute).not.toHaveBeenCalled();
  });
  it('does not throw when a route is given but no store is resolvable', () => {
    const logException = vi.fn(() => Promise.resolve());
    expect(() =>
      reportErrorOnce(fakeClient({ logException }), new Error('boom'), {
        shouldReport: always,
        route: '/r',
      }),
    ).not.toThrow();
    expect(logException).toHaveBeenCalled();
  });
  it('dedups an object error across calls when a reported set is shared', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const err = new Error('boom');
    const reported = new WeakSet<object>();
    expect(reportErrorOnce(client, err, { shouldReport: always, reported })).toBe(true);
    expect(reportErrorOnce(client, err, { shouldReport: always, reported })).toBe(false);
    expect(logException).toHaveBeenCalledTimes(1);
  });
  it('cannot dedup a primitive error (always reports)', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const reported = new WeakSet<object>();
    expect(reportErrorOnce(client, 'boom', { shouldReport: always, reported })).toBe(true);
    expect(reportErrorOnce(client, 'boom', { shouldReport: always, reported })).toBe(true);
    expect(logException).toHaveBeenCalledTimes(2);
  });
});
