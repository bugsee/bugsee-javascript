import { getCarrierClient } from '@bugsee/core';
import {
  type Bugsee,
  type RequestContextStore,
  RequestContextStoreToken,
  runServerRequest,
  type ServerInstrumentOptions,
} from '@bugsee/node';

// The Express adapter (design: docs/design/framework-adapters.md S6 + incoming-server-instrumentation.md
// §5.4). Two opt-in middlewares over the shared server-instrumentation core (@bugsee/node):
//   requestHandler() — opens a per-request context + http.server transaction via `runServerRequest`
//     (run-scoped), continues an inbound W3C trace, refines the route once routing has run, and finishes
//     on response. When the node:http auto-instrument also owns the request, this REFINES that span
//     instead of opening a second context/transaction (first-owner-wins re-entrancy — the core handles it).
//   errorHandler() — reports an unhandled route error against the in-flight span, then forwards via
//     next(err). Express reports EVERY unhandled route error (its policy is "always report").
// Fully defensive: never throws into the route pipeline, always calls next/next(err); the client is the
// process-singleton carrier client (a no-op when none is launched).

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
  /** Mint a context id; default a portable random id. Injectable for tests. */
  newContextId?: () => string;
}

const headerValue = (
  headers: ExpressRequest['headers'],
  lowercaseName: string,
): string | undefined => {
  const value = headers[lowercaseName];
  return Array.isArray(value) ? value[0] : value;
};

const routeOf = (req: ExpressRequest): string | undefined => req.route?.path;
const urlOf = (req: ExpressRequest): string => req.originalUrl ?? req.url ?? '';

const resolveStore = (client: Bugsee): RequestContextStore | undefined =>
  client.getServiceProvider(RequestContextStoreToken).getImmediate({ optional: true }) ?? undefined;

// Express options → the core's instrument options (getClient/newContextId; express carries `user` per
// request on the ServerRequestInfo instead). Only set keys that are provided (exactOptionalPropertyTypes).
const toOptions = (options: ExpressAdapterOptions): ServerInstrumentOptions => ({
  ...(options.getClient !== undefined
    ? { getClient: options.getClient }
    : { getClient: defaultGetClient }),
  ...(options.newContextId !== undefined ? { newContextId: options.newContextId } : {}),
});

const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

/**
 * Express middleware that opens a per-request Bugsee context (+ an `http.server` APM transaction when the
 * performance extension is wired) for the duration of the request.
 */
export function requestHandler(options: ExpressAdapterOptions = {}): RequestMiddleware {
  const opts = toOptions(options);
  return (req, res, next) => {
    const route = routeOf(req);
    const traceparent = headerValue(req.headers, 'traceparent');
    const user = options.user?.(req);
    const info = {
      method: req.method ?? 'GET',
      url: urlOf(req),
      ...(route !== undefined ? { route } : {}),
      ...(traceparent !== undefined ? { traceparent } : {}),
      ...(user !== undefined ? { user } : {}),
    };
    runServerRequest(info, opts, (span) => {
      const finalize = (): void => {
        const finalRoute = routeOf(req); // the parametrized route is known once routing has run
        if (finalRoute !== undefined) {
          span.setRoute(finalRoute);
        }
        span.finish(res.statusCode ?? 0);
      };
      res.once('finish', finalize);
      res.once('close', finalize);
      next();
    });
  };
}

/**
 * Express error middleware: report an unhandled route error against the in-flight span (enriched with the
 * matched route), then forward it via next(err). The 4-arg signature is what express uses to recognize an
 * error handler.
 */
export function errorHandler(options: ExpressAdapterOptions = {}): ErrorMiddleware {
  const getClient = options.getClient ?? defaultGetClient;
  return (err, req, _res, next) => {
    try {
      const client = getClient();
      if (client !== undefined) {
        const store = resolveStore(client);
        // Enrich the active context (the in-flight request's — the http-layer owner's under re-entrancy)
        // with the matched route, then report. Express reports EVERY unhandled route error.
        const route = routeOf(req);
        if (store !== undefined && route !== undefined) {
          store.setAttribute('http.route', route);
        }
        void client.logException(err, { mechanism: 'http-error' });
      }
    } catch {
      // the adapter must never replace the app's own error handling
    }
    next(err);
  };
}
