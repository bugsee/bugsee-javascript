import type { BugseeClient } from '@bugsee/core';
import { createNodeRequestContextStore, type FetchRequestLike } from '@bugsee/node';
import { describe, expect, it, vi } from 'vitest';
import { createBunServeInterceptor } from './bun-serve-interceptor';

// A structural http.server transaction (avoids a @bugsee/performance dep in this Bun package).
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

// A fake Bun global whose serve() records the options it was handed.
const fakeBunHost = () => {
  const served: Array<{ fetch?: (req: FetchRequestLike) => unknown }> = [];
  const serve = vi.fn((options: { fetch?: (req: FetchRequestLike) => unknown }) => {
    served.push(options);
    return { stop() {} };
  });
  return { host: { Bun: { serve } }, serve, served };
};

describe('createBunServeInterceptor', () => {
  it('wraps the fetch handler so a Bun.serve request opens a context + finishes the txn', async () => {
    const store = createNodeRequestContextStore();
    const { client, txn, startTransaction } = fakeClient(store);
    const { host, served } = fakeBunHost();
    const ic = createBunServeInterceptor({
      target: host,
      getClient: () => client,
      newContextId: () => 'bun-cid',
      shouldReport: () => true,
    });
    ic.install();

    let ctxDuring: string | undefined;
    host.Bun.serve({
      port: 0,
      fetch: async (_req: FetchRequestLike) => {
        ctxDuring = store.getCurrent()?.contextId;
        return { status: 201 };
      },
    } as never);
    const wrappedFetch = served[0]?.fetch as (req: FetchRequestLike) => Promise<{ status: number }>;
    const res = await wrappedFetch(makeReq('GET', '/widgets/1'));
    ic.uninstall();

    expect(res).toEqual({ status: 201 });
    expect(ctxDuring).toBe('bun-cid'); // context (with the supplied id) active inside the native handler
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'GET /widgets/1', operation: 'http.server' }),
    );
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('self-skips when Bun is absent (install + uninstall are no-ops)', () => {
    const ic = createBunServeInterceptor({ target: {} }); // no Bun
    expect(() => {
      ic.install();
      ic.uninstall();
    }).not.toThrow();
  });

  it('passes through serve() options without a fetch function untouched', () => {
    const { host, serve } = fakeBunHost();
    const ic = createBunServeInterceptor({ target: host });
    ic.install();
    const opts = { port: 0, websocket: {} };
    host.Bun.serve(opts as never);
    ic.uninstall();
    expect(serve).toHaveBeenCalledWith(opts); // unwrapped (no fetch to instrument)
  });

  it('restores the original Bun.serve on uninstall (idempotent)', () => {
    const { host, serve } = fakeBunHost();
    const ic = createBunServeInterceptor({ target: host });
    ic.install();
    expect(host.Bun.serve).not.toBe(serve); // patched
    ic.install(); // idempotent — does not re-wrap
    ic.uninstall();
    expect(host.Bun.serve).toBe(serve); // restored
    ic.uninstall(); // idempotent — safe second uninstall
    expect(host.Bun.serve).toBe(serve);
  });
});
