import { describe, expect, it, vi } from 'vitest';
import { AWAITED_FLUSH_TIMEOUT_MS, resolveEdgeStore, runInEdgeContext } from './edge-context';
import { type Bugsee, EdgeContextStoreToken } from './launch';
import { createEdgeRequestContextStore } from './request-context-store';

// A fake launched edge client: a real edge context store (single-slot in node), spied logException + flush.
function fakeClient(over: { withStore?: boolean } = {}) {
  const withStore = over.withStore ?? true;
  const store = createEdgeRequestContextStore();
  const logException = vi.fn((_e: unknown, _o?: unknown) => Promise.resolve({ ok: true }));
  const flush = vi.fn((_timeoutMs?: number) => Promise.resolve(true));
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

  it('BOUNDS the awaited flush, so a stuck upload cannot hold the customer’s response open', async () => {
    // A bundle's retry ladder is 10s + 20s + 40s inside createIssue and again inside the signed PUT, so
    // an unbounded flush can run ~140 s — and on the Durable Object path this one is holding the
    // CUSTOMER's HTTP response open for all of it. Bounding costs no delivery the platform would have
    // provided anyway: the isolate is killed at the platform's own budget regardless, so waiting longer
    // buys nothing and risks the request.
    //
    // The fake RESOLVES unconditionally and the assertion does the work. An earlier version resolved only
    // when given a deadline, so removing the bound made this fail by 30s test timeout — no expected /
    // received, 30s of CI wall clock per regression, and indistinguishable from runner flakiness, which
    // is how a hanging test gets "fixed" by raising the timeout instead of read.
    const { client, flush } = fakeClient();
    await runInEdgeContext(client, { ctx: { waitUntil: vi.fn() }, awaitFlush: true }, () => 'ok');
    expect(flush).toHaveBeenCalledWith(expect.any(Number));
  });

  it('lets the caller choose the flush deadline via flushTimeoutMs', async () => {
    const { client, flush } = fakeClient();
    await runInEdgeContext(
      client,
      { ctx: { waitUntil: vi.fn() }, awaitFlush: true, flushTimeoutMs: 1234 },
      () => 'ok',
    );
    expect(flush).toHaveBeenCalledWith(1234);
  });

  it('honours flushTimeoutMs on the DEFERRED path too, not only the awaited one', async () => {
    // The awaited path is the Durable Object one; `waitUntil` is the DEFAULT path, so an override that
    // worked only under `awaitFlush` was unreachable for almost every caller — and replacing the
    // deferred `??` with the bare constant passed the whole package suite.
    const { client, flush } = fakeClient();
    const held: Array<Promise<unknown>> = [];
    await runInEdgeContext(
      client,
      { ctx: { waitUntil: (p) => held.push(p) }, flushTimeoutMs: 777 },
      () => 'ok',
    );
    await Promise.all(held);
    expect(flush).toHaveBeenCalledWith(777);
  });

  it('treats a non-finite flushTimeoutMs as genuinely UNBOUNDED', async () => {
    // The TSDoc promised `Number.POSITIVE_INFINITY` restores the old unbounded behaviour. It did not:
    // `flush` races `sleep(timeout)`, and `setTimeout(fn, Infinity)` coerces to 0 and fires IMMEDIATELY,
    // so passing Infinity made the flush give up at once — the precise opposite of what was documented.
    const { client, flush } = fakeClient();
    await runInEdgeContext(
      client,
      { ctx: { waitUntil: vi.fn() }, awaitFlush: true, flushTimeoutMs: Number.POSITIVE_INFINITY },
      () => 'ok',
    );
    expect(flush).toHaveBeenCalledWith(undefined); // no deadline reaches the client
  });

  it('REPORTS a flush that ran out of time instead of dropping the report silently', async () => {
    // `client.flush(timeout)` is a race, not a cancel: it abandons and says so by returning false. On the
    // edge tier there is no durable queue and no next launch, so an abandoned flush is a permanently lost
    // incident. Nobody read the boolean, so the loss was invisible.
    const onError = vi.fn();
    const { client, flush } = fakeClient();
    flush.mockResolvedValue(false); // deadline won the race
    await runInEdgeContext(
      client,
      { ctx: { waitUntil: vi.fn() }, awaitFlush: true, onError },
      () => 'ok',
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('BOUNDS the deferred (waitUntil) flush too, with a longer deadline than the awaited one', async () => {
    // Off the response path, so it may run longer — but still not unbounded: the platform's extend-lifetime
    // budget is finite and an upload that outlives it is killed mid-flight either way.
    const { client, flush } = fakeClient();
    const held: Array<Promise<unknown>> = [];
    await runInEdgeContext(client, { ctx: { waitUntil: (p) => held.push(p) } }, () => 'ok');
    await Promise.all(held);
    const awaited = flush.mock.calls[0]?.[0];
    expect(awaited).toEqual(expect.any(Number));
    expect(awaited as number).toBeGreaterThan(AWAITED_FLUSH_TIMEOUT_MS);
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

// S4 (docs/design/cloudflare-tenant-isolation.md §4.1): the per-invocation context carries the TENANT.
//
// `contextId` is per-invocation; `owner` is the tenant, so a Durable Object's rolling window stays
// per-tenant and its incident bundle cannot pick up another DO's capture (docs/review/cloudflare.md SEV1
// #2, proven on real workerd).
describe('runInEdgeContext — owner (tenant key)', () => {
  it('puts the supplied owner on the context the handler runs in', async () => {
    const { client, store } = fakeClient();
    let owner: string | undefined;
    await runInEdgeContext(client, { owner: 'do-tenant-A' }, () => {
      owner = store.getCurrent()?.owner;
    });
    expect(owner).toBe('do-tenant-A');
  });

  it('leaves owner undefined when none is supplied (fetch handlers are single-tenant)', async () => {
    const { client, store } = fakeClient();
    let owner: string | undefined = 'sentinel';
    await runInEdgeContext(client, {}, () => {
      owner = store.getCurrent()?.owner;
    });
    expect(owner).toBeUndefined();
  });

  it('keeps contextId per-invocation while owner stays constant across them', async () => {
    const { client, store } = fakeClient();
    const seen: Array<{ id?: string; owner?: string }> = [];
    const record = () =>
      seen.push({ id: store.getCurrent()?.contextId, owner: store.getCurrent()?.owner });
    await runInEdgeContext(client, { owner: 'do-tenant-A' }, record);
    await runInEdgeContext(client, { owner: 'do-tenant-A' }, record);
    expect(seen[0]?.owner).toBe('do-tenant-A');
    expect(seen[1]?.owner).toBe('do-tenant-A');
    expect(seen[0]?.id).not.toBe(seen[1]?.id); // per-invocation, as before
  });
});
