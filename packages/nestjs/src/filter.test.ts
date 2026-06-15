import type { Bugsee, RequestContextStore } from '@bugsee/node';
import type { ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BugseeExceptionCaptured, BugseeExceptionFilter } from './filter';
import type { NestHttpRequest } from './shared';

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
  logException?: ReturnType<typeof vi.fn>;
}): Bugsee =>
  ({
    getServiceProvider: () => ({ getImmediate: () => opts.store ?? undefined }),
    ext: () => {
      throw new Error('no ext');
    },
    logException: opts.logException ?? vi.fn(() => Promise.resolve()),
  }) as unknown as Bugsee;

const host = (req: NestHttpRequest): ArgumentsHost =>
  ({
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  }) as unknown as ArgumentsHost;

const req = (over: Partial<NestHttpRequest> = {}): NestHttpRequest => ({
  method: 'GET',
  url: '/u',
  headers: {},
  ...over,
});

describe('BugseeExceptionFilter', () => {
  // Stub the real BaseExceptionFilter.catch so the unit test does not need a running Nest http adapter;
  // the real super.catch delegation (response preservation) is proven by the integration test (S6).
  let superCatch: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    superCatch = vi
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation(() => undefined) as ReturnType<typeof vi.spyOn>;
  });
  afterEach(() => {
    superCatch.mockRestore();
  });

  it('reports the exception (mechanism http-error) then DELEGATES to super.catch', () => {
    const logException = vi.fn(() => Promise.resolve());
    const filter = new BugseeExceptionFilter({ getClient: () => fakeClient({ logException }) });
    const err = new Error('boom');
    const h = host(req());
    filter.catch(err, h);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(superCatch).toHaveBeenCalledWith(err, h); // Nest still formats the response
  });

  it('skips reporting an HttpException by default but still delegates', () => {
    const logException = vi.fn(() => Promise.resolve());
    const filter = new BugseeExceptionFilter({ getClient: () => fakeClient({ logException }) });
    const httpErr = { getStatus: () => 403 };
    filter.catch(httpErr, host(req()));
    expect(logException).not.toHaveBeenCalled();
    expect(superCatch).toHaveBeenCalledTimes(1);
  });

  it('delegates (and does not report) when no client is launched', () => {
    const filter = new BugseeExceptionFilter({ getClient: () => undefined });
    filter.catch(new Error('boom'), host(req()));
    expect(superCatch).toHaveBeenCalledTimes(1);
  });

  it('delegates even when getClient throws (reporting never replaces Nest handling)', () => {
    const filter = new BugseeExceptionFilter({
      getClient: () => {
        throw new Error('resolve failed');
      },
    });
    const err = new Error('boom');
    const h = host(req());
    expect(() => filter.catch(err, h)).not.toThrow();
    expect(superCatch).toHaveBeenCalledWith(err, h);
  });

  it('stamps http.route from the matched route before reporting', () => {
    const store = fakeStore();
    const filter = new BugseeExceptionFilter({ getClient: () => fakeClient({ store }) });
    filter.catch(new Error('boom'), host(req({ route: { path: '/users/:id' } })));
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/users/:id');
  });

  it('honors a custom shouldReport', () => {
    const logException = vi.fn(() => Promise.resolve());
    const filter = new BugseeExceptionFilter({
      getClient: () => fakeClient({ logException }),
      shouldReport: () => true,
    });
    const httpErr = { getStatus: () => 500 };
    filter.catch(httpErr, host(req()));
    expect(logException).toHaveBeenCalledWith(httpErr, { mechanism: 'http-error' });
  });

  it('dedups against a shared reported set', () => {
    const logException = vi.fn(() => Promise.resolve());
    const reported = new WeakSet<object>();
    const filter = new BugseeExceptionFilter(
      { getClient: () => fakeClient({ logException }) },
      reported,
    );
    const err = new Error('boom');
    filter.catch(err, host(req()));
    filter.catch(err, host(req()));
    expect(logException).toHaveBeenCalledTimes(1);
    expect(superCatch).toHaveBeenCalledTimes(2); // delegation happens BOTH times
  });

  it('defaults to the carrier client when constructed with no options', () => {
    const filter = new BugseeExceptionFilter();
    expect(() => filter.catch(new Error('boom'), host(req()))).not.toThrow();
    expect(superCatch).toHaveBeenCalledTimes(1);
  });
});

describe('BugseeExceptionCaptured (decorator escape hatch)', () => {
  it('wraps a filter catch to report first, then calls the original and returns its value', () => {
    const logException = vi.fn(() => Promise.resolve());
    const original = vi.fn(() => 'original-return');
    const descriptor: PropertyDescriptor = { value: original };
    BugseeExceptionCaptured({ getClient: () => fakeClient({ logException }) })(
      {},
      'catch',
      descriptor,
    );
    const err = new Error('boom');
    const h = host(req());
    const ret = (descriptor.value as (e: unknown, host: ArgumentsHost) => unknown).call(
      null,
      err,
      h,
    );
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(original).toHaveBeenCalledWith(err, h);
    expect(ret).toBe('original-return');
  });

  it('calls the original even when no client is launched', () => {
    const original = vi.fn(() => 'r');
    const descriptor: PropertyDescriptor = { value: original };
    BugseeExceptionCaptured({ getClient: () => undefined })({}, 'catch', descriptor);
    (descriptor.value as (e: unknown, host: ArgumentsHost) => unknown).call(
      null,
      new Error('x'),
      host(req()),
    );
    expect(original).toHaveBeenCalledTimes(1);
  });

  it('swallows a reporting failure and still calls the original', () => {
    const original = vi.fn(() => 'r');
    const descriptor: PropertyDescriptor = { value: original };
    BugseeExceptionCaptured({
      getClient: () => {
        throw new Error('resolve failed');
      },
    })({}, 'catch', descriptor);
    expect(() =>
      (descriptor.value as (e: unknown, host: ArgumentsHost) => unknown).call(
        null,
        new Error('x'),
        host(req()),
      ),
    ).not.toThrow();
    expect(original).toHaveBeenCalledTimes(1);
  });

  it('defaults options when called with none', () => {
    const original = vi.fn(() => 'r');
    const descriptor: PropertyDescriptor = { value: original };
    BugseeExceptionCaptured()({}, 'catch', descriptor);
    (descriptor.value as (e: unknown, host: ArgumentsHost) => unknown).call(
      null,
      new Error('x'),
      host(req()),
    );
    expect(original).toHaveBeenCalledTimes(1);
  });
});
