import type { Bugsee, RequestContextStore } from '@bugsee/node';
import type { Transaction } from '@bugsee/performance';
import { describe, expect, it, vi } from 'vitest';
import {
  bugseeKoa,
  defaultShouldReport,
  httpErrorStatus,
  type KoaContextLike,
  requestName,
} from './middleware';

// Fully conforming — deliberately NOT cast (`as unknown as Transaction`/`as Transaction`). Left as a
// bare object literal assigned to a `Transaction`-typed const, tsc's excess/missing-property check on a
// fresh object literal rejects this double at authoring time (a CI gate) the moment `Transaction` grows a
// member this doesn't implement — see docs/review/OPEN-FINDINGS.md §R3-7's "structural point (S2)".
const fakeTxn = (over: Partial<Transaction> = {}): Transaction => {
  const txn: Transaction = {
    getTraceId: () => 'trace-1',
    getSpanId: () => 'span-1',
    isSampled: () => true,
    isFinished: vi.fn(() => false),
    setName: vi.fn(() => txn),
    setDescription: vi.fn(() => txn),
    setAttribute: vi.fn(() => txn),
    setStatus: vi.fn(() => txn),
    startChildSpan: vi.fn(() => txn),
    recordChildSpan: vi.fn(),
    getStatus: () => 'OK',
    getOperation: () => 'http.server',
    getDescription: () => undefined,
    // Required so server-instrument's F-4 manual-rename check (transaction.getAttributes()) runs for
    // real instead of degrading via a defensive catch — see server-instrument.ts's `manuallyRenamed` read.
    getAttributes: vi.fn(() => ({})),
    getName: () => 'name',
    finish: vi.fn(),
    ...over,
  };
  return txn;
};

const fakeStore = (): RequestContextStore & {
  run: ReturnType<typeof vi.fn>;
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

const ctx = (over: Partial<KoaContextLike> = {}): KoaContextLike => ({
  method: over.method ?? 'GET',
  path: over.path ?? '/u',
  url: over.url ?? '/u',
  status: over.status ?? 404,
  headers: over.headers ?? {},
  _matchedRoute: over._matchedRoute,
});
const okNext = (c: KoaContextLike, status: number) => async () => {
  c.status = status;
};
const errNext = (err: unknown) => async () => {
  throw err;
};
const httpError = (status: number) => Object.assign(new Error('http error'), { status });

describe('httpErrorStatus', () => {
  it('reads status, then statusCode, else undefined', () => {
    expect(httpErrorStatus({ status: 404 })).toBe(404);
    expect(httpErrorStatus({ statusCode: 503 })).toBe(503);
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

describe('requestName', () => {
  it('uses the matched route when present, else the path', () => {
    expect(requestName(ctx({ method: 'POST', _matchedRoute: '/o/:id' }))).toBe('POST /o/:id');
    expect(requestName(ctx({ method: 'GET', path: '/raw' }))).toBe('GET /raw');
  });
});

describe('bugseeKoa', () => {
  it('passes through (next once, no report) when no client is launched', async () => {
    const next = vi.fn(async () => undefined);
    await bugseeKoa({ getClient: () => undefined })(ctx(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('opens a context (store.run), continues a trace, finishes OK on success', async () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    const c = ctx({
      method: 'POST',
      url: '/o/7',
      _matchedRoute: '/o/:id',
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    });
    await bugseeKoa({ getClient: () => client, newContextId: () => 'cid-1' })(c, okNext(c, 200));
    expect(store.run).toHaveBeenCalledTimes(1);
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
    const [openedCtx] = store.run.mock.calls[0] as [{ attributes: object }];
    expect(openedCtx.attributes).toEqual({ 'http.method': 'POST', 'http.url': '/o/7' });
    expect(txn.setName).toHaveBeenCalledWith('POST /o/:id');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.method', 'POST');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  // F-4 (round-2 D2): a manual rename (client.ext('performance').setRouteName()/setActiveTransactionName())
  // stamps 'bugsee.name_source' on the transaction; server-instrument's finishWith must NOT clobber it
  // with the automatic route-derived name. This exercises the check against a Transaction double whose
  // getAttributes() actually reports the stamp, not one that omits the method entirely.
  it('does NOT clobber a manual rename (name-source attribute present) with the automatic route name', async () => {
    const store = fakeStore();
    const txn = fakeTxn({ getAttributes: vi.fn(() => ({ 'bugsee.name_source': 'route' })) });
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    const c = ctx({ method: 'POST', url: '/o/7', _matchedRoute: '/o/:id' });
    await bugseeKoa({ getClient: () => client, newContextId: () => 'cid-1' })(c, okNext(c, 200));
    expect(txn.setName).not.toHaveBeenCalled(); // the manual rename wins
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('reports a thrown error (http-error), re-throws it, finishes ERROR (status 500)', async () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({
      store,
      perf: { startTransaction: vi.fn(() => txn) },
      logException,
    });
    const err = new Error('handler boom');
    const c = ctx({ _matchedRoute: '/x/:id' });
    await expect(bugseeKoa({ getClient: () => client })(c, errNext(err))).rejects.toBe(err);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/x/:id');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 500);
    expect(txn.finish).toHaveBeenCalledWith('ERROR');
  });

  it('does NOT report a 4xx error, re-throws it, finishes OK (status 404)', async () => {
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) }, logException });
    const err = httpError(404);
    const c = ctx();
    await expect(bugseeKoa({ getClient: () => client })(c, errNext(err))).rejects.toBe(err);
    expect(logException).not.toHaveBeenCalled();
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 404);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('reports a 5xx http error and finishes ERROR', async () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const err = httpError(503);
    await expect(bugseeKoa({ getClient: () => client })(ctx(), errNext(err))).rejects.toBe(err);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
  });

  it('honors a custom shouldReport (report a 4xx)', async () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const err = httpError(404);
    await expect(
      bugseeKoa({ getClient: () => client, shouldReport: () => true })(ctx(), errNext(err)),
    ).rejects.toBe(err);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
  });

  it('reports without the performance extension and without a store', async () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const err = new Error('boom');
    await expect(bugseeKoa({ getClient: () => client })(ctx(), errNext(err))).rejects.toBe(err);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
  });

  it('resolves the user and stamps it on the context', async () => {
    const store = fakeStore();
    const client = fakeClient({ store });
    const c = ctx();
    await bugseeKoa({ getClient: () => client, user: () => 'bob@x.com' })(c, okNext(c, 200));
    const [openedCtx] = store.run.mock.calls[0] as [{ user?: string }];
    expect(openedCtx.user).toBe('bob@x.com');
  });

  it('swallows a logException failure but still re-throws the original error', async () => {
    const logException = vi.fn(() => {
      throw new Error('reporting blew up');
    });
    const client = fakeClient({ logException });
    const err = new Error('boom');
    await expect(bugseeKoa({ getClient: () => client })(ctx(), errNext(err))).rejects.toBe(err);
  });

  it('swallows a startTransaction failure — APM never breaks the request, error still reported', async () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({
      perf: {
        startTransaction: vi.fn(() => {
          throw new Error('apm init blew up');
        }),
      },
      logException,
    });
    const err = new Error('boom');
    await expect(bugseeKoa({ getClient: () => client })(ctx(), errNext(err))).rejects.toBe(err);
    expect(logException).toHaveBeenCalled();
  });

  it('does not finish an already-finished transaction', async () => {
    const txn = fakeTxn({ isFinished: vi.fn(() => true) });
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const c = ctx();
    await bugseeKoa({ getClient: () => client })(c, okNext(c, 200));
    expect(txn.finish).not.toHaveBeenCalled();
  });

  it('continues a trace from an array-valued traceparent header (first element)', async () => {
    const txn = fakeTxn();
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction } });
    const c = ctx({
      headers: {
        traceparent: ['00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', 'second'],
      },
    });
    await bugseeKoa({ getClient: () => client })(c, okNext(c, 200));
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        continuation: {
          traceId: '0af7651916cd43dd8448eb211c80319c',
          parentSpanId: 'b7ad6b7169203331',
          sampled: true,
        },
      }),
    );
  });

  it('starts a transaction WITHOUT continuation when there is no inbound traceparent', async () => {
    const txn = fakeTxn();
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction } });
    const c = ctx();
    await bugseeKoa({ getClient: () => client })(c, okNext(c, 200));
    expect(startTransaction).toHaveBeenCalledWith(
      expect.not.objectContaining({ continuation: expect.anything() }),
    );
  });

  it('defaults to the carrier client when no options are given (pass-through)', async () => {
    const next = vi.fn(async () => undefined);
    await bugseeKoa()(ctx(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('refactor: route refinement + re-entrancy', () => {
  it('refines the txn name with the route discovered during routing (set before finish)', async () => {
    const txn = fakeTxn();
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction: vi.fn(() => txn) } });
    const c = ctx({ method: 'GET', url: '/users/7', path: '/users/7' }); // no _matchedRoute yet
    await bugseeKoa({ getClient: () => client })(c, async () => {
      c._matchedRoute = '/users/:id'; // @koa/router matches downstream, AFTER the bugsee middleware opened
      c.status = 200;
    });
    expect(txn.setName).toHaveBeenCalledWith('GET /users/:id'); // setRoute at finish refined the name
  });

  it('re-entrancy: refines the http-layer owner — one txn, error on owner, refiner finish no-op', async () => {
    const { createNodeRequestContextStore, runServerRequest } = await import('@bugsee/node');
    const store = createNodeRequestContextStore();
    const ownerTxn = fakeTxn();
    const startTransaction = vi.fn(() => ownerTxn);
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ store, perf: { startTransaction }, logException });
    const mw = bugseeKoa({ getClient: () => client, newContextId: () => 'adapter' });
    const err = httpError(500);
    await runServerRequest(
      { method: 'GET', url: '/users/7' },
      { getClient: () => client, newContextId: () => 'owner' },
      async () => {
        const c = ctx({ url: '/users/7', path: '/users/7', _matchedRoute: '/users/:id' });
        await expect(mw(c, errNext(err))).rejects.toBe(err); // koa re-throws
        expect(store.getCurrent()?.contextId).toBe('owner'); // refined — no new context
        expect(store.getCurrent()?.attributes?.['http.route']).toBe('/users/:id');
        return null;
      },
    );
    expect(startTransaction).toHaveBeenCalledTimes(1); // owner only
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(ownerTxn.finish).not.toHaveBeenCalled(); // refiner finish was a no-op
  });
});
