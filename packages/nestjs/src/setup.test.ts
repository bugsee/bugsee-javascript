import type { Bugsee } from '@bugsee/node';
import { BaseExceptionFilter } from '@nestjs/core';
import { throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BugseeExceptionFilter } from './filter';
import { BugseeInterceptor, type CallHandlerLike, type ExecutionContextLike } from './interceptor';
import { type NestApp, setupNest } from './setup';
import type { NestHttpRequest } from './shared';

const fakeApp = () => ({
  use: vi.fn(),
  useGlobalInterceptors: vi.fn(),
  useGlobalFilters: vi.fn(),
  getHttpAdapter: vi.fn(() => ({})),
});

const fakeClient = (logException = vi.fn(() => Promise.resolve())): Bugsee =>
  ({
    getServiceProvider: () => ({ getImmediate: () => undefined }),
    ext: () => {
      throw new Error('no ext');
    },
    logException,
  }) as unknown as Bugsee;

const ctx = (): ExecutionContextLike =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', url: '/u', headers: {} }) as NestHttpRequest,
      getResponse: () => ({}),
    }),
  }) as unknown as ExecutionContextLike;

describe('setupNest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('always installs the context middleware (a function) via app.use', () => {
    const app = fakeApp();
    setupNest(app as unknown as NestApp);
    expect(app.use).toHaveBeenCalledTimes(1);
    expect(typeof app.use.mock.calls[0]?.[0]).toBe('function');
  });

  it('defaults to the interceptor seam only (no filter)', () => {
    const app = fakeApp();
    setupNest(app as unknown as NestApp);
    expect(app.useGlobalInterceptors).toHaveBeenCalledTimes(1);
    expect(app.useGlobalInterceptors.mock.calls[0]?.[0]).toBeInstanceOf(BugseeInterceptor);
    expect(app.useGlobalFilters).not.toHaveBeenCalled();
    expect(app.getHttpAdapter).not.toHaveBeenCalled();
  });

  it("errorCapture 'filter' installs only the filter (with the http adapter), not the interceptor", () => {
    const app = fakeApp();
    setupNest(app as unknown as NestApp, { errorCapture: 'filter' });
    expect(app.useGlobalInterceptors).not.toHaveBeenCalled();
    expect(app.useGlobalFilters).toHaveBeenCalledTimes(1);
    expect(app.useGlobalFilters.mock.calls[0]?.[0]).toBeInstanceOf(BugseeExceptionFilter);
    expect(app.getHttpAdapter).toHaveBeenCalledTimes(1);
  });

  it("errorCapture 'both' installs interceptor AND filter", () => {
    const app = fakeApp();
    setupNest(app as unknown as NestApp, { errorCapture: 'both' });
    expect(app.useGlobalInterceptors).toHaveBeenCalledTimes(1);
    expect(app.useGlobalFilters).toHaveBeenCalledTimes(1);
  });

  it("errorCapture 'both' shares a dedup set — an error caught by BOTH seams reports once", () => {
    // Stub super.catch so the filter does not need a real http adapter.
    vi.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient(logException);
    const app = fakeApp();
    setupNest(app as unknown as NestApp, { errorCapture: 'both', getClient: () => client });

    const interceptor = app.useGlobalInterceptors.mock.calls[0]?.[0] as BugseeInterceptor;
    const filter = app.useGlobalFilters.mock.calls[0]?.[0] as BugseeExceptionFilter;
    const err = new Error('shared boom');

    // 1) interceptor sees + reports it
    interceptor
      .intercept(ctx(), { handle: () => throwError(() => err) } as CallHandlerLike)
      .subscribe({ error: () => undefined });
    // 2) the SAME error reaches the filter (e.g. it also bubbled to the catch-all) → deduped
    filter.catch(err, {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/u', headers: {} }),
        getResponse: () => ({}),
      }),
    } as never);

    expect(logException).toHaveBeenCalledTimes(1); // reported ONCE across the two seams
  });

  it('passes adapter options through to the interceptor (custom shouldReport honored)', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient(logException);
    const app = fakeApp();
    setupNest(app as unknown as NestApp, {
      getClient: () => client,
      shouldReport: () => true, // would normally skip HttpExceptions; force-report
    });
    const interceptor = app.useGlobalInterceptors.mock.calls[0]?.[0] as BugseeInterceptor;
    const httpErr = { getStatus: () => 404 };
    interceptor
      .intercept(ctx(), { handle: () => throwError(() => httpErr) } as CallHandlerLike)
      .subscribe({ error: () => undefined });
    expect(logException).toHaveBeenCalledWith(httpErr, { mechanism: 'http-error' });
  });

  it('the installed middleware is a no-op pass-through when no client is launched', () => {
    const app = fakeApp();
    setupNest(app as unknown as NestApp, { getClient: () => undefined });
    const middleware = app.use.mock.calls[0]?.[0] as (
      r: unknown,
      s: unknown,
      n: () => void,
    ) => void;
    const next = vi.fn();
    middleware({ method: 'GET', url: '/', headers: {} }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
