import { describe, expect, it, vi } from 'vitest';
import { withBugseeFetch } from './fetch-handler';
import { type Bugsee, EdgeContextStoreToken } from './launch';
import { createEdgeRequestContextStore } from './request-context-store';

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

  it('requestAttributes is defensive: omits an absent method/url, keeps a malformed URL raw', async () => {
    const { client, store } = fakeClient();
    const read = async (req: unknown): Promise<Record<string, unknown> | undefined> => {
      let attrs: Record<string, unknown> | undefined;
      await withBugseeFetch(client, async (..._a: unknown[]) => {
        attrs = store.getCurrent()?.attributes; // read synchronously at handler start (single-slot is fine)
        return new Response('ok');
      })(req as Request, {}, { waitUntil: vi.fn() });
      return attrs;
    };
    const empty = await read({}); // neither method nor url → both omitted
    expect('http.method' in (empty ?? {})).toBe(false);
    expect('http.url' in (empty ?? {})).toBe(false);
    const malformed = await read({ url: '/relative/path' }); // new URL throws → kept raw; no method
    expect(malformed?.['http.url']).toBe('/relative/path');
    expect('http.method' in (malformed ?? {})).toBe(false);
  });

  it('redacts secrets on the malformed-URL fallback, where the query is NOT dropped (Wave 1.1)', async () => {
    // The happy path reduces the URL to `new URL(...).pathname`, which discards the query and any
    // userinfo. The fallback keeps the value raw — so it is the one branch here that can carry a secret.
    const { client, store } = fakeClient();
    let attrs: Record<string, unknown> | undefined;
    await withBugseeFetch(client, async (..._a: unknown[]) => {
      attrs = store.getCurrent()?.attributes;
      return new Response('ok');
    })({ url: '/cb?id_token=SECRET' } as unknown as Request, {}, { waitUntil: vi.fn() });
    expect(attrs?.['http.url']).toBe('/cb?id_token=%3Credacted%3E');
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
    const { client, store, logException } = fakeClient();
    let ctxAttrsAtLog: Record<string, unknown> | undefined;
    let ctxIdAtLog: string | undefined;
    // record the context active at the EXACT moment logException is called (core snapshots it synchronously)
    logException.mockImplementation(() => {
      ctxIdAtLog = store.getCurrent()?.contextId;
      ctxAttrsAtLog = store.getCurrent()?.attributes;
      return Promise.resolve({ ok: true });
    });
    // throw SYNCHRONOUSLY so the capture is provably inside run()'s frame — deterministic (no real-ALS cross-
    // await timing, no global stub). The restructure (capture INSIDE store.run) is what keeps the context active
    // at logException time; an outer catch would run after run() unwound, where getCurrent() is undefined.
    const wrapped = withBugseeFetch(client, (..._a: unknown[]) => {
      throw new Error('boom');
    });
    await expect(
      wrapped(new Request('https://x.test/pay/9', { method: 'PUT' }), {}, { waitUntil: vi.fn() }),
    ).rejects.toThrow('boom');
    // an outer-catch structure would see undefined here → report uncorrelated (no contextId, no route attrs)
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
