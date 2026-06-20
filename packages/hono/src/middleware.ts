import { getCarrierClient } from '@bugsee/core';
import { type Bugsee, runServerRequest, type ServerInstrumentOptions } from '@bugsee/node';
import { randomId } from '@bugsee/util';

// The Hono adapter (design: docs/design/framework-adapters.md + incoming-server-instrumentation.md §5.4).
// Hono is a PEER (structural types only). A single middleware over the shared server-instrumentation core:
//   - opens a per-request context + http.server transaction via `runServerRequest` (run-scoped) — or
//     REFINES the node:http-layer owner's span when that auto-instrument also runs (first-owner-wins
//     re-entrancy),
//   - after next() resolves, REPORTS a handled error via `c.error` — Hono's compose catches a thrown
//     handler error and routes it to `app.onError`, so the error is observed via `c.error` (not a try/catch
//     around next()). NOTE: Hono only routes `instanceof Error` throws to `c.error`; a non-Error throw is
//     invisible here (Hono drops it the same way) — we stay transparent rather than wrap next().
//   - finishes the transaction (route-parametrized name + status; `c.res.status` is final by here).
// Fully defensive: never throws into the request; works across node/bun/deno wherever the launched client
// provides the context store.

/** Minimal structural Hono request. */
export interface HonoRequestLike {
  method: string;
  path: string;
  /** The matched route pattern (`/users/:id`). */
  routePath: string;
  header(name: string): string | undefined;
}
/** Minimal structural Hono context. */
export interface HonoContextLike {
  req: HonoRequestLike;
  /** The response (set once the handler/onError runs); `status` is final at the middleware's `finally`. */
  res?: { status: number };
  /** A handled error, set by Hono's compose when a downstream handler throws. */
  error?: unknown;
}
export type HonoNext = () => Promise<void>;
export type HonoMiddleware = (c: HonoContextLike, next: HonoNext) => Promise<void>;

export interface HonoAdapterOptions {
  /** Extract the end-user identity for reports. Privacy-safe default: OFF. */
  user?: (c: HonoContextLike) => string | undefined;
  /** Resolve the active client; default the process-singleton carrier client. Injectable for tests. */
  getClient?: () => Bugsee | undefined;
  /** Mint a context id; default a portable random id. Injectable for tests. */
  newContextId?: () => string;
  /** Decide whether a thrown error is reported. Default: skip Hono HTTPExceptions, report genuine errors. */
  shouldReport?: (err: unknown) => boolean;
}

const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

export const requestName = (c: HonoContextLike): string =>
  `${c.req.method} ${c.req.routePath || c.req.path}`;

/**
 * Default report policy: a Hono `HTTPException` (duck-typed by its `getResponse()` method) is deliberate
 * control flow, so it is NOT reported; everything else (uncaught plain Errors, etc.) IS reported.
 */
export const defaultShouldReport = (err: unknown): boolean =>
  typeof (err as { getResponse?: unknown } | null | undefined)?.getResponse !== 'function';

// Portable id (global crypto is undefined on Node 18; node:crypto is absent on edge) — see @bugsee/util.
const newRandomId = (): string => randomId();

const routeOf = (c: HonoContextLike): string => c.req.routePath || c.req.path;

const toOptions = (options: HonoAdapterOptions): ServerInstrumentOptions => ({
  ...(options.getClient !== undefined
    ? { getClient: options.getClient }
    : { getClient: defaultGetClient }),
  ...(options.newContextId !== undefined
    ? { newContextId: options.newContextId }
    : { newContextId: newRandomId }),
  shouldReport: options.shouldReport ?? defaultShouldReport,
});

/**
 * Build the Bugsee Hono middleware. Pass the result to `app.use(...)` (done for you by setupHono). A
 * transparent pass-through when no client is launched.
 */
export function bugseeHono(options: HonoAdapterOptions = {}): HonoMiddleware {
  const opts = toOptions(options);
  return async (c, next) => {
    const traceparent = c.req.header('traceparent');
    const user = options.user?.(c);
    const info = {
      method: c.req.method,
      url: c.req.path, // Hono uses the path (no query) as http.url
      route: routeOf(c),
      ...(traceparent !== undefined ? { traceparent } : {}),
      ...(user !== undefined ? { user } : {}),
    };
    await runServerRequest(info, opts, async (span) => {
      try {
        await next();
      } finally {
        span.setRoute(routeOf(c)); // route is parametrized by here; refines the txn name
        const err = c.error;
        if (err !== undefined && err !== null) {
          span.captureError(err); // reports per Hono's shouldReport (skips HTTPException); sets http.route
        }
        span.finish(c.res?.status ?? 0);
      }
    });
  };
}
