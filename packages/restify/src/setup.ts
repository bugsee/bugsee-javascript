import { parseTraceparent } from '@bugsee/capture';
import { getCarrierClient, type RequestContext } from '@bugsee/core';
import { type Bugsee, type RequestContextStore, RequestContextStoreToken } from '@bugsee/node';
import type { PerformanceApi, Transaction } from '@bugsee/performance';

// The Restify adapter (design: docs/design/framework-adapters.md). Restify is a PEER (structural types
// only). setupRestify wires a `use` middleware + the server `after` event over the per-request context
// foundation:
//   use         — opens the per-request context (store.enterWith, since restify middleware is callback-
//                 style and returns before the route handler runs) + starts an http.server APM transaction
//                 + continues an inbound W3C traceparent. The context + transaction are kept per-request on
//                 a WeakMap, then next() proceeds.
//   after event — fires once per request for BOTH success and error (with the err, the matched route, and
//                 the final res.statusCode). Reports a genuine error (mechanism http-error) and finishes
//                 the transaction. The report is made by RE-ENTERING the saved context (store.run) so it
//                 carries the right contextId even if the `after` event runs outside the request's async
//                 chain. Fully defensive: a failure in either hook never breaks the request.
//
// NOTE: restify 11.x does not import on Node >= 18 (its transitive spdy/http-deceiver uses the removed
// `process.binding('http_parser')`), so there is no real-restify e2e here — the adapter is structural and
// validated by unit tests; it runs wherever restify itself runs. See the README.

/** Minimal structural Restify request. */
export interface RestifyRequestLike {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** The matched route, available once routing has run (`req.route.path` / `.spec.path`). */
  route?: { path?: string | RegExp; spec?: { path?: string | RegExp } };
}
/** Minimal structural Restify response. */
export interface RestifyResponseLike {
  statusCode?: number;
}
/** The matched-route object passed to the `after` event. */
export interface RestifyRouteLike {
  path?: string | RegExp;
  spec?: { path?: string | RegExp };
}
export type RestifyNext = (err?: unknown) => void;
export type RestifyMiddleware = (
  req: RestifyRequestLike,
  res: RestifyResponseLike,
  next: RestifyNext,
) => void;
export type RestifyAfterHandler = (
  req: RestifyRequestLike,
  res: RestifyResponseLike,
  route: RestifyRouteLike | undefined,
  err: unknown,
) => void;
/** The minimal Restify server surface setupRestify needs. */
export interface RestifyServerLike {
  use(handler: RestifyMiddleware): unknown;
  on(event: 'after', handler: RestifyAfterHandler): unknown;
}

export interface RestifyAdapterOptions {
  /** Extract the end-user identity for reports. Privacy-safe default: OFF. */
  user?: (req: RestifyRequestLike) => string | undefined;
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
  headers: RestifyRequestLike['headers'],
  lowercaseName: string,
): string | undefined => {
  const value = headers[lowercaseName];
  return Array.isArray(value) ? value[0] : value;
};

const requestPath = (req: RestifyRequestLike): string => {
  const url = req.url;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
};

const routePattern = (req: RestifyRequestLike, route?: RestifyRouteLike): string | undefined => {
  // restify route paths can be a RegExp (regex-mounted routes) — coerce to a string for the wire.
  const path = route?.spec?.path ?? route?.path ?? req.route?.spec?.path ?? req.route?.path;
  if (path === undefined) {
    return undefined;
  }
  return typeof path === 'string' ? path : String(path);
};

export const requestName = (req: RestifyRequestLike, route?: RestifyRouteLike): string =>
  `${req.method} ${routePattern(req, route) ?? requestPath(req)}`;

/** The HTTP status carried by a restify-errors error (`statusCode` or `status`), or undefined. */
export const httpErrorStatus = (err: unknown): number | undefined => {
  const e = err as { statusCode?: unknown; status?: unknown } | null | undefined;
  if (typeof e?.statusCode === 'number') {
    return e.statusCode;
  }
  if (typeof e?.status === 'number') {
    return e.status;
  }
  return undefined;
};

/** Default report policy: report a genuine error (no status) or a 5xx; skip 4xx. */
export const defaultShouldReport = (err: unknown): boolean => {
  const status = httpErrorStatus(err);
  return status === undefined || status >= 500;
};

const newRandomId = (): string => crypto.randomUUID();

interface RequestState {
  context: RequestContext | undefined;
  transaction: Transaction | undefined;
}

/** Register the Bugsee restify middleware + after-hook. Call once on the server. */
export function setupRestify(server: RestifyServerLike, options: RestifyAdapterOptions = {}): void {
  const getClient = options.getClient ?? defaultGetClient;
  const newContextId = options.newContextId ?? newRandomId;
  const shouldReport = options.shouldReport ?? defaultShouldReport;
  const states = new WeakMap<object, RequestState>();

  server.use((req, _res, next) => {
    try {
      const client = getClient();
      if (client !== undefined) {
        const store = resolveStore(client);
        let context: RequestContext | undefined;
        if (store !== undefined) {
          const user = options.user?.(req);
          context = {
            contextId: newContextId(),
            attributes: { 'http.method': req.method, 'http.url': requestPath(req) },
            ...(user !== undefined ? { user } : {}),
          };
          store.enterWith(context);
        }
        states.set(req, { context, transaction: startTransaction(client, req, store) });
      }
    } catch {
      // never break the request
    }
    next();
  });

  server.on('after', (req, res, route, err) => {
    try {
      const state = states.get(req);
      states.delete(req);
      const client = getClient();
      if (client !== undefined && err !== undefined && err !== null && shouldReport(err)) {
        report(client, err, req, route, state?.context);
      }
      finishTransaction(state?.transaction, req, res, route);
    } catch {
      // never break the response lifecycle
    }
  });
}

function startTransaction(
  client: Bugsee,
  req: RestifyRequestLike,
  store: RequestContextStore | undefined,
): Transaction | undefined {
  const perf = tryGetPerf(client);
  if (perf === undefined) {
    return undefined;
  }
  const inbound = parseTraceparent(headerValue(req.headers, 'traceparent'));
  const transaction = perf.startTransaction({
    name: requestName(req),
    operation: 'http.server',
    ...(inbound !== undefined ? { continuation: { traceId: inbound.traceId } } : {}),
  });
  store?.setTrace({ traceId: transaction.getTraceId(), spanId: transaction.getSpanId() });
  return transaction;
}

function report(
  client: Bugsee,
  err: unknown,
  req: RestifyRequestLike,
  route: RestifyRouteLike | undefined,
  context: RequestContext | undefined,
): void {
  const store = resolveStore(client);
  const emit = (): void => {
    store?.setAttribute('http.route', routePattern(req, route) ?? requestPath(req));
    void client.logException(err, { mechanism: 'http-error' });
  };
  // Re-enter the saved context so the report carries the right contextId even if the `after` event runs
  // outside the request's async chain.
  if (store !== undefined && context !== undefined) {
    store.run(context, emit);
  } else {
    emit();
  }
}

function finishTransaction(
  transaction: Transaction | undefined,
  req: RestifyRequestLike,
  res: RestifyResponseLike,
  route: RestifyRouteLike | undefined,
): void {
  if (transaction === undefined || transaction.isFinished()) {
    return;
  }
  const status = res.statusCode ?? 0; // final at the `after` event (response already sent)
  transaction.setName(requestName(req, route));
  transaction.setAttribute('http.method', req.method);
  transaction.setAttribute('http.status_code', status);
  transaction.finish(status >= 500 ? 'ERROR' : 'OK');
}
