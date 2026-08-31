import type { BugseeClient } from '@bugsee/core';
import type { Transaction } from '@bugsee/performance';
import { NAME_SOURCE_ATTRIBUTE } from '@bugsee/protocol';
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
    // Required so finishWith's F-4 manual-rename check (transaction.getAttributes()) runs for real
    // instead of falling through a defensive catch — see server-instrument.ts's `manuallyRenamed` read.
    getAttributes: vi.fn(() => ({})),
    getName: () => 'name',
    finish: vi.fn(),
    ...over,
  };
  return txn;
};

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

  it('redacts secrets in the request URL before they reach `http.url`', () => {
    // Wave 1.1. `info.url` is the raw request target, and its own doc comment claimed "the redaction
    // pipeline scrubs query secrets" — it did not (docs/review/node-B-http-server.md SEV3 #12). This is
    // the shared core behind node/bun/deno http AND express/fastify/koa/hapi/elysia, so it is the one
    // place that has to be right.
    const store = fakeStore();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => fakeTxn()) } });
    openServerRequest(info({ method: 'GET', url: '/pay?api_key=SECRET&page=2' }), {
      getClient: () => client,
      newContextId: () => 'cid-1',
    });
    const [ctx] = store.enterWith.mock.calls[0] as [{ attributes: Record<string, string> }];
    expect(ctx.attributes['http.url']).toBe('/pay?api_key=%3Credacted%3E&page=2');
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
        // Continues as a CHILD of the inbound span, adopting the upstream sampling decision.
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
  });

  it('continues an UNSAMPLED inbound trace: continuation.sampled is the parsed flag (not hardcoded true)', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    openServerRequest(
      info({
        method: 'GET',
        url: '/u',
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00', // flags 00 → NOT sampled
      }),
      { getClient: () => client },
    );
    const startTx = (client.ext as () => { startTransaction: ReturnType<typeof vi.fn> })()
      .startTransaction;
    expect(startTx).toHaveBeenCalledWith(
      expect.objectContaining({
        continuation: expect.objectContaining({ sampled: false, parentSpanId: 'b7ad6b7169203331' }),
      }),
    );
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

  // F-4: `setRouteName()`/`setActiveTransactionName()` (the performance controller) rename the ACTIVE
  // transaction directly and stamp NAME_SOURCE_ATTRIBUTE ('bugsee.name_source'). finishWith() used to
  // unconditionally call `transaction.setName(spanName(info, route))` on finish, clobbering that manual
  // rename with the route-derived name every time. The fix: skip the automatic setName call once the
  // transaction already carries a name-source attribute (a manual rename happened this request) — but
  // still set the other attributes and finish normally.
  it('does NOT clobber a manual rename (setRouteName/setActiveTransactionName) with the route name', () => {
    const txn = fakeTxn({
      getAttributes: vi.fn(() => ({ [NAME_SOURCE_ATTRIBUTE]: 'route' })),
    });
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction: vi.fn(() => txn) } });
    const span = openServerRequest(info({ method: 'POST', route: '/o/:id' }), {
      getClient: () => client,
    });
    span.finish(201);
    expect(txn.setName).not.toHaveBeenCalled(); // the manual rename wins
    expect(txn.setAttribute).toHaveBeenCalledWith('http.method', 'POST');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 201);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('sets the automatic route-derived name when NO manual rename happened (name-source attribute absent)', () => {
    const txn = fakeTxn({ getAttributes: vi.fn(() => ({})) });
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    openServerRequest(info({ method: 'GET', route: '/o/:id' }), { getClient: () => client }).finish(
      200,
    );
    expect(txn.setName).toHaveBeenCalledWith('GET /o/:id');
  });

  // D2 (round 2) / R3 S1: `getAttributes()` is a REQUIRED, non-throwing member of the real `Span` — no
  // production `Transaction` can throw from it, so `finishWith` reads it directly (no bespoke inner
  // try/catch around just that call), and the outer try/catch is NOT proven through it (a throwing
  // `getAttributes` is not a reachable production trigger). The outer try/catch around the whole
  // finishWith block exists for a genuine reason instead: a broken 3rd-party APM shim's `Transaction` can
  // throw from a member it actually implements and finishWith actually calls — `setAttribute` is exactly
  // that (every real shim implements it; finishWith calls it twice per finish). Provoke the catch through
  // THAT, not through the unreachable `getAttributes` throw: finishWith still never lets the exception
  // escape into the response lifecycle, even though the steps that already ran before the throwing call
  // (here, the automatic rename) have already taken effect — this is a partial no-op, not a full one.
  it('a Transaction whose setAttribute throws (a broken 3rd-party APM shim) is swallowed by the outer catch, never throws out', () => {
    const txn = fakeTxn({
      setAttribute: vi.fn(() => {
        throw new Error('hostile setAttribute');
      }),
    });
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const span = openServerRequest(info({ method: 'GET', route: '/o/:id' }), {
      getClient: () => client,
    });
    expect(() => span.finish(200)).not.toThrow();
    expect(txn.setName).toHaveBeenCalledWith('GET /o/:id'); // ran before the throwing call
    expect(txn.setAttribute).toHaveBeenCalledWith('http.method', 'GET'); // the call that throws
    expect(txn.finish).not.toHaveBeenCalled(); // never reached — the throw short-circuits the block
  });

  // F-4 integration: the REAL @bugsee/performance controller + real Transaction — not the fakeTxn/fakePerf
  // structural doubles above — so the fix is proven against the actual setRouteName/getAttributes/setName
  // implementation this file's own NAME_SOURCE_ATTRIBUTE-based check depends on, not merely against a
  // hand-rolled mock's assumption about that contract.
  it("F-4 integration (real performance controller): setRouteName's rename survives finish()", async () => {
    const { createPerformanceController, createTransactionStore } = await import(
      '@bugsee/performance'
    );
    const clock = { wallNow: () => 1000, monotonicNow: () => 0 };
    const txnStore = createTransactionStore();
    const perf = createPerformanceController({ clock, store: txnStore });
    const client = fakeClient({ store: fakeStore(), perf: perf as never });
    const span = openServerRequest(info({ method: 'GET', route: '/o/:id' }), {
      getClient: () => client,
    });
    // The app renames the active transaction mid-request — the exact call a route handler makes via
    // `client.ext('performance').setRouteName(...)`.
    perf.setRouteName('/o/custom-name');
    span.finish(200);
    const [buffered] = txnStore.drain();
    expect(buffered?.name).toBe('/o/custom-name'); // the manual rename won, not the route-derived name
  });

  it('F-4 integration (real performance controller): with NO manual rename, the route name is used', async () => {
    const { createPerformanceController, createTransactionStore } = await import(
      '@bugsee/performance'
    );
    const clock = { wallNow: () => 1000, monotonicNow: () => 0 };
    const txnStore = createTransactionStore();
    const perf = createPerformanceController({ clock, store: txnStore });
    const client = fakeClient({ perf: perf as never });
    openServerRequest(info({ method: 'GET', route: '/o/:id' }), { getClient: () => client }).finish(
      200,
    );
    const [buffered] = txnStore.drain();
    expect(buffered?.name).toBe('GET /o/:id');
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

  it('sanitizes the url path used for the span name and http.route', () => {
    // `http.url` was sanitized; the span NAME and `http.route` were derived from the same raw url through
    // `urlPath`, which only strips the query. So `GET /app;jsessionid=ABC` redacted one field and shipped
    // the same session id in two others — the identical shape as the statusText/reason/channel finding,
    // one file over. `jsessionid` is in the denylist, so the denylist already meant to catch this.
    const store = fakeStore();
    const txn = fakeTxn();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    const span = openServerRequest(
      info({ method: 'GET', url: '/app;jsessionid=9A2B4C6D8E/index.jsp?q=1' }),
      { getClient: () => client },
    );
    span.captureError(new Error('x'));
    span.finish(500);
    expect(store.setAttribute).toHaveBeenCalledWith(
      'http.route',
      '/app;jsessionid=%3Credacted%3E/index.jsp',
    );
    expect(txn.setName).toHaveBeenCalledWith('GET /app;jsessionid=%3Credacted%3E/index.jsp');
  });

  it('leaves an ordinary path untouched in the span name and http.route', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    const span = openServerRequest(info({ method: 'GET', url: '/users/42/orders?q=1' }), {
      getClient: () => client,
    });
    span.captureError(new Error('x'));
    span.finish(200);
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/users/42/orders');
    expect(txn.setName).toHaveBeenCalledWith('GET /users/42/orders');
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
    expect(store.setTrace).toHaveBeenCalledWith({
      traceId: 'trace-1',
      spanId: 'span-1',
      sampled: true,
    });
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

  it('an enterWith owner (openServerRequest) is NOT refinable — a later opener opens its OWN context', () => {
    // Only a RUN-SCOPED owner (the http/native auto-instrument) is refined. An enterWith adapter's context
    // must NOT be refined by a later opener — else concurrent requests sharing an async context (e.g.
    // Elysia's app.handle) would collapse onto one context. So two openServerRequest opens TWO owners.
    const store = createNodeRequestContextStore();
    const startTransaction = vi.fn(() => fakeTxn());
    const client = fakeClient({ store, perf: { startTransaction } });
    openServerRequest(info({ url: '/e/1' }), {
      getClient: () => client,
      newContextId: () => 'owner',
    });
    expect(store.getCurrent()?.contextId).toBe('owner');
    expect(stashed(store.getCurrent())).toBeDefined(); // its span is stashed (but marked NOT run-scoped)
    openServerRequest(info({ url: '/e/1', route: '/e/:id' }), {
      getClient: () => client,
      newContextId: () => 'second',
    });
    expect(store.getCurrent()?.contextId).toBe('second'); // opened its OWN context — did NOT refine
    expect(startTransaction).toHaveBeenCalledTimes(2); // two owners
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
    expect(id).toMatch(/^[0-9a-f]{32}$/); // the portable randomId (Node-18 + edge safe)
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

describe('responseHeaders — BE→FE return path (X4, Profile v1 §12 return headers)', () => {
  // The span exposes the configured return headers; the CALLER (http patch / native wrap) writes them to
  // its response object. Default OFF (T9) until the frontend consumes them.
  const ownerSpan = (traceResponse?: ServerInstrumentOptions['traceResponse'], txnOver = {}) => {
    const txn = fakeTxn(txnOver);
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    return startServerSpan(info({ url: '/o/7' }), { getClient: () => client, traceResponse });
  };

  it('emits NOTHING when traceResponse is absent (default off, T9)', () => {
    expect(ownerSpan().responseHeaders()).toEqual({});
  });

  it('emits NOTHING when both flags are explicitly false', () => {
    expect(ownerSpan({ serverTiming: false, traceresponse: false }).responseHeaders()).toEqual({});
  });

  it('traceresponse:true → the W3C trace-context-L2 header (00-traceId-beSpanId-flags), sampled → 01', () => {
    expect(ownerSpan({ traceresponse: true }).responseHeaders()).toEqual({
      traceresponse: '00-trace-1-span-1-01',
    });
  });

  it('traceresponse flags reflect the sampling decision (unsampled → 00)', () => {
    const span = ownerSpan({ traceresponse: true }, { isSampled: () => false });
    expect(span.responseHeaders().traceresponse).toBe('00-trace-1-span-1-00');
  });

  it('serverTiming:true → a Server-Timing entry carrying the trace context as desc', () => {
    expect(ownerSpan({ serverTiming: true }).responseHeaders()).toEqual({
      'Server-Timing': 'traceparent;desc="00-trace-1-span-1-01"',
    });
  });

  it('both flags → both headers', () => {
    expect(ownerSpan({ serverTiming: true, traceresponse: true }).responseHeaders()).toEqual({
      traceresponse: '00-trace-1-span-1-01',
      'Server-Timing': 'traceparent;desc="00-trace-1-span-1-01"',
    });
  });

  // --- F0: cross-origin exposure (so a cross-origin FE can READ the return headers) ---
  it('timingAllowOrigin + serverTiming → Timing-Allow-Origin alongside Server-Timing', () => {
    expect(ownerSpan({ serverTiming: true, timingAllowOrigin: '*' }).responseHeaders()).toEqual({
      'Server-Timing': 'traceparent;desc="00-trace-1-span-1-01"',
      'Timing-Allow-Origin': '*',
    });
  });

  it('timingAllowOrigin as an origin LIST is joined with ", "', () => {
    const headers = ownerSpan({
      serverTiming: true,
      timingAllowOrigin: ['https://a.test', 'https://b.test'],
    }).responseHeaders();
    expect(headers['Timing-Allow-Origin']).toBe('https://a.test, https://b.test');
  });

  it('timingAllowOrigin is IGNORED when serverTiming is off (only expose what we emit)', () => {
    expect(ownerSpan({ timingAllowOrigin: '*' }).responseHeaders()).toEqual({});
  });

  it('exposeTraceresponse + traceresponse → Access-Control-Expose-Headers: traceresponse', () => {
    expect(ownerSpan({ traceresponse: true, exposeTraceresponse: true }).responseHeaders()).toEqual(
      {
        traceresponse: '00-trace-1-span-1-01',
        'Access-Control-Expose-Headers': 'traceresponse',
      },
    );
  });

  it('exposeTraceresponse is IGNORED when traceresponse is off', () => {
    expect(ownerSpan({ exposeTraceresponse: true }).responseHeaders()).toEqual({});
  });

  it('full cross-origin: both trace headers + both CORS-exposure headers', () => {
    expect(
      ownerSpan({
        serverTiming: true,
        traceresponse: true,
        timingAllowOrigin: '*',
        exposeTraceresponse: true,
      }).responseHeaders(),
    ).toEqual({
      traceresponse: '00-trace-1-span-1-01',
      'Server-Timing': 'traceparent;desc="00-trace-1-span-1-01"',
      'Timing-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'traceresponse',
    });
  });

  it('emits NOTHING when there is no transaction (no performance extension)', () => {
    const client = fakeClient({}); // no perf → no transaction
    const span = startServerSpan(info({ url: '/o/7' }), {
      getClient: () => client,
      traceResponse: { serverTiming: true, traceresponse: true },
    });
    expect(span.responseHeaders()).toEqual({});
  });

  it('a transaction whose trace getters throw degrades to no headers (guarded, never throws out)', () => {
    const span = ownerSpan(
      { traceresponse: true },
      {
        getTraceId: () => {
          throw new Error('hostile txn');
        },
      },
    );
    expect(() => span.responseHeaders()).not.toThrow();
    expect(span.responseHeaders()).toEqual({});
  });

  it('the no-client NOOP span emits nothing', () => {
    const span = startServerSpan(info(), {
      getClient: () => undefined,
      traceResponse: { traceresponse: true },
    });
    expect(span.responseHeaders()).toEqual({});
  });

  it('a refining handle delegates to the OWNER span (the owner holds the real transaction + config)', () => {
    const store = createNodeRequestContextStore();
    const txn = fakeTxn();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    // The run-scoped owner sets traceResponse; a later opener in the same request refines.
    runServerRequest(
      info({ url: '/o/7' }),
      { getClient: () => client, traceResponse: { traceresponse: true } },
      () => {
        // The refiner passes NO traceResponse, yet still returns the owner's configured headers.
        const refiner = openServerRequest(info({ url: '/o/7' }), { getClient: () => client });
        expect(refiner.responseHeaders()).toEqual({ traceresponse: '00-trace-1-span-1-01' });
        return null;
      },
    );
  });
});
