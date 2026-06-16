import type { Bugsee, RequestContextStore } from '@bugsee/node';
import type { Transaction } from '@bugsee/performance';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultShouldReport,
  openBugseeContext,
  openBugseeRequest,
  startBugseeServerSpan,
} from './server';

const fakeTxn = (over: Partial<Record<keyof Transaction, unknown>> = {}): Transaction =>
  ({
    getTraceId: () => 'trace-1',
    getSpanId: () => 'span-1',
    isFinished: vi.fn(() => false),
    setName: vi.fn(),
    setAttribute: vi.fn(),
    finish: vi.fn(),
    ...over,
  }) as unknown as Transaction;

const fakeStore = (): RequestContextStore & {
  enterWith: ReturnType<typeof vi.fn>;
  setTrace: ReturnType<typeof vi.fn>;
  setAttribute: ReturnType<typeof vi.fn>;
} =>
  ({
    getCurrent: vi.fn(),
    run: vi.fn(),
    enterWith: vi.fn(),
    setAttribute: vi.fn(),
    setTrace: vi.fn(),
  }) as never;

const fakeClient = (opts: {
  store?: RequestContextStore;
  perf?: { startTransaction: ReturnType<typeof vi.fn> };
  logException?: ReturnType<typeof vi.fn>;
}): Bugsee =>
  ({
    getServiceProvider: () => ({ getImmediate: () => opts.store ?? undefined }),
    ext: () => {
      if (!opts.perf) throw new Error('no performance extension');
      return opts.perf;
    },
    logException: opts.logException ?? vi.fn(() => Promise.resolve()),
  }) as unknown as Bugsee;

const info = (over: Partial<Parameters<typeof openBugseeRequest>[0]> = {}) => ({
  method: over.method ?? 'GET',
  url: over.url ?? '/u',
  route: over.route,
  traceparent: over.traceparent,
  user: over.user,
});

describe('defaultShouldReport (robust multi-shape duck-typer)', () => {
  it('reports a plain Error (no status)', () => {
    expect(defaultShouldReport(new Error('x'))).toBe(true);
  });
  it('skips a 4xx and reports a 5xx via getStatus (Nest HttpException)', () => {
    expect(defaultShouldReport({ getStatus: () => 404 })).toBe(false);
    expect(defaultShouldReport({ getStatus: () => 500 })).toBe(true);
  });
  it('reads status (http-errors / Koa), statusCode (restify), output.statusCode (Boom)', () => {
    expect(defaultShouldReport({ status: 404 })).toBe(false);
    expect(defaultShouldReport({ statusCode: 503 })).toBe(true);
    expect(defaultShouldReport({ output: { statusCode: 404 } })).toBe(false);
    expect(defaultShouldReport({ output: { statusCode: 500 } })).toBe(true);
  });
  it('reports null / a non-numeric getStatus', () => {
    expect(defaultShouldReport(null)).toBe(true);
    expect(defaultShouldReport({ getStatus: () => 'oops' })).toBe(true);
  });
  it('swallows a throwing getStatus and reports (treats it as a genuine error)', () => {
    expect(
      defaultShouldReport({
        getStatus: () => {
          throw new Error('boom');
        },
      }),
    ).toBe(true);
  });
  it('never throws on a hostile error with a throwing status getter (reports)', () => {
    expect(
      defaultShouldReport({
        get status() {
          throw new Error('hostile');
        },
      }),
    ).toBe(true);
  });
});

describe('openBugseeRequest', () => {
  it('returns a safe no-op span when no client is launched', () => {
    const span = openBugseeRequest(info(), { getClient: () => undefined });
    expect(span.captureError(new Error('x'))).toBe(false);
    expect(() => {
      span.setRoute('/r');
      span.finish(200);
      span.cancel();
    }).not.toThrow();
  });

  it('returns a no-op span when getClient throws', () => {
    const span = openBugseeRequest(info(), {
      getClient: () => {
        throw new Error('resolve failed');
      },
    });
    expect(span.captureError(new Error('x'))).toBe(false);
  });

  it('opens the context (enterWith), starts an http.server span, continues a trace', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    openBugseeRequest(
      info({
        method: 'POST',
        url: '/o/7',
        route: '/o/:id',
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        user: 'bob@x.com',
      }),
      { getClient: () => client, newContextId: () => 'cid-1' },
    );
    expect(store.enterWith).toHaveBeenCalledTimes(1);
    const [ctx] = store.enterWith.mock.calls[0] as [
      { contextId: string; attributes: object; user?: string },
    ];
    expect(ctx.contextId).toBe('cid-1');
    expect(ctx.attributes).toEqual({ 'http.method': 'POST', 'http.url': '/o/7' });
    expect(ctx.user).toBe('bob@x.com');
    const startTx = (client.ext as () => { startTransaction: ReturnType<typeof vi.fn> })()
      .startTransaction;
    expect(startTx).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'POST /o/:id',
        operation: 'http.server',
        continuation: { traceId: '0af7651916cd43dd8448eb211c80319c' },
      }),
    );
    expect(store.setTrace).toHaveBeenCalledWith({ traceId: 'trace-1', spanId: 'span-1' });
  });

  it('span.finish(status) finishes OK (<500) / ERROR (>=500) with method + status_code + route name', () => {
    const txn = fakeTxn();
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction: vi.fn(() => txn) } });
    const span = openBugseeRequest(info({ method: 'POST', route: '/o/:id' }), {
      getClient: () => client,
    });
    span.finish(201);
    expect(txn.setName).toHaveBeenCalledWith('POST /o/:id');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.method', 'POST');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 201);
    expect(txn.finish).toHaveBeenCalledWith('OK');

    const txn2 = fakeTxn();
    const c2 = fakeClient({ perf: { startTransaction: vi.fn(() => txn2) } });
    openBugseeRequest(info(), { getClient: () => c2 }).finish(500);
    expect(txn2.finish).toHaveBeenCalledWith('ERROR');
  });

  it('span.cancel() finishes CANCELLED with status_code 0', () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    openBugseeRequest(info(), { getClient: () => client }).cancel();
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 0);
    expect(txn.finish).toHaveBeenCalledWith('CANCELLED');
  });

  it('span.captureError reports (mechanism http-error) + sets http.route + returns true', () => {
    const store = fakeStore();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ store, logException });
    const err = new Error('boom');
    const reported = openBugseeRequest(info({ route: '/x/:id' }), {
      getClient: () => client,
    }).captureError(err);
    expect(reported).toBe(true);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/x/:id');
  });

  it('span.captureError skips (returns false) when shouldReport is false', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const reported = openBugseeRequest(info(), { getClient: () => client }).captureError({
      getStatus: () => 404,
    });
    expect(reported).toBe(false);
    expect(logException).not.toHaveBeenCalled();
  });

  it('span.captureError honors a per-call shouldReport override', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const err = { getStatus: () => 404 };
    const reported = openBugseeRequest(info(), { getClient: () => client }).captureError(err, {
      shouldReport: () => true,
    });
    expect(reported).toBe(true);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
  });

  it('setRoute refines the route used by http.route and the finished span name', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({
      store,
      perf: { startTransaction: vi.fn(() => txn) },
      logException,
    });
    const span = openBugseeRequest(info({ method: 'GET', url: '/o/7' }), {
      getClient: () => client,
    });
    span.setRoute('/o/:id');
    span.captureError(new Error('x'));
    span.finish(500);
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/o/:id');
    expect(txn.setName).toHaveBeenCalledWith('GET /o/:id');
  });

  it('falls back to the url path (query stripped) for the span name + http.route when no route', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    const span = openBugseeRequest(info({ method: 'GET', url: '/raw?q=1' }), {
      getClient: () => client,
    });
    span.captureError(new Error('x'));
    span.finish(500);
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/raw');
    expect(txn.setName).toHaveBeenCalledWith('GET /raw');
  });

  it('works without the performance extension (reports, no transaction)', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const span = openBugseeRequest(info(), { getClient: () => client });
    expect(span.captureError(new Error('x'))).toBe(true);
    expect(() => span.finish(200)).not.toThrow();
  });

  it('works without a context store (reports without an http.route)', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException }); // no store
    expect(
      openBugseeRequest(info(), { getClient: () => client }).captureError(new Error('x')),
    ).toBe(true);
    expect(logException).toHaveBeenCalled();
  });

  it('swallows a logException failure and returns false', () => {
    const logException = vi.fn(() => {
      throw new Error('reporting blew up');
    });
    const client = fakeClient({ logException });
    expect(
      openBugseeRequest(info(), { getClient: () => client }).captureError(new Error('x')),
    ).toBe(false);
  });

  it('swallows a startTransaction failure (span still usable)', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({
      perf: {
        startTransaction: vi.fn(() => {
          throw new Error('apm blew up');
        }),
      },
      logException,
    });
    const span = openBugseeRequest(info(), { getClient: () => client });
    expect(span.captureError(new Error('x'))).toBe(true);
    expect(() => span.finish(200)).not.toThrow();
  });

  it('does not finish an already-finished transaction', () => {
    const txn = fakeTxn({ isFinished: vi.fn(() => true) });
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    openBugseeRequest(info(), { getClient: () => client }).finish(200);
    expect(txn.finish).not.toHaveBeenCalled();
  });

  it('starts WITHOUT continuation when there is no inbound traceparent', () => {
    const txn = fakeTxn();
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction } });
    openBugseeRequest(info(), { getClient: () => client });
    expect(startTransaction).toHaveBeenCalledWith(
      expect.not.objectContaining({ continuation: expect.anything() }),
    );
  });

  it('defaults to the carrier client (no options) — no-op span without a launch', () => {
    expect(openBugseeRequest(info()).captureError(new Error('x'))).toBe(false);
  });
});

describe('decoupled primitives (openBugseeContext / startBugseeServerSpan)', () => {
  it('openBugseeContext opens the context (enterWith) without starting a transaction', () => {
    const store = fakeStore();
    const startTransaction = vi.fn();
    const client = fakeClient({ store, perf: { startTransaction } });
    openBugseeContext(info({ user: 'a@x.com' }), { getClient: () => client });
    expect(store.enterWith).toHaveBeenCalledTimes(1);
    expect(startTransaction).not.toHaveBeenCalled();
  });

  it('openBugseeContext is a no-op without a client / store', () => {
    const store = fakeStore();
    openBugseeContext(info(), { getClient: () => undefined });
    openBugseeContext(info(), { getClient: () => fakeClient({}) }); // client but no store
    expect(store.enterWith).not.toHaveBeenCalled();
  });

  it('startBugseeServerSpan starts the transaction WITHOUT opening a context', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    const span = startBugseeServerSpan(info({ method: 'PUT', route: '/p/:id' }), {
      getClient: () => client,
    });
    expect(store.enterWith).not.toHaveBeenCalled(); // context NOT opened here
    expect(store.setTrace).toHaveBeenCalledWith({ traceId: 'trace-1', spanId: 'span-1' });
    span.finish(200);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('startBugseeServerSpan returns a no-op span without a client', () => {
    expect(
      startBugseeServerSpan(info(), { getClient: () => undefined }).captureError(new Error('x')),
    ).toBe(false);
  });

  it('both decoupled primitives default to the carrier client when called with no options', () => {
    expect(() => openBugseeContext(info())).not.toThrow(); // no launch → no-op
    expect(startBugseeServerSpan(info()).captureError(new Error('x'))).toBe(false);
  });
});
