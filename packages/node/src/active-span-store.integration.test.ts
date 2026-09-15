import { createPerformanceController, createTransactionStore } from '@bugsee/performance';
import { describe, expect, it } from 'vitest';
import { createRequestScopedActiveSpanStore } from './active-span-store';
import { createNodeRequestContextStore } from './request-context-store';

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// D2 part 2, end to end: the REAL performance controller over the REAL AsyncLocalStorage-backed
// request-context store, driven the way server-instrument drives it (one `startTransaction` per
// incoming request, inside that request's context). Two interleaved requests must each keep their
// own active transaction — under the old process-wide slot the second start overwrote the first
// and a rename in request A landed on request B's transaction.
describe('request-scoped active span (D2 part 2 integration)', () => {
  it('concurrent requests keep their own active transaction; a rename in one never touches the other', async () => {
    const als = createNodeRequestContextStore();
    const txStore = createTransactionStore();
    const api = createPerformanceController({
      clock: { wallNow: () => 1000, monotonicNow: () => 0 },
      store: txStore,
      activeSpanStore: createRequestScopedActiveSpanStore(als),
    });

    const request = async (id: string, route: string, delayMs: number): Promise<void> => {
      await als.run({ contextId: id }, async () => {
        const own = api.startTransaction({ name: `GET ${id}`, operation: 'http.server' });
        await tick(delayMs); // yield so the sibling request starts before reading back
        expect(api.getActiveSpan()).toBe(own); // still ours, not the sibling's
        api.setRouteName(route); // must rename OURS, not the sibling's
        expect(own.getName()).toBe(route);
        own.finish('OK');
      });
    };
    await Promise.all([request('A', '/a/:id', 20), request('B', '/b/:id', 5)]);

    // Both transactions finished into the shared buffer, each carrying its own route name —
    // the buffer is shared by design (correlation-by-tagging, not isolation), but the NAMES
    // prove no rename crossed requests (under the old global slot one of these would be wrong).
    expect(
      txStore
        .drain()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['/a/:id', '/b/:id']);
  });

  it('an ambient transaction finished inside a request is never readable from it', async () => {
    // SCOPE, deliberately narrow: through the CONTROLLER a finished transaction is hidden by the
    // store's own live() filter, so this test cannot observe whether the ambient SLOT was released —
    // it would pass with clear() deleted outright. It pins what it can: a background transaction
    // finished from inside a request is invisible to that request both before and after, and the
    // request's own reads stay private-empty. The slot-release guarantee is pinned separately, on a
    // LIVE transaction, in active-span-store.test.ts ('clearing an ambient transaction from inside a
    // context clears the ambient slot').
    const als = createNodeRequestContextStore();
    const api = createPerformanceController({
      clock: { wallNow: () => 1000, monotonicNow: () => 0 },
      store: createTransactionStore(),
      activeSpanStore: createRequestScopedActiveSpanStore(als),
    });
    const ambient = api.startTransaction({ name: 'ambient', operation: 'custom' });
    await als.run({ contextId: 'R' }, async () => {
      expect(api.getActiveSpan()).toBeUndefined(); // this request stashed nothing: private-empty
      ambient.finish('OK'); // finishing what it holds by reference still clears where it lives
      expect(api.getActiveSpan()).toBeUndefined();
    });
    expect(api.getActiveSpan()).toBeUndefined(); // and it stays cleared outside too
  });

  it('a rename inside a frozen context never touches the ambient transaction (F1)', async () => {
    // End-to-end shape of the finding: the frozen request's own start is dropped, so a setRouteName
    // there must no-op — not rename the unrelated live ambient transaction it would otherwise read
    // through the fallback.
    const als = createNodeRequestContextStore();
    const api = createPerformanceController({
      clock: { wallNow: () => 1000, monotonicNow: () => 0 },
      store: createTransactionStore(),
      activeSpanStore: createRequestScopedActiveSpanStore(als),
    });
    const ambient = api.startTransaction({ name: 'background', operation: 'custom' });
    const frozen = Object.freeze({ contextId: 'F' });
    await als.run(frozen, async () => {
      const own = api.startTransaction({ name: 'GET /f', operation: 'http.server' });
      expect(api.getActiveSpan()).toBeUndefined(); // private reads: no fallback to ambient here
      api.setRouteName('/orders/:id'); // must no-op, not rename ambient
      expect(own.getName()).toBe('GET /f');
      own.finish('OK');
    });
    expect(ambient.getName()).toBe('background'); // the foreign transaction is untouched
    ambient.finish('OK');
  });

  it('a rename issued while two requests are in flight lands on the caller’s own transaction', async () => {
    const als = createNodeRequestContextStore();
    const api = createPerformanceController({
      clock: { wallNow: () => 1000, monotonicNow: () => 0 },
      store: createTransactionStore(),
      activeSpanStore: createRequestScopedActiveSpanStore(als),
    });
    let nameOfA = '';
    let nameOfB = '';
    await Promise.all([
      als.run({ contextId: 'A' }, async () => {
        const own = api.startTransaction({ name: 'GET /a', operation: 'http.server' });
        await tick(20);
        api.setRouteName('/a/:id'); // B is still in flight — under the old global slot this renamed B's txn
        nameOfA = own.getName();
        own.finish('OK');
      }),
      als.run({ contextId: 'B' }, async () => {
        const own = api.startTransaction({ name: 'GET /b', operation: 'http.server' });
        await tick(30); // B reads AFTER A renamed — its own name must be untouched by A's rename
        nameOfB = own.getName();
        own.finish('OK');
      }),
    ]);
    expect(nameOfA).toBe('/a/:id');
    expect(nameOfB).toBe('GET /b');
  });
});
