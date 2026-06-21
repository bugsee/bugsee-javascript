import type { Bugsee, RequestContextStore } from '@bugsee/node';
import type { Transaction } from '@bugsee/performance';
import { describe, expect, it, vi } from 'vitest';
import {
  codeToStatus,
  type ElysiaAppLike,
  type ElysiaContextLike,
  type ElysiaErrorContextLike,
  isElysiaServerError,
  requestName,
  setupElysia,
} from './hooks';

const fakeTxn = (over: Partial<Record<keyof Transaction, unknown>> = {}): Transaction =>
  ({
    getTraceId: () => 'trace-1',
    getSpanId: () => 'span-1',
    isSampled: () => true,
    isFinished: vi.fn(() => false),
    setName: vi.fn(),
    setAttribute: vi.fn(),
    finish: vi.fn(),
    ...over,
  }) as unknown as Transaction;

const fakeStore = (): RequestContextStore & {
  enterWith: ReturnType<typeof vi.fn>;
  setAttribute: ReturnType<typeof vi.fn>;
  setTrace: ReturnType<typeof vi.fn>;
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

// Capture the three hooks setupElysia registers.
interface Captured {
  onRequest?: (c: ElysiaContextLike) => unknown;
  onError?: (c: ElysiaErrorContextLike) => unknown;
  mapResponse?: (c: ElysiaContextLike) => unknown;
}
const wire = (options: Parameters<typeof setupElysia>[1]): Captured => {
  const cap: Captured = {};
  const app: ElysiaAppLike = {
    onRequest: (h) => {
      cap.onRequest = h;
      return app;
    },
    onError: (h) => {
      cap.onError = h;
      return app;
    },
    mapResponse: (h) => {
      cap.mapResponse = h;
      return app;
    },
  };
  setupElysia(app, options);
  return cap;
};

const ctx = (
  over: {
    method?: string;
    url?: string;
    route?: string;
    status?: number | string;
    traceparent?: string;
  } = {},
): ElysiaContextLike & { request: object } => ({
  request: {
    method: over.method ?? 'GET',
    url: over.url ?? 'http://localhost/u',
    headers: { get: (n: string) => (n === 'traceparent' ? (over.traceparent ?? null) : null) },
  },
  set: { status: over.status },
  route: over.route,
});
const errCtx = (
  over: Parameters<typeof ctx>[0] & { code?: unknown; error?: unknown } = {},
): ElysiaErrorContextLike => ({ ...ctx(over), code: over.code, error: over.error });

describe('codeToStatus', () => {
  it('returns a numeric code verbatim', () => {
    expect(codeToStatus(503)).toBe(503);
    expect(codeToStatus(404)).toBe(404);
  });
  it('maps UNKNOWN / INTERNAL_SERVER_ERROR to 500', () => {
    expect(codeToStatus('UNKNOWN')).toBe(500);
    expect(codeToStatus('INTERNAL_SERVER_ERROR')).toBe(500);
  });
  it('returns undefined for named framework codes', () => {
    expect(codeToStatus('NOT_FOUND')).toBeUndefined();
    expect(codeToStatus('VALIDATION')).toBeUndefined();
  });
});

describe('isElysiaServerError', () => {
  it('is true for UNKNOWN and 5xx codes', () => {
    expect(isElysiaServerError('UNKNOWN')).toBe(true);
    expect(isElysiaServerError(503)).toBe(true);
    expect(isElysiaServerError(500)).toBe(true); // boundary
  });
  it('is false for named 4xx codes and numeric 4xx', () => {
    expect(isElysiaServerError('NOT_FOUND')).toBe(false);
    expect(isElysiaServerError('VALIDATION')).toBe(false);
    expect(isElysiaServerError(404)).toBe(false);
  });
});

describe('requestName', () => {
  it('combines method and route', () => {
    expect(requestName(ctx({ method: 'POST', route: '/o/:id', url: 'http://x/o/7' }))).toBe(
      'POST /o/:id',
    );
  });
  it('falls back to the URL path when no route is set', () => {
    expect(requestName(ctx({ method: 'GET', url: 'http://x/raw?q=1' }))).toBe('GET /raw');
  });
  it('degrades to the raw url when it is not parseable', () => {
    expect(requestName(ctx({ method: 'GET', url: 'not-a-valid-url' }))).toBe('GET not-a-valid-url');
  });
});

describe('setupElysia hooks', () => {
  it('onRequest opens the context (enterWith), starts a trace, mapResponse finishes OK', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    const cap = wire({ getClient: () => client, newContextId: () => 'cid-1' });
    const c = ctx({
      method: 'POST',
      url: 'http://x/o/7',
      route: '/o/:id',
      status: 201,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });

    cap.onRequest?.(c);
    expect(store.enterWith).toHaveBeenCalledTimes(1);
    const [openedCtx] = store.enterWith.mock.calls[0] as [
      { contextId: string; attributes: object },
    ];
    expect(openedCtx.contextId).toBe('cid-1');
    expect(openedCtx.attributes).toEqual({ 'http.method': 'POST', 'http.url': '/o/7' });
    const startTx = (client.ext as () => { startTransaction: ReturnType<typeof vi.fn> })()
      .startTransaction;
    expect(startTx).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'POST /o/:id',
        operation: 'http.server',
        continuation: {
          traceId: '0af7651916cd43dd8448eb211c80319c',
          parentSpanId: 'b7ad6b7169203331',
          sampled: true,
        },
      }),
    );
    expect(store.setTrace).toHaveBeenCalledWith({
      traceId: 'trace-1',
      spanId: 'span-1',
      sampled: true,
    });

    cap.mapResponse?.(c);
    expect(txn.setName).toHaveBeenCalledWith('POST /o/:id');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.method', 'POST');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 201);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('onError reports a server error (UNKNOWN), sets the route, finishes ERROR', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({
      store,
      perf: { startTransaction: vi.fn(() => txn) },
      logException,
    });
    const cap = wire({ getClient: () => client });
    const err = new Error('boom');
    const c = errCtx({ route: '/x/:id', code: 'UNKNOWN', error: err });

    cap.onRequest?.(c);
    cap.onError?.(c);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/x/:id');
    cap.mapResponse?.(c);
    expect(txn.finish).toHaveBeenCalledWith('ERROR');
  });

  it('stamps http.route with the URL path when no route pattern is known', () => {
    const store = fakeStore();
    const client = fakeClient({ store });
    const cap = wire({ getClient: () => client });
    cap.onError?.(errCtx({ url: 'http://x/raw', code: 'UNKNOWN', error: new Error('x') }));
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/raw');
  });

  it('onError skips a framework error (NOT_FOUND) and finishes OK', () => {
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) }, logException });
    const cap = wire({ getClient: () => client });
    const c = errCtx({ code: 'NOT_FOUND', error: new Error('nf') });
    cap.onRequest?.(c);
    cap.onError?.(c);
    expect(logException).not.toHaveBeenCalled();
    cap.mapResponse?.(c);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('reports a numeric 5xx status code and skips a numeric 4xx', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const cap = wire({ getClient: () => client });
    cap.onError?.(errCtx({ code: 503, error: new Error('down') }));
    expect(logException).toHaveBeenCalledTimes(1);
    cap.onError?.(errCtx({ code: 404, error: new Error('nf') }));
    expect(logException).toHaveBeenCalledTimes(1); // 404 not reported
  });

  it('honors a custom shouldReport (report even a NOT_FOUND)', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const cap = wire({ getClient: () => client, shouldReport: () => true });
    const err = new Error('nf');
    cap.onError?.(errCtx({ code: 'NOT_FOUND', error: err }));
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
  });

  it('resolves the user and stamps it on the context', () => {
    const store = fakeStore();
    const client = fakeClient({ store });
    const cap = wire({ getClient: () => client, user: () => 'bob@x.com' });
    cap.onRequest?.(ctx());
    const [openedCtx] = store.enterWith.mock.calls[0] as [{ user?: string }];
    expect(openedCtx.user).toBe('bob@x.com');
  });

  it('reports without the performance extension (no transaction) and without a store', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException }); // no perf, no store
    const cap = wire({ getClient: () => client });
    const c = errCtx({ code: 'UNKNOWN', error: new Error('boom') });
    cap.onRequest?.(c);
    cap.onError?.(c);
    expect(logException).toHaveBeenCalled();
    expect(() => cap.mapResponse?.(c)).not.toThrow();
  });

  it('all hooks are no-ops when no client is launched', () => {
    const store = fakeStore();
    const cap = wire({ getClient: () => undefined });
    const c = errCtx({ code: 'UNKNOWN', error: new Error('x') });
    cap.onRequest?.(c);
    cap.onError?.(c);
    cap.mapResponse?.(c);
    expect(store.enterWith).not.toHaveBeenCalled();
  });

  it('swallows a thrown getClient in every hook (never breaks the request)', () => {
    const cap = wire({
      getClient: () => {
        throw new Error('resolve failed');
      },
    });
    const c = errCtx({ code: 'UNKNOWN', error: new Error('x') });
    expect(() => cap.onRequest?.(c)).not.toThrow();
    expect(() => cap.onError?.(c)).not.toThrow();
    expect(() => cap.mapResponse?.(c)).not.toThrow();
  });

  it('does not touch an already-finished transaction', () => {
    const txn = fakeTxn({ isFinished: vi.fn(() => true) });
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const cap = wire({ getClient: () => client });
    const c = ctx();
    cap.onRequest?.(c);
    cap.mapResponse?.(c);
    expect(txn.finish).not.toHaveBeenCalled();
    expect(txn.setName).not.toHaveBeenCalled(); // guarded BEFORE any mutation
  });

  it('falls back to status 500 for the txn when set.status is not numeric (ERROR)', () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const cap = wire({ getClient: () => client });
    const c = errCtx({ code: 'UNKNOWN', error: new Error('x') }); // no numeric set.status
    cap.onRequest?.(c);
    cap.onError?.(c);
    cap.mapResponse?.(c);
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 500); // outcome ERROR → 500
  });

  it('falls back to status 200 for the txn on a clean success with no numeric set.status', () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const cap = wire({ getClient: () => client });
    const c = ctx(); // success: no onError → outcome OK, no numeric set.status
    cap.onRequest?.(c);
    cap.mapResponse?.(c);
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('records the true status (e.g. 503) from a numeric error code', () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const cap = wire({ getClient: () => client });
    const c = errCtx({ code: 503, error: new Error('down') }); // set.status unreliable in onError
    cap.onRequest?.(c);
    cap.onError?.(c);
    cap.mapResponse?.(c);
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 503);
  });

  it('starts a transaction WITHOUT continuation when there is no inbound traceparent', () => {
    const txn = fakeTxn();
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction } });
    const cap = wire({ getClient: () => client });
    cap.onRequest?.(ctx()); // no traceparent header
    expect(startTransaction).toHaveBeenCalledWith(
      expect.not.objectContaining({ continuation: expect.anything() }),
    );
  });

  it('defaults to the carrier client when no options are given (no-op without a launch)', () => {
    const cap = wire(undefined);
    expect(() => cap.onRequest?.(ctx())).not.toThrow();
  });
});

describe('refactor: mapResponse guard + re-entrancy', () => {
  it('mapResponse is a no-op when no onRequest opened a span', () => {
    const cap = wire({ getClient: () => fakeClient({}) });
    expect(() => cap.mapResponse?.(ctx())).not.toThrow();
  });

  it('re-entrancy: refines a RUN-SCOPED owner — one txn, reports on the owner, finish no-op', async () => {
    const { createNodeRequestContextStore, runServerRequest } = await import('@bugsee/node');
    const store = createNodeRequestContextStore();
    const ownerTxn = fakeTxn();
    const startTransaction = vi.fn(() => ownerTxn);
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ store, perf: { startTransaction }, logException });
    const cap = wire({ getClient: () => client, newContextId: () => 'adapter' });
    const err = new Error('boom');
    const c = errCtx({ url: 'http://x/users/7', route: '/users/:id', code: 'UNKNOWN', error: err });
    runServerRequest(
      { method: 'GET', url: '/users/7' },
      { getClient: () => client, newContextId: () => 'owner' },
      () => {
        cap.onRequest?.(c); // refiner (run-scoped owner active) — no new context/txn
        expect(store.getCurrent()?.contextId).toBe('owner');
        cap.onError?.(c); // reports the UNKNOWN error on the owner context
        cap.mapResponse?.(c); // refiner finish → no-op
        expect(store.getCurrent()?.attributes?.['http.route']).toBe('/users/:id');
        return null;
      },
    );
    expect(startTransaction).toHaveBeenCalledTimes(1); // owner only
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(ownerTxn.finish).not.toHaveBeenCalled(); // refiner finish was a no-op
  });
});
