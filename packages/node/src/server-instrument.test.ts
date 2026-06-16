import type { BugseeClient } from '@bugsee/core';
import type { Transaction } from '@bugsee/performance';
import { describe, expect, it, vi } from 'vitest';
import { createNodeRequestContextStore, type RequestContextStore } from './request-context-store';
import {
  defaultShouldReport,
  getActiveServerSpan,
  openServerContext,
  openServerRequest,
  runServerRequest,
  type ServerInstrumentOptions,
  startServerSpan,
} from './server-instrument';

const SERVER_SPAN = Symbol.for('bugsee.server.span');
const stashed = (ctx: unknown): unknown =>
  ctx === undefined ? undefined : (ctx as Record<symbol, unknown>)[SERVER_SPAN];

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

// A minimal fake store (getCurrent → undefined) for the owner-path / decoupled unit tests.
const fakeStore = (): RequestContextStore & {
  enterWith: ReturnType<typeof vi.fn>;
  setTrace: ReturnType<typeof vi.fn>;
  setAttribute: ReturnType<typeof vi.fn>;
} =>
  ({
    getCurrent: vi.fn(),
    run: vi.fn(),
    enterWith: vi.fn(),
    setUser: vi.fn(),
    setAttribute: vi.fn(),
    setTrace: vi.fn(),
  }) as never;

const fakeClient = (opts: {
  store?: RequestContextStore;
  perf?: { startTransaction: ReturnType<typeof vi.fn> };
  logException?: ReturnType<typeof vi.fn>;
}): BugseeClient =>
  ({
    getServiceProvider: () => ({ getImmediate: () => opts.store ?? undefined }),
    ext: () => {
      if (!opts.perf) throw new Error('no performance extension');
      return opts.perf;
    },
    logException: opts.logException ?? vi.fn(() => Promise.resolve()),
  }) as unknown as BugseeClient;

const info = (over: Partial<Parameters<typeof openServerRequest>[0]> = {}) => ({
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
  it('reads status (http-errors / Koa), statusCode, output.statusCode (Boom)', () => {
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

describe('openServerRequest', () => {
  it('returns a safe no-op span when no client is launched', () => {
    const span = openServerRequest(info(), { getClient: () => undefined });
    expect(span.captureError(new Error('x'))).toBe(false);
    expect(() => {
      span.setRoute('/r');
      span.finish(200);
      span.cancel();
    }).not.toThrow();
  });

  it('returns a no-op span when getClient throws', () => {
    const span = openServerRequest(info(), {
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
    openServerRequest(
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

  it('finish(status) finishes OK (<500) / ERROR (>=500) with method + status_code + route name', () => {
    const txn = fakeTxn();
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction: vi.fn(() => txn) } });
    const span = openServerRequest(info({ method: 'POST', route: '/o/:id' }), {
      getClient: () => client,
    });
    span.finish(201);
    expect(txn.setName).toHaveBeenCalledWith('POST /o/:id');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.method', 'POST');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 201);
    expect(txn.finish).toHaveBeenCalledWith('OK');

    const txn2 = fakeTxn();
    const c2 = fakeClient({ perf: { startTransaction: vi.fn(() => txn2) } });
    openServerRequest(info(), { getClient: () => c2 }).finish(500);
    expect(txn2.finish).toHaveBeenCalledWith('ERROR');
  });

  it('finish(status, outcome) honors an EXPLICIT outcome over the status-derived one (D10)', () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    // recorded status 200 (sub-500) but the framework decided ERROR (e.g. Nest 5xx HttpException)
    openServerRequest(info(), { getClient: () => client }).finish(200, 'ERROR');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
    expect(txn.finish).toHaveBeenCalledWith('ERROR');

    const txn2 = fakeTxn();
    const c2 = fakeClient({ perf: { startTransaction: vi.fn(() => txn2) } });
    openServerRequest(info(), { getClient: () => c2 }).finish(503, 'OK');
    expect(txn2.finish).toHaveBeenCalledWith('OK');
  });

  it('cancel() finishes CANCELLED with status_code 0', () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    openServerRequest(info(), { getClient: () => client }).cancel();
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 0);
    expect(txn.finish).toHaveBeenCalledWith('CANCELLED');
  });

  it('finish(status, "CANCELLED") records the real status but finishes CANCELLED (distinct from cancel())', () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    openServerRequest(info(), { getClient: () => client }).finish(499, 'CANCELLED');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 499);
    expect(txn.finish).toHaveBeenCalledWith('CANCELLED');
  });

  it('captureError reports (mechanism http-error) + sets http.route + returns true', () => {
    const store = fakeStore();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ store, logException });
    const err = new Error('boom');
    const reported = openServerRequest(info({ route: '/x/:id' }), {
      getClient: () => client,
    }).captureError(err);
    expect(reported).toBe(true);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/x/:id');
  });

  it('captureError skips (returns false) when shouldReport is false', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const reported = openServerRequest(info(), { getClient: () => client }).captureError({
      getStatus: () => 404,
    });
    expect(reported).toBe(false);
    expect(logException).not.toHaveBeenCalled();
  });

  it('captureError honors a per-call shouldReport override', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const err = { getStatus: () => 404 };
    const reported = openServerRequest(info(), { getClient: () => client }).captureError(err, {
      shouldReport: () => true,
    });
    expect(reported).toBe(true);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
  });

  it('captureError honors an adapter-level options.shouldReport default', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    // an adapter that never reports (its own policy) — passed as options.shouldReport
    const opts: ServerInstrumentOptions = { getClient: () => client, shouldReport: () => false };
    expect(openServerRequest(info(), opts).captureError(new Error('x'))).toBe(false);
    expect(logException).not.toHaveBeenCalled();
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
    const span = openServerRequest(info({ method: 'GET', url: '/o/7' }), {
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
    const span = openServerRequest(info({ method: 'GET', url: '/raw?q=1' }), {
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
    const span = openServerRequest(info(), { getClient: () => client });
    expect(span.captureError(new Error('x'))).toBe(true);
    expect(() => span.finish(200)).not.toThrow();
  });

  it('works without a context store (reports without an http.route)', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException }); // no store
    expect(
      openServerRequest(info(), { getClient: () => client }).captureError(new Error('x')),
    ).toBe(true);
    expect(logException).toHaveBeenCalled();
  });

  it('swallows a logException failure and returns false', () => {
    const logException = vi.fn(() => {
      throw new Error('reporting blew up');
    });
    const client = fakeClient({ logException });
    expect(
      openServerRequest(info(), { getClient: () => client }).captureError(new Error('x')),
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
    const span = openServerRequest(info(), { getClient: () => client });
    expect(span.captureError(new Error('x'))).toBe(true);
    expect(() => span.finish(200)).not.toThrow();
  });

  it('does not finish an already-finished transaction', () => {
    const txn = fakeTxn({ isFinished: vi.fn(() => true) });
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    openServerRequest(info(), { getClient: () => client }).finish(200);
    expect(txn.finish).not.toHaveBeenCalled();
  });

  it('starts WITHOUT continuation when there is no inbound traceparent', () => {
    const txn = fakeTxn();
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction } });
    openServerRequest(info(), { getClient: () => client });
    expect(startTransaction).toHaveBeenCalledWith(
      expect.not.objectContaining({ continuation: expect.anything() }),
    );
  });

  it('defaults to the carrier client (no options) — no-op span without a launch', () => {
    expect(openServerRequest(info()).captureError(new Error('x'))).toBe(false);
  });
});

describe('decoupled primitives (openServerContext / startServerSpan)', () => {
  it('openServerContext opens the context (enterWith) without starting a transaction', () => {
    const store = fakeStore();
    const startTransaction = vi.fn();
    const client = fakeClient({ store, perf: { startTransaction } });
    openServerContext(info({ user: 'a@x.com' }), { getClient: () => client });
    expect(store.enterWith).toHaveBeenCalledTimes(1);
    expect(startTransaction).not.toHaveBeenCalled();
  });

  it('openServerContext is a no-op without a client / store', () => {
    const store = fakeStore();
    openServerContext(info(), { getClient: () => undefined });
    openServerContext(info(), { getClient: () => fakeClient({}) }); // client but no store
    expect(store.enterWith).not.toHaveBeenCalled();
  });

  it('openServerContext does NOT replace an already-active context (re-entrancy)', () => {
    const store = createNodeRequestContextStore();
    const client = fakeClient({ store });
    store.run({ contextId: 'pre', attributes: {} }, () => {
      openServerContext(info({ user: 'late@x.com' }), { getClient: () => client });
      expect(store.getCurrent()?.contextId).toBe('pre'); // unchanged
      expect(store.getCurrent()?.user).toBeUndefined();
    });
  });

  it('startServerSpan starts the transaction WITHOUT opening a context', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    const span = startServerSpan(info({ method: 'PUT', route: '/p/:id' }), {
      getClient: () => client,
    });
    expect(store.enterWith).not.toHaveBeenCalled(); // context NOT opened here
    expect(store.setTrace).toHaveBeenCalledWith({ traceId: 'trace-1', spanId: 'span-1' });
    span.finish(200);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('startServerSpan returns a no-op span without a client', () => {
    expect(
      startServerSpan(info(), { getClient: () => undefined }).captureError(new Error('x')),
    ).toBe(false);
  });

  it('both decoupled primitives default to the carrier client when called with no options', () => {
    expect(() => openServerContext(info())).not.toThrow(); // no launch → no-op
    expect(startServerSpan(info()).captureError(new Error('x'))).toBe(false);
  });
});

describe('runServerRequest (run-scoped owner/refiner)', () => {
  it('runs dispatch with a no-op span and returns its value when no client is launched', () => {
    let seen = false;
    const result = runServerRequest(info(), { getClient: () => undefined }, (span) => {
      expect(span.captureError(new Error('x'))).toBe(false);
      span.finish(200);
      seen = true;
      return 42;
    });
    expect(seen).toBe(true);
    expect(result).toBe(42);
  });

  it('OWNER: opens the context (run), starts ONE txn, stashes its span, reverts after dispatch', () => {
    const store = createNodeRequestContextStore();
    const txn = fakeTxn();
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ store, perf: { startTransaction } });
    let ctxIdDuring: string | undefined;
    let stashDuring: unknown;
    const result = runServerRequest(
      info({
        method: 'GET',
        url: '/u',
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      }),
      { getClient: () => client, newContextId: () => 'cid' },
      (span) => {
        ctxIdDuring = store.getCurrent()?.contextId;
        stashDuring = stashed(store.getCurrent());
        span.finish(200);
        return 'ok';
      },
    );
    expect(result).toBe('ok');
    expect(ctxIdDuring).toBe('cid');
    expect(stashDuring).toBeDefined(); // owner span stashed on the context during dispatch
    expect(startTransaction).toHaveBeenCalledTimes(1);
    expect(store.getCurrent()).toBeUndefined(); // run reverted the context
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('OWNER without a store: still starts a txn (no context) and runs dispatch', () => {
    const txn = fakeTxn();
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ perf: { startTransaction } }); // no store
    const result = runServerRequest(info(), { getClient: () => client }, (span) => {
      span.finish(204);
      return 7;
    });
    expect(result).toBe(7);
    expect(startTransaction).toHaveBeenCalledTimes(1);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('the stashed span is NON-ENUMERABLE (never leaks into report/capture enumeration)', () => {
    const store = createNodeRequestContextStore();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => fakeTxn()) } });
    runServerRequest(info(), { getClient: () => client, newContextId: () => 'cid' }, () => {
      const ctx = store.getCurrent() as object;
      expect(stashed(ctx)).toBeDefined();
      expect(Object.getOwnPropertyDescriptor(ctx, SERVER_SPAN)?.enumerable).toBe(false);
      // only named fields enumerate (trace was set by the started txn); the symbol-keyed span is absent
      expect(Object.keys(ctx)).toEqual(['contextId', 'attributes', 'trace']);
      // object-spread (how report assembly copies the context) drops the non-enumerable symbol span
      expect(SERVER_SPAN in { ...(ctx as Record<string | symbol, unknown>) }).toBe(false);
      return null;
    });
  });

  it('REFINER: a later opener in the SAME request refines the owner (no 2nd context/txn)', () => {
    const store = createNodeRequestContextStore();
    const ownerTxn = fakeTxn();
    const startTransaction = vi.fn(() => ownerTxn);
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ store, perf: { startTransaction }, logException });
    runServerRequest(
      info({ method: 'GET', url: '/o/7' }),
      { getClient: () => client, newContextId: () => 'owner' },
      (ownerSpan) => {
        // a dedicated adapter opens later — it must REFINE, not open anew
        const refiner = openServerRequest(
          info({ method: 'GET', url: '/o/7', route: '/o/:id', user: 'u@x.com' }),
          { getClient: () => client, newContextId: () => 'adapter' },
        );
        // same context (still 'owner'), user propagated, no new context minted
        expect(store.getCurrent()?.contextId).toBe('owner');
        expect(store.getCurrent()?.user).toBe('u@x.com');
        refiner.setRoute('/o/:id');
        expect(refiner.captureError(new Error('boom'))).toBe(true);
        expect(store.getCurrent()?.attributes?.['http.route']).toBe('/o/:id');
        refiner.finish(500); // no-op — the owner finishes
        refiner.cancel(); // no-op too
        ownerSpan.finish(200);
        return null;
      },
    );
    expect(startTransaction).toHaveBeenCalledTimes(1); // ONE transaction for the request
    expect(logException).toHaveBeenCalledWith(expect.any(Error), { mechanism: 'http-error' });
    // owner finished OK (200); the refiner's finish(500) did NOT flip it to ERROR
    expect(ownerTxn.finish).toHaveBeenCalledTimes(1);
    expect(ownerTxn.finish).toHaveBeenCalledWith('OK');
  });

  it('REFINER via runServerRequest: reuses owner ctx/txn, refines route+error, finish is a true no-op, preserves owner user+trace', () => {
    const store = createNodeRequestContextStore();
    const ownerTxn = fakeTxn();
    const startTransaction = vi.fn(() => ownerTxn);
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ store, perf: { startTransaction }, logException });
    let innerResult: unknown;
    runServerRequest(
      info({ method: 'GET', url: '/a/1', user: 'owner@x.com' }),
      { getClient: () => client, newContextId: () => 'owner' },
      () => {
        const ownerTrace = store.getCurrent()?.trace;
        innerResult = runServerRequest(
          info({ method: 'GET', url: '/a/1', route: '/a/:id' }), // refiner: NO user
          { getClient: () => client, newContextId: () => 'inner' },
          (refiner) => {
            expect(store.getCurrent()?.contextId).toBe('owner'); // not 'inner'
            refiner.setRoute('/a/:id');
            expect(refiner.captureError(new Error('boom'))).toBe(true);
            refiner.finish(503); // no-op
            refiner.cancel(); // no-op
            // a refiner with NO user must not clobber the owner's user; owner trace untouched
            expect(store.getCurrent()?.user).toBe('owner@x.com');
            expect(store.getCurrent()?.trace).toBe(ownerTrace);
            expect(store.getCurrent()?.attributes?.['http.route']).toBe('/a/:id');
            return 'inner-ran';
          },
        );
        return null;
      },
    );
    expect(innerResult).toBe('inner-ran');
    expect(startTransaction).toHaveBeenCalledTimes(1); // owner only
    expect(logException).toHaveBeenCalledWith(expect.any(Error), { mechanism: 'http-error' });
    // the refiner's finish(503)/cancel() were true no-ops — the owner txn was never finished by it
    expect(ownerTxn.finish).not.toHaveBeenCalled();
  });

  it('OWNER via openServerRequest (enterWith) stashes its span so a later opener refines (one txn)', () => {
    const store = createNodeRequestContextStore();
    const ownerTxn = fakeTxn();
    const startTransaction = vi.fn(() => ownerTxn);
    const client = fakeClient({ store, perf: { startTransaction } });
    // enterWith makes the owner context active for the rest of this execution (fresh store → no leak)
    openServerRequest(info({ url: '/e/1' }), {
      getClient: () => client,
      newContextId: () => 'owner',
    });
    expect(store.getCurrent()?.contextId).toBe('owner');
    expect(stashed(store.getCurrent())).toBeDefined(); // owner span stashed onto the active context
    const refiner = openServerRequest(info({ url: '/e/1', route: '/e/:id' }), {
      getClient: () => client,
    });
    refiner.setRoute('/e/:id');
    refiner.finish(200); // no-op
    expect(store.getCurrent()?.contextId).toBe('owner'); // not replaced
    expect(startTransaction).toHaveBeenCalledTimes(1); // owner only
    expect(ownerTxn.finish).not.toHaveBeenCalled();
  });

  it('REFINER captureError applies the refiner adapter policy, not the owner default', () => {
    const store = createNodeRequestContextStore();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({
      store,
      perf: { startTransaction: vi.fn(() => fakeTxn()) },
      logException,
    });
    runServerRequest(
      info({ url: '/o' }),
      { getClient: () => client, newContextId: () => 'owner' },
      () => {
        // refiner whose adapter policy NEVER reports — must win over the owner's default
        const refiner = openServerRequest(info({ url: '/o' }), {
          getClient: () => client,
          shouldReport: () => false,
        });
        expect(refiner.captureError(new Error('x'))).toBe(false);
        expect(logException).not.toHaveBeenCalled();
        return null;
      },
    );
  });

  it('defaults to the carrier client when no getClient is supplied (no launch → no-op)', () => {
    const result = runServerRequest(info(), {}, (span) => {
      expect(span.captureError(new Error('x'))).toBe(false);
      return 'noop';
    });
    expect(result).toBe('noop');
  });

  it('OWNER mints a context id via the default generator when none is supplied', () => {
    const store = createNodeRequestContextStore();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => fakeTxn()) } });
    let id: string | undefined;
    runServerRequest(info(), { getClient: () => client }, () => {
      id = store.getCurrent()?.contextId;
      return null;
    });
    expect(typeof id).toBe('string');
    expect(id).toHaveLength(36); // crypto.randomUUID()
  });

  it('startServerSpan REFINES an active owner: one txn, setRoute+captureError reach the owner, per-call override honored', () => {
    const store = createNodeRequestContextStore();
    const ownerTxn = fakeTxn();
    const startTransaction = vi.fn(() => ownerTxn);
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ store, perf: { startTransaction }, logException });
    runServerRequest(
      info({ url: '/s/1' }),
      { getClient: () => client, newContextId: () => 'owner' },
      () => {
        const refiner = startServerSpan(info({ url: '/s/1', route: '/s/:id' }), {
          getClient: () => client,
          shouldReport: () => false, // adapter default: never report
        });
        refiner.setRoute('/s/:id');
        // a per-call override beats the refiner's adapter default
        expect(refiner.captureError(new Error('x'), { shouldReport: () => true })).toBe(true);
        expect(store.getCurrent()?.attributes?.['http.route']).toBe('/s/:id');
        refiner.finish(200); // no-op
        return null;
      },
    );
    expect(startTransaction).toHaveBeenCalledTimes(1); // owner only — startServerSpan refined
    expect(logException).toHaveBeenCalledTimes(1);
    expect(ownerTxn.finish).not.toHaveBeenCalled(); // refiner finish was a no-op
  });
});

describe('getActiveServerSpan', () => {
  it('returns undefined without a client', () => {
    expect(getActiveServerSpan({ getClient: () => undefined })).toBeUndefined();
  });

  it('returns undefined when no context is active', () => {
    const store = createNodeRequestContextStore();
    const client = fakeClient({ store });
    expect(getActiveServerSpan({ getClient: () => client })).toBeUndefined();
  });

  it("returns the owner's stashed span during a request — a later seam can captureError against it", () => {
    const store = createNodeRequestContextStore();
    const ownerTxn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({
      store,
      perf: { startTransaction: vi.fn(() => ownerTxn) },
      logException,
    });
    runServerRequest(info({ url: '/o/7' }), { getClient: () => client }, () => {
      const span = getActiveServerSpan({ getClient: () => client });
      expect(span).toBeDefined();
      span?.setRoute('/o/:id');
      expect(span?.captureError(new Error('boom'))).toBe(true);
      expect(store.getCurrent()?.attributes?.['http.route']).toBe('/o/:id');
      return null;
    });
    expect(logException).toHaveBeenCalledWith(expect.any(Error), { mechanism: 'http-error' });
  });
});
