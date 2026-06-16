import type { BugseeClient } from '@bugsee/core';
import type { Transaction } from '@bugsee/performance';
import { describe, expect, it, vi } from 'vitest';
import { type FetchHandler, type FetchRequestLike, wrapFetchHandler } from './fetch-server-wrap';
import { createNodeRequestContextStore, type RequestContextStore } from './request-context-store';

const fakeTxn = (): Transaction =>
  ({
    getTraceId: () => 'trace-1',
    getSpanId: () => 'span-1',
    isFinished: vi.fn(() => false),
    setName: vi.fn(),
    setAttribute: vi.fn(),
    finish: vi.fn(),
  }) as unknown as Transaction;

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

const makeReq = (
  method: string,
  url: string,
  headers: Record<string, string> = {},
): FetchRequestLike => ({
  method,
  url,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

describe('wrapFetchHandler', () => {
  it('opens a context for the handler and finishes OK from the Response status', async () => {
    const store = createNodeRequestContextStore();
    const txn = fakeTxn();
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ store, perf: { startTransaction } });
    let ctxDuring: string | undefined;
    const handler = wrapFetchHandler(
      async (req) => {
        ctxDuring = store.getCurrent()?.contextId;
        expect(req.method).toBe('POST');
        return { status: 204 };
      },
      { getClient: () => client, newContextId: () => 'cid' },
    );
    const res = await handler(makeReq('POST', '/o/7?x=1'));
    expect(res).toEqual({ status: 204 });
    expect(ctxDuring).toBe('cid'); // context active during the native handler
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'POST /o/7', operation: 'http.server' }), // query stripped for name
    );
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 204);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('finishes ERROR from a returned 5xx Response status (no throw)', async () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const handler = wrapFetchHandler(async () => ({ status: 503 }), { getClient: () => client });
    await handler(makeReq('GET', '/x'));
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 503);
    expect(txn.finish).toHaveBeenCalledWith('ERROR'); // status>=500 → ERROR even on a normal return
  });

  it('forwards extra runtime args (the Bun server / Deno info 2nd arg) to the handler', async () => {
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => fakeTxn()) } });
    const sentinel = { runtimeArg: true };
    let received: unknown;
    const handler = wrapFetchHandler(
      async (_req, extra: unknown) => {
        received = extra;
        return { status: 200 };
      },
      { getClient: () => client },
    );
    await handler(makeReq('GET', '/x'), sentinel);
    expect(received).toBe(sentinel); // ...rest is forwarded verbatim
  });

  it('captures + finishes ERROR on a rejected handler, re-throwing the error', async () => {
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) }, logException });
    const err = new Error('boom');
    const handler = wrapFetchHandler(
      async () => {
        throw err;
      },
      { getClient: () => client },
    );
    await expect(handler(makeReq('GET', '/x'))).rejects.toBe(err);
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 500);
    expect(txn.finish).toHaveBeenCalledWith('ERROR');
  });

  it('captures + finishes ERROR on a SYNCHRONOUS handler throw, re-throwing', () => {
    const txn = fakeTxn();
    const logException = vi.fn(() => Promise.resolve());
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) }, logException });
    const err = new Error('sync-boom');
    const handler = wrapFetchHandler(
      (() => {
        throw err;
      }) as FetchHandler,
      { getClient: () => client },
    );
    expect(() => handler(makeReq('GET', '/x'))).toThrow('sync-boom');
    expect(logException).toHaveBeenCalledWith(err, { mechanism: 'http-error' });
    expect(txn.finish).toHaveBeenCalledWith('ERROR');
  });

  it('forwards the inbound traceparent as a trace continuation', async () => {
    const txn = fakeTxn();
    const startTransaction = vi.fn(() => txn);
    const client = fakeClient({ perf: { startTransaction } });
    const handler = wrapFetchHandler(async () => ({ status: 200 }), { getClient: () => client });
    await handler(
      makeReq('GET', '/x', {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      }),
    );
    expect(startTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ continuation: { traceId: '0af7651916cd43dd8448eb211c80319c' } }),
    );
  });

  it('without a launched client: runs the handler + returns its Response, opens no transaction', async () => {
    let ran = false;
    const handler = wrapFetchHandler(
      async () => {
        ran = true;
        return { status: 200 };
      },
      { getClient: () => undefined },
    );
    const res = await handler(makeReq('GET', '/x'));
    expect(ran).toBe(true);
    expect(res).toEqual({ status: 200 });
  });

  it('defaults to status 200 when the Response carries no numeric status', async () => {
    const txn = fakeTxn();
    const client = fakeClient({ perf: { startTransaction: vi.fn(() => txn) } });
    const handler = wrapFetchHandler(async () => ({}) as { status: number }, {
      getClient: () => client,
    });
    await handler(makeReq('GET', '/x'));
    expect(txn.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('isolates concurrent invocations — distinct contexts, each stable across an await', async () => {
    const store = createNodeRequestContextStore();
    const client = fakeClient({ store, perf: { startTransaction: vi.fn(() => fakeTxn()) } });
    const seen: Array<string | undefined> = [];
    const handler = wrapFetchHandler(
      async () => {
        const before = store.getCurrent()?.contextId;
        await new Promise((r) => setTimeout(r, 15));
        expect(store.getCurrent()?.contextId).toBe(before); // stable across the await
        seen.push(before);
        return { status: 200 };
      },
      { getClient: () => client },
    );
    await Promise.all([handler(makeReq('GET', '/a')), handler(makeReq('GET', '/b'))]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[0]).not.toBe(seen[1]); // the two native requests had distinct contexts
  });
});
