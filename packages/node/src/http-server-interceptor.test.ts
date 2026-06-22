import type { BugseeClient } from '@bugsee/core';
import type { Transaction } from '@bugsee/performance';
import { describe, expect, it, vi } from 'vitest';
import { createHttpServerInterceptor, type HttpServerTarget } from './http-server-interceptor';
import { createNodeRequestContextStore, type RequestContextStore } from './request-context-store';

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

const fakeClient = (opts: {
  store?: RequestContextStore;
  perf?: { startTransaction: ReturnType<typeof vi.fn> };
}): BugseeClient =>
  ({
    getServiceProvider: () => ({ getImmediate: () => opts.store ?? undefined }),
    ext: () => {
      if (!opts.perf) throw new Error('no performance extension');
      return opts.perf;
    },
    logException: vi.fn(() => Promise.resolve()),
  }) as unknown as BugseeClient;

// A fake EventEmitter whose `emit('request', …)` dispatches to a per-instance handler and records `this`.
// `FakeHttp/HttpsServer.prototype.emit` is INHERITED (no own property) — mirrors a real node Server.
class FakeEmitter {
  requestHandler?: (req: unknown, res: unknown) => void;
  lastThis: unknown;
  emit(this: FakeEmitter, event: string | symbol, ...args: unknown[]): boolean {
    this.lastThis = this;
    if (event === 'request' && this.requestHandler) {
      this.requestHandler(args[0], args[1]);
      return true; // "had listeners"
    }
    return false;
  }
}
class FakeHttpServer extends FakeEmitter {}
class FakeHttpsServer extends FakeEmitter {}

const makeTarget = () => ({ http: { Server: FakeHttpServer }, https: { Server: FakeHttpsServer } });
const asTarget = (t: ReturnType<typeof makeTarget>): HttpServerTarget =>
  t as unknown as HttpServerTarget;

interface FakeRes {
  statusCode: number;
  writableFinished: boolean;
  headersSent: boolean;
  /** Headers the patch set via setHeader (the BE→FE return-path assertion channel). */
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
  once(event: string, listener: () => void): void;
  fire(event: string): void;
}
const makeRes = (
  opts: { statusCode?: number; writableFinished?: boolean; headersSent?: boolean } = {},
): FakeRes => {
  const listeners = new Map<string, () => void>();
  const headers: Record<string, string> = {};
  return {
    statusCode: opts.statusCode ?? 200,
    writableFinished: opts.writableFinished ?? false,
    headersSent: opts.headersSent ?? false,
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
    once(event, listener) {
      listeners.set(event, listener);
    },
    fire(event) {
      listeners.get(event)?.();
    },
  };
};

const launchedClient = () => {
  const store = createNodeRequestContextStore();
  const txn = fakeTxn();
  const startTransaction = vi.fn(() => txn);
  const client = fakeClient({ store, perf: { startTransaction } });
  return { store, txn, startTransaction, client };
};

describe('createHttpServerInterceptor', () => {
  it('instruments a request: context active in the handler, dispatches to the original, finishes on response', () => {
    const { store, txn, startTransaction, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({
      target: asTarget(target),
      getClient: () => client,
      newContextId: () => 'cid',
    });
    ic.install();
    const server = new target.http.Server();
    let ctxId: string | undefined;
    let handlerThis: unknown;
    server.requestHandler = function (this: unknown) {
      ctxId = store.getCurrent()?.contextId;
      handlerThis = this;
    };
    const res = makeRes({ statusCode: 204 });
    const req = {
      method: 'POST',
      url: '/o/7?x=1',
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    };
    const ret = server.emit('request', req, res);
    ic.uninstall();

    expect(ctxId).toBe('cid'); // context active during the app handler
    expect(handlerThis).toBe(server); // `this` preserved through the patch
    expect(ret).toBe(true); // the original emit's boolean (had listeners) is preserved
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'POST /o/7', // query stripped for the name
        operation: 'http.server',
        continuation: {
          traceId: '0af7651916cd43dd8448eb211c80319c',
          parentSpanId: 'b7ad6b7169203331',
          sampled: true,
        },
      }),
    );
    res.writableFinished = true;
    res.fire('close'); // the owner finishes on 'close' (after any refiner's 'finish' setRoute)
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 204);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('cancels (CANCELLED) when the response closes before finishing (client abort)', () => {
    const { txn, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({ target: asTarget(target), getClient: () => client });
    ic.install();
    const server = new target.http.Server();
    server.requestHandler = () => {};
    const res = makeRes({ writableFinished: false });
    server.emit('request', { method: 'GET', url: '/x', headers: {} }, res);
    res.fire('close'); // closed without finishing
    ic.uninstall();
    expect(txn.finish).toHaveBeenCalledWith('CANCELLED');
  });

  it('does NOT cancel when the response closes AFTER finishing (writableFinished)', () => {
    const { txn, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({ target: asTarget(target), getClient: () => client });
    ic.install();
    const server = new target.http.Server();
    server.requestHandler = () => {};
    const res = makeRes({ statusCode: 200, writableFinished: false });
    server.emit('request', { method: 'GET', url: '/x', headers: {} }, res);
    res.fire('finish'); // normal finish first
    res.writableFinished = true; // response fully written
    res.fire('close'); // then close — must NOT cancel
    ic.uninstall();
    expect(txn.finish).toHaveBeenCalledTimes(1);
    expect(txn.finish).toHaveBeenCalledWith('OK');
    expect(txn.finish).not.toHaveBeenCalledWith('CANCELLED');
  });

  it('writes the BE→FE return headers (traceResponse) at request-open, before the handler runs', () => {
    const { txn, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({
      target: asTarget(target),
      getClient: () => client,
      traceResponse: { traceresponse: true, serverTiming: true },
    });
    ic.install();
    const server = new target.http.Server();
    let headersAtHandler: Record<string, string> | undefined;
    const res = makeRes();
    server.requestHandler = () => {
      // The headers are present DURING the handler (set at open) → they survive a streaming response.
      headersAtHandler = { ...res.headers };
    };
    server.emit('request', { method: 'GET', url: '/x', headers: {} }, res);
    ic.uninstall();
    expect(headersAtHandler).toEqual({
      traceresponse: `00-${txn.getTraceId()}-${txn.getSpanId()}-01`,
      'Server-Timing': `traceparent;desc="00-${txn.getTraceId()}-${txn.getSpanId()}-01"`,
    });
  });

  it('writes NO return headers by default (traceResponse off — T9)', () => {
    const { client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({ target: asTarget(target), getClient: () => client });
    ic.install();
    const server = new target.http.Server();
    server.requestHandler = () => {};
    const res = makeRes();
    server.emit('request', { method: 'GET', url: '/x', headers: {} }, res);
    ic.uninstall();
    expect(res.headers).toEqual({});
  });

  it('skips the return headers when the response has already flushed (headersSent)', () => {
    const { client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({
      target: asTarget(target),
      getClient: () => client,
      traceResponse: { traceresponse: true },
    });
    ic.install();
    const server = new target.http.Server();
    server.requestHandler = () => {};
    const res = makeRes({ headersSent: true });
    server.emit('request', { method: 'GET', url: '/x', headers: {} }, res);
    ic.uninstall();
    expect(res.headers).toEqual({}); // never call setHeader after flush
  });

  it('a throwing setHeader never breaks the request — emit does not throw, the handler still dispatches', () => {
    const { client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({
      target: asTarget(target),
      getClient: () => client,
      traceResponse: { traceresponse: true },
    });
    ic.install();
    const server = new target.http.Server();
    let dispatched = false;
    server.requestHandler = () => {
      dispatched = true;
    };
    const res = makeRes();
    res.setHeader = () => {
      throw new Error('hostile setHeader');
    };
    expect(() =>
      server.emit('request', { method: 'GET', url: '/x', headers: {} }, res),
    ).not.toThrow();
    ic.uninstall();
    expect(dispatched).toBe(true); // the guard swallowed the throw and the app handler still ran
  });

  it('passes a non-request event straight through (no context, no transaction)', () => {
    const { startTransaction, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({ target: asTarget(target), getClient: () => client });
    ic.install();
    const server = new target.http.Server();
    const ret = server.emit('connection', { sock: true });
    ic.uninstall();
    expect(ret).toBe(false); // original ran (no 'connection' listener → false)
    expect(server.lastThis).toBe(server); // dispatched to the original with correct `this`
    expect(startTransaction).not.toHaveBeenCalled();
  });

  it('self-isolates an inbound x-bugsee-internal request (pass through, no transaction)', () => {
    const { store, startTransaction, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({ target: asTarget(target), getClient: () => client });
    ic.install();
    const server = new target.http.Server();
    let ctxDuring: unknown;
    server.requestHandler = () => {
      ctxDuring = store.getCurrent();
    };
    server.emit(
      'request',
      { method: 'GET', url: '/x', headers: { 'x-bugsee-internal': '1' } },
      makeRes(),
    );
    ic.uninstall();
    expect(startTransaction).not.toHaveBeenCalled(); // skipped
    expect(ctxDuring).toBeUndefined(); // no context opened for SDK's own traffic
  });

  it('honors a custom isInternal predicate', () => {
    const { startTransaction, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({
      target: asTarget(target),
      getClient: () => client,
      isInternal: (h) => h['x-skip'] === 'yes',
    });
    ic.install();
    const server = new target.http.Server();
    server.requestHandler = () => {};
    server.emit('request', { method: 'GET', url: '/x', headers: { 'x-skip': 'yes' } }, makeRes());
    ic.uninstall();
    expect(startTransaction).not.toHaveBeenCalled();
  });

  it('also patches https.Server.prototype.emit', () => {
    const { startTransaction, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({ target: asTarget(target), getClient: () => client });
    ic.install();
    const server = new target.https.Server();
    server.requestHandler = () => {};
    server.emit('request', { method: 'GET', url: '/secure', headers: {} }, makeRes());
    ic.uninstall();
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'GET /secure', operation: 'http.server' }),
    );
  });

  it('restores an INHERITED emit by delete (prototype returns to its pristine shape) and stops instrumenting', () => {
    const { startTransaction, client } = launchedClient();
    const target = makeTarget();
    const proto = target.http.Server.prototype;
    expect(Object.hasOwn(proto, 'emit')).toBe(false);
    const ic = createHttpServerInterceptor({ target: asTarget(target), getClient: () => client });
    ic.install();
    expect(Object.hasOwn(proto, 'emit')).toBe(true); // own override added
    ic.uninstall();
    expect(Object.hasOwn(proto, 'emit')).toBe(false); // deleted → inherited again

    const server = new target.http.Server();
    server.requestHandler = () => {};
    const ret = server.emit('request', { method: 'GET', url: '/x', headers: {} }, makeRes());
    expect(ret).toBe(true); // inherited emit still works
    expect(startTransaction).not.toHaveBeenCalled(); // no longer instrumented
  });

  it('restores an OWN emit by reassignment (not delete)', () => {
    const original = vi.fn(function (this: unknown) {
      return true;
    });
    const httpProto = { emit: original };
    const httpsProto = { emit: vi.fn(() => true) };
    const target = {
      http: { Server: { prototype: httpProto } },
      https: { Server: { prototype: httpsProto } },
    } as unknown as HttpServerTarget;
    const ic = createHttpServerInterceptor({ target });
    ic.install();
    expect(httpProto.emit).not.toBe(original); // patched
    ic.uninstall();
    expect(httpProto.emit).toBe(original); // restored by assignment
    expect(Object.hasOwn(httpProto, 'emit')).toBe(true);
  });

  it('install is idempotent — a second install does not double-wrap', () => {
    const target = makeTarget();
    const proto = target.http.Server.prototype;
    const ic = createHttpServerInterceptor({ target: asTarget(target) });
    ic.install();
    const afterFirst = proto.emit;
    ic.install(); // no-op
    expect(proto.emit).toBe(afterFirst); // not re-wrapped
    ic.uninstall(); // single uninstall fully restores
    expect(Object.hasOwn(proto, 'emit')).toBe(false);
  });

  it('uninstall before install is a safe no-op', () => {
    const target = makeTarget();
    const ic = createHttpServerInterceptor({ target: asTarget(target) });
    expect(() => ic.uninstall()).not.toThrow();
    expect(Object.hasOwn(target.http.Server.prototype, 'emit')).toBe(false);
  });

  it('without a launched client: passes through, returns the boolean, opens no transaction', () => {
    const target = makeTarget();
    const ic = createHttpServerInterceptor({
      target: asTarget(target),
      getClient: () => undefined,
    });
    ic.install();
    const server = new target.http.Server();
    let ran = false;
    server.requestHandler = () => {
      ran = true;
    };
    const ret = server.emit('request', { method: 'GET', url: '/x', headers: {} }, makeRes());
    ic.uninstall();
    expect(ran).toBe(true); // the app handler still ran
    expect(ret).toBe(true);
  });

  it('passes through a malformed request emit with no req/res (guard)', () => {
    const { startTransaction, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({ target: asTarget(target), getClient: () => client });
    ic.install();
    const server = new target.http.Server();
    const ret = server.emit('request'); // no req/res
    ic.uninstall();
    expect(ret).toBe(false); // original ran (no handler)
    expect(startTransaction).not.toHaveBeenCalled(); // guard skipped instrumentation
  });

  it('falls back to GET + empty path when method/url are absent on the request', () => {
    const { startTransaction, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({ target: asTarget(target), getClient: () => client });
    ic.install();
    const server = new target.http.Server();
    server.requestHandler = () => {};
    server.emit('request', { headers: {} }, makeRes()); // no method / url
    ic.uninstall();
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'GET ', operation: 'http.server' }),
    );
  });

  it('returns the original false when a request has no listener but still opens+finishes the txn', () => {
    const { txn, startTransaction, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({ target: asTarget(target), getClient: () => client });
    ic.install();
    const server = new target.http.Server(); // no requestHandler
    const res = makeRes({ statusCode: 200 });
    const ret = server.emit('request', { method: 'GET', url: '/x', headers: {} }, res);
    res.writableFinished = true;
    res.fire('close');
    ic.uninstall();
    expect(ret).toBe(false); // original emit had no 'request' listener
    expect(startTransaction).toHaveBeenCalledTimes(1); // txn still opened
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('flows the real response statusCode to finish — a 5xx finishes as ERROR', () => {
    const { txn, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({ target: asTarget(target), getClient: () => client });
    ic.install();
    const server = new target.http.Server();
    server.requestHandler = () => {};
    const res = makeRes({ statusCode: 503 });
    server.emit('request', { method: 'GET', url: '/x', headers: {} }, res);
    res.writableFinished = true;
    res.fire('close');
    ic.uninstall();
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 503);
    expect(txn.finish).toHaveBeenCalledWith('ERROR');
  });

  it('does not finish the txn until the response closes', () => {
    const { txn, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({ target: asTarget(target), getClient: () => client });
    ic.install();
    const server = new target.http.Server();
    server.requestHandler = () => {};
    const res = makeRes({ statusCode: 200 });
    server.emit('request', { method: 'GET', url: '/x', headers: {} }, res);
    res.fire('finish'); // 'finish' alone does NOT finish the span (the owner waits for 'close')
    expect(txn.finish).not.toHaveBeenCalled(); // still in-flight
    res.writableFinished = true;
    res.fire('close');
    expect(txn.finish).toHaveBeenCalledWith('OK'); // finished only on 'close'
    ic.uninstall();
  });

  it('forwards a non-string (symbol) event verbatim through the original', () => {
    const { startTransaction, client } = launchedClient();
    const target = makeTarget();
    const ic = createHttpServerInterceptor({ target: asTarget(target), getClient: () => client });
    ic.install();
    const server = new target.http.Server();
    const ret = server.emit(Symbol('custom'), 1, 2);
    ic.uninstall();
    expect(ret).toBe(false); // original ran (no listener for the symbol event)
    expect(server.lastThis).toBe(server); // `this` preserved
    expect(startTransaction).not.toHaveBeenCalled(); // not a 'request' → not instrumented
  });
});
