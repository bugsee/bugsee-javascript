import { describe, expect, it, vi } from 'vitest';
import { resolveEdgeStore, runInEdgeContext } from './edge-context';
import { type Bugsee, EdgeContextStoreToken } from './launch';
import { createEdgeRequestContextStore } from './request-context-store';

// A fake launched edge client: a real edge context store (single-slot in node), spied logException + flush.
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

describe('runInEdgeContext', () => {
  it('runs fn inside a context stamped with the given attributes', async () => {
    const { client, store } = fakeClient();
    let id: string | undefined;
    let attrs: Record<string, unknown> | undefined;
    await runInEdgeContext(
      client,
      { attributes: { 'faas.trigger': 'timer' }, ctx: { waitUntil: vi.fn() } },
      () => {
        id = store.getCurrent()?.contextId;
        attrs = store.getCurrent()?.attributes;
        return 'ok';
      },
    );
    expect(typeof id).toBe('string');
    expect(attrs).toEqual({ 'faas.trigger': 'timer' });
  });

  it('opens a context with NO attributes when none are given (the undefined-attributes branch)', async () => {
    const { client, store } = fakeClient();
    let id: string | undefined;
    let attrs: unknown = 'untouched';
    await runInEdgeContext(client, {}, () => {
      id = store.getCurrent()?.contextId;
      attrs = store.getCurrent()?.attributes;
      return 0;
    });
    expect(typeof id).toBe('string');
    expect(attrs).toBeUndefined(); // contextId only — no attributes key
  });

  it("returns fn's result on a clean invocation and flushes a no-op via waitUntil", async () => {
    const { client, flush } = fakeClient();
    const waitUntil = vi.fn();
    const result = await runInEdgeContext(client, { ctx: { waitUntil } }, () => 42);
    expect(result).toBe(42);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise); // the flush() promise is handed to waitUntil
  });

  it('captures + RETHROWS a thrown error WHILE the context is still active (correlated)', async () => {
    const { client, store, logException, flush } = fakeClient();
    let ctxIdAtLog: string | undefined;
    logException.mockImplementation(() => {
      ctxIdAtLog = store.getCurrent()?.contextId;
      return Promise.resolve({ ok: true });
    });
    const boom = new Error('boom');
    // sync throw → the catch (and logException) run inside run()'s frame (deterministic, no real-ALS timing)
    await expect(
      runInEdgeContext(client, { ctx: { waitUntil: vi.fn() } }, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(logException).toHaveBeenCalledWith(boom, { mechanism: 'uncaught' });
    expect(typeof ctxIdAtLog).toBe('string'); // logException fired INSIDE the context (report stays correlated)
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('AWAITS client.flush() in-request when awaitFlush is set (instead of deferring to waitUntil)', async () => {
    const { client, flush } = fakeClient();
    const waitUntil = vi.fn();
    let releaseFlush: (value: boolean) => void = () => {};
    flush.mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseFlush = resolve;
      }),
    );
    let settled = false;
    const call = runInEdgeContext(
      client,
      { ctx: { waitUntil }, awaitFlush: true },
      () => 'ok',
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false); // the invocation has NOT resolved — it is awaiting the flush
    expect(waitUntil).not.toHaveBeenCalled(); // and did NOT defer to waitUntil (which is inert on a DO)
    releaseFlush(true);
    await call;
    expect(settled).toBe(true); // resolves only once the flush completes
  });

  it('degrades to no context when the client has no edge store (still captures + rethrows + flushes)', async () => {
    const { client, logException, flush } = fakeClient({ withStore: false });
    await expect(
      runInEdgeContext(client, {}, () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(logException).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

describe('resolveEdgeStore', () => {
  it('returns the registered edge context store', () => {
    const { client, store } = fakeClient();
    expect(resolveEdgeStore(client)).toBe(store);
  });

  it('returns undefined when the client is not a launched edge client (getService throws)', () => {
    const { client } = fakeClient({ withStore: false });
    expect(resolveEdgeStore(client)).toBeUndefined();
  });
});
