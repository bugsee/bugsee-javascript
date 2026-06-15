import { parseTraceparent } from '@bugsee/capture';
import { getCarrierClient, type RequestContext } from '@bugsee/core';
import { type Bugsee, type RequestContextStore, RequestContextStoreToken } from '@bugsee/node';
import type { PerformanceApi, Transaction } from '@bugsee/performance';

// The Hono adapter (design: docs/design/framework-adapters.md). Hono is a PEER (structural types only —
// nothing here imports `hono`). A single middleware over the per-request context foundation:
//   - opens a per-request context (store.run wraps next, so the whole chain is correlated),
//   - starts an `http.server` APM transaction + continues an inbound W3C traceparent (when performance is
//     wired),
//   - after next() resolves, REPORTS a handled error via `c.error` — Hono's compose catches a thrown
//     handler error and routes it to `app.onError` BEFORE it would propagate to the middleware, so the
//     error is observed via `c.error` (not a try/catch around next()); the user's `onError` is untouched.
//     NOTE: Hono's compose only routes `instanceof Error` throws to `c.error`/onError; a thrown non-Error
//     (e.g. `throw 'str'`) is invisible here (Hono itself drops it the same way). We stay transparent
//     rather than wrap next() to catch it (which would risk altering app behavior).
//   - finishes the transaction (route-parametrized name + status; `c.res.status` is final by here).
// Fully defensive: it never throws into the request, and works across node/bun/deno (wherever the launched
// @bugsee/node client provides the context store). Multi-runtime Hono on the edge follows the edge platform.

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
  /** Mint a context id; default `crypto.randomUUID`. Injectable for tests. */
  newContextId?: () => string;
  /** Decide whether a thrown error is reported. Default: skip Hono HTTPExceptions, report genuine errors. */
  shouldReport?: (err: unknown) => boolean;
}

const resolveStore = (client: Bugsee): RequestContextStore | undefined =>
  client.getServiceProvider(RequestContextStoreToken).getImmediate({ optional: true }) ?? undefined;

const tryGetPerf = (client: Bugsee): PerformanceApi | undefined => {
  try {
    return client.ext('performance');
  } catch {
    return undefined; // the performance extension is optional
  }
};

const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

export const requestName = (c: HonoContextLike): string =>
  `${c.req.method} ${c.req.routePath || c.req.path}`;

/**
 * Default report policy: a Hono `HTTPException` (duck-typed by its `getResponse()` method) is deliberate
 * control flow, so it is NOT reported; everything else (uncaught plain Errors, etc.) IS reported.
 */
export const defaultShouldReport = (err: unknown): boolean =>
  typeof (err as { getResponse?: unknown } | null | undefined)?.getResponse !== 'function';

const newRandomId = (): string => crypto.randomUUID();

/**
 * Build the Bugsee Hono middleware. Pass the result to `app.use(...)` (done for you by setupHono). A
 * transparent pass-through when no client is launched.
 */
export function bugseeHono(options: HonoAdapterOptions = {}): HonoMiddleware {
  const getClient = options.getClient ?? defaultGetClient;
  const newContextId = options.newContextId ?? newRandomId;
  const shouldReport = options.shouldReport ?? defaultShouldReport;

  return async (c, next) => {
    const client = getClient();
    if (client === undefined) {
      await next();
      return;
    }
    const store = resolveStore(client);
    let context: RequestContext | undefined;
    if (store !== undefined) {
      const user = options.user?.(c); // resolve once (the getter may have side effects / cost)
      context = {
        contextId: newContextId(),
        attributes: { 'http.method': c.req.method, 'http.url': c.req.path },
        ...(user !== undefined ? { user } : {}),
      };
    }

    const body = async (): Promise<void> => {
      let transaction: Transaction | undefined;
      try {
        transaction = startTransaction(client, c, store);
      } catch {
        transaction = undefined; // APM wiring failure must never break the request
      }
      try {
        await next();
      } finally {
        captureError(client, c, shouldReport);
        finishTransaction(transaction, c);
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
  c: HonoContextLike,
  store: RequestContextStore | undefined,
): Transaction | undefined {
  const perf = tryGetPerf(client);
  if (perf === undefined) {
    return undefined;
  }
  const inbound = parseTraceparent(c.req.header('traceparent'));
  const transaction = perf.startTransaction({
    name: requestName(c),
    operation: 'http.server',
    ...(inbound !== undefined ? { continuation: { traceId: inbound.traceId } } : {}),
  });
  store?.setTrace({ traceId: transaction.getTraceId(), spanId: transaction.getSpanId() });
  return transaction;
}

function captureError(
  client: Bugsee,
  c: HonoContextLike,
  shouldReport: (err: unknown) => boolean,
): void {
  try {
    const err = c.error;
    if (err !== undefined && err !== null && shouldReport(err)) {
      resolveStore(client)?.setAttribute('http.route', c.req.routePath);
      void client.logException(err, { mechanism: 'http-error' });
    }
  } catch {
    // reporting must never break the request
  }
}

function finishTransaction(transaction: Transaction | undefined, c: HonoContextLike): void {
  try {
    if (transaction === undefined || transaction.isFinished()) {
      return;
    }
    const status = c.res?.status ?? 0;
    transaction.setName(requestName(c)); // route now parametrized
    transaction.setAttribute('http.method', c.req.method);
    transaction.setAttribute('http.status_code', status);
    transaction.finish(status >= 500 ? 'ERROR' : 'OK');
  } catch {
    // finishing APM must never break the response lifecycle
  }
}
