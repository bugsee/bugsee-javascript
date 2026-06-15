import { parseTraceparent } from '@bugsee/capture';
import { getCarrierClient, type RequestContext } from '@bugsee/core';
import { type Bugsee, type RequestContextStore, RequestContextStoreToken } from '@bugsee/node';
import type { PerformanceApi, Transaction } from '@bugsee/performance';

// The Koa adapter (design: docs/design/framework-adapters.md). Koa is a PEER (structural types only). A
// single middleware over the per-request context foundation: Koa's compose propagates a downstream throw
// up through `await next()` (verified), so the middleware catches it, REPORTS it, then RE-THROWS untouched
// — Koa's own onerror still formats the response. It also opens the per-request context (store.run wraps
// next), starts an http.server APM transaction + continues an inbound W3C traceparent, and finishes the
// transaction (route name + status). Fully defensive: it never throws anything other than the original
// downstream error, and never alters Koa's response.

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

const resolveStore = (client: Bugsee): RequestContextStore | undefined =>
  client.getServiceProvider(RequestContextStoreToken).getImmediate({ optional: true }) ?? undefined;

const tryGetPerf = (client: Bugsee): PerformanceApi | undefined => {
  try {
    return client.ext('performance');
  } catch {
    return undefined;
  }
};

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

/**
 * Build the Bugsee Koa middleware. Pass the result to `app.use(...)` (done for you by setupKoa). Install it
 * FIRST so it wraps the whole chain. A transparent pass-through when no client is launched.
 */
export function bugseeKoa(options: KoaAdapterOptions = {}): KoaMiddleware {
  const getClient = options.getClient ?? defaultGetClient;
  const newContextId = options.newContextId ?? newRandomId;
  const shouldReport = options.shouldReport ?? defaultShouldReport;

  return async (ctx, next) => {
    const client = getClient();
    if (client === undefined) {
      await next();
      return;
    }
    const store = resolveStore(client);
    let context: RequestContext | undefined;
    if (store !== undefined) {
      const user = options.user?.(ctx);
      context = {
        contextId: newContextId(),
        attributes: { 'http.method': ctx.method, 'http.url': ctx.url },
        ...(user !== undefined ? { user } : {}),
      };
    }

    const body = async (): Promise<void> => {
      let transaction: Transaction | undefined;
      try {
        transaction = startTransaction(client, ctx, store);
      } catch {
        transaction = undefined;
      }
      let errorStatus: number | undefined;
      try {
        await next();
      } catch (err) {
        try {
          if (shouldReport(err)) {
            resolveStore(client)?.setAttribute('http.route', matchedRoute(ctx));
            void client.logException(err, { mechanism: 'http-error' });
          }
        } catch {
          // reporting must never replace Koa's own error handling
        }
        errorStatus = httpErrorStatus(err) ?? 500; // ctx.status is unreliable in the catch
        throw err; // re-throw untouched → Koa's onerror formats the response
      } finally {
        finishTransaction(transaction, ctx, errorStatus);
      }
    };

    if (store !== undefined && context !== undefined) {
      await store.run(context, body);
    } else {
      await body();
    }
  };
}

function startTransaction(
  client: Bugsee,
  ctx: KoaContextLike,
  store: RequestContextStore | undefined,
): Transaction | undefined {
  const perf = tryGetPerf(client);
  if (perf === undefined) {
    return undefined;
  }
  const inbound = parseTraceparent(headerValue(ctx.headers, 'traceparent'));
  const transaction = perf.startTransaction({
    name: requestName(ctx),
    operation: 'http.server',
    ...(inbound !== undefined ? { continuation: { traceId: inbound.traceId } } : {}),
  });
  store?.setTrace({ traceId: transaction.getTraceId(), spanId: transaction.getSpanId() });
  return transaction;
}

function finishTransaction(
  transaction: Transaction | undefined,
  ctx: KoaContextLike,
  errorStatus: number | undefined,
): void {
  try {
    if (transaction === undefined || transaction.isFinished()) {
      return;
    }
    // On success use ctx.status (final); on error use the error's status (ctx.status is unreliable here).
    const status = errorStatus ?? ctx.status;
    transaction.setName(requestName(ctx)); // route now parametrized
    transaction.setAttribute('http.method', ctx.method);
    transaction.setAttribute('http.status_code', status);
    transaction.finish(status >= 500 ? 'ERROR' : 'OK');
  } catch {
    // finishing APM must never break the response lifecycle
  }
}
