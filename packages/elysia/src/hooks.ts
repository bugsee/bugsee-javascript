import { getCarrierClient } from '@bugsee/core';
import {
  type Bugsee,
  openServerRequest,
  type RequestContextStore,
  RequestContextStoreToken,
  type ServerInstrumentOptions,
  type ServerRequestSpan,
} from '@bugsee/node';
import { randomId } from '@bugsee/util';

// The Elysia adapter (design: docs/design/framework-adapters.md + incoming-server-instrumentation.md §5.4).
// Elysia is a PEER (structural types only). setupElysia adds three hooks over the shared
// server-instrumentation core (@bugsee/node):
//   onRequest    — opens the per-request context + http.server transaction via `openServerRequest`
//                  (enterWith, like @bugsee/fastify) — or REFINES the node:http-layer owner's span when that
//                  auto-instrument also runs (first-owner-wins re-entrancy). The span + outcome are kept
//                  per-request on a WeakMap.
//   onError      — Elysia classifies the throw via `code`; we report server errors (UNKNOWN/5xx), skip the
//                  rest (NOT_FOUND/VALIDATION/4xx), via logException directly (the decision is CODE-based,
//                  not error-shape-based, so it does not flow through the span's shouldReport). `set.status`
//                  is unreliable here, so the txn status is derived from the code.
//   mapResponse  — fires LAST for BOTH success and error — finishes the transaction with the EXPLICIT
//                  outcome (decoupled from the recorded status; D10) + the route-parametrized name.
// Fully defensive: a failure in any hook never breaks the request.

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
  /** Mint a context id; default a portable random id. Injectable for tests. */
  newContextId?: () => string;
  /**
   * Override the report decision. Default: report Elysia "server" errors (a plain throw / a 5xx status),
   * skip framework control flow (NOT_FOUND, VALIDATION, a 4xx status, …).
   */
  shouldReport?: (err: unknown) => boolean;
}

const resolveStore = (client: Bugsee): RequestContextStore | undefined =>
  client.getServiceProvider(RequestContextStoreToken).getImmediate({ optional: true }) ?? undefined;

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

const nameRoute = (c: ElysiaContextLike): string => c.route || requestPath(c);

export const requestName = (c: ElysiaContextLike): string => `${c.request.method} ${nameRoute(c)}`;

// Portable id (global crypto is undefined on Node 18; node:crypto is absent on edge) — see @bugsee/util.
const newRandomId = (): string => randomId();

const toOptions = (options: ElysiaAdapterOptions): ServerInstrumentOptions => ({
  ...(options.getClient !== undefined
    ? { getClient: options.getClient }
    : { getClient: defaultGetClient }),
  ...(options.newContextId !== undefined
    ? { newContextId: options.newContextId }
    : { newContextId: newRandomId }),
});

interface RequestState {
  span: ServerRequestSpan;
  outcome: 'OK' | 'ERROR';
  /** The true status derived from the error `code` (e.g. 503), since `c.set.status` is unreliable here. */
  status?: number;
}

/** Register the Bugsee Elysia hooks. Call on the instance that owns your routes. */
export function setupElysia(app: ElysiaAppLike, options: ElysiaAdapterOptions = {}): void {
  const opts = toOptions(options);
  const getClient = options.getClient ?? defaultGetClient;
  // Per-request span + outcome, keyed by the request object (GC'd with it; no context mutation).
  const states = new WeakMap<object, RequestState>();

  app.onRequest((c) => {
    try {
      const user = options.user?.(c);
      const traceparent = c.request.headers.get('traceparent') ?? undefined;
      const info = {
        method: c.request.method,
        url: requestPath(c),
        route: nameRoute(c), // c.route || path — refined again at mapResponse once routing has run
        ...(traceparent !== undefined ? { traceparent } : {}),
        ...(user !== undefined ? { user } : {}),
      };
      states.set(c.request, { span: openServerRequest(info, opts), outcome: 'OK' });
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
      state.span.setRoute(nameRoute(c)); // route now parametrized; refines the txn name
      // Prefer a numeric c.set.status, then the code-derived status (e.g. 503), then 200. The OUTCOME is
      // explicit (D10): a server error finishes ERROR even when the recorded status is not >= 500.
      const status = typeof c.set.status === 'number' ? c.set.status : (state.status ?? 200);
      state.span.finish(status, state.outcome);
    } catch {
      // never break the response lifecycle
    }
  });
}
