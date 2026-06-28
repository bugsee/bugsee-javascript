import type { AttributeValue } from '@bugsee/core';
import { runInEdgeContext } from './edge-context';
import type { Bugsee } from './launch';
import type { EdgeExecutionContext } from './wait-until';

// The edge fetch-handler wrapper (docs/design/edge-runtime.md E5) — the fetch-specific face of the generic
// edge-invocation core (`runInEdgeContext`, edge-context.ts). Wrap your Worker/Edge `fetch` handler so each
// request runs in its own Bugsee context (stamped with which route is running), a thrown error is captured AND
// rethrown, and the incident upload completes inside `ctx.waitUntil(client.flush())` (without which the eager
// upload fetch is dropped the instant the isolate freezes on Response). Incident-driven: a clean request uploads
// nothing. Use with a launched edge client:
//   export default { fetch: withBugseeFetch(bugsee, async (request) => new Response('ok')) };

/** An edge `fetch` handler. Vercel Edge passes just `request`; Cloudflare passes `(request, env, ctx)`
 *  (the ExecutionContext is the 3rd arg / `args[1]`). */
export type EdgeFetchHandler<Args extends unknown[] = unknown[]> = (
  request: Request,
  ...args: Args
) => Response | Promise<Response>;

// Stamp WHICH request is running onto its context (merged into any incident report produced within it), so an
// edge crash report tells you the failing route — the one capture the wrapper already has in hand. Keys mirror
// node's server-instrument (`http.method`/`http.url`). The query string is DROPPED: report attributes don't
// pass through the redaction pipeline, so a secret in `?token=…` must not leak. Best-effort — a relative /
// malformed URL keeps its raw value rather than being dropped.
export function requestAttributes(request: Request): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {};
  if (typeof request?.method === 'string') {
    attributes['http.method'] = request.method;
  }
  if (typeof request?.url === 'string') {
    let target = request.url;
    try {
      target = new URL(request.url).pathname;
    } catch {
      // a relative / malformed URL → keep the raw value
    }
    attributes['http.url'] = target;
  }
  return attributes;
}

/** Wrap an edge `fetch` handler with Bugsee per-request context + error capture + a `waitUntil` flush. */
export function withBugseeFetch<Args extends unknown[]>(
  client: Bugsee,
  handler: EdgeFetchHandler<Args>,
): (request: Request, ...args: Args) => Promise<Response> {
  // Cloudflare's ExecutionContext is the 3rd handler arg (args[1]); on Vercel Edge there is none → the resolver
  // reads the global request-context symbol instead.
  return (request: Request, ...args: Args): Promise<Response> =>
    runInEdgeContext(
      client,
      { attributes: requestAttributes(request), ctx: args[1] as EdgeExecutionContext | undefined },
      () => handler(request, ...args),
    );
}
