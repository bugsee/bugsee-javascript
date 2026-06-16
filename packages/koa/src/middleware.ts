import { getCarrierClient } from '@bugsee/core';
import { type Bugsee, runServerRequest, type ServerInstrumentOptions } from '@bugsee/node';

// The Koa adapter (design: docs/design/framework-adapters.md + incoming-server-instrumentation.md §5.4).
// Koa is a PEER (structural types only). A single middleware over the shared server-instrumentation core:
// Koa's compose propagates a downstream throw up through `await next()`, so the middleware catches it,
// REPORTS it (per Koa's status-based policy), then RE-THROWS untouched — Koa's onerror still formats the
// response. It opens the per-request context + http.server transaction via `runServerRequest` (run-scoped)
// — or REFINES the node:http-layer owner's span when that auto-instrument also runs (first-owner-wins
// re-entrancy) — and finishes from the error's status (catch) or ctx.status (success). Fully defensive: it
// never throws anything other than the original downstream error, and never alters Koa's response.

/** Minimal structural Koa context. */
export interface KoaContextLike {
  method: string;
  path: string;
  url: string;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** The matched route pattern (`/users/:id`) when @koa/router is used; undefined otherwise. */
  _matchedRoute?: string;
}
export type KoaNext = () => Promise<void>;
export type KoaMiddleware = (ctx: KoaContextLike, next: KoaNext) => Promise<void>;

export interface KoaAdapterOptions {
  /** Extract the end-user identity for reports. Privacy-safe default: OFF. */
  user?: (ctx: KoaContextLike) => string | undefined;
  /** Resolve the active client; default the process-singleton carrier client. Injectable for tests. */
  getClient?: () => Bugsee | undefined;
  /** Mint a context id; default `crypto.randomUUID`. Injectable for tests. */
  newContextId?: () => string;
  /** Override the report decision. Default: report errors with no status / a 5xx status, skip 4xx. */
  shouldReport?: (err: unknown) => boolean;
}

const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

const headerValue = (
  headers: KoaContextLike['headers'],
  lowercaseName: string,
): string | undefined => {
  const value = headers[lowercaseName];
  return Array.isArray(value) ? value[0] : value;
};

const matchedRoute = (ctx: KoaContextLike): string => ctx._matchedRoute || ctx.path;

export const requestName = (ctx: KoaContextLike): string => `${ctx.method} ${matchedRoute(ctx)}`;

/** The HTTP status carried by a Koa/http-errors error (`status` or `statusCode`), or undefined. */
export const httpErrorStatus = (err: unknown): number | undefined => {
  const e = err as { status?: unknown; statusCode?: unknown } | null | undefined;
  if (typeof e?.status === 'number') {
    return e.status;
  }
  if (typeof e?.statusCode === 'number') {
    return e.statusCode;
  }
  return undefined;
};

/** Default report policy: report a genuine error (no status, i.e. a plain throw) or a 5xx; skip 4xx. */
export const defaultShouldReport = (err: unknown): boolean => {
  const status = httpErrorStatus(err);
  return status === undefined || status >= 500;
};

const newRandomId = (): string => crypto.randomUUID();

const toOptions = (options: KoaAdapterOptions): ServerInstrumentOptions => ({
  ...(options.getClient !== undefined
    ? { getClient: options.getClient }
    : { getClient: defaultGetClient }),
  ...(options.newContextId !== undefined
    ? { newContextId: options.newContextId }
    : { newContextId: newRandomId }),
  shouldReport: options.shouldReport ?? defaultShouldReport,
});

/**
 * Build the Bugsee Koa middleware. Pass the result to `app.use(...)` (done for you by setupKoa). Install it
 * FIRST so it wraps the whole chain. A transparent pass-through when no client is launched.
 */
export function bugseeKoa(options: KoaAdapterOptions = {}): KoaMiddleware {
  const opts = toOptions(options);
  return async (ctx, next) => {
    const traceparent = headerValue(ctx.headers, 'traceparent');
    const user = options.user?.(ctx);
    const info = {
      method: ctx.method,
      url: ctx.url,
      route: matchedRoute(ctx), // _matchedRoute || path — refined again at finish once routing has run
      ...(traceparent !== undefined ? { traceparent } : {}),
      ...(user !== undefined ? { user } : {}),
    };
    await runServerRequest(info, opts, async (span) => {
      let errorStatus: number | undefined;
      try {
        await next();
      } catch (err) {
        span.setRoute(matchedRoute(ctx)); // route is parametrized once routing has run
        span.captureError(err); // reports per Koa's shouldReport; sets http.route
        errorStatus = httpErrorStatus(err) ?? 500; // ctx.status is unreliable in the catch
        throw err; // re-throw untouched → Koa's onerror formats the response
      } finally {
        span.setRoute(matchedRoute(ctx)); // refine the txn name (idempotent; covers the success path)
        // On success use ctx.status (final); on error use the error's status (ctx.status is unreliable here).
        span.finish(errorStatus ?? ctx.status);
      }
    });
  };
}
