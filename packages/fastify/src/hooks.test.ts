import type { AttributeValue } from '@bugsee/core';
import { type Bugsee, createNodeRequestContextStore, type RequestContextStore } from '@bugsee/node';
import type { PerformanceApi, Transaction } from '@bugsee/performance';
import { describe, expect, it, vi } from 'vitest';
import {
  type FastifyAdapterOptions,
  type FastifyHookDone,
  type FastifyReply,
  type FastifyRequest,
  setupFastify,
} from './index';

// --- structural fakes (fastify is a peer; the client is faked) -----------------------------------

const fakeTransaction = (traceId = 'tid-1', spanId = 'sid-1') => {
  let finished = false;
  const txn = {
    getTraceId: () => traceId,
    getSpanId: () => spanId,
    isFinished: () => finished,
    setName: vi.fn(() => txn),
    setAttribute: vi.fn(() => txn),
    setStatus: vi.fn(() => txn),
    finish: vi.fn(() => {
      finished = true;
    }),
  };
  return txn as unknown as Transaction & {
    setName: ReturnType<typeof vi.fn>;
    setAttribute: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
  };
};

const fakePerf = (txn = fakeTransaction()) => {
  const startTransaction = vi.fn(() => txn);
  const perf = { startTransaction, getActiveSpan: () => txn } as unknown as PerformanceApi;
  return { perf, startTransaction, txn };
};

interface FakeClientOpts {
  store?: RequestContextStore | null;
  perf?: PerformanceApi | undefined;
  logException?: ReturnType<typeof vi.fn>;
}
const fakeClient = (opts: FakeClientOpts = {}) => {
  const store = opts.store === undefined ? createNodeRequestContextStore() : opts.store;
  const logException = opts.logException ?? vi.fn(async () => ({ ok: true }));
  const client = {
    logException,
    getServiceProvider: () => ({
      getImmediate: (o?: { optional?: boolean }) =>
        o?.optional === true ? (store ?? null) : store,
    }),
    ext: (name: string) => {
      if (name === 'performance' && opts.perf !== undefined) {
        return opts.perf;
      }
      throw new Error(`Extension "${name}" is not registered`);
    },
  } as unknown as Bugsee;
  return { client, store, logException };
};

// A fake Fastify instance that records the registered hooks by name, so tests can invoke them.
type AnyHook = (...args: never[]) => unknown;
function fakeApp(options: FastifyAdapterOptions = {}) {
  const hooks: Record<string, AnyHook> = {};
  const app = {
    addHook(name: string, handler: AnyHook) {
      hooks[name] = handler;
      return app;
    },
  };
  setupFastify(app, options);
  return {
    onRequest: (req: FastifyRequest, reply: FastifyReply, done: FastifyHookDone) =>
      (hooks.onRequest as (r: FastifyRequest, p: FastifyReply, d: FastifyHookDone) => void)(
        req,
        reply,
        done,
      ),
    onError: (req: FastifyRequest, reply: FastifyReply, err: unknown, done: FastifyHookDone) =>
      (
        hooks.onError as (
          r: FastifyRequest,
          p: FastifyReply,
          e: unknown,
          d: FastifyHookDone,
        ) => void
      )(req, reply, err, done),
    onResponse: (req: FastifyRequest, reply: FastifyReply, done: FastifyHookDone) =>
      (hooks.onResponse as (r: FastifyRequest, p: FastifyReply, d: FastifyHookDone) => void)(
        req,
        reply,
        done,
      ),
    onRequestAbort: (req: FastifyRequest, done: FastifyHookDone) =>
      (hooks.onRequestAbort as (r: FastifyRequest, d: FastifyHookDone) => void)(req, done),
    hooks,
  };
}

const fakeReq = (over: Partial<FastifyRequest> = {}): FastifyRequest => ({
  method: 'GET',
  url: '/x',
  headers: {},
  ...over,
});
const fakeReply = (statusCode = 200): FastifyReply => ({ statusCode });

const TRACE = '0123456789abcdef0123456789abcdef';
const SPAN = 'aaaaaaaaaaaaaaaa';

describe('setupFastify — hook registration', () => {
  it('registers the onRequest, onError, onResponse and onRequestAbort hooks', () => {
    const { hooks } = fakeApp({ getClient: () => fakeClient().client });
    expect(Object.keys(hooks).sort()).toEqual([
      'onError',
      'onRequest',
      'onRequestAbort',
      'onResponse',
    ]);
  });
});

describe('onRequest hook', () => {
  it('opens a request context (contextId + http attributes) via enterWith', () => {
    const { client, store } = fakeClient();
    const app = fakeApp({ getClient: () => client, newContextId: () => 'ctx-1' });
    const done = vi.fn();
    app.onRequest(fakeReq({ method: 'POST', url: '/pay' }), fakeReply(), done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(store?.getCurrent()?.contextId).toBe('ctx-1');
    expect(store?.getCurrent()?.attributes).toEqual({ 'http.method': 'POST', 'http.url': '/pay' });
  });

  it('extracts the user via the getter when provided', () => {
    const { client, store } = fakeClient();
    const app = fakeApp({
      getClient: () => client,
      newContextId: () => 'c',
      user: (req) => `user:${req.method}`,
    });
    app.onRequest(fakeReq({ method: 'PUT' }), fakeReply(), vi.fn());
    expect(store?.getCurrent()?.user).toBe('user:PUT');
  });

  it('starts an http.server transaction + stamps the context trace when perf is wired', () => {
    const { perf, startTransaction } = fakePerf(fakeTransaction(TRACE, SPAN));
    const { client, store } = fakeClient({ perf });
    const app = fakeApp({ getClient: () => client, newContextId: () => 'c' });
    app.onRequest(
      fakeReq({ url: '/users/1', routeOptions: { url: '/users/:id' } }),
      fakeReply(),
      vi.fn(),
    );
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'GET /users/:id', operation: 'http.server' }),
    );
    expect(store?.getCurrent()?.trace).toEqual({ traceId: TRACE, spanId: SPAN });
  });

  it('continues an inbound W3C trace', () => {
    const { perf, startTransaction } = fakePerf();
    const { client } = fakeClient({ perf });
    const app = fakeApp({ getClient: () => client, newContextId: () => 'c' });
    app.onRequest(
      fakeReq({ headers: { traceparent: `00-${TRACE}-${SPAN}-01` } }),
      fakeReply(),
      vi.fn(),
    );
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ continuation: { traceId: TRACE } }),
    );
  });

  it('passes through (done) when no client / no store, and degrades without perf', () => {
    const noClient = fakeApp({ getClient: () => undefined });
    const d1 = vi.fn();
    noClient.onRequest(fakeReq(), fakeReply(), d1);
    expect(d1).toHaveBeenCalledTimes(1);

    const { client, store } = fakeClient({ perf: undefined });
    const noPerf = fakeApp({ getClient: () => client, newContextId: () => 'c' });
    noPerf.onRequest(fakeReq(), fakeReply(), vi.fn());
    expect(store?.getCurrent()?.contextId).toBe('c');
    expect(store?.getCurrent()?.trace).toBeUndefined(); // no perf → no trace
  });

  it('never throws into the request — a failing getClient still calls done', () => {
    const app = fakeApp({
      getClient: () => {
        throw new Error('boom');
      },
    });
    const done = vi.fn();
    app.onRequest(fakeReq(), fakeReply(), done);
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe('onError hook', () => {
  it('reports the error as http-error with the route, then calls done', () => {
    const { client, store, logException } = fakeClient();
    const app = fakeApp({ getClient: () => client });
    const err = new Error('route blew up');
    const done = vi.fn();
    // Inside the request's context (enterWith), so the report merges it.
    store?.run({ contextId: 'c', attributes: {} as Record<string, AttributeValue> }, () => {
      app.onError(fakeReq({ routeOptions: { url: '/users/:id' } }), fakeReply(500), err, done);
    });
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('sets the matched route on the active context', () => {
    const { client, store } = fakeClient();
    const app = fakeApp({ getClient: () => client });
    const ctx = { contextId: 'c', attributes: {} as Record<string, AttributeValue> };
    store?.run(ctx, () => {
      app.onError(
        fakeReq({ routeOptions: { url: '/users/:id' } }),
        fakeReply(500),
        new Error('e'),
        vi.fn(),
      );
    });
    expect(ctx.attributes['http.route']).toBe('/users/:id');
  });

  it('still calls done when there is no client / logException throws', () => {
    const noClient = fakeApp({ getClient: () => undefined });
    const d1 = vi.fn();
    noClient.onError(fakeReq(), fakeReply(), new Error('e'), d1);
    expect(d1).toHaveBeenCalledTimes(1);

    const logException = vi.fn(() => {
      throw new Error('report boom');
    });
    const { client } = fakeClient({ logException });
    const throwing = fakeApp({ getClient: () => client });
    const d2 = vi.fn();
    throwing.onError(fakeReq(), fakeReply(), new Error('e'), d2);
    expect(d2).toHaveBeenCalledTimes(1);
  });
});

describe('onResponse hook', () => {
  it('finishes the transaction with the route name + status (>= 500 → ERROR)', () => {
    const { perf, txn } = fakePerf();
    const { client } = fakeClient({ perf });
    const app = fakeApp({ getClient: () => client, newContextId: () => 'c' });
    const req = fakeReq({ url: '/users/1', routeOptions: { url: '/users/:id' } });
    app.onRequest(req, fakeReply(), vi.fn()); // starts the txn (keyed by req)
    const done = vi.fn();
    app.onResponse(req, fakeReply(503), done);
    expect(txn.setName).toHaveBeenCalledWith('GET /users/:id');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.method', 'GET');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 503);
    expect(txn.finish).toHaveBeenCalledWith('ERROR');
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('finishes with OK for < 500 and only once (idempotent across responses)', () => {
    const { perf, txn } = fakePerf();
    const { client } = fakeClient({ perf });
    const app = fakeApp({ getClient: () => client, newContextId: () => 'c' });
    const req = fakeReq();
    app.onRequest(req, fakeReply(), vi.fn());
    app.onResponse(req, fakeReply(200), vi.fn());
    app.onResponse(req, fakeReply(200), vi.fn()); // no-op (already finished + removed)
    expect(txn.finish).toHaveBeenCalledTimes(1);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('is a no-op (still calls done) when there was no transaction for the request', () => {
    const { client } = fakeClient({ perf: undefined });
    const app = fakeApp({ getClient: () => client, newContextId: () => 'c' });
    const req = fakeReq();
    app.onRequest(req, fakeReply(), vi.fn()); // no perf → no txn
    const done = vi.fn();
    app.onResponse(req, fakeReply(200), done);
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe('defaults + edge branches (coverage)', () => {
  it('defaults to the carrier client (none launched → pass-through on every hook)', () => {
    const app = fakeApp(); // no getClient → defaultGetClient → getCarrierClient() → undefined
    const d1 = vi.fn();
    app.onRequest(fakeReq(), fakeReply(), d1);
    expect(d1).toHaveBeenCalledTimes(1);
    const d2 = vi.fn();
    app.onError(fakeReq(), fakeReply(), new Error('e'), d2);
    expect(d2).toHaveBeenCalledTimes(1);
    const d3 = vi.fn();
    app.onResponse(fakeReq(), fakeReply(), d3);
    expect(d3).toHaveBeenCalledTimes(1);
  });

  it('mints a random uuid contextId by default', () => {
    const { client, store } = fakeClient();
    const app = fakeApp({ getClient: () => client }); // no newContextId → randomUUID
    app.onRequest(fakeReq(), fakeReply(), vi.fn());
    expect(store?.getCurrent()?.contextId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('reads the first value of an array-valued traceparent header', () => {
    const { perf, startTransaction } = fakePerf();
    const { client } = fakeClient({ perf });
    const app = fakeApp({ getClient: () => client, newContextId: () => 'c' });
    app.onRequest(
      fakeReq({ headers: { traceparent: [`00-${TRACE}-${SPAN}-01`, 'second'] } }),
      fakeReply(),
      vi.fn(),
    );
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ continuation: { traceId: TRACE } }),
    );
  });

  it('defaults method/url/route/status when the request and reply omit them', () => {
    const { perf, txn } = fakePerf();
    const { client, store } = fakeClient({ perf });
    const app = fakeApp({ getClient: () => client, newContextId: () => 'c' });
    const bareReq = { headers: {} } as FastifyRequest;
    app.onRequest(bareReq, {} as FastifyReply, vi.fn());
    expect(store?.getCurrent()?.attributes).toEqual({ 'http.method': 'GET', 'http.url': '' });
    app.onResponse(bareReq, {} as FastifyReply, vi.fn()); // statusCode undefined → 0 → OK; no route → 'GET '
    expect(txn.setName).toHaveBeenCalledWith('GET ');
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });
});

describe('review-driven coverage', () => {
  it('passes through on every hook when the context store is absent (non-node client)', () => {
    const { client } = fakeClient({ store: null });
    const app = fakeApp({ getClient: () => client, newContextId: () => 'c' });
    const d1 = vi.fn();
    app.onRequest(fakeReq(), fakeReply(), d1); // store null → no enterWith, just done
    expect(d1).toHaveBeenCalledTimes(1);
    const d2 = vi.fn();
    app.onError(fakeReq({ routeOptions: { url: '/x' } }), fakeReply(), new Error('e'), d2);
    expect(d2).toHaveBeenCalledTimes(1); // resolveStore → undefined → route enrich skipped, still reports
    const d3 = vi.fn();
    app.onResponse(fakeReq(), fakeReply(), d3);
    expect(d3).toHaveBeenCalledTimes(1);
  });

  it('reports an error even with no active context (route enrich is skipped, not the report)', () => {
    const { client, logException } = fakeClient();
    const app = fakeApp({ getClient: () => client });
    // No enterWith/run wrapping → getCurrent() is undefined; setAttribute is a no-op but logException fires.
    app.onError(
      fakeReq({ routeOptions: { url: '/users/:id' } }),
      fakeReply(500),
      new Error('e'),
      vi.fn(),
    );
    expect(logException).toHaveBeenCalledWith(expect.any(Error), { mechanism: 'http-error' });
  });

  it('reports an error with no route (routeOptions absent) — no http.route written', () => {
    const { client, store, logException } = fakeClient();
    const app = fakeApp({ getClient: () => client });
    const ctx = { contextId: 'c', attributes: {} as Record<string, AttributeValue> };
    store?.run(ctx, () => {
      app.onError(fakeReq(), fakeReply(500), new Error('e'), vi.fn()); // no routeOptions
    });
    expect(logException).toHaveBeenCalledWith(expect.any(Error), { mechanism: 'http-error' });
    expect('http.route' in ctx.attributes).toBe(false);
  });

  it('classifies an exact 500 status as ERROR (the >= 500 boundary)', () => {
    const { perf, txn } = fakePerf();
    const { client } = fakeClient({ perf });
    const app = fakeApp({ getClient: () => client, newContextId: () => 'c' });
    const req = fakeReq();
    app.onRequest(req, fakeReply(), vi.fn());
    app.onResponse(req, fakeReply(500), vi.fn());
    expect(txn.finish).toHaveBeenCalledWith('ERROR');
  });

  it('names the transaction from the URL when no matched route is available', () => {
    const { perf, txn } = fakePerf();
    const { client } = fakeClient({ perf });
    const app = fakeApp({ getClient: () => client, newContextId: () => 'c' });
    const req = fakeReq({ method: 'GET', url: '/raw/path' }); // no routeOptions
    app.onRequest(req, fakeReply(), vi.fn());
    app.onResponse(req, fakeReply(200), vi.fn());
    expect(txn.setName).toHaveBeenCalledWith('GET /raw/path');
  });

  it('onRequestAbort finishes the transaction as CANCELLED (a client abort sends no response)', () => {
    const { perf, txn } = fakePerf();
    const { client } = fakeClient({ perf });
    const app = fakeApp({ getClient: () => client, newContextId: () => 'c' });
    const req = fakeReq();
    app.onRequest(req, fakeReply(), vi.fn()); // starts the txn
    const done = vi.fn();
    app.onRequestAbort(req, done);
    expect(txn.finish).toHaveBeenCalledWith('CANCELLED');
    expect(done).toHaveBeenCalledTimes(1);
    // onResponse after an abort is then a no-op (the txn was removed).
    app.onResponse(req, fakeReply(200), vi.fn());
    expect(txn.finish).toHaveBeenCalledTimes(1);
  });

  it('onRequestAbort is a no-op (still calls done) when there was no transaction', () => {
    const { client } = fakeClient({ perf: undefined });
    const app = fakeApp({ getClient: () => client, newContextId: () => 'c' });
    const req = fakeReq();
    app.onRequest(req, fakeReply(), vi.fn()); // no perf → no txn
    const done = vi.fn();
    app.onRequestAbort(req, done);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
