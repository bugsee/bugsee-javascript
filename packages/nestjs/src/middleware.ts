import { randomUUID } from 'node:crypto';
import type { RequestContext } from '@bugsee/core';
import type { Bugsee, RequestContextStore } from '@bugsee/node';
import {
  buildContext,
  defaultGetClient,
  type NestAdapterOptions,
  type NestHttpRequest,
  type NestHttpResponse,
  resolveStore,
} from './shared';

// The context-opening seam for @bugsee/nestjs: a functional middleware (`app.use(...)`) that opens a
// per-request RequestContext for the request's async chain. It is registered FIRST (the middleware phase
// runs before guards/interceptors), so even guard- and pipe-phase capture auto-attributes to the request.
// It uses `enterWith` (not `run`): the context is bound to the request's ambient async context so the whole
// downstream pipeline stays correlated on BOTH the express- and fastify-based Nest platforms (see the
// enterWith block below). Fully defensive — it never throws into the request and always calls next(). APM +
// error reporting live in the interceptor/filter, not here.

export type NestNextFunction = (err?: unknown) => void;
export type NestRequestMiddleware = (
  req: NestHttpRequest,
  res: NestHttpResponse,
  next: NestNextFunction,
) => void;

/**
 * Build the Bugsee per-request context middleware. Pass the result to `app.use(...)` (done for you by
 * {@link setupNest}). A no-op pass-through when no client is launched or no context store is registered.
 */
export function createBugseeMiddleware(options: NestAdapterOptions = {}): NestRequestMiddleware {
  const getClient = options.getClient ?? defaultGetClient;
  const newContextId = options.newContextId ?? randomUUID;

  return (req, _res, next) => {
    let client: Bugsee | undefined;
    let store: RequestContextStore | undefined;
    let context: RequestContext | undefined;
    try {
      client = getClient();
      store = client !== undefined ? resolveStore(client) : undefined;
      if (client !== undefined && store !== undefined) {
        context = buildContext(req, newContextId, options.user?.(req));
      }
    } catch {
      context = undefined; // adapter setup failed → pass through, never break the request
    }

    // Pass-through (no client / no store / setup failed). OUTSIDE the try so a downstream synchronous
    // throw propagates and next() is called exactly once.
    if (client === undefined || store === undefined || context === undefined) {
      next();
      return;
    }

    // enterWith (NOT run) — open the context on the request's async chain, then continue. This is the
    // uniformly-safe choice across BOTH the express- and fastify-based Nest platforms: on Fastify the
    // middleware runs via @fastify/middie and a `run()`-wrapped next() CAN lose the ALS context across the
    // body-parse async boundary on some Node/Fastify versions (nodejs/node#41285, fastify#3570,
    // nestjs#8837); enterWith binds the context to the ambient async context so the whole pipeline
    // (guards/interceptor/handler/body parsing) stays correlated regardless. Each request is its own async
    // context, so it stays isolated — the same approach the @bugsee/fastify hook adapter uses.
    store.enterWith(context);
    next();
  };
}
