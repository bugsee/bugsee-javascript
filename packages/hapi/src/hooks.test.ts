import type { Bugsee, RequestContextStore } from '@bugsee/node';
import type { Transaction } from '@bugsee/performance';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultShouldReport,
  type HapiExtension,
  type HapiRequestLike,
  type HapiServerLike,
  type HapiToolkitLike,
  requestName,
  responseStatus,
  setupHapi,
} from './hooks';

const CONTINUE = Symbol('continue');
const h: HapiToolkitLike = { continue: CONTINUE };

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

interface Captured {
  onRequest?: HapiExtension;
  onPreResponse?: HapiExtension;
}
const wire = (options: Parameters<typeof setupHapi>[1]): Captured => {
  const cap: Captured = {};
  const server: HapiServerLike = {
    ext: (event, method) => {
      if (event === 'onRequest') cap.onRequest = method;
      else cap.onPreResponse = method;
    },
  };
  setupHapi(server, options);
  return cap;
};

const req = (over: Partial<HapiRequestLike> = {}): HapiRequestLike & { request: object } => ({
  request: {},
  method: over.method ?? 'get',
  path: over.path ?? '/u',
  route: over.route ?? { path: '/u' },
  headers: over.headers ?? {},
  response: over.response,
  events: over.events,
});
const boom = (statusCode: number, isServer: boolean, message = 'boom') =>
  ({ isBoom: true, isServer, output: { statusCode }, message }) as unknown;

describe('responseStatus', () => {
  it('reads a Boom output statusCode', () => {
    expect(responseStatus(boom(503, true))).toBe(503);
  });
  it('defaults a Boom without an output status to 500', () => {
    expect(responseStatus({ isBoom: true })).toBe(500);
  });
  it('reads a non-Boom response statusCode, else 0', () => {
    expect(responseStatus({ statusCode: 201 })).toBe(201);
    expect(responseStatus(undefined)).toBe(0);
  });
});

describe('defaultShouldReport', () => {
  it('reports a Boom server (5xx) error', () => {
    expect(defaultShouldReport(boom(500, true))).toBe(true);
  });
  it('skips a Boom client (4xx) error and a non-Boom value', () => {
    expect(defaultShouldReport(boom(404, false))).toBe(false);
    expect(defaultShouldReport(new Error('x'))).toBe(false);
    expect(defaultShouldReport(null)).toBe(false);
  });
});

describe('requestName', () => {
  it('uppercases the method and uses the route pattern', () => {
    expect(requestName(req({ method: 'post', route: { path: '/o/{id}' } }))).toBe('POST /o/{id}');
  });
  it('falls back to the path when no route pattern', () => {
    expect(requestName(req({ method: 'get', route: {}, path: '/raw' }))).toBe('GET /raw');
  });
});

describe('setupHapi extensions', () => {
  it('onRequest opens context (enterWith) + trace; onPreResponse finishes OK on success', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    const cap = wire({ getClient: () => client, newContextId: () => 'cid-1' });
    // Models Hapi's two-phase route resolution: at onRequest only the catch-all is known; the real
    // pattern appears by onPreResponse, where the adapter re-stamps the name.
    const r = req({
      method: 'post',
      path: '/o/7',
      route: { path: '/{p*}' },
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
      response: { statusCode: 201 },
    });

    expect(cap.onRequest?.(r, h)).toBe(CONTINUE);
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
        name: 'POST /{p*}', // start time: only the catch-all is known
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

    r.route = { path: '/o/{id}' }; // routing has now resolved the real pattern
    expect(cap.onPreResponse?.(r, h)).toBe(CONTINUE);
    expect(txn.setName).toHaveBeenCalledWith('POST /o/{id}'); // re-stamped at finish
    expect(txn.setAttribute).toHaveBeenCalledWith('http.method', 'POST');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 201);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  // F-4 (round-2 D2): a manual rename (client.ext('performance').setRouteName()/setActiveTransactionName())
  // stamps 'bugsee.name_source' on the transaction; server-instrument's finishWith must NOT clobber it
  // with the automatic route-derived name. This exercises the check against a Transaction double whose
  // getAttributes() actually reports the stamp, not one that omits the method entirely.
  it('does NOT clobber a manual rename (name-source attribute present) with the automatic route name', () => {
    const store = fakeStore();
    const txn = fakeTxn({ getAttributes: vi.fn(() => ({ 'bugsee.name_source': 'route' })) });
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => txn) } });
    const cap = wire({ getClient: () => client });
    const r = req({
      method: 'post',
      path: '/o/7',
      route: { path: '/o/{id}' },
      response: { statusCode: 200 },
    });
    cap.onRequest?.(r, h);
    cap.onPreResponse?.(r, h);
    expect(txn.setName).not.toHaveBeenCalled(); // the manual rename wins
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('onPreResponse reports a Boom server error, sets the route, finishes ERROR', () => {
    const store = fakeStore();
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({
      store,
      perf: { startTransaction: vi.fn(() => txn) },
      logException,
    });
    const cap = wire({ getClient: () => client });
    const err = boom(500, true);
    const r = req({ route: { path: '/x/{id}' }, response: err });
    cap.onRequest?.(r, h);
    cap.onPreResponse?.(r, h);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/x/{id}');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 500);
    expect(txn.finish).toHaveBeenCalledWith('ERROR');
  });

  it('onPreResponse skips a Boom client (404) error and finishes OK', () => {
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) }, logException });
    const cap = wire({ getClient: () => client });
    const r = req({ response: boom(404, false) });
    cap.onRequest?.(r, h);
    cap.onPreResponse?.(r, h);
    expect(logException).not.toHaveBeenCalled();
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 404);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('stamps http.route with the path when no route pattern is known', () => {
    const store = fakeStore();
    const client = fakeClient({ store });
    const cap = wire({ getClient: () => client });
    cap.onPreResponse?.(req({ route: {}, path: '/raw', response: boom(500, true) }), h);
    expect(store.setAttribute).toHaveBeenCalledWith('http.route', '/raw');
  });

  it('honors a custom shouldReport (report a client Boom)', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const cap = wire({ getClient: () => client, shouldReport: () => true });
    const err = boom(404, false);
    cap.onPreResponse?.(req({ response: err }), h);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
  });

  it('does not report a non-Boom response', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const cap = wire({ getClient: () => client });
    cap.onPreResponse?.(req({ response: { statusCode: 200 } }), h);
    expect(logException).not.toHaveBeenCalled();
  });

  it('resolves the user and stamps it on the context', () => {
    const store = fakeStore();
    const client = fakeClient({ store });
    const cap = wire({ getClient: () => client, user: () => 'bob@x.com' });
    cap.onRequest?.(req(), h);
    const [openedCtx] = store.enterWith.mock.calls[0] as [{ user?: string }];
    expect(openedCtx.user).toBe('bob@x.com');
  });

  it('reports without the performance extension and without a store', () => {
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ logException });
    const cap = wire({ getClient: () => client });
    const r = req({ response: boom(500, true) });
    cap.onRequest?.(r, h);
    cap.onPreResponse?.(r, h);
    expect(logException).toHaveBeenCalled();
  });

  it('all extensions are no-ops + return h.continue when no client is launched', () => {
    const store = fakeStore();
    const cap = wire({ getClient: () => undefined });
    const r = req({ response: boom(500, true) });
    expect(cap.onRequest?.(r, h)).toBe(CONTINUE);
    expect(cap.onPreResponse?.(r, h)).toBe(CONTINUE);
    expect(store.enterWith).not.toHaveBeenCalled();
  });

  it('swallows a thrown getClient and still returns h.continue', () => {
    const cap = wire({
      getClient: () => {
        throw new Error('resolve failed');
      },
    });
    const r = req();
    expect(cap.onRequest?.(r, h)).toBe(CONTINUE);
    expect(cap.onPreResponse?.(r, h)).toBe(CONTINUE);
  });

  it('does not touch an already-finished transaction', () => {
    const txn = fakeTxn({ isFinished: vi.fn(() => true) });
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const cap = wire({ getClient: () => client });
    const r = req();
    cap.onRequest?.(r, h);
    cap.onPreResponse?.(r, h);
    expect(txn.finish).not.toHaveBeenCalled();
    expect(txn.setName).not.toHaveBeenCalled();
  });

  it('starts a transaction WITHOUT continuation when there is no inbound traceparent', () => {
    const txn = fakeTxn();
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ store: fakeStore(), perf: { startTransaction } });
    const cap = wire({ getClient: () => client });
    cap.onRequest?.(req(), h);
    expect(startTransaction).toHaveBeenCalledWith(
      expect.not.objectContaining({ continuation: expect.anything() }),
    );
  });

  it('finishes the transaction as CANCELLED on a client disconnect (onPreResponse never fires)', () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const cap = wire({ getClient: () => client });
    let disconnect: (() => void) | undefined;
    const r = req({
      events: {
        once: (event, listener) => {
          if (event === 'disconnect') disconnect = listener;
        },
      },
    });
    cap.onRequest?.(r, h);
    expect(disconnect).toBeTypeOf('function');
    disconnect?.(); // simulate the client aborting mid-request
    expect(txn.finish).toHaveBeenCalledWith('CANCELLED');
  });

  it('a disconnect AFTER the response is a no-op (no double finish)', () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const cap = wire({ getClient: () => client });
    let disconnect: (() => void) | undefined;
    const r = req({
      events: {
        once: (event, listener) => {
          if (event === 'disconnect') disconnect = listener;
        },
      },
      response: { statusCode: 200 },
    });
    cap.onRequest?.(r, h);
    cap.onPreResponse?.(r, h); // finishes OK + removes the txn from the map
    disconnect?.(); // a late abort signal must not finish again
    expect(txn.finish).toHaveBeenCalledTimes(1);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('swallows a thrown user getter and still returns h.continue', () => {
    const client = fakeClient({ store: fakeStore() });
    const cap = wire({
      getClient: () => client,
      user: () => {
        throw new Error('user getter blew up');
      },
    });
    expect(cap.onRequest?.(req(), h)).toBe(CONTINUE);
  });

  it('defaults to the carrier client when no options are given (no-op without a launch)', () => {
    const cap = wire(undefined);
    expect(cap.onRequest?.(req(), h)).toBe(CONTINUE);
  });
});

describe('re-entrancy with the http-layer owner', () => {
  it('refines the owner — one txn, reports the Boom on the owner, onPreResponse finish no-op', async () => {
    const { createNodeRequestContextStore, runServerRequest } = await import('@bugsee/node');
    const store = createNodeRequestContextStore();
    const ownerTxn = fakeTxn();
    const startTransaction = vi.fn(() => ownerTxn);
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ store, perf: { startTransaction }, logException });
    const cap = wire({ getClient: () => client, newContextId: () => 'adapter' });
    runServerRequest(
      { method: 'GET', url: '/users/7' },
      { getClient: () => client, newContextId: () => 'owner' },
      () => {
        const r = req({
          method: 'get',
          path: '/users/7',
          route: { path: '/users/{id}' },
          response: boom(503, true),
        });
        cap.onRequest?.(r, h); // refiner (owner active) — no new context/txn
        expect(store.getCurrent()?.contextId).toBe('owner');
        cap.onPreResponse?.(r, h); // reports the Boom on the owner context; refiner finish is a no-op
        expect(store.getCurrent()?.attributes?.['http.route']).toBe('/users/{id}');
        return null;
      },
    );
    expect(startTransaction).toHaveBeenCalledTimes(1); // owner only
    expect(logException).toHaveBeenCalledWith(expect.objectContaining({ isBoom: true }), {
      mechanism: 'http-error',
    });
    expect(ownerTxn.finish).not.toHaveBeenCalled(); // refiner finish was a no-op
  });
});
