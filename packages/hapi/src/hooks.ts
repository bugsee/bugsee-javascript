import { parseTraceparent } from '@bugsee/capture';
import { getCarrierClient, type RequestContext } from '@bugsee/core';
import { type Bugsee, type RequestContextStore, RequestContextStoreToken } from '@bugsee/node';
import type { PerformanceApi, Transaction } from '@bugsee/performance';

// The Hapi adapter (design: docs/design/framework-adapters.md). Hapi is a PEER (structural types only).
// setupHapi registers two request-lifecycle extensions over the per-request context foundation:
//   onRequest      — runs before routing; opens the per-request context (via store.enterWith, since the
//                    extension returns before the route handler) + starts an http.server APM transaction +
//                    continues an inbound W3C traceparent. The transaction is kept per-request on a WeakMap.
//   onPreResponse  — runs for BOTH success and error, after the handler; if the response is a Boom error,
//                    reports it (mechanism http-error) — Hapi marks 5xx as `isServer`, so the default
//                    reports server errors and skips client (4xx) Boom; then finishes the transaction
//                    (route-parametrized name + status). Returns h.continue, so it never alters the response.
// Hapi extensions are additive (registering ours never replaces the app's). Fully defensive: a failure in
// any extension never breaks the request, and h.continue is always returned.

/** Minimal structural Hapi request. Hapi lowercases the method and the header names. */
export interface HapiRequestLike {
  method: string;
  path: string;
  /** The matched route pattern (`/users/{id}`), available once routing has run. */
  route?: { path?: string };
  headers: Record<string, string | undefined>;
  /** The response in flight, or a Boom error (when the handler threw / returned an error). */
  response?: unknown;
  /** Per-request event emitter; `disconnect` fires on a client abort (onPreResponse will NOT fire then). */
  events?: { once(event: string, listener: () => void): unknown };
}
/** Minimal structural Boom error. */
export interface HapiBoomLike {
  isBoom?: boolean;
  /** True for 5xx (server) errors; false for 4xx (client) errors. */
  isServer?: boolean;
  output?: { statusCode?: number };
}
/** Minimal structural Hapi response toolkit (the extension returns `h.continue`). */
export interface HapiToolkitLike {
  continue: unknown;
}
export type HapiExtension = (request: HapiRequestLike, h: HapiToolkitLike) => unknown;
/** The minimal Hapi server surface setupHapi needs. */
export interface HapiServerLike {
  ext(event: 'onRequest' | 'onPreResponse', method: HapiExtension): unknown;
}

export interface HapiAdapterOptions {
  /** Extract the end-user identity for reports. Privacy-safe default: OFF. */
  user?: (request: HapiRequestLike) => string | undefined;
  /** Resolve the active client; default the process-singleton carrier client. Injectable for tests. */
  getClient?: () => Bugsee | undefined;
  /** Mint a context id; default `crypto.randomUUID`. Injectable for tests. */
  newContextId?: () => string;
  /** Override the report decision. Default: report Boom server errors (5xx), skip client (4xx) Boom. */
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

const methodOf = (request: HapiRequestLike): string => request.method.toUpperCase();

export const requestName = (request: HapiRequestLike): string =>
  `${methodOf(request)} ${request.route?.path || request.path}`;

/** The HTTP status of the in-flight response (Boom output status, or the response statusCode, else 0). */
export const responseStatus = (response: unknown): number => {
  const r = response as (HapiBoomLike & { statusCode?: number }) | null | undefined;
  if (r?.isBoom === true) {
    return r.output?.statusCode ?? 500;
  }
  return r?.statusCode ?? 0;
};

/** Default report policy: report a Boom SERVER error (5xx, `isServer`); skip client (4xx) Boom. */
export const defaultShouldReport = (err: unknown): boolean =>
  (err as { isServer?: unknown } | null | undefined)?.isServer === true;

const newRandomId = (): string => crypto.randomUUID();

/** Register the Bugsee Hapi lifecycle extensions. Call once on the server before start. */
export function setupHapi(server: HapiServerLike, options: HapiAdapterOptions = {}): void {
  const getClient = options.getClient ?? defaultGetClient;
  const newContextId = options.newContextId ?? newRandomId;
  const shouldReport = options.shouldReport ?? defaultShouldReport;
  // Per-request transaction, keyed by the request object (GC'd with it; no request mutation).
  const transactions = new WeakMap<object, Transaction>();

  server.ext('onRequest', (request, h) => {
    try {
      const client = getClient();
      if (client !== undefined) {
        const store = resolveStore(client);
        if (store !== undefined) {
          const user = options.user?.(request);
          const context: RequestContext = {
            contextId: newContextId(),
            attributes: { 'http.method': methodOf(request), 'http.url': request.path },
            ...(user !== undefined ? { user } : {}),
          };
          store.enterWith(context);
        }
        const transaction = startTransaction(client, request, store);
        if (transaction !== undefined) {
          transactions.set(request, transaction);
          // A client disconnect skips onPreResponse — finish the transaction as CANCELLED (so it is still
          // delivered) rather than leaking it. Matches the @bugsee/fastify onRequestAbort hook.
          request.events?.once('disconnect', () => {
            try {
              const t = transactions.get(request);
              if (t !== undefined && !t.isFinished()) {
                transactions.delete(request);
                t.finish('CANCELLED');
              }
            } catch {
              // never break the abort lifecycle
            }
          });
        }
      }
    } catch {
      // never break the request
    }
    return h.continue;
  });

  server.ext('onPreResponse', (request, h) => {
    try {
      const client = getClient();
      if (client !== undefined) {
        const response = request.response;
        if (
          (response as HapiBoomLike | null | undefined)?.isBoom === true &&
          shouldReport(response)
        ) {
          resolveStore(client)?.setAttribute('http.route', request.route?.path ?? request.path);
          void client.logException(response, { mechanism: 'http-error' });
        }
      }
      finishTransaction(transactions.get(request), request);
      transactions.delete(request);
    } catch {
      // never break Hapi's response lifecycle
    }
    return h.continue;
  });
}

function startTransaction(
  client: Bugsee,
  request: HapiRequestLike,
  store: RequestContextStore | undefined,
): Transaction | undefined {
  const perf = tryGetPerf(client);
  if (perf === undefined) {
    return undefined;
  }
  const inbound = parseTraceparent(request.headers.traceparent);
  const transaction = perf.startTransaction({
    name: requestName(request),
    operation: 'http.server',
    ...(inbound !== undefined ? { continuation: { traceId: inbound.traceId } } : {}),
  });
  store?.setTrace({ traceId: transaction.getTraceId(), spanId: transaction.getSpanId() });
  return transaction;
}

function finishTransaction(transaction: Transaction | undefined, request: HapiRequestLike): void {
  if (transaction === undefined || transaction.isFinished()) {
    return;
  }
  const status = responseStatus(request.response);
  transaction.setName(requestName(request)); // route now parametrized
  transaction.setAttribute('http.method', methodOf(request));
  transaction.setAttribute('http.status_code', status);
  transaction.finish(status >= 500 ? 'ERROR' : 'OK');
}
