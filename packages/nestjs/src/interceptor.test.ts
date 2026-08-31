import type { Bugsee, RequestContextStore } from '@bugsee/node';
import type { Transaction } from '@bugsee/performance';
import { type Observable, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { CallHandlerLike, ExecutionContextLike } from './interceptor';
import { BugseeInterceptor } from './interceptor';
import type { NestHttpRequest, NestHttpResponse } from './shared';

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
  setTrace: ReturnType<typeof vi.fn>;
  setUser: ReturnType<typeof vi.fn>;
  getCurrent: ReturnType<typeof vi.fn>;
} =>
  ({
    getCurrent: vi.fn(),
    run: vi.fn(),
    enterWith: vi.fn(),
    setUser: vi.fn(),
    setAttribute: vi.fn(),
    setTrace: vi.fn(),
  }) as unknown as RequestContextStore & {
    setTrace: ReturnType<typeof vi.fn>;
    setUser: ReturnType<typeof vi.fn>;
    getCurrent: ReturnType<typeof vi.fn>;
  };

const fakeClient = (opts: {
  store?: RequestContextStore;
  perf?: { startTransaction: ReturnType<typeof vi.fn> };
  logException?: ReturnType<typeof vi.fn>;
  getClientThrows?: boolean;
}): Bugsee =>
  ({
    getServiceProvider: () => ({ getImmediate: () => opts.store ?? undefined }),
    ext: () => {
      if (!opts.perf) throw new Error('no performance extension');
      return opts.perf;
    },
    logException: opts.logException ?? vi.fn(() => Promise.resolve()),
  }) as unknown as Bugsee;

const ctx = (req: NestHttpRequest, res: NestHttpResponse): ExecutionContextLike =>
  ({
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  }) as unknown as ExecutionContextLike;

const handlerOf = (obs: Observable<unknown>): CallHandlerLike =>
  ({ handle: () => obs }) as unknown as CallHandlerLike;

const req = (over: Partial<NestHttpRequest> = {}): NestHttpRequest => ({
  method: 'GET',
  url: '/u',
  headers: {},
  ...over,
});

// Subscribe synchronously and collect the outcome.
const drain = (
  obs: Observable<unknown>,
): { value?: unknown; error?: unknown; completed: boolean } => {
  const out: { value?: unknown; error?: unknown; completed: boolean } = { completed: false };
  obs.subscribe({
    next: (v) => {
      out.value = v;
    },
    error: (e) => {
      out.error = e;
    },
    complete: () => {
      out.completed = true;
    },
  });
  return out;
};

describe('BugseeInterceptor', () => {
  it('returns the handler stream untouched when no client is launched', () => {
    const stream = of('passthrough');
    const result = new BugseeInterceptor({ getClient: () => undefined }).intercept(
      ctx(req(), {}),
      handlerOf(stream),
    );
    expect(result).toBe(stream); // exact same observable, no wrapping
  });

  it('defaults to the carrier client (no options) — pass-through when none is launched', () => {
    const stream = of('x');
    // exercises `options.getClient ?? defaultGetClient` + the `options = {}` default
    const result = new BugseeInterceptor().intercept(ctx(req(), {}), handlerOf(stream));
    expect(result).toBe(stream);
  });

  it('returns the handler stream untouched when getClient throws', () => {
    const stream = of('x');
    const result = new BugseeInterceptor({
      getClient: () => {
        throw new Error('resolve failed');
      },
    }).intercept(ctx(req(), {}), handlerOf(stream));
    expect(result).toBe(stream);
  });

  it('returns the handler stream untouched on a non-HTTP context (switchToHttp throws)', () => {
    const stream = of('x');
    const badCtx = {
      switchToHttp: () => {
        throw new Error('not an http context');
      },
    } as unknown as ExecutionContextLike;
    const result = new BugseeInterceptor({ getClient: () => fakeClient({}) }).intercept(
      badCtx,
      handlerOf(stream),
    );
    expect(result).toBe(stream);
  });

  it('starts an http.server transaction (name + operation), publishes its trace, finishes OK on success', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ store, perf: { startTransaction } });
    const res: NestHttpResponse = { statusCode: 200 };

    const out = drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(req({ method: 'POST', route: { path: '/orders/:id' } }), res),
        handlerOf(of('ok')),
      ),
    );

    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'POST /orders/:id', operation: 'http.server' }),
    );
    expect(store.setTrace).toHaveBeenCalledWith({
      traceId: 'trace-1',
      spanId: 'span-1',
      sampled: true,
    });
    expect(out.value).toBe('ok');
    expect(out.completed).toBe(true);
    expect(txn.finish).toHaveBeenCalledWith('OK');
    expect(txn.setName).toHaveBeenCalledWith('POST /orders/:id'); // re-stamped with the parametrized route
    expect(txn.setAttribute).toHaveBeenCalledWith('http.method', 'POST');
  });

  // F-4 (round-2 D2): a manual rename (client.ext('performance').setRouteName()/setActiveTransactionName())
  // stamps 'bugsee.name_source' on the transaction; server-instrument's finishWith must NOT clobber it
  // with the automatic route-derived name. This exercises the check against a Transaction double whose
  // getAttributes() actually reports the stamp, not one that omits the method entirely.
  it('does NOT clobber a manual rename (name-source attribute present) with the automatic route name', () => {
    const store = fakeStore();
    const txn = fakeTxn({ getAttributes: vi.fn(() => ({ 'bugsee.name_source': 'route' })) });
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ store, perf: { startTransaction } });
    const res: NestHttpResponse = { statusCode: 200 };

    const out = drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(req({ method: 'POST', route: { path: '/orders/:id' } }), res),
        handlerOf(of('ok')),
      ),
    );

    expect(out.value).toBe('ok');
    expect(txn.setName).not.toHaveBeenCalled(); // the manual rename wins
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('continues an inbound W3C trace from the traceparent header', () => {
    const startTransaction = vi.fn(() => fakeTxn());
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction } });
    drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(
          req({
            headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
          }),
          {},
        ),
        handlerOf(of('ok')),
      ),
    );
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

  it('reports a thrown error (mechanism http-error) and re-throws it (response untouched)', () => {
    const logException = vi.fn(() => Promise.resolve());
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) }, logException });
    const err = new Error('handler boom');

    const out = drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(req({ route: { path: '/x/:id' } }), {}),
        handlerOf(throwError(() => err)),
      ),
    );

    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(out.error).toBe(err); // the SAME error propagates downstream
    expect(txn.finish).toHaveBeenCalledWith('ERROR');
  });

  it('skips reporting a 4xx HttpException, re-throws it, and finishes the transaction OK', () => {
    const logException = vi.fn(() => Promise.resolve());
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) }, logException });
    const httpErr = { getStatus: () => 404, message: 'not found' };

    const out = drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(req(), {}),
        handlerOf(throwError(() => httpErr)),
      ),
    );

    expect(logException).not.toHaveBeenCalled();
    expect(out.error).toBe(httpErr);
    // a 4xx is client control flow → the server transaction is OK, not ERROR
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('finishes the transaction ERROR for a thrown 5xx HttpException', () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const httpErr = { getStatus: () => 503 };
    drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(req(), {}),
        handlerOf(throwError(() => httpErr)),
      ),
    );
    expect(txn.finish).toHaveBeenCalledWith('ERROR');
  });

  it('honors a custom shouldReport', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const httpErr = { getStatus: () => 500 };
    drain(
      new BugseeInterceptor({
        getClient: () => client,
        shouldReport: () => true, // override: report even HttpExceptions
      }).intercept(ctx(req(), {}), handlerOf(throwError(() => httpErr))),
    );
    expect(logException).toHaveBeenCalledWith(httpErr, { mechanism: 'http-error' });
  });

  it('works without the performance extension (reports, no transaction)', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException }); // no perf
    const err = new Error('boom');
    const out = drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(req(), {}),
        handlerOf(throwError(() => err)),
      ),
    );
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(out.error).toBe(err);
  });

  it('swallows a synchronous logException failure (never breaks the stream)', () => {
    const logException = vi.fn(() => {
      throw new Error('reporting blew up');
    });
    const client = fakeClient({ logException });
    const err = new Error('boom');
    const out = drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(req(), {}),
        handlerOf(throwError(() => err)),
      ),
    );
    expect(out.error).toBe(err); // original error still propagates
  });

  it('swallows a transaction.finish() failure on finalize', () => {
    const txn = fakeTxn({
      finish: vi.fn(() => {
        throw new Error('finish blew up');
      }),
    });
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const out = drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(req(), { statusCode: 200 }),
        handlerOf(of('ok')),
      ),
    );
    expect(out.value).toBe('ok'); // success still flows
    expect(out.completed).toBe(true);
    expect(txn.finish).toHaveBeenCalled(); // the failure came FROM finish(), i.e. it was attempted
  });

  it('does not finish an already-finished transaction', () => {
    const txn = fakeTxn({ isFinished: vi.fn(() => true) });
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(req(), {}),
        handlerOf(of('ok')),
      ),
    );
    expect(txn.finish).not.toHaveBeenCalled();
  });

  it('swallows a startTransaction failure — APM wiring never breaks the request', () => {
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
    const out = drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(req(), {}),
        handlerOf(throwError(() => err)),
      ),
    );
    expect(out.error).toBe(err); // request still flows
    expect(logException).toHaveBeenCalled(); // reporting still works without APM
  });

  it('defaults the finished transaction method to GET when the request has none', () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const noMethod = { url: '/u', headers: {} } as NestHttpRequest; // no `method`
    drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(noMethod, { statusCode: 200 }),
        handlerOf(of('ok')),
      ),
    );
    expect(txn.setAttribute).toHaveBeenCalledWith('http.method', 'GET');
  });

  it('records the best-effort http.status_code from the response', () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(req(), { statusCode: 201 }),
        handlerOf(of('ok')),
      ),
    );
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 201);
  });

  it('names the transaction from originalUrl (query stripped) when no route is matched', () => {
    const startTransaction = vi.fn(() => fakeTxn());
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction } });
    drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx({ method: 'GET', originalUrl: '/search?q=secret', headers: {} } as NestHttpRequest, {
          statusCode: 200,
        }),
        handlerOf(of('ok')),
      ),
    );
    // express Nest exposes originalUrl; with no matched route the span name falls back to its PATH (the
    // query string — which may carry secrets — is stripped out of the name).
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'GET /search', operation: 'http.server' }),
    );
  });

  it('REFINES the node:http owner span under re-entrancy (no second transaction; propagates route + user)', () => {
    // A run-scoped owner span stashed on the active context exactly as the node:http interceptor does it
    // (`runScoped: true` makes it the refinable owner). The Nest interceptor must REUSE it, not start a 2nd.
    const ownerSpan = {
      setRoute: vi.fn(),
      captureError: vi.fn(() => false),
      finish: vi.fn(),
      cancel: vi.fn(),
    };
    const activeContext = {
      contextId: 'owner-ctx',
      attributes: {},
      [Symbol.for('bugsee.server.span')]: { span: ownerSpan, runScoped: true },
    };
    const startTransaction = vi.fn(() => fakeTxn());
    const store = fakeStore();
    store.getCurrent.mockReturnValue(activeContext);
    const client = fakeClient({ store, perf: { startTransaction } });

    const out = drain(
      new BugseeInterceptor({
        getClient: () => client,
        user: () => 'eve@example.com',
      }).intercept(
        ctx(req({ method: 'PUT', route: { path: '/items/:id' } }), { statusCode: 200 }),
        handlerOf(of('ok')),
      ),
    );

    expect(startTransaction).not.toHaveBeenCalled(); // refine the owner → NO second http.server transaction
    expect(store.setUser).toHaveBeenCalledWith('eve@example.com'); // the adapter's user lands on the owner ctx
    expect(ownerSpan.setRoute).toHaveBeenCalledWith('/items/:id'); // routing refines the owner's name
    expect(ownerSpan.finish).not.toHaveBeenCalled(); // the owner (node:http) finishes on res 'close', not us
    expect(out.value).toBe('ok');
    expect(out.completed).toBe(true);
  });

  it('reports a thrown error under re-entrancy WITHOUT finishing the owner span (owner finishes on close)', () => {
    // Same re-entrancy setup as above, but the handler THROWS. Error reporting must go through the direct
    // `reportErrorOnce` path (logException) — NOT the owner span's captureError — and the refining span's
    // finish must stay a no-op so the node:http owner alone finishes the transaction.
    const ownerSpan = {
      setRoute: vi.fn(),
      captureError: vi.fn(() => false),
      finish: vi.fn(),
      cancel: vi.fn(),
    };
    const activeContext = {
      contextId: 'owner-ctx',
      attributes: {},
      [Symbol.for('bugsee.server.span')]: { span: ownerSpan, runScoped: true },
    };
    const logException = vi.fn(() => Promise.resolve());
    const store = fakeStore();
    store.getCurrent.mockReturnValue(activeContext);
    const client = fakeClient({
      store,
      perf: { startTransaction: vi.fn(() => fakeTxn()) },
      logException,
    });
    const err = new Error('handler boom under re-entrancy');

    const out = drain(
      new BugseeInterceptor({ getClient: () => client }).intercept(
        ctx(req({ method: 'GET', route: { path: '/items/:id' } }), { statusCode: 500 }),
        handlerOf(throwError(() => err)),
      ),
    );

    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' }); // reported directly
    expect(ownerSpan.captureError).not.toHaveBeenCalled(); // NOT via the span (keeps the both-mode dedup seam)
    expect(ownerSpan.finish).not.toHaveBeenCalled(); // refiner finish is a no-op → the node:http owner finishes
    expect(ownerSpan.cancel).not.toHaveBeenCalled();
    expect(out.error).toBe(err); // the original error re-propagates so Nest's filters still format the response
  });

  it('survives a throwing user getter — still starts the transaction (degrades to no user)', () => {
    const startTransaction = vi.fn(() => fakeTxn());
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction } });
    const out = drain(
      new BugseeInterceptor({
        getClient: () => client,
        user: () => {
          throw new Error('user getter blew up');
        },
      }).intercept(
        ctx(req({ method: 'GET', route: { path: '/u/:id' } }), { statusCode: 200 }),
        handlerOf(of('ok')),
      ),
    );
    // The thrown user getter is swallowed: the http.server transaction is still started (name has no user).
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'GET /u/:id', operation: 'http.server' }),
    );
    expect(out.value).toBe('ok');
    expect(out.completed).toBe(true);
  });
});
