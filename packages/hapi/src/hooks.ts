import { getCarrierClient } from '@bugsee/core';
import {
  type Bugsee,
  openServerRequest,
  type RequestContextStore,
  RequestContextStoreToken,
  type ServerInstrumentOptions,
  type ServerRequestSpan,
} from '@bugsee/node';

// The Hapi adapter (design: docs/design/framework-adapters.md + incoming-server-instrumentation.md §5.4).
// Hapi is a PEER (structural types only). setupHapi registers two request-lifecycle extensions over the
// shared server-instrumentation core (@bugsee/node):
//   onRequest      — opens the per-request context + http.server transaction via `openServerRequest`
//                    (enterWith, since the extension returns before the route handler) — or REFINES the
//                    node:http-layer owner's span when that auto-instrument also runs (first-owner-wins
//                    re-entrancy). The span is held per-request on a WeakMap; a client disconnect cancels it.
//   onPreResponse  — runs for BOTH success and error; if the response is a Boom error, reports it
//                    (logException directly — Hapi reports server (5xx, isServer) Boom, skips client (4xx);
//                    direct reporting captures the active owner context under re-entrancy and supports the
//                    standalone extension the tests pin). Then finishes the transaction (route name + status).
// Hapi extensions are additive. Fully defensive: a failure never breaks the request; h.continue is returned.

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

const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

const methodOf = (request: HapiRequestLike): string => request.method.toUpperCase();
const nameRoute = (request: HapiRequestLike): string => request.route?.path || request.path;

export const requestName = (request: HapiRequestLike): string =>
  `${methodOf(request)} ${nameRoute(request)}`;

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

const toOptions = (options: HapiAdapterOptions): ServerInstrumentOptions => ({
  ...(options.getClient !== undefined
    ? { getClient: options.getClient }
    : { getClient: defaultGetClient }),
  ...(options.newContextId !== undefined
    ? { newContextId: options.newContextId }
    : { newContextId: newRandomId }),
});

/** Register the Bugsee Hapi lifecycle extensions. Call once on the server before start. */
export function setupHapi(server: HapiServerLike, options: HapiAdapterOptions = {}): void {
  const opts = toOptions(options);
  const getClient = options.getClient ?? defaultGetClient;
  const shouldReport = options.shouldReport ?? defaultShouldReport;
  // Per-request span, keyed by the request object (GC'd with it; no request mutation).
  const spans = new WeakMap<object, ServerRequestSpan>();

  server.ext('onRequest', (request, h) => {
    try {
      const user = options.user?.(request);
      const route = request.route?.path; // usually undefined at onRequest (pre-routing); refined later
      const traceparent = request.headers.traceparent;
      const info = {
        method: methodOf(request),
        url: request.path,
        ...(route !== undefined ? { route } : {}),
        ...(traceparent !== undefined ? { traceparent } : {}),
        ...(user !== undefined ? { user } : {}),
      };
      const span = openServerRequest(info, opts); // enterWith + own/refine + txn
      spans.set(request, span);
      // A client disconnect skips onPreResponse — cancel the transaction (still delivered) rather than leak.
      request.events?.once('disconnect', () => {
        try {
          const s = spans.get(request);
          if (s !== undefined) {
            spans.delete(request);
            s.cancel();
          }
        } catch {
          // never break the abort lifecycle
        }
      });
    } catch {
      // never break the request
    }
    return h.continue;
  });

  server.ext('onPreResponse', (request, h) => {
    try {
      const client = getClient();
      const response = request.response;
      if (
        client !== undefined &&
        (response as HapiBoomLike | null | undefined)?.isBoom === true &&
        shouldReport(response)
      ) {
        // Report the Boom directly against the active context (the owner's under re-entrancy).
        resolveStore(client)?.setAttribute('http.route', request.route?.path ?? request.path);
        void client.logException(response, { mechanism: 'http-error' });
      }
      const span = spans.get(request);
      if (span !== undefined) {
        spans.delete(request);
        span.setRoute(nameRoute(request)); // route now parametrized; refines the txn name
        span.finish(responseStatus(response));
      }
    } catch {
      // never break Hapi's response lifecycle
    }
    return h.continue;
  });
}
