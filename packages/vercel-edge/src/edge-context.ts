import type { AttributeValue, RequestContext } from '@bugsee/core';
import { randomId } from '@bugsee/util';
import { type Bugsee, EdgeContextStoreToken } from './launch';
import type { EdgeRequestContextStore } from './request-context-store';
import { type EdgeExecutionContext, resolveWaitUntil } from './wait-until';

// The generic edge-invocation core (docs/design/edge-runtime.md E5/C2). EVERY edge handler — fetch, and on
// Cloudflare scheduled/queue/email/tail/Durable-Object/RPC — runs the same shape: open a per-invocation Bugsee
// context, run the handler INSIDE it (so an incident report is correlated), capture + RETHROW a thrown error,
// then flush the incident upload via the resolved `waitUntil` so it survives the isolate freeze. This module
// holds that shape ONCE; `withBugseeFetch` (fetch) and `@bugsee/cloudflare`'s per-type wrappers build on it.

/** Resolve the edge request-context store from a launched client; `undefined` when `client` is not a launched
 *  edge client (then the invocation runs WITHOUT a per-request context — capture still works, just uncorrelated). */
export function resolveEdgeStore(client: Bugsee): EdgeRequestContextStore | undefined {
  try {
    return client.getService(EdgeContextStoreToken);
  } catch {
    return undefined;
  }
}

export interface EdgeInvocationOptions {
  /** Attributes stamped on the per-invocation context (merged into any incident report produced within it) —
   *  e.g. `http.method`/`http.url` for fetch, or `faas.trigger`/`faas.cron` for a Cron handler. */
  attributes?: Record<string, AttributeValue>;
  /** The platform ExecutionContext (Cloudflare passes it to the handler) used to acquire `waitUntil`; absent on
   *  Vercel Edge (the resolver reads the global request-context symbol there instead). */
  ctx?: EdgeExecutionContext;
  /** Tenant key for capture-store partitioning — the DURABLE OBJECT id on Cloudflare. Unlike the
   *  per-invocation `contextId`, this is stable for the tenant, so its rolling window stays its own and an
   *  incident bundle cannot pick up another tenant's capture. Absent for single-tenant handlers (fetch),
   *  where partitioning is a no-op (docs/design/cloudflare-tenant-isolation.md §4.1). */
  owner?: string;
  /** AWAIT the flush inside the invocation instead of deferring it to `waitUntil`. Required for Durable Objects:
   *  `DurableObjectState.waitUntil` is a documented NO-OP (it only exists for API compatibility), so the only
   *  thing that keeps a DO alive long enough for the incident upload is the request handler's promise staying
   *  pending — the flush must be awaited before the method returns. (Module Workers / WorkerEntrypoint have a
   *  real, effective `ctx.waitUntil`, so they leave this `false` and defer the flush — no added response latency.) */
  awaitFlush?: boolean;
}

/** Run `fn` as a Bugsee-instrumented edge invocation: in a fresh per-invocation context (stamped with
 *  `options.attributes`), capturing + RETHROWING a thrown error, then flushing the incident upload via the
 *  resolved `waitUntil`. The capture runs INSIDE the context — `client.logException` snapshots the active
 *  context SYNCHRONOUSLY (core `submitReport`), so it must fire while the context is open; an outer catch would
 *  run after `store.run()` unwound (`getCurrent()` === undefined there), and only a fn STARTED inside `run()`
 *  sees the store in its own post-await catch. A clean invocation flushes a no-op and returns `fn`'s value. */
export async function runInEdgeContext<T>(
  client: Bugsee,
  options: EdgeInvocationOptions,
  fn: () => T | Promise<T>,
): Promise<T> {
  const store = resolveEdgeStore(client);
  const waitUntil = resolveWaitUntil(options.ctx);
  const context: RequestContext = {
    contextId: randomId(),
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    ...(options.attributes !== undefined ? { attributes: options.attributes } : {}),
  };
  const capture = async (): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      // Fire-and-forget: the report is registered as pending, which the finally's flush then awaits. Rethrow so
      // the platform / the user's own error handling still runs.
      void client.logException(error, { mechanism: 'uncaught' });
      throw error;
    }
  };
  try {
    return store !== undefined ? await store.run(context, capture) : await capture();
  } finally {
    // Keep the isolate alive until any incident upload from this invocation completes (a no-op on a clean one).
    if (options.awaitFlush === true) {
      await client.flush(); // Durable Object: ctx.waitUntil is inert → hold the request open by awaiting
    } else {
      waitUntil(client.flush());
    }
  }
}
