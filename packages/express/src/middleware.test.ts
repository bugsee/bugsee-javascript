import type { AttributeValue } from '@bugsee/core';
import { type Bugsee, createNodeRequestContextStore, type RequestContextStore } from '@bugsee/node';
import type { PerformanceApi, Transaction } from '@bugsee/performance';
import { describe, expect, it, vi } from 'vitest';
import { type ExpressRequest, type ExpressResponse, errorHandler, requestHandler } from './index';

// --- structural fakes (express is a peer; the client is faked) -----------------------------------

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

const fakeReq = (over: Partial<ExpressRequest> = {}): ExpressRequest => ({
  method: 'GET',
  url: '/x',
  originalUrl: '/x',
  headers: {},
  ...over,
});

const fakeRes = (statusCode = 200) => {
  const listeners = new Map<string, () => void>();
  const res: ExpressResponse = {
    statusCode,
    once: (event, listener) => {
      listeners.set(event, listener);
      return res;
    },
  };
  return { res, fire: (event: string) => listeners.get(event)?.() };
};

const TRACE = '0123456789abcdef0123456789abcdef';
const SPAN = 'aaaaaaaaaaaaaaaa';

describe('requestHandler', () => {
  it('opens a request context (contextId + http attributes) for the downstream chain', () => {
    const { client, store } = fakeClient();
    let seen: ReturnType<RequestContextStore['getCurrent']>;
    requestHandler({ getClient: () => client, newContextId: () => 'ctx-1' })(
      fakeReq({ method: 'POST', originalUrl: '/pay?x=1' }),
      fakeRes().res,
      () => {
        seen = store?.getCurrent();
      },
    );
    expect(seen?.contextId).toBe('ctx-1');
    expect(seen?.attributes).toEqual({ 'http.method': 'POST', 'http.url': '/pay?x=1' });
  });

  it('extracts the user via the getter when provided', () => {
    const { client, store } = fakeClient();
    let user: string | undefined;
    requestHandler({
      getClient: () => client,
      newContextId: () => 'c',
      user: (req) => `user:${req.method}`,
    })(fakeReq({ method: 'PUT' }), fakeRes().res, () => {
      user = store?.getCurrent()?.user;
    });
    expect(user).toBe('user:PUT');
  });

  it('passes through transparently when no client is launched', () => {
    const next = vi.fn();
    requestHandler({ getClient: () => undefined })(fakeReq(), fakeRes().res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // no error
  });

  it('passes through when the context store is absent (non-node client)', () => {
    const { client } = fakeClient({ store: null });
    const next = vi.fn();
    requestHandler({ getClient: () => client })(fakeReq(), fakeRes().res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('starts an http.server transaction and stamps the context trace when perf is wired', () => {
    const { perf, startTransaction, txn } = fakePerf(fakeTransaction(TRACE, SPAN));
    const { client, store } = fakeClient({ perf });
    let trace: unknown;
    requestHandler({ getClient: () => client, newContextId: () => 'c' })(
      fakeReq({ method: 'GET', originalUrl: '/users/1' }),
      fakeRes().res,
      () => {
        trace = store?.getCurrent()?.trace;
      },
    );
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'GET /users/1', operation: 'http.server' }),
    );
    expect(trace).toEqual({ traceId: TRACE, spanId: SPAN });
    expect(txn).toBeDefined();
  });

  it('continues an inbound W3C trace into the server transaction', () => {
    const { perf, startTransaction } = fakePerf();
    const { client } = fakeClient({ perf });
    requestHandler({ getClient: () => client, newContextId: () => 'c' })(
      fakeReq({ headers: { traceparent: `00-${TRACE}-${SPAN}-01` } }),
      fakeRes().res,
      vi.fn(),
    );
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ continuation: { traceId: TRACE } }),
    );
  });

  it('finishes the transaction on response finish with the route name + status', () => {
    const { perf, txn } = fakePerf();
    const { client } = fakeClient({ perf });
    const res = fakeRes(503);
    requestHandler({ getClient: () => client, newContextId: () => 'c' })(
      fakeReq({ method: 'GET', route: { path: '/users/:id' }, originalUrl: '/users/1' }),
      res.res,
      vi.fn(),
    );
    res.fire('finish');
    expect(txn.setName).toHaveBeenCalledWith('GET /users/:id'); // parametrized at finish
    expect(txn.setAttribute).toHaveBeenCalledWith('http.method', 'GET');
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 503);
    expect(txn.finish).toHaveBeenCalledWith('ERROR'); // >= 500
  });

  it('finishes with OK for a < 500 status and only once across finish + close', () => {
    const { perf, txn } = fakePerf();
    const { client } = fakeClient({ perf });
    const res = fakeRes(200);
    requestHandler({ getClient: () => client, newContextId: () => 'c' })(
      fakeReq(),
      res.res,
      vi.fn(),
    );
    res.fire('finish');
    res.fire('close'); // idempotent — already finished
    expect(txn.finish).toHaveBeenCalledTimes(1);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('degrades to context-only when the performance extension is not wired', () => {
    const { client, store } = fakeClient({ perf: undefined });
    const next = vi.fn();
    let hadContext = false;
    requestHandler({ getClient: () => client, newContextId: () => 'c' })(
      fakeReq(),
      fakeRes().res,
      () => {
        hadContext = store?.getCurrent() !== undefined;
        next();
      },
    );
    expect(hadContext).toBe(true);
    expect(store?.getCurrent()?.trace).toBeUndefined(); // no transaction → no trace
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('never breaks the request when the adapter setup throws', () => {
    const next = vi.fn();
    requestHandler({
      getClient: () => {
        throw new Error('boom');
      },
    })(fakeReq(), fakeRes().res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('does not swallow a downstream throw (it propagates to express)', () => {
    const { client } = fakeClient();
    expect(() =>
      requestHandler({ getClient: () => client, newContextId: () => 'c' })(
        fakeReq(),
        fakeRes().res,
        () => {
          throw new Error('route failed');
        },
      ),
    ).toThrow('route failed');
  });

  it('degrades when a perf wiring step throws (still opens context + calls next)', () => {
    const throwingPerf = {
      startTransaction: () => {
        throw new Error('perf boom');
      },
    } as unknown as PerformanceApi;
    const { client, store } = fakeClient({ perf: throwingPerf });
    const next = vi.fn();
    let hadContext = false;
    requestHandler({ getClient: () => client, newContextId: () => 'c' })(
      fakeReq(),
      fakeRes().res,
      () => {
        hadContext = store?.getCurrent() !== undefined;
        next();
      },
    );
    expect(hadContext).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('errorHandler', () => {
  it('reports the error as http-error and forwards it via next(err)', () => {
    const { client, logException } = fakeClient();
    const err = new Error('route blew up');
    const next = vi.fn();
    errorHandler({ getClient: () => client })(err, fakeReq(), fakeRes().res, next);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(next).toHaveBeenCalledWith(err);
  });

  it('enriches the active context with the matched route before reporting', () => {
    const { client, store } = fakeClient();
    const ctx = { contextId: 'c', attributes: {} as Record<string, AttributeValue> };
    store?.run(ctx, () => {
      errorHandler({ getClient: () => client })(
        new Error('e'),
        fakeReq({ route: { path: '/users/:id' } }),
        fakeRes().res,
        vi.fn(),
      );
    });
    expect(ctx.attributes['http.route']).toBe('/users/:id');
  });

  it('forwards via next(err) with no client (no report)', () => {
    const next = vi.fn();
    const err = new Error('e');
    errorHandler({ getClient: () => undefined })(err, fakeReq(), fakeRes().res, next);
    expect(next).toHaveBeenCalledWith(err);
  });

  it('still forwards next(err) when logException throws (never breaks app error handling)', () => {
    const logException = vi.fn(() => {
      throw new Error('report boom');
    });
    const { client } = fakeClient({ logException });
    const err = new Error('e');
    const next = vi.fn();
    errorHandler({ getClient: () => client })(err, fakeReq(), fakeRes().res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('defaults + edge branches (coverage)', () => {
  it('defaults to the carrier client (none launched in tests → transparent pass-through)', () => {
    const next = vi.fn();
    requestHandler()(fakeReq(), fakeRes().res, next); // no getClient → getCarrierClient() → undefined
    expect(next).toHaveBeenCalledWith();
    const errNext = vi.fn();
    const err = new Error('e');
    errorHandler()(err, fakeReq(), fakeRes().res, errNext); // no getClient → no report, still forwards
    expect(errNext).toHaveBeenCalledWith(err);
  });

  it('mints a random uuid contextId by default', () => {
    const { client, store } = fakeClient();
    let id: string | undefined;
    requestHandler({ getClient: () => client })(fakeReq(), fakeRes().res, () => {
      id = store?.getCurrent()?.contextId;
    });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('reads the first value of an array-valued traceparent header', () => {
    const { perf, startTransaction } = fakePerf();
    const { client } = fakeClient({ perf });
    requestHandler({ getClient: () => client, newContextId: () => 'c' })(
      fakeReq({ headers: { traceparent: [`00-${TRACE}-${SPAN}-01`, 'second'] } }),
      fakeRes().res,
      vi.fn(),
    );
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ continuation: { traceId: TRACE } }),
    );
  });

  it('defaults method/url and status when the request/response omit them', () => {
    const { perf, txn } = fakePerf();
    const { client, store } = fakeClient({ perf });
    const bareReq = { headers: {} } as ExpressRequest;
    const listeners = new Map<string, () => void>();
    const bareRes = {
      statusCode: undefined,
      once: (e: string, l: () => void) => {
        listeners.set(e, l);
      },
    } as unknown as ExpressResponse;
    let attrs: unknown;
    requestHandler({ getClient: () => client, newContextId: () => 'c' })(bareReq, bareRes, () => {
      attrs = store?.getCurrent()?.attributes;
    });
    expect(attrs).toEqual({ 'http.method': 'GET', 'http.url': '' });
    listeners.get('finish')?.();
    expect(txn.finish).toHaveBeenCalledWith('OK'); // status defaulted to 0 → < 500
  });
});

describe('control-flow safety (review)', () => {
  it('calls next exactly once on the pass-through path even when downstream throws (no client)', () => {
    // The pass-through next() must be OUTSIDE the adapter try/catch — else a sync downstream throw is
    // caught and next is double-called exactly where Bugsee is not even active.
    const next = vi.fn(() => {
      throw new Error('downstream boom');
    });
    expect(() =>
      requestHandler({ getClient: () => undefined })(fakeReq(), fakeRes().res, next),
    ).toThrow('downstream boom');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls next exactly once on the pass-through path even when downstream throws (no store)', () => {
    const { client } = fakeClient({ store: null });
    const next = vi.fn(() => {
      throw new Error('downstream boom');
    });
    expect(() =>
      requestHandler({ getClient: () => client })(fakeReq(), fakeRes().res, next),
    ).toThrow('downstream boom');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a downstream throw when perf IS wired', () => {
    const { perf } = fakePerf();
    const { client } = fakeClient({ perf });
    expect(() =>
      requestHandler({ getClient: () => client, newContextId: () => 'c' })(
        fakeReq(),
        fakeRes().res,
        () => {
          throw new Error('route failed');
        },
      ),
    ).toThrow('route failed');
  });

  it('finalizes the transaction on a bare close (abort with no prior finish)', () => {
    const { perf, txn } = fakePerf();
    const { client } = fakeClient({ perf });
    const res = fakeRes(200);
    requestHandler({ getClient: () => client, newContextId: () => 'c' })(
      fakeReq(),
      res.res,
      vi.fn(),
    );
    res.fire('close'); // client aborted — no 'finish'
    expect(txn.finish).toHaveBeenCalledTimes(1);
  });

  it('classifies an exact 500 as ERROR (the >= 500 boundary)', () => {
    const { perf, txn } = fakePerf();
    const { client } = fakeClient({ perf });
    const res = fakeRes(500);
    requestHandler({ getClient: () => client, newContextId: () => 'c' })(
      fakeReq(),
      res.res,
      vi.fn(),
    );
    res.fire('finish');
    expect(txn.finish).toHaveBeenCalledWith('ERROR');
  });
});
