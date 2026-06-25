import { afterEach, describe, expect, it, vi } from 'vitest';
import { withBugseeFetch } from './fetch-handler';
import { type Bugsee, EdgeContextStoreToken } from './launch';
import { createEdgeRequestContextStore } from './request-context-store';

afterEach(() => vi.unstubAllGlobals());

// A fake launched edge client: a real edge context store (single-slot), spied logException + flush.
function fakeClient(over: { withStore?: boolean } = {}) {
  const withStore = over.withStore ?? true;
  const store = createEdgeRequestContextStore();
  const logException = vi.fn((_e: unknown, _o?: unknown) => Promise.resolve({ ok: true }));
  const flush = vi.fn(() => Promise.resolve(true));
  const client = {
    logException,
    flush,
    getService: (token: unknown) => {
      if (token === EdgeContextStoreToken) {
        if (!withStore) throw new Error('not registered');
        return store;
      }
      return undefined;
    },
  } as unknown as Bugsee;
  return { client, store, logException, flush };
}

describe('withBugseeFetch', () => {
  it('runs the handler inside a Bugsee context + returns its Response, then flushes via waitUntil', async () => {
    const { client, store, flush } = fakeClient();
    const waitUntil = vi.fn();
    let contextDuringHandler: string | undefined;
    const wrapped = withBugseeFetch(client, async (_req: Request, ..._rest: unknown[]) => {
      contextDuringHandler = store.getCurrent()?.contextId; // a context is active
      return new Response('ok', { status: 200 });
    });
    const res = await wrapped(new Request('https://x.test/'), {}, { waitUntil });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(typeof contextDuringHandler).toBe('string'); // ran within store.run
    expect(store.getCurrent()).toBeUndefined(); // context closed after
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise); // flush() promise handed to waitUntil
  });

  it('stamps the request method + path onto the per-request context (http.method/http.url, query dropped)', async () => {
    const { client, store } = fakeClient();
    const waitUntil = vi.fn();
    let attrs: Record<string, unknown> | undefined;
    const wrapped = withBugseeFetch(client, async (_req: Request, ..._rest: unknown[]) => {
      attrs = store.getCurrent()?.attributes; // the active context carries which request is running
      return new Response('ok');
    });
    await wrapped(
      new Request('https://x.test/orders/7?token=secret', { method: 'POST' }),
      {},
      { waitUntil },
    );
    expect(attrs?.['http.method']).toBe('POST');
    expect(attrs?.['http.url']).toBe('/orders/7'); // PATH only — the ?token=secret query is dropped (PII-safe)
  });

  it('returns the handler Response on the no-store SUCCESS path (degraded, no context)', async () => {
    const { client } = fakeClient({ withStore: false });
    const waitUntil = vi.fn();
    const wrapped = withBugseeFetch(
      client,
      async (..._a: unknown[]) => new Response('degraded-ok', { status: 201 }),
    );
    const res = await wrapped(new Request('https://x.test/'), {}, { waitUntil });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('degraded-ok'); // the handler's own Response passes through untouched
  });

  it('captures a thrown handler error (uncaught) + RETHROWS it + still flushes via waitUntil', async () => {
    const { client, logException, flush } = fakeClient();
    const waitUntil = vi.fn();
    const boom = new Error('handler boom');
    const wrapped = withBugseeFetch(client, async (..._a: unknown[]) => {
      throw boom;
    });
    await expect(wrapped(new Request('https://x.test/'), {}, { waitUntil })).rejects.toBe(boom);
    expect(logException).toHaveBeenCalledTimes(1);
    expect(logException.mock.calls[0]?.[0]).toBe(boom);
    expect((logException.mock.calls[0]?.[1] as { mechanism?: string })?.mechanism).toBe('uncaught');
    expect(waitUntil).toHaveBeenCalledTimes(1); // the upload still gets a waitUntil even on error
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('captures a thrown error WHILE the request context is still active (report stays correlated)', async () => {
    // Real ALS (production edge has it global: Vercel built-in / Cloudflare nodejs_compat); node doesn't expose
    // it globally, so without this the store would use the single-slot fallback which can't span the await. The
    // dynamic import keeps the edge src's node-free tsconfig (no @types/node); the test itself runs in node.
    // @ts-expect-error node:async_hooks is intentionally untyped here (the edge package declares no node types).
    const { AsyncLocalStorage } = await import('node:async_hooks');
    vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage);
    const { client, store, logException } = fakeClient();
    let ctxAttrsAtLog: Record<string, unknown> | undefined;
    let ctxIdAtLog: string | undefined;
    // record the context active at the EXACT moment logException is called (core snapshots it synchronously)
    logException.mockImplementation(() => {
      ctxIdAtLog = store.getCurrent()?.contextId;
      ctxAttrsAtLog = store.getCurrent()?.attributes;
      return Promise.resolve({ ok: true });
    });
    const wrapped = withBugseeFetch(client, async (..._a: unknown[]) => {
      throw new Error('boom');
    });
    await expect(
      wrapped(new Request('https://x.test/pay/9', { method: 'PUT' }), {}, { waitUntil: vi.fn() }),
    ).rejects.toThrow('boom');
    // if the capture fired in an outer catch (after run() unwound) these would be undefined → report uncorrelated
    expect(typeof ctxIdAtLog).toBe('string');
    expect(ctxAttrsAtLog?.['http.method']).toBe('PUT');
    expect(ctxAttrsAtLog?.['http.url']).toBe('/pay/9');
  });

  it('acquires waitUntil from the Cloudflare ctx (args[1])', async () => {
    const { client } = fakeClient();
    const waitUntil = vi.fn();
    const wrapped = withBugseeFetch(client, async (..._a: unknown[]) => new Response('ok'));
    await wrapped(new Request('https://x.test/'), { SECRET: '1' }, { waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('degrades to no per-request context when the client has no edge store (still captures + flushes)', async () => {
    const { client, logException, flush } = fakeClient({ withStore: false });
    const waitUntil = vi.fn();
    const wrapped = withBugseeFetch(client, async (..._a: unknown[]) => {
      throw new Error('x');
    });
    await expect(wrapped(new Request('https://x.test/'), {}, { waitUntil })).rejects.toThrow('x');
    expect(logException).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no waitUntil is resolvable (Vercel symbol absent / no ctx)', async () => {
    const { client, flush } = fakeClient();
    const wrapped = withBugseeFetch(client, async () => new Response('ok'));
    // no ctx arg + not on Vercel Edge → resolveWaitUntil returns a no-op
    const res = await wrapped(new Request('https://x.test/'));
    expect(res.status).toBe(200);
    expect(flush).toHaveBeenCalledTimes(1); // flush still called (its promise goes to the no-op waitUntil)
  });
});
