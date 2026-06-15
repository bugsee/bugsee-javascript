import { randomUUID } from 'node:crypto';
import { parseTraceparent } from '@bugsee/capture';
import { getCarrierClient, type RequestContext } from '@bugsee/core';
import { type Bugsee, type RequestContextStore, RequestContextStoreToken } from '@bugsee/node';
import type { PerformanceApi } from '@bugsee/performance';

// The Express adapter (design: docs/design/framework-adapters.md, S6). Two opt-in middlewares over the
// per-request context foundation:
//   requestHandler() — opens a RequestContext for the request's async chain (so logException/capture
//     inside the route auto-attribute to it), continues an inbound W3C trace, and (when the performance
//     extension is wired) starts an `http.server` transaction that finishes on response.
//   errorHandler()  — reports an unhandled route error WITH the request context merged, then re-throws
//     via next(err).
// Fully defensive: the adapter never throws into the route pipeline and always calls next/next(err); the
// client is the process-singleton carrier client (a no-op when none is launched).

/** Minimal structural Express request — express is a PEER, not a dependency. */
export interface ExpressRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  route?: { path?: string };
  headers: Record<string, string | string[] | undefined>;
}
/** Minimal structural Express response. */
export interface ExpressResponse {
  statusCode?: number;
  once(event: string, listener: () => void): unknown;
}
export type NextFunction = (err?: unknown) => void;
export type RequestMiddleware = (
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction,
) => void;
export type ErrorMiddleware = (
  err: unknown,
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction,
) => void;

export interface ExpressAdapterOptions {
  /**
   * Extract the end-user identity for reports produced during this request. Privacy-safe default: OFF —
   * nothing identity-bearing is read unless this getter is provided. Return undefined to skip a request.
   */
  user?: (req: ExpressRequest) => string | undefined;
  /** Resolve the active client; default the process-singleton carrier client. Injectable for tests. */
  getClient?: () => Bugsee | undefined;
  /** Mint a context id; default `crypto.randomUUID`. Injectable for tests. */
  newContextId?: () => string;
}

const headerValue = (
  headers: ExpressRequest['headers'],
  lowercaseName: string,
): string | undefined => {
  const value = headers[lowercaseName];
  return Array.isArray(value) ? value[0] : value;
};

const resolveStore = (client: Bugsee): RequestContextStore | undefined =>
  client.getServiceProvider(RequestContextStoreToken).getImmediate({ optional: true }) ?? undefined;

// The performance extension is optional; ext() throws when it is not registered (bare @bugsee/node).
const tryGetPerf = (client: Bugsee): PerformanceApi | undefined => {
  try {
    return client.ext('performance');
  } catch {
    return undefined;
  }
};

const requestName = (req: ExpressRequest): string => {
  const method = req.method ?? 'GET';
  // The matched route (`/users/:id`) is known only after routing; before that, fall back to the URL.
  const path = req.route?.path ?? req.originalUrl ?? req.url ?? '';
  return `${method} ${path}`;
};

const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

/**
 * Express middleware that opens a per-request Bugsee context (+ an `http.server` APM transaction when the
 * performance extension is wired) for the duration of the request.
 */
export function requestHandler(options: ExpressAdapterOptions = {}): RequestMiddleware {
  const getClient = options.getClient ?? defaultGetClient;
  const newContextId = options.newContextId ?? randomUUID;

  return (req, res, next) => {
    let client: Bugsee | undefined;
    let store: RequestContextStore | undefined;
    let context: RequestContext | undefined;
    try {
      client = getClient();
      store = client !== undefined ? resolveStore(client) : undefined;
      if (client !== undefined && store !== undefined) {
        const method = req.method ?? 'GET';
        const url = req.originalUrl ?? req.url ?? '';
        const user = options.user?.(req);
        context = {
          contextId: newContextId(),
          attributes: { 'http.method': method, 'http.url': url },
          ...(user !== undefined ? { user } : {}),
        };
      }
    } catch {
      context = undefined; // adapter setup failed → pass through below, never break the request
    }

    // Pass-through (no client launched / no store / setup failed). OUTSIDE the try/catch so a downstream
    // synchronous throw propagates to express and next() is called exactly once.
    if (client === undefined || store === undefined || context === undefined) {
      next();
      return;
    }

    const activeClient = client;
    const activeStore = store;
    // Run the rest of the request INSIDE the context. A downstream throw propagates to express (it is NOT
    // caught here — express routes it to the error handler); only the adapter's own wiring is guarded.
    activeStore.run(context, () => {
      try {
        const inbound = parseTraceparent(headerValue(req.headers, 'traceparent'));
        const perf = tryGetPerf(activeClient);
        if (perf !== undefined) {
          const transaction = perf.startTransaction({
            name: requestName(req),
            operation: 'http.server',
            ...(inbound !== undefined ? { continuation: { traceId: inbound.traceId } } : {}),
          });
          // Publish the server transaction's trace onto the context so capture entries are stamped with it.
          activeStore.setTrace({
            traceId: transaction.getTraceId(),
            spanId: transaction.getSpanId(),
          });
          const finalize = (): void => {
            if (transaction.isFinished()) {
              return;
            }
            const status = res.statusCode ?? 0;
            transaction.setName(requestName(req)); // now parametrized (routing done)
            transaction.setAttribute('http.method', req.method ?? 'GET');
            transaction.setAttribute('http.status_code', status);
            transaction.finish(status >= 500 ? 'ERROR' : 'OK');
          };
          res.once('finish', finalize);
          res.once('close', finalize);
        }
      } catch {
        // APM wiring failure must never break the request — degrade to context-only.
      }
      next();
    });
  };
}

/**
 * Express error middleware: report an unhandled route error with the active request context merged, then
 * forward it via next(err). The 4-arg signature is what express uses to recognize an error handler.
 */
export function errorHandler(options: ExpressAdapterOptions = {}): ErrorMiddleware {
  const getClient = options.getClient ?? defaultGetClient;

  return (err, req, _res, next) => {
    try {
      const client = getClient();
      if (client !== undefined) {
        const store = resolveStore(client);
        // Enrich the active context with the matched route (known now that routing has run) before reporting.
        const routePath = req.route?.path;
        if (store !== undefined && routePath !== undefined) {
          store.setAttribute('http.route', routePath);
        }
        // Synchronous submit captures the active context now; the upload is fire-and-forget.
        void client.logException(err, { mechanism: 'http-error' });
      }
    } catch {
      // The adapter must never replace the app's own error handling.
    }
    next(err);
  };
}
