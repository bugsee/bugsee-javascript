import type { Bugsee, RequestContextStore } from '@bugsee/node';
import type { Transaction } from '@bugsee/performance';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultShouldReport,
  httpErrorStatus,
  type RestifyAfterHandler,
  type RestifyMiddleware,
  type RestifyRequestLike,
  type RestifyServerLike,
  requestName,
  setupRestify,
} from './setup';

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
  run: ReturnType<typeof vi.fn>;
  enterWith: ReturnType<typeof vi.fn>;
  setTrace: ReturnType<typeof vi.fn>;
  setAttribute: ReturnType<typeof vi.fn>;
} =>
  ({
    getCurrent: vi.fn(),
    run: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
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

interface Captured {
  use?: RestifyMiddleware;
  after?: RestifyAfterHandler;
}
const wire = (options: Parameters<typeof setupRestify>[1]): Captured => {
  const cap: Captured = {};
  const server: RestifyServerLike = {
    use: (h) => {
      cap.use = h;
    },
    on: (_event, h) => {
      cap.after = h;
    },
  };
  setupRestify(server, options);
  return cap;
};

const req = (over: Partial<RestifyRequestLike> = {}): RestifyRequestLike & { request: object } => ({
  request: {},
  method: over.method ?? 'GET',
  url: over.url ?? '/u',
  headers: over.headers ?? {},
  route: over.route,
});
const res = (statusCode?: number) => ({ statusCode });
const httpError = (statusCode: number) => Object.assign(new Error('http error'), { statusCode });

describe('httpErrorStatus', () => {
  it('reads statusCode, then status, else undefined', () => {
    expect(httpErrorStatus({ statusCode: 404 })).toBe(404);
    expect(httpErrorStatus({ status: 503 })).toBe(503);
    expect(httpErrorStatus(new Error('x'))).toBeUndefined();
    expect(httpErrorStatus(null)).toBeUndefined();
  });
});

describe('defaultShouldReport', () => {
  it('reports a plain Error (no status) and a 5xx', () => {
    expect(defaultShouldReport(new Error('x'))).toBe(true);
    expect(defaultShouldReport(httpError(500))).toBe(true);
  });
  it('skips a 4xx', () => {
    expect(defaultShouldReport(httpError(404))).toBe(false);
  });
});

describe('requestName / route resolution', () => {
  it('prefers the after-route spec.path, then route.path, then req.route, then the url path', () => {
    expect(requestName(req({ method: 'POST' }), { spec: { path: '/a/:id' } })).toBe('POST /a/:id');
    expect(requestName(req(), { path: '/b/:id' })).toBe('GET /b/:id');
    expect(requestName(req({ route: { path: '/c/:id' } }), undefined)).toBe('GET /c/:id');
    expect(requestName(req({ url: '/raw?q=1' }), undefined)).toBe('GET /raw');
  });
  it('coerces a RegExp route path to a string', () => {
    const re = /^\/u/;
    expect(requestName(req(), { path: re })).toBe(`GET ${String(re)}`);
  });
});

describe('setupRestify', () => {
  it('use opens context (enterWith) + trace; after finishes OK on success (no err)', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({
      store,
      perf: { startTransaction: vi.fn(() => txn) },
      logException,
    });
    const cap = wire({ getClient: () => client, newContextId: () => 'cid-1' });
    const r = req({
      method: 'POST',
      url: '/o/7',
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    });
    const next = vi.fn();
    cap.use?.(r, res(), next);
    expect(next).toHaveBeenCalledTimes(1);
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
        operation: 'http.server',
        continuation: { traceId: '0af7651916cd43dd8448eb211c80319c' },
      }),
    );
    expect(store.setTrace).toHaveBeenCalledWith({ traceId: 'trace-1', spanId: 'span-1' });

    cap.after?.(r, res(200), { spec: { path: '/o/:id' } }, null);
    expect(txn.setName).toHaveBeenCalledWith('POST /o/:id');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.method', 'POST');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
    expect(txn.finish).toHaveBeenCalledWith('OK');
    expect(logException).not.toHaveBeenCalled(); // a successful request (err=null) is NOT reported
    expect(store.run).not.toHaveBeenCalled(); // no context re-entry without an error to report
  });

  it('keeps per-request state isolated across two distinct requests (WeakMap by req)', () => {
    const txn1 = fakeTxn();
    const txn2 = fakeTxn();
    const txns = [txn1, txn2];
    let i = 0;
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txns[i++]) } });
    const cap = wire({ getClient: () => client });
    const r1 = req({ url: '/a' });
    const r2 = req({ url: '/b' });
    cap.use?.(r1, res(), vi.fn());
    cap.use?.(r2, res(), vi.fn()); // a shared-slot bug would overwrite r1's state here
    cap.after?.(r1, res(200), { path: '/a' }, null);
    cap.after?.(r2, res(500), { path: '/b' }, new Error('boom'));
    expect(txn1.finish).toHaveBeenCalledTimes(1);
    expect(txn1.finish).toHaveBeenCalledWith('OK'); // r1's own outcome
    expect(txn2.finish).toHaveBeenCalledTimes(1);
    expect(txn2.finish).toHaveBeenCalledWith('ERROR'); // r2's own outcome
  });

  it('after reports a server error, re-entering the saved context, finishes ERROR', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({
      store,
      perf: { startTransaction: vi.fn(() => txn) },
      logException,
    });
    const cap = wire({ getClient: () => client, newContextId: () => 'cid-9' });
    const err = new Error('handler boom');
    const r = req();
    cap.use?.(r, res(), vi.fn());
    cap.after?.(r, res(500), { path: '/x/:id' }, err);
    // the report runs INSIDE a store.run re-entering the saved context (so the contextId is correct)
    expect(store.run).toHaveBeenCalledTimes(1);
    const [reenteredCtx] = store.run.mock.calls[0] as [{ contextId: string }];
    expect(reenteredCtx.contextId).toBe('cid-9');
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/x/:id');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 500);
    expect(txn.finish).toHaveBeenCalledWith('ERROR');
  });

  it('after does NOT report a 4xx error and finishes OK', () => {
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) }, logException });
    const cap = wire({ getClient: () => client });
    const r = req();
    cap.use?.(r, res(), vi.fn());
    cap.after?.(r, res(404), undefined, httpError(404));
    expect(logException).not.toHaveBeenCalled();
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 404);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('falls back to the URL path for http.route, and status_code 0, when neither is known', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({
      store,
      perf: { startTransaction: vi.fn(() => txn) },
      logException,
    });
    const cap = wire({ getClient: () => client });
    const r = req({ url: '/raw?q=1' });
    cap.use?.(r, res(), vi.fn());
    cap.after?.(r, res(), undefined, new Error('boom')); // no route, no res.statusCode
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/raw');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 0);
    expect(txn.finish).toHaveBeenCalledWith('OK'); // status 0 < 500
  });

  it('honors a custom shouldReport (report a 4xx)', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const cap = wire({ getClient: () => client, shouldReport: () => true });
    const err = httpError(404);
    const r = req();
    cap.use?.(r, res(), vi.fn());
    cap.after?.(r, res(404), undefined, err);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
  });

  it('reports without the performance extension and without a store (no re-enter)', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException }); // no perf, no store
    const cap = wire({ getClient: () => client });
    const r = req();
    cap.use?.(r, res(), vi.fn());
    cap.after?.(r, res(500), undefined, new Error('boom'));
    expect(logException).toHaveBeenCalledWith(expect.any(Error), { mechanism: 'http-error' });
  });

  it('resolves the user and stamps it on the context', () => {
    const store = fakeStore();
    const client = fakeClient({ store });
    const cap = wire({ getClient: () => client, user: () => 'bob@x.com' });
    cap.use?.(req(), res(), vi.fn());
    const [openedCtx] = store.enterWith.mock.calls[0] as [{ user?: string }];
    expect(openedCtx.user).toBe('bob@x.com');
  });

  it('the use middleware always calls next, and after is a no-op, when no client is launched', () => {
    const store = fakeStore();
    const cap = wire({ getClient: () => undefined });
    const next = vi.fn();
    cap.use?.(req(), res(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(store.enterWith).not.toHaveBeenCalled();
    expect(() => cap.after?.(req(), res(200), undefined, null)).not.toThrow();
  });

  it('swallows a thrown getClient in both hooks and still calls next', () => {
    const cap = wire({
      getClient: () => {
        throw new Error('resolve failed');
      },
    });
    const next = vi.fn();
    cap.use?.(req(), res(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(() => cap.after?.(req(), res(200), undefined, new Error('x'))).not.toThrow();
  });

  it('does not finish an already-finished transaction', () => {
    const txn = fakeTxn({ isFinished: vi.fn(() => true) });
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const cap = wire({ getClient: () => client });
    const r = req();
    cap.use?.(r, res(), vi.fn());
    cap.after?.(r, res(200), undefined, null);
    expect(txn.finish).not.toHaveBeenCalled();
  });

  it('starts a transaction WITHOUT continuation when there is no inbound traceparent', () => {
    const txn = fakeTxn();
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction } });
    cap_run(wire({ getClient: () => client }));
    expect(startTransaction).toHaveBeenCalledWith(
      expect.not.objectContaining({ continuation: expect.anything() }),
    );
  });

  it('after with no prior use (no state) is a safe no-op', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const cap = wire({ getClient: () => client });
    // no use() called → no WeakMap entry; a server error still reports (context-less) but finishes nothing
    expect(() => cap.after?.(req(), res(500), undefined, new Error('boom'))).not.toThrow();
    expect(logException).toHaveBeenCalled();
  });

  it('reads an array-valued traceparent header (first element)', () => {
    const txn = fakeTxn();
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction } });
    const cap = wire({ getClient: () => client });
    cap.use?.(
      req({
        headers: { traceparent: ['00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', 'x'] },
      }),
      res(),
      vi.fn(),
    );
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ continuation: { traceId: '0af7651916cd43dd8448eb211c80319c' } }),
    );
  });

  it('defaults to the carrier client when no options are given (no-op without a launch)', () => {
    const cap = wire(undefined);
    const next = vi.fn();
    cap.use?.(req(), res(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// Helper: drive use() with a plain request (no traceparent) for the no-continuation test.
function cap_run(cap: Captured): void {
  cap.use?.(req(), res(), vi.fn());
}
