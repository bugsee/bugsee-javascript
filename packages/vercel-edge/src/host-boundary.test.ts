import { describe, expect, it, vi } from 'vitest';
import { runInEdgeContext } from './edge-context';
import type { Bugsee } from './launch';

// WAVE 2.1/2.2 — the host-boundary contract for the edge invocation wrapper.
//
// This wrapper IS the customer's request. Whatever it returns is the response; whatever it throws is the
// failure the platform sees. So an SDK failure inside it does not cost a report — it changes the outcome of
// the request, which is the strongest form of the rule Wave 2.1 exists to enforce.
//
// Two seams are exposed, and they fail differently:
//
//  - the CATCH: `logException` runs while the customer's error is in flight. If it throws, the SDK's error
//    REPLACES the customer's — their handling never sees what actually went wrong.
//  - the FINALLY: `flush()` / `waitUntil()` run after the handler finished. A throw there replaces the
//    handler's RETURN VALUE on a clean request, turning a 200 into a 500 for a request that succeeded.

const okClient = (over: Partial<Record<string, unknown>> = {}): Bugsee =>
  ({
    logException: () => Promise.resolve(),
    flush: () => Promise.resolve(),
    getServiceProvider: () => ({ getImmediate: () => undefined }),
    ...over,
  }) as unknown as Bugsee;

describe('the edge invocation wrapper is a contained host boundary', () => {
  it('returns the handler’s value even when the SDK flush throws', async () => {
    // A CLEAN request. The customer's handler succeeded; a Bugsee flush failure must not turn that into a
    // rejection — the response is already the app's answer.
    const client = okClient({
      flush: () => {
        throw new Error('flush blew up');
      },
    });
    await expect(runInEdgeContext(client, {}, () => 'the response')).resolves.toBe('the response');
  });

  it('returns the handler’s value when flush REJECTS asynchronously', async () => {
    const client = okClient({ flush: () => Promise.reject(new Error('flush rejected')) });
    await expect(runInEdgeContext(client, {}, () => 'the response')).resolves.toBe('the response');
  });

  it('returns the handler’s value when flush rejects under awaitFlush (Durable Object path)', async () => {
    // The `awaitFlush` branch AWAITS the flush, so an async rejection propagates straight out of the
    // invocation — a rejecting upload would fail a Durable Object method whose handler had succeeded.
    const client = okClient({ flush: () => Promise.reject(new Error('flush rejected')) });
    await expect(
      runInEdgeContext(client, { awaitFlush: true }, () => 'the response'),
    ).resolves.toBe('the response');
  });

  it('never hands waitUntil a promise that can reject', async () => {
    // The platform awaits whatever `waitUntil` receives. A rejecting flush there is an unhandled rejection
    // in the isolate, or a platform-level error, rather than something we contained.
    const seen: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => seen.push(p) };
    const client = okClient({ flush: () => Promise.reject(new Error('flush rejected')) });
    await runInEdgeContext(client, { ctx }, () => 'ok');
    expect(seen).toHaveLength(1);
    await expect(seen[0]).resolves.toBeUndefined();
  });

  it('reports a rejecting flush to onError rather than discarding it', async () => {
    const onError = vi.fn();
    const client = okClient({ flush: () => Promise.reject(new Error('flush rejected')) });
    await runInEdgeContext(client, { awaitFlush: true, onError }, () => 'ok');
    expect(onError).toHaveBeenCalled();
  });

  it('rethrows the CUSTOMER’s error, not the SDK’s, when logException throws', async () => {
    // The seam that matters most: the app's error handling must see the app's error.
    const customerError = new Error('the real failure');
    const client = okClient({
      logException: () => {
        throw new Error('SDK internal failure');
      },
    });
    await expect(
      runInEdgeContext(client, {}, () => {
        throw customerError;
      }),
    ).rejects.toBe(customerError);
  });

  it('rethrows the customer’s error even when the flush ALSO throws', async () => {
    const customerError = new Error('the real failure');
    const client = okClient({
      logException: () => {
        throw new Error('SDK internal failure');
      },
      flush: () => {
        throw new Error('flush blew up');
      },
    });
    await expect(
      runInEdgeContext(client, {}, () => {
        throw customerError;
      }),
    ).rejects.toBe(customerError);
  });

  it('survives a hostile ExecutionContext whose waitUntil throws', async () => {
    // `ctx` is handed in by the platform (Cloudflare) or the app — not ours.
    const ctx = {
      waitUntil: () => {
        throw new Error('waitUntil blew up');
      },
    };
    await expect(runInEdgeContext(okClient(), { ctx }, () => 'ok')).resolves.toBe('ok');
  });

  it('still flushes on a clean invocation — the guard must not swallow the upload', async () => {
    // The canary. Without it, every assertion above is satisfied by a wrapper that stopped flushing.
    const flush = vi.fn(() => Promise.resolve());
    const ctx = { waitUntil: vi.fn() };
    await runInEdgeContext(okClient({ flush }), { ctx }, () => 'ok');
    expect(flush).toHaveBeenCalled();
    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it('still reports the error on a failing invocation', async () => {
    const logException = vi.fn(() => Promise.resolve());
    await expect(
      runInEdgeContext(okClient({ logException }), {}, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(logException).toHaveBeenCalled();
  });
});
