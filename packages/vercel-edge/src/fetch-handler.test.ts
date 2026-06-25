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
