import type { BugseeClient } from '@bugsee/core';
import { createNodeRequestContextStore, type FetchRequestLike } from '@bugsee/node';
import { describe, expect, it, vi } from 'vitest';
import { createDenoServeInterceptor } from './deno-serve-interceptor';

// A structural http.server transaction (avoids a @bugsee/performance dep in this Deno package).
const fakeTxn = () => ({
  getTraceId: () => 'trace-1',
  getSpanId: () => 'span-1',
  isSampled: () => true,
  isFinished: vi.fn(() => false),
  setName: vi.fn(),
  setAttribute: vi.fn(),
  finish: vi.fn(),
});

const fakeClient = (store?: ReturnType<typeof createNodeRequestContextStore>) => {
  const txn = fakeTxn();
  const startTransaction = vi.fn(() => txn);
  const client = {
    getServiceProvider: () => ({ getImmediate: () => store }),
    ext: () => ({ startTransaction }),
    logException: vi.fn(() => Promise.resolve()),
  } as unknown as BugseeClient;
  return { client, txn, startTransaction };
};

const makeReq = (method: string, url: string): FetchRequestLike => ({
  method,
  url,
  headers: { get: () => null },
});

type Handler = (req: FetchRequestLike) => unknown;
// A fake Deno global whose serve() records the (options?, handler) it was handed.
const fakeDenoHost = () => {
  const calls: Array<{ args: unknown[] }> = [];
  const serve = vi.fn((...args: unknown[]) => {
    calls.push({ args });
    return { shutdown: async () => {}, addr: { port: 0 } };
  });
  return { host: { Deno: { serve } }, serve, calls };
};

// Pull the wrapped handler out of a recorded serve() call: it's the function arg (last positional) or
// options.handler.
const handlerOf = (call: { args: unknown[] }): Handler => {
  const fn = call.args.find((a) => typeof a === 'function');
  if (fn) {
    return fn as Handler;
  }
  return (call.args[0] as { handler: Handler }).handler;
};

describe('createDenoServeInterceptor', () => {
  it.each([
    [
      'handler-first  Deno.serve(handler)',
      (serve: (...a: unknown[]) => unknown, h: Handler) => serve(h),
    ],
    [
      'options-first  Deno.serve(options, handler)',
      (serve: (...a: unknown[]) => unknown, h: Handler) => serve({ port: 0 }, h),
    ],
    [
      'options-object Deno.serve({ handler })',
      (serve: (...a: unknown[]) => unknown, h: Handler) => serve({ port: 0, handler: h }),
    ],
  ])('wraps the handler for the %s overload', async (_name, invoke) => {
    const store = createNodeRequestContextStore();
    const { client, txn } = fakeClient(store);
    const { host, calls } = fakeDenoHost();
    const ic = createDenoServeInterceptor({
      target: host,
      getClient: () => client,
      newContextId: () => 'deno-cid',
      shouldReport: () => true,
    });
    ic.install();

    let ctxDuring: string | undefined;
    const userHandler: Handler = async () => {
      ctxDuring = store.getCurrent()?.contextId;
      return { status: 200 };
    };
    invoke(host.Deno.serve, userHandler);
    const wrapped = handlerOf(calls[0] as { args: unknown[] });
    const res = await wrapped(makeReq('GET', '/x'));
    ic.uninstall();

    expect(res).toEqual({ status: 200 });
    expect(ctxDuring).toBe('deno-cid'); // context (with the supplied id) active inside the native handler
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('forwards traceResponse → the wrapped handler decorates its Response with the return headers (X4)', async () => {
    const { client } = fakeClient(createNodeRequestContextStore());
    const { host, calls } = fakeDenoHost();
    const ic = createDenoServeInterceptor({
      target: host,
      getClient: () => client,
      traceResponse: { traceresponse: true, serverTiming: true },
    });
    ic.install();
    const set: Record<string, string> = {};
    const userHandler: Handler = async () => ({
      status: 200,
      headers: {
        set: (n: string, v: string) => {
          set[n] = v;
        },
      },
    });
    host.Deno.serve(userHandler);
    const wrapped = handlerOf(calls[0] as { args: unknown[] });
    await wrapped(makeReq('GET', '/x'));
    ic.uninstall();
    expect(set).toEqual({
      traceresponse: '00-trace-1-span-1-01',
      'Server-Timing': 'traceparent;desc="00-trace-1-span-1-01"',
    });
  });

  it('passes through serve() with no handler — options-only AND no-args — untouched', () => {
    const { host, serve } = fakeDenoHost();
    const ic = createDenoServeInterceptor({ target: host });
    ic.install();
    host.Deno.serve({ port: 0 }); // options, no handler → passthrough
    host.Deno.serve(); // no args → the `args[0] ?? {}` fallback → passthrough
    ic.uninstall();
    expect(serve).toHaveBeenNthCalledWith(1, { port: 0 });
    expect(serve).toHaveBeenNthCalledWith(2);
  });

  it('self-skips when Deno is absent (install + uninstall are no-ops)', () => {
    const ic = createDenoServeInterceptor({ target: {} });
    expect(() => {
      ic.install();
      ic.uninstall();
    }).not.toThrow();
  });

  it('restores the original Deno.serve on uninstall (idempotent)', () => {
    const { host, serve } = fakeDenoHost();
    const ic = createDenoServeInterceptor({ target: host });
    ic.install();
    expect(host.Deno.serve).not.toBe(serve); // patched
    ic.install(); // idempotent — does not re-wrap
    ic.uninstall();
    expect(host.Deno.serve).toBe(serve); // restored
    ic.uninstall(); // idempotent
    expect(host.Deno.serve).toBe(serve);
  });
});
