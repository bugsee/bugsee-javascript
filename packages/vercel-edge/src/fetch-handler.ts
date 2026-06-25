import type { RequestContext } from '@bugsee/core';
import { randomId } from '@bugsee/util';
import { type Bugsee, EdgeContextStoreToken } from './launch';
import type { EdgeRequestContextStore } from './request-context-store';
import { type EdgeExecutionContext, resolveWaitUntil } from './wait-until';

// The edge fetch-handler wrapper (docs/design/edge-runtime.md E5). Wrap your Worker/Edge `fetch` handler so:
//   1. each request runs in its own Bugsee context (the contextId/trace stamp captures for correlation),
//   2. a thrown error is captured (`logException`) AND rethrown (the platform still produces its error
//      response / the user's own handling runs),
//   3. the incident upload completes inside the request's `ctx.waitUntil(client.flush())` — WITHOUT which the
//      eager upload fetch is dropped the instant the isolate freezes on Response.
// Incident-driven: a clean request uploads nothing (flush is a no-op). Use with a launched edge client:
//   export default { fetch: withBugseeFetch(bugsee, async (request) => new Response('ok')) };

/** An edge `fetch` handler. Vercel Edge passes just `request`; Cloudflare passes `(request, env, ctx)`
 *  (the ExecutionContext is the 3rd arg / `args[1]`). */
export type EdgeFetchHandler<Args extends unknown[] = unknown[]> = (
  request: Request,
  ...args: Args
) => Response | Promise<Response>;

function resolveStore(client: Bugsee): EdgeRequestContextStore | undefined {
  try {
    return client.getService(EdgeContextStoreToken);
  } catch {
    return undefined; // not a launched edge client — degrade to no per-request context (capture still works)
  }
}

/** Wrap an edge `fetch` handler with Bugsee per-request context + error capture + a `waitUntil` flush. */
export function withBugseeFetch<Args extends unknown[]>(
  client: Bugsee,
  handler: EdgeFetchHandler<Args>,
): (request: Request, ...args: Args) => Promise<Response> {
  const store = resolveStore(client);
  return async (request: Request, ...args: Args): Promise<Response> => {
    // Cloudflare's ExecutionContext is the 3rd handler arg (args[1]); on Vercel Edge there is none → the
    // resolver reads the global request-context symbol instead.
    const waitUntil = resolveWaitUntil(args[1] as EdgeExecutionContext | undefined);
    const context: RequestContext = { contextId: randomId() };
    const run =
      store !== undefined
        ? (fn: () => Response | Promise<Response>) => store.run(context, fn)
        : (fn: () => Response | Promise<Response>) => fn();
    try {
      return await run(() => handler(request, ...args));
    } catch (error) {
      // Capture the handler error (fire-and-forget: the report is registered as pending, which the finally's
      // flush then awaits). Rethrow so the platform / the user's own error handling still runs.
      void client.logException(error, { mechanism: 'uncaught' });
      throw error;
    } finally {
      // Keep the isolate alive until any incident upload from this request completes (a no-op on a clean one).
      waitUntil(client.flush());
    }
  };
}
