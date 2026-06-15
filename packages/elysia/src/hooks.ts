import { parseTraceparent } from '@bugsee/capture';
import { getCarrierClient, type RequestContext } from '@bugsee/core';
import { type Bugsee, type RequestContextStore, RequestContextStoreToken } from '@bugsee/node';
import type { PerformanceApi, Transaction } from '@bugsee/performance';

// The Elysia adapter (design: docs/design/framework-adapters.md). Elysia is a PEER (structural types only).
// Elysia's lifecycle hooks are ADDITIVE (registering ours never replaces the user's), so setupElysia adds
// three hooks over the per-request context foundation:
//   onRequest    — opens the per-request context (via store.enterWith — the hook returns before the route
//                  handler, like the @bugsee/fastify hook) + starts an http.server APM transaction +
//                  continues an inbound W3C traceparent. The transaction is kept per-request on a WeakMap.
//   onError      — reports a GENUINE error (mechanism http-error). Elysia classifies via `code`: a plain
//                  throw is 'UNKNOWN', a status(n) throw is the number n, framework control flow is a named
//                  code (NOT_FOUND/VALIDATION/PARSE/…). We report server errors (UNKNOWN/5xx) and skip the
//                  rest; `set.status` is unreliable here, so the decision is code-based.
//   mapResponse  — fires LAST for BOTH success and error (Elysia's .listen is unsupported on Node, so the
//                  pipeline is driven via app.handle; onAfterResponse does NOT fire there, but mapResponse
//                  does) — finishes the transaction (route-parametrized name + outcome). Returns nothing,
//                  so it never alters the response.
// Fully defensive: a failure in any hook never breaks the request. Register on the instance that owns your
// routes (Elysia hooks are scoped per instance).

/** Minimal structural Elysia request (a Fetch Request). */
export interface ElysiaRequestLike {
  method: string;
  url: string;
  headers: { get(name: string): string | null };
}
/** Minimal structural Elysia context. */
export interface ElysiaContextLike {
  request: ElysiaRequestLike;
  set: { status?: number | string };
  /** The matched route pattern (`/users/:id`), available once routing has run. */
  route?: string;
}
/** Elysia onError context — adds the classified `code` + the thrown `error`. */
export interface ElysiaErrorContextLike extends ElysiaContextLike {
  code: unknown;
  error: unknown;
}
/** The minimal Elysia application surface setupElysia needs (hooks are chainable; we ignore the return). */
export interface ElysiaAppLike {
  onRequest(handler: (c: ElysiaContextLike) => unknown): unknown;
  onError(handler: (c: ElysiaErrorContextLike) => unknown): unknown;
  mapResponse(handler: (c: ElysiaContextLike) => unknown): unknown;
}

export interface ElysiaAdapterOptions {
  /** Extract the end-user identity for reports. Privacy-safe default: OFF. */
  user?: (c: ElysiaContextLike) => string | undefined;
  /** Resolve the active client; default the process-singleton carrier client. Injectable for tests. */
  getClient?: () => Bugsee | undefined;
  /** Mint a context id; default `crypto.randomUUID`. Injectable for tests. */
  newContextId?: () => string;
  /**
   * Override the report decision. Default: report Elysia "server" errors (a plain throw / a 5xx status),
   * skip framework control flow (NOT_FOUND, VALIDATION, a 4xx status, …).
   */
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

/** The HTTP status an Elysia error `code` maps to, or undefined when it is not a server-classifiable code. */
export const codeToStatus = (code: unknown): number | undefined => {
  if (typeof code === 'number') {
    return code;
  }
  if (code === 'UNKNOWN' || code === 'INTERNAL_SERVER_ERROR') {
    return 500;
  }
  return undefined; // named framework codes (NOT_FOUND, VALIDATION, PARSE, …) → client control flow
};

/** Whether an Elysia error `code` represents a SERVER error (→ report + transaction ERROR). */
export const isElysiaServerError = (code: unknown): boolean => {
  const status = codeToStatus(code);
  return status !== undefined && status >= 500;
};

const requestPath = (c: ElysiaContextLike): string => {
  try {
    return new URL(c.request.url).pathname;
  } catch {
    return c.request.url; // defensive: a malformed URL still yields something
  }
};

export const requestName = (c: ElysiaContextLike): string =>
  `${c.request.method} ${c.route || requestPath(c)}`;

const newRandomId = (): string => crypto.randomUUID();

interface RequestState {
  transaction: Transaction | undefined;
  outcome: 'OK' | 'ERROR';
  /** The true status derived from the error `code` (e.g. 503), since `c.set.status` is unreliable here. */
  status?: number;
}

/** Register the Bugsee Elysia hooks. Call on the instance that owns your routes. */
export function setupElysia(app: ElysiaAppLike, options: ElysiaAdapterOptions = {}): void {
  const getClient = options.getClient ?? defaultGetClient;
  const newContextId = options.newContextId ?? newRandomId;
  // Per-request transaction + outcome, keyed by the request object (GC'd with it; no context mutation).
  const states = new WeakMap<object, RequestState>();

  app.onRequest((c) => {
    try {
      const client = getClient();
      if (client === undefined) {
        return;
      }
      const store = resolveStore(client);
      if (store !== undefined) {
        const user = options.user?.(c);
        const context: RequestContext = {
          contextId: newContextId(),
          attributes: { 'http.method': c.request.method, 'http.url': requestPath(c) },
          ...(user !== undefined ? { user } : {}),
        };
        store.enterWith(context);
      }
      states.set(c.request, { transaction: startTransaction(client, c, store), outcome: 'OK' });
    } catch {
      // never break the request
    }
  });

  app.onError((c) => {
    try {
      const client = getClient();
      if (client === undefined) {
        return;
      }
      const serverError = isElysiaServerError(c.code);
      const state = states.get(c.request);
      if (state !== undefined) {
        state.outcome = serverError ? 'ERROR' : 'OK';
        state.status = codeToStatus(c.code); // the true status (e.g. 503), for the transaction
      }
      const report = options.shouldReport ? options.shouldReport(c.error) : serverError;
      if (report) {
        resolveStore(client)?.setAttribute('http.route', c.route ?? requestPath(c));
        void client.logException(c.error, { mechanism: 'http-error' });
      }
    } catch {
      // never break Elysia's error handling
    }
  });

  app.mapResponse((c) => {
    try {
      const state = states.get(c.request);
      if (state === undefined) {
        return;
      }
      states.delete(c.request);
      finishTransaction(state.transaction, c, state.outcome, state.status);
    } catch {
      // never break the response lifecycle
    }
  });
}

function startTransaction(
  client: Bugsee,
  c: ElysiaContextLike,
  store: RequestContextStore | undefined,
): Transaction | undefined {
  const perf = tryGetPerf(client);
  if (perf === undefined) {
    return undefined;
  }
  const inbound = parseTraceparent(c.request.headers.get('traceparent') ?? undefined);
  const transaction = perf.startTransaction({
    name: requestName(c),
    operation: 'http.server',
    ...(inbound !== undefined ? { continuation: { traceId: inbound.traceId } } : {}),
  });
  store?.setTrace({ traceId: transaction.getTraceId(), spanId: transaction.getSpanId() });
  return transaction;
}

function finishTransaction(
  transaction: Transaction | undefined,
  c: ElysiaContextLike,
  outcome: 'OK' | 'ERROR',
  statusHint: number | undefined,
): void {
  if (transaction === undefined || transaction.isFinished()) {
    return;
  }
  transaction.setName(requestName(c)); // route now parametrized
  transaction.setAttribute('http.method', c.request.method);
  // Prefer a numeric c.set.status, then the code-derived status (e.g. 503), then 200. (statusHint is
  // always set when outcome is ERROR — a server error always has a >= 500 code — so 200 is the OK default.)
  const status = typeof c.set.status === 'number' ? c.set.status : (statusHint ?? 200);
  transaction.setAttribute('http.status_code', status);
  transaction.finish(outcome);
}
