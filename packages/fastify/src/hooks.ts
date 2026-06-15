import { randomUUID } from 'node:crypto';
import { parseTraceparent } from '@bugsee/capture';
import { getCarrierClient, type RequestContext } from '@bugsee/core';
import { type Bugsee, type RequestContextStore, RequestContextStoreToken } from '@bugsee/node';
import type { PerformanceApi, Transaction } from '@bugsee/performance';

// The Fastify adapter (design: docs/design/framework-adapters.md). Unlike Express (middleware), Fastify is
// hook-based, so a single setupFastify(app) call at the top installs three lifecycle hooks that cover the
// whole app — no error-handler placement, no listen wrapping:
//   onRequest  — open the request context (via the store's enterWith, since the hook returns before the
//                route handler runs) + start an http.server APM transaction (when performance is wired) +
//                continue an inbound W3C trace.
//   onError    — report an unhandled route error (mechanism 'http-error') WITH the context merged.
//   onResponse — finish the transaction (route-parametrized name + status).
// Reuses the per-request context foundation verbatim; only the binding differs. Fully defensive: a failure
// in any hook never breaks the request, and done() is always called. The client is the process-singleton
// carrier client (a no-op when none is launched). fastify is a PEER dependency.

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
  /** Mint a context id; default `crypto.randomUUID`. Injectable for tests. */
  newContextId?: () => string;
}

const headerValue = (
  headers: FastifyRequest['headers'],
  lowercaseName: string,
): string | undefined => {
  const value = headers[lowercaseName];
  return Array.isArray(value) ? value[0] : value;
};

const resolveStore = (client: Bugsee): RequestContextStore | undefined =>
  client.getServiceProvider(RequestContextStoreToken).getImmediate({ optional: true }) ?? undefined;

const tryGetPerf = (client: Bugsee): PerformanceApi | undefined => {
  try {
    return client.ext('performance');
  } catch {
    return undefined; // the performance extension is optional
  }
};

const requestName = (req: FastifyRequest): string => {
  const method = req.method ?? 'GET';
  const path = req.routeOptions?.url ?? req.url ?? '';
  return `${method} ${path}`;
};

const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

/**
 * One-call Fastify setup: installs the request / error / response (+ request-abort) hooks. Call on the
 * ROOT Fastify instance — Fastify hooks are encapsulated per scope, so the hooks cover this instance and
 * its child plugins, NOT a parent/sibling scope. Hook-vs-route ordering does NOT matter (Fastify binds
 * hooks at ready time), so it may be called before or after your routes — just register it on the root.
 */
export function setupFastify(app: FastifyInstance, options: FastifyAdapterOptions = {}): void {
  const getClient = options.getClient ?? defaultGetClient;
  const newContextId = options.newContextId ?? randomUUID;
  // Per-request transaction, keyed by the request object (GC'd with it — no decorator, no request mutation).
  const transactions = new WeakMap<object, Transaction>();

  const onRequest = (req: FastifyRequest, _reply: FastifyReply, done: FastifyHookDone): void => {
    try {
      const client = getClient();
      const store = client !== undefined ? resolveStore(client) : undefined;
      if (client !== undefined && store !== undefined) {
        const method = req.method ?? 'GET';
        const url = req.url ?? '';
        const user = options.user?.(req);
        const context: RequestContext = {
          contextId: newContextId(),
          attributes: { 'http.method': method, 'http.url': url },
          ...(user !== undefined ? { user } : {}),
        };
        // enterWith (not run) — the hook returns before the route handler runs; the context then follows
        // the request's async chain. Each request is its own async context, so it stays isolated.
        store.enterWith(context);

        const inbound = parseTraceparent(headerValue(req.headers, 'traceparent'));
        const perf = tryGetPerf(client);
        if (perf !== undefined) {
          const transaction = perf.startTransaction({
            name: requestName(req),
            operation: 'http.server',
            ...(inbound !== undefined ? { continuation: { traceId: inbound.traceId } } : {}),
          });
          store.setTrace({
            traceId: transaction.getTraceId(),
            spanId: transaction.getSpanId(),
          });
          transactions.set(req, transaction);
        }
      }
    } catch {
      // never break the request
    }
    done();
  };

  const onError = (
    req: FastifyRequest,
    _reply: FastifyReply,
    error: unknown,
    done: FastifyHookDone,
  ): void => {
    try {
      const client = getClient();
      if (client !== undefined) {
        const store = resolveStore(client);
        const route = req.routeOptions?.url;
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
      // onResponse fires once per request; the WeakMap delete makes a repeat call a no-op (and
      // Transaction.finish is itself idempotent).
      const transaction = transactions.get(req);
      if (transaction !== undefined) {
        transactions.delete(req);
        const status = reply.statusCode ?? 0;
        transaction.setName(requestName(req)); // now parametrized (routing done)
        transaction.setAttribute('http.method', req.method ?? 'GET');
        transaction.setAttribute('http.status_code', status);
        transaction.finish(status >= 500 ? 'ERROR' : 'OK');
      }
    } catch {
      // never break the response lifecycle
    }
    done();
  };

  // A client abort fires onRequestAbort, NOT onResponse — finish the transaction (as CANCELLED) so it is
  // still delivered rather than dropped. (req, done) — no reply on this hook.
  const onRequestAbort = (req: FastifyRequest, done: FastifyHookDone): void => {
    try {
      const transaction = transactions.get(req);
      if (transaction !== undefined) {
        transactions.delete(req);
        transaction.finish('CANCELLED');
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
