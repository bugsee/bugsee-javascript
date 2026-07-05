// @bugsee/nextjs — `withBugseeMiddleware`: instrument a Next.js `middleware.ts` export.
//
// Next middleware runs on the EDGE runtime and its errors are NOT delivered to `onRequestError` (Next bug
// #83404) — so it needs its own path. `withBugseeMiddleware` wraps the user's middleware to run inside a
// per-invocation edge context (so capture correlates + the report carries the failing route), capture +
// RETHROW a thrown error, and flush the incident upload via the fetch event's `waitUntil`.
//
// EDGE-only (imports the `@bugsee/vercel-edge` family) → behind the `./middleware` subpath, never the
// portable `.` graph. The launched edge client comes from `register()` (edge branch) on the carrier.
import { type BugseeClient, getCarrierClient } from '@bugsee/core';
import {
  type EdgeExecutionContext,
  requestAttributes,
  runInEdgeContext,
} from '@bugsee/vercel-edge';

/** The Next.js `NextFetchEvent` subset we use — its `waitUntil` keeps the isolate alive for the flush. */
export interface NextFetchEventLike extends EdgeExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** The Next.js middleware signature (structural; `NextRequest` extends `Request`, returns a response or
 *  nothing to continue). `Ev` is generic so a middleware pre-typed with the real, WIDER `NextFetchEvent`
 *  (it has `sourcePage`/`passThroughOnException` beyond `waitUntil`) flows through — mirroring `Req`. */
export type NextMiddleware<
  Req extends Request = Request,
  Res = Response | undefined,
  Ev extends NextFetchEventLike = NextFetchEventLike,
> = (request: Req, event: Ev) => Res | Promise<Res>;

export interface WithBugseeMiddlewareOptions {
  /** Resolve the Bugsee client. Default: the per-isolate carrier singleton (launched by `register()`). */
  getClient?: () => BugseeClient | undefined;
}

/**
 * Wrap a Next.js `middleware` export so Bugsee captures + reports its errors (which `onRequestError` does
 * not) and correlates capture to the invocation. Transparent when Bugsee is not launched.
 *
 * ```ts
 * // middleware.ts
 * import { withBugseeMiddleware } from '@bugsee/nextjs/middleware';
 * export const middleware = withBugseeMiddleware((request, event) => { ... });
 * export const config = { matcher: [...] };
 * ```
 */
export function withBugseeMiddleware<Req extends Request, Res, Ev extends NextFetchEventLike>(
  middleware: NextMiddleware<Req, Res, Ev>,
  options: WithBugseeMiddlewareOptions = {},
): NextMiddleware<Req, Res, Ev> {
  const getClient = options.getClient ?? (() => getCarrierClient<BugseeClient>());
  return (request, event) => {
    const client = getClient();
    // Not launched → run the middleware untouched (never add latency / change behavior when Bugsee is off).
    if (client === undefined) return middleware(request, event);
    return runInEdgeContext(client, { attributes: requestAttributes(request), ctx: event }, () =>
      middleware(request, event),
    );
  };
}
