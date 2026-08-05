import { getCarrierClient } from '@bugsee/core';
import {
  type Bugsee,
  neverThrow,
  openServerRequest,
  type RequestContextStore,
  RequestContextStoreToken,
  type ServerInstrumentOptions,
  type ServerRequestSpan,
} from '@bugsee/node';

// The Fastify adapter (design: docs/design/framework-adapters.md + incoming-server-instrumentation.md §5.4).
// Fastify is hook-based, so a single setupFastify(app) call installs lifecycle hooks over the shared
// server-instrumentation core (@bugsee/node):
//   onRequest      — open the request context + http.server transaction via `openServerRequest` (enterWith,
//                    since the hook returns before the route handler) — or REFINE the node:http-layer
//                    owner's span when that auto-instrument also runs (first-owner-wins re-entrancy; the
//                    core handles it). The span is held per-request in a WeakMap.
//   onError        — report an unhandled route error against the request's span (fastify reports EVERY one).
//   onResponse     — finish the transaction (route-parametrized name + status).
//   onRequestAbort — cancel the transaction (a client abort fires this, not onResponse).
// Fully defensive: a hook failure never breaks the request, and done() is always called. The client is the
// process-singleton carrier client (a no-op when none is launched). fastify is a PEER dependency.

/** Minimal structural Fastify request — fastify is a PEER, not a dependency. */
export interface FastifyRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  /** The matched route pattern (`/users/:id`), available once routing has run. */
  routeOptions?: { url?: string };
}
/** Minimal structural Fastify reply. */
export interface FastifyReply {
  statusCode?: number;
}
export type FastifyHookDone = (err?: unknown) => void;
/** The minimal Fastify instance surface setupFastify needs. */
export interface FastifyInstance {
  addHook(name: string, handler: (...args: never[]) => unknown): unknown;
}

export interface FastifyAdapterOptions {
  /**
   * Extract the end-user identity for reports during this request. Privacy-safe default: OFF — nothing
   * identity-bearing is read unless this getter is provided.
   */
  user?: (req: FastifyRequest) => string | undefined;
  /** Resolve the active client; default the process-singleton carrier client. Injectable for tests. */
  getClient?: () => Bugsee | undefined;
  /** Mint a context id; default a portable random id. Injectable for tests. */
  newContextId?: () => string;
  /**
   * Where an SDK-internal failure in the adapter is reported. It is never thrown into the host: setup runs
   * at server bootstrap, where a throw would stop the app starting. Without a sink the containment is
   * silent, which is why this exists.
   */
  onError?: (error: unknown) => void;
}

const headerValue = (
  headers: FastifyRequest['headers'],
  lowercaseName: string,
): string | undefined => {
  const value = headers[lowercaseName];
  return Array.isArray(value) ? value[0] : value;
};

const routeOf = (req: FastifyRequest): string | undefined => req.routeOptions?.url;
const urlOf = (req: FastifyRequest): string => req.url ?? '';
const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

const resolveStore = (client: Bugsee): RequestContextStore | undefined =>
  client.getServiceProvider(RequestContextStoreToken).getImmediate({ optional: true }) ?? undefined;

const toOptions = (options: FastifyAdapterOptions): ServerInstrumentOptions => ({
  ...(options.getClient !== undefined
    ? { getClient: options.getClient }
    : { getClient: defaultGetClient }),
  ...(options.newContextId !== undefined ? { newContextId: options.newContextId } : {}),
});

/**
 * One-call Fastify setup: installs the request / error / response (+ request-abort) hooks. Call on the
 * ROOT Fastify instance — Fastify hooks are encapsulated per scope, so the hooks cover this instance and
 * its child plugins, NOT a parent/sibling scope. Hook-vs-route ordering does NOT matter (Fastify binds
 * hooks at ready time), so it may be called before or after your routes — just register it on the root.
 */
/**
 * CONTAINED. This runs at SERVER BOOTSTRAP, walking a host-supplied app/server object and calling its
 * registration methods. An unguarded throw here does not cost one report — it stops the application
 * starting at all, which is the most severe form of the failure Wave 2.1 exists to prevent.
 *
 * The failure is routed to `onError`, NOT swallowed. Containing a bootstrap failure silently would trade
 * this defect for the one Wave 4 is about ("features that silently do nothing"); reporting it keeps the
 * app alive AND tells anyone who wired a sink that instrumentation did not install.
 */
export function setupFastify(app: FastifyInstance, options: FastifyAdapterOptions = {}): void {
  neverThrow(() => setupFastifyUnsafe(app, options), options.onError);
}

function setupFastifyUnsafe(app: FastifyInstance, options: FastifyAdapterOptions = {}): void {
  const opts = toOptions(options);
  // Per-request span, keyed by the request object (GC'd with it — no decorator, no request mutation).
  const spans = new WeakMap<object, ServerRequestSpan>();

  const onRequest = (req: FastifyRequest, _reply: FastifyReply, done: FastifyHookDone): void => {
    try {
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
      spans.set(req, openServerRequest(info, opts)); // enterWith + own/refine + txn
    } catch {
      // never break the request
    }
    done();
  };

  const getClient = options.getClient ?? defaultGetClient;
  const onError = (
    req: FastifyRequest,
    _reply: FastifyReply,
    error: unknown,
    done: FastifyHookDone,
  ): void => {
    try {
      const client = getClient();
      if (client !== undefined) {
        // Report against the active context (the in-flight request's — the http-layer owner's under
        // re-entrancy), enriched with the matched route. Fastify reports EVERY unhandled route error.
        const store = resolveStore(client);
        const route = routeOf(req);
        if (store !== undefined && route !== undefined) {
          store.setAttribute('http.route', route);
        }
        void client.logException(error, { mechanism: 'http-error' });
      }
    } catch {
      // never break Fastify's error handling
    }
    done();
  };

  const onResponse = (req: FastifyRequest, reply: FastifyReply, done: FastifyHookDone): void => {
    try {
      const span = spans.get(req);
      if (span !== undefined) {
        spans.delete(req); // onResponse fires once; the delete + the span's own guard make a repeat a no-op
        const route = routeOf(req);
        if (route !== undefined) {
          span.setRoute(route);
        }
        span.finish(reply.statusCode ?? 0);
      }
    } catch {
      // never break the response lifecycle
    }
    done();
  };

  // A client abort fires onRequestAbort, NOT onResponse — cancel the transaction so it is still delivered
  // rather than dropped. (req, done) — no reply on this hook.
  const onRequestAbort = (req: FastifyRequest, done: FastifyHookDone): void => {
    try {
      const span = spans.get(req);
      if (span !== undefined) {
        spans.delete(req);
        span.cancel();
      }
    } catch {
      // never break the abort lifecycle
    }
    done();
  };

  app.addHook('onRequest', onRequest as never);
  app.addHook('onError', onError as never);
  app.addHook('onResponse', onResponse as never);
  app.addHook('onRequestAbort', onRequestAbort as never);
}
