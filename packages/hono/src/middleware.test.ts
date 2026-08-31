import type { Bugsee, RequestContextStore } from '@bugsee/node';
import type { Transaction } from '@bugsee/performance';
import { describe, expect, it, vi } from 'vitest';
import { bugseeHono, defaultShouldReport, type HonoContextLike, requestName } from './middleware';

// ── Fakes ──
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

interface MutableCtx extends HonoContextLike {
  res: { status: number } | undefined;
  error?: unknown;
}
const ctx = (over: Partial<MutableCtx> = {}): MutableCtx => ({
  req: {
    method: over.req?.method ?? 'GET',
    path: over.req?.path ?? '/u',
    routePath: over.req?.routePath ?? '/u',
    header: over.req?.header ?? (() => undefined),
  },
  res: over.res,
  error: over.error,
});

// A `next` thunk that simulates the downstream: sets c.res (final status) and optionally c.error.
const nextThatSets = (c: MutableCtx, status: number, error?: unknown) => async () => {
  c.res = { status };
  if (error !== undefined) c.error = error;
};

describe('requestName', () => {
  it('combines method and routePath', () => {
    expect(
      requestName(
        ctx({
          req: { method: 'POST', routePath: '/o/:id', path: '/o/7', header: () => undefined },
        }),
      ),
    ).toBe('POST /o/:id');
  });
  it('falls back to the path when routePath is empty', () => {
    expect(
      requestName(
        ctx({ req: { method: 'GET', routePath: '', path: '/raw', header: () => undefined } }),
      ),
    ).toBe('GET /raw');
  });
});

describe('defaultShouldReport', () => {
  it('reports a plain Error', () => {
    expect(defaultShouldReport(new Error('x'))).toBe(true);
  });
  it('skips a Hono HTTPException (duck-typed getResponse)', () => {
    expect(defaultShouldReport({ getResponse: () => new Response(), status: 404 })).toBe(false);
  });
  it('reports an object whose getResponse is not a function', () => {
    expect(defaultShouldReport({ getResponse: 'x' })).toBe(true);
  });
  it('reports null / a string', () => {
    expect(defaultShouldReport(null)).toBe(true);
    expect(defaultShouldReport('boom')).toBe(true);
  });
});

describe('bugseeHono', () => {
  it('passes through (next once, no report) when no client is launched', async () => {
    const c = ctx();
    const next = vi.fn(async () => undefined);
    await bugseeHono({ getClient: () => undefined })(c, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('opens a context (store.run), continues a trace, finishes OK on success', async () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    const c = ctx({
      req: {
        method: 'POST',
        path: '/o/7',
        routePath: '/o/:id',
        header: (n) =>
          n === 'traceparent'
            ? '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
            : undefined,
      },
    });
    await bugseeHono({ getClient: () => client, newContextId: () => 'cid-1' })(
      c,
      nextThatSets(c, 200),
    );
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
    expect(txn.finish).toHaveBeenCalledWith('OK');
    expect(txn.setName).toHaveBeenCalledWith('POST /o/:id');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.method', 'POST');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
  });

  // F-4 (round-2 D2): a manual rename (client.ext('performance').setRouteName()/setActiveTransactionName())
  // stamps 'bugsee.name_source' on the transaction; server-instrument's finishWith must NOT clobber it
  // with the automatic route-derived name. This exercises the check against a Transaction double whose
  // getAttributes() actually reports the stamp, not one that omits the method entirely.
  it('does NOT clobber a manual rename (name-source attribute present) with the automatic route name', async () => {
    const store = fakeStore();
    const txn = fakeTxn({ getAttributes: vi.fn(() => ({ 'bugsee.name_source': 'route' })) });
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    const c = ctx({
      req: { method: 'POST', path: '/o/7', routePath: '/o/:id', header: () => undefined },
    });
    await bugseeHono({ getClient: () => client, newContextId: () => 'cid-1' })(
      c,
      nextThatSets(c, 200),
    );
    expect(txn.setName).not.toHaveBeenCalled(); // the manual rename wins
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('reports c.error (mechanism http-error) and finishes the transaction ERROR on a 500', async () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({
      store,
      perf: { startTransaction: vi.fn(() => txn) },
      logException,
    });
    const err = new Error('handler boom');
    const c = ctx({
      req: { method: 'GET', path: '/x', routePath: '/x/:id', header: () => undefined },
    });
    await bugseeHono({ getClient: () => client })(c, nextThatSets(c, 500, err));
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/x/:id');
    expect(txn.finish).toHaveBeenCalledWith('ERROR');
  });

  it('does NOT report a Hono HTTPException, and finishes the transaction OK on a 404', async () => {
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) }, logException });
    const httpErr = { getResponse: () => new Response(), status: 404 };
    const c = ctx();
    await bugseeHono({ getClient: () => client })(c, nextThatSets(c, 404, httpErr));
    expect(logException).not.toHaveBeenCalled();
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('honors a custom shouldReport', async () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const httpErr = { getResponse: () => new Response(), status: 404 };
    const c = ctx();
    await bugseeHono({ getClient: () => client, shouldReport: () => true })(
      c,
      nextThatSets(c, 404, httpErr),
    );
    expect(logException).toHaveBeenCalledWith(httpErr, { mechanism: 'http-error' });
  });

  it('reports without the performance extension (no transaction) and without a store', async () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException }); // no perf, no store
    const err = new Error('boom');
    const c = ctx();
    await bugseeHono({ getClient: () => client })(c, nextThatSets(c, 500, err));
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
  });

  it('resolves the user and stamps it on the context', async () => {
    const store = fakeStore();
    const client = fakeClient({ store });
    const c = ctx();
    await bugseeHono({ getClient: () => client, user: () => 'bob@x.com' })(c, nextThatSets(c, 200));
    const [openedCtx] = store.run.mock.calls[0] as [
      { user?: string; attributes?: Record<string, unknown> },
    ];
    expect(openedCtx.user).toBe('bob@x.com');
    expect(openedCtx.attributes).toEqual({ 'http.method': 'GET', 'http.url': '/u' });
  });

  it('swallows a logException failure (never breaks the request)', async () => {
    const logException = vi.fn(() => {
      throw new Error('reporting blew up');
    });
    const client = fakeClient({ logException });
    const c = ctx();
    await expect(
      bugseeHono({ getClient: () => client })(c, nextThatSets(c, 500, new Error('boom'))),
    ).resolves.toBeUndefined();
  });

  it('swallows a transaction.finish failure', async () => {
    const txn = fakeTxn({
      finish: vi.fn(() => {
        throw new Error('finish blew up');
      }),
    });
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const c = ctx();
    await expect(
      bugseeHono({ getClient: () => client })(c, nextThatSets(c, 200)),
    ).resolves.toBeUndefined();
    expect(txn.finish).toHaveBeenCalled();
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
    const c = ctx();
    await expect(
      bugseeHono({ getClient: () => client })(c, nextThatSets(c, 500, new Error('boom'))),
    ).resolves.toBeUndefined();
    expect(logException).toHaveBeenCalled();
  });

  it('does not finish an already-finished transaction', async () => {
    const txn = fakeTxn({ isFinished: vi.fn(() => true) });
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const c = ctx();
    await bugseeHono({ getClient: () => client })(c, nextThatSets(c, 200));
    expect(txn.finish).not.toHaveBeenCalled();
  });

  it('records status_code 0 and finishes OK when no response status is set', async () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const c = ctx(); // c.res stays undefined (next sets nothing)
    await bugseeHono({ getClient: () => client })(c, async () => undefined);
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 0);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('defaults to the carrier client when no options are given (pass-through)', async () => {
    const c = ctx();
    const next = vi.fn(async () => undefined);
    await bugseeHono()(c, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('refactor: route fallback + re-entrancy', () => {
  it('falls back to the path for the txn name when routePath is empty', async () => {
    const txn = fakeTxn();
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction: vi.fn(() => txn) } });
    const c = ctx({
      req: { method: 'GET', path: '/users/7', routePath: '', header: () => undefined },
    });
    await bugseeHono({ getClient: () => client })(c, nextThatSets(c, 200));
    expect(txn.setName).toHaveBeenCalledWith('GET /users/7'); // routePath empty → path
  });

  it('re-entrancy: refines the http-layer owner — one txn, error on owner, refiner finish no-op', async () => {
    const { createNodeRequestContextStore, runServerRequest } = await import('@bugsee/node');
    const store = createNodeRequestContextStore();
    const ownerTxn = fakeTxn();
    const startTransaction = vi.fn(() => ownerTxn);
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ store, perf: { startTransaction }, logException });
    const mw = bugseeHono({ getClient: () => client, newContextId: () => 'adapter' });
    const err = new Error('boom');
    await runServerRequest(
      { method: 'GET', url: '/users/7' },
      { getClient: () => client, newContextId: () => 'owner' },
      async () => {
        const c = ctx({
          req: {
            method: 'GET',
            path: '/users/7',
            routePath: '/users/:id',
            header: () => undefined,
          },
        });
        await mw(c, nextThatSets(c, 500, err));
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
