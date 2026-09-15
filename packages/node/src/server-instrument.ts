import { parseTraceparent } from '@bugsee/capture';
import { type BugseeClient, getCarrierClient, type RequestContext } from '@bugsee/core';
import type { PerformanceApi, Transaction } from '@bugsee/performance';
import { NAME_SOURCE_ATTRIBUTE, sanitizeUrl } from '@bugsee/protocol';
import { randomId } from '@bugsee/util';
import { type RequestContextStore, RequestContextStoreToken } from './request-context-store';

// Shared server-instrumentation core (design: docs/design/incoming-server-instrumentation.md). Absorbed
// from the retired @bugsee/server-adapters engine and extended with (a) a `run`-scoped entry
// (`runServerRequest`) for the node:http emit patch / native serve wraps / express / koa, and (b)
// first-owner-wins RE-ENTRANCY: the first opener OWNS the per-request context + the `http.server`
// transaction and stashes its span on the context; a later opener (a dedicated framework adapter) gets a
// REFINING handle (setRoute / captureError on the owner's span; finish/cancel no-op) — so the http layer
// and a dedicated adapter coexist as exactly one context + one transaction. It takes PLAIN VALUES (no
// framework objects), is fully defensive (no client → safe no-op; nothing throws into the request
// pipeline beyond a fire-and-forget report), and acquires the performance extension at runtime via
// `client.ext('performance')` so @bugsee/node stays decoupled from it at the value level.

/** Plain request facts the caller extracts from its framework (no framework objects). */
export interface ServerRequestInfo {
  method: string;
  /** The request URL/path. Pass it RAW — `buildContext` scrubs it with `sanitizeUrl` before it becomes
   * `http.url`, so callers must not pre-redact. The query-stripped path is the route-name fallback. */
  url: string;
  /** The matched route pattern (`/users/:id`) → `http.route` + span name; refine later via `setRoute`. */
  route?: string;
  /** The inbound W3C `traceparent` header value, for distributed-trace continuation. */
  traceparent?: string;
  /** The resolved end-user identity for reports produced during this request (privacy-safe — opt-in). */
  user?: string;
}

/**
 * The BE→FE return headers (Profile v1 §12 return path), each independently toggleable. BOTH default OFF
 * (T9) — there is no consumer until the frontend adapters read them, at which point they flip on. Built
 * by {@link buildTraceResponseHeaders} and applied to the response by the CALLER (the node:http patch / the
 * native serve wrap), which owns the response object — the core has no response handle.
 */
export interface TraceResponseConfig {
  /** Append a `Server-Timing` entry carrying the trace context (browser-readable via PerformanceObserver). */
  serverTiming?: boolean;
  /** Emit the W3C trace-context-L2 draft `traceresponse` header so the FE adopts the BE's exact span id. */
  traceresponse?: boolean;
  /**
   * (F0, cross-origin) The `Timing-Allow-Origin` value to emit alongside `Server-Timing`, so a cross-origin
   * browser can READ it via `PerformanceResourceTiming.serverTiming` (without TAO the entry is opaque). A
   * string (e.g. `'*'`) or an origin list (joined with `, `). Only emitted when `serverTiming` is on.
   */
  timingAllowOrigin?: string | readonly string[];
  /**
   * (F0, cross-origin) Add `traceresponse` to `Access-Control-Expose-Headers`, so a cross-origin browser can
   * READ it off the fetch `Response`. Only emitted when `traceresponse` is on.
   */
  exposeTraceresponse?: boolean;
}

export interface ServerInstrumentOptions {
  /** Resolve the active client; default the process-singleton carrier client. */
  getClient?: () => BugseeClient | undefined;
  /** Mint a context id; default a portable random id. */
  newContextId?: () => string;
  /** Decide whether a thrown error is reported. Default {@link defaultShouldReport} (status-based). */
  shouldReport?: (err: unknown) => boolean;
  /** BE→FE return headers (default both off, T9). The caller writes {@link ServerRequestSpan.responseHeaders}. */
  traceResponse?: TraceResponseConfig;
  /** Where an SDK-internal failure in the request path is reported. It is never thrown into the request. */
  onError?: (error: unknown) => void;
}

/** A handle over the in-flight request. All methods are safe no-ops when no client is launched. */
export interface ServerRequestSpan {
  /** Refine the matched route once routing has run (updates `http.route` + the finished span name). */
  setRoute(route: string): void;
  /** Report `err` iff it should be reported. Returns whether it reported (lets callers dedup across seams). */
  captureError(err: unknown, opts?: { shouldReport?: (err: unknown) => boolean }): boolean;
  /** Finish the http.server transaction. Outcome defaults to `OK` if `status < 500`, else `ERROR`; pass an
   * explicit `outcome` when the framework decides it independently of the recorded status (Nest/Elysia). */
  finish(status: number, outcome?: 'OK' | 'ERROR' | 'CANCELLED'): void;
  /** Finish the http.server transaction as `CANCELLED` (e.g. a client abort). */
  cancel(): void;
  /** The configured BE→FE return headers (traceresponse / Server-Timing) for this request's span. Empty
   * when both are off (the default) or there is no transaction. The CALLER writes them to its response. */
  responseHeaders(): Record<string, string>;
}

// The owner stashes its span on the active RequestContext under a realm-global key, so a later opener in
// the SAME request (a refiner) finds it even across duplicate ESM/CJS copies of @bugsee/node. Stored
// non-enumerable so it never leaks into report assembly / capture stamping (which read named fields only).
const SERVER_SPAN = Symbol.for('bugsee.server.span');
/**
 * What an owner stashes: its span + whether it RUN-SCOPED the context (the http/native auto-instrument,
 * via `store.run`) vs ENTERED it (an adapter, via `store.enterWith`). Only a run-scoped owner is REFINABLE
 * — an enterWith adapter's context can linger across concurrent requests that share an async context (e.g.
 * Elysia's `app.handle`), and must not be mistaken for THIS request's owner (which would collapse them).
 */
interface StashedOwner {
  span: ServerRequestSpan;
  runScoped: boolean;
}
type ContextWithSpan = RequestContext & { [SERVER_SPAN]?: StashedOwner };

const stashSpan = (context: RequestContext, span: ServerRequestSpan, runScoped: boolean): void => {
  Object.defineProperty(context, SERVER_SPAN, {
    value: { span, runScoped },
    enumerable: false,
    configurable: true,
    writable: true,
  });
};

const stashedOwner = (context: RequestContext | undefined): StashedOwner | undefined =>
  context === undefined ? undefined : (context as ContextWithSpan)[SERVER_SPAN];

/** The span a NEW opener should refine: ONLY a run-scoped owner (the http/native auto-instrument). */
const refinableSpan = (context: RequestContext | undefined): ServerRequestSpan | undefined => {
  const owner = stashedOwner(context);
  return owner?.runScoped === true ? owner.span : undefined;
};

/** The in-flight span regardless of how the context was opened (for getActiveServerSpan). */
const activeSpan = (context: RequestContext | undefined): ServerRequestSpan | undefined =>
  stashedOwner(context)?.span;

const resolveStore = (client: BugseeClient): RequestContextStore | undefined =>
  client.getServiceProvider(RequestContextStoreToken).getImmediate({ optional: true }) ?? undefined;

/**
 * The active context, or `undefined` when there is none — or when the (integrator-replaceable)
 * store itself throws. A custom `requestContextStore` whose `getCurrent()` throws must degrade
 * every read to "no active context", never propagate into the request lifecycle (the same fail-safe
 * the request-scoped active-span store holds: a broken binding degrades, it never breaks).
 * Deliberately silent (no warning): these are high-frequency read paths with no per-store latch
 * available, and the same root cause already surfaces once via the span store's warn-once when the
 * performance extension is on.
 */
const safeCurrent = (store: RequestContextStore | undefined): RequestContext | undefined => {
  try {
    const context = store?.getCurrent() as unknown;
    // A custom binding may return null (the idiomatic absent value) instead of undefined. The raw
    // stash readers below only guard undefined, so without normalization a null would throw a
    // TypeError out of start/open/get — and read as "already active" in openServerContext. Same
    // absent-normalization the request-scoped active-span store applies at its own boundary.
    return typeof context === 'object' && context !== null
      ? (context as RequestContext)
      : undefined;
  } catch {
    return undefined;
  }
};

const tryGetPerf = (client: BugseeClient): PerformanceApi | undefined => {
  try {
    return client.ext('performance');
  } catch {
    return undefined;
  }
};

const defaultGetClient = (): BugseeClient | undefined => getCarrierClient<BugseeClient>();
// Portable id (NOT the global `crypto`, undefined on Node 18; NOT `node:crypto`, absent on edge runtimes).
const defaultNewContextId = (): string => randomId();

/**
 * The path, with the query stripped AND the path itself sanitized.
 *
 * Stripping the query is not enough: a matrix parameter lives IN the path (`/app;jsessionid=…`, canonical
 * Java servlet URL rewriting), so this value carried a session id into the transaction name and
 * `http.route` while `http.url` — derived from the same `info.url` two lines away — was redacted. The same
 * "redacting one field leaves the secret one field over" shape that the network provider's
 * statusText/reason/channel fix closed.
 */
const urlPath = (url: string): string => {
  const q = url.indexOf('?');
  return sanitizeUrl(q === -1 ? url : url.slice(0, q));
};

const spanName = (info: ServerRequestInfo, route: string | undefined): string =>
  `${info.method} ${route || urlPath(info.url)}`;

/**
 * Pure: the BE→FE return headers from the active trace, per the configured policy. `traceresponse` is the
 * W3C trace-context-L2 draft format `00-<traceId>-<beSpanId>-<flags>` (flags = the sampling bit). The
 * `Server-Timing` entry carries that same trace context as a `traceparent` metric `desc`, the de-facto
 * browser-RUM channel for surfacing it via PerformanceObserver. Returns `{}` when both flags are off.
 */
function buildTraceResponseHeaders(
  trace: { traceId: string; spanId: string; sampled: boolean },
  config: TraceResponseConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const traceContext = `00-${trace.traceId}-${trace.spanId}-${trace.sampled ? '01' : '00'}`;
  if (config.traceresponse === true) {
    headers.traceresponse = traceContext;
    // F0: expose `traceresponse` to a cross-origin FE (it reads it off the fetch Response).
    if (config.exposeTraceresponse === true) {
      headers['Access-Control-Expose-Headers'] = 'traceresponse';
    }
  }
  if (config.serverTiming === true) {
    headers['Server-Timing'] = `traceparent;desc="${traceContext}"`;
    // F0: expose Server-Timing to a cross-origin FE (it reads it via PerformanceResourceTiming.serverTiming;
    // without `Timing-Allow-Origin` the entry is opaque). Only meaningful alongside the Server-Timing header.
    if (config.timingAllowOrigin !== undefined) {
      headers['Timing-Allow-Origin'] =
        typeof config.timingAllowOrigin === 'string'
          ? config.timingAllowOrigin
          : config.timingAllowOrigin.join(', ');
    }
  }
  return headers;
}

/**
 * Default report policy: report a genuine unhandled error, skip an "expected" 4xx. Duck-types the common
 * HTTP-error shapes across frameworks — `getStatus()` (Nest), `status`/`statusCode` (Koa/http-errors),
 * `output.statusCode` (Boom). A value with no resolvable status (a plain Error) is reported.
 */
export const defaultShouldReport = (err: unknown): boolean => {
  const status = httpErrorStatus(err);
  return status === undefined || status >= 500;
};

const httpErrorStatus = (err: unknown): number | undefined => {
  // Guarded as a whole: a hostile error with a throwing getStatus() or a throwing status/output getter must
  // not throw out of the exported defaultShouldReport — it degrades to "no resolvable status" (→ reported).
  try {
    const e = err as
      | {
          getStatus?: unknown;
          status?: unknown;
          statusCode?: unknown;
          output?: { statusCode?: unknown };
        }
      | null
      | undefined;
    if (typeof e?.getStatus === 'function') {
      const s = (e as { getStatus: () => unknown }).getStatus();
      if (typeof s === 'number') {
        return s;
      }
    }
    if (typeof e?.status === 'number') {
      return e.status;
    }
    if (typeof e?.statusCode === 'number') {
      return e.statusCode;
    }
    if (typeof e?.output?.statusCode === 'number') {
      return e.output.statusCode;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

// Shared singleton for the no-client path; frozen so a caller can't corrupt the process-wide no-op.
const NOOP_SPAN: ServerRequestSpan = Object.freeze({
  setRoute() {},
  captureError() {
    return false;
  },
  finish() {},
  cancel() {},
  responseHeaders() {
    return {};
  },
});

const safeGetClient = (getClient: () => BugseeClient | undefined): BugseeClient | undefined => {
  try {
    return getClient();
  } catch {
    return undefined;
  }
};

// `http.url` is the inbound request target and rides into reports and the `http.server` span. It carries
// whatever the client sent — including `?api_key=…` — so it is redacted here, at the one point every
// server path (node/bun/deno http, and the express/fastify/koa/hapi/elysia adapters) funnels through.
const buildContext = (info: ServerRequestInfo, newContextId: () => string): RequestContext => ({
  contextId: newContextId(),
  attributes: { 'http.method': info.method, 'http.url': sanitizeUrl(info.url) },
  ...(info.user !== undefined ? { user: info.user } : {}),
});

/** Open the per-request context (via store.enterWith) for the active async chain. A no-op without a store,
 * and a no-op when a context is already active (so it does not replace an http-layer owner's context). */
export function openServerContext(
  info: ServerRequestInfo,
  options: ServerInstrumentOptions = {},
): void {
  const client = safeGetClient(options.getClient ?? defaultGetClient);
  if (client === undefined) {
    return;
  }
  try {
    const store = resolveStore(client);
    if (store === undefined || safeCurrent(store) !== undefined) {
      return;
    }
    store.enterWith(buildContext(info, options.newContextId ?? defaultNewContextId));
  } catch {
    // never break the request
  }
}

/** Start an http.server transaction in the ALREADY-ACTIVE context. Refines instead when one is already
 * owned. Returns a no-op span without a client. */
export function startServerSpan(
  info: ServerRequestInfo,
  options: ServerInstrumentOptions = {},
): ServerRequestSpan {
  const client = safeGetClient(options.getClient ?? defaultGetClient);
  if (client === undefined) {
    return NOOP_SPAN;
  }
  const store = resolveStore(client);
  const existing = refinableSpan(safeCurrent(store));
  if (existing !== undefined) {
    return refiningHandle(existing, info, store, options);
  }
  return makeSpan(client, info, options, false); // enterWith-based (Nest interceptor in the active context)
}

/**
 * The http.server span the current request's owner stashed on the active context, or `undefined` (no
 * client, no active context, or no owner span yet). Lets a SEPARATE middleware (an error handler that runs
 * after the opener) refine / capture against the in-flight request's span — without threading the span
 * through framework state. Returns the owner's span directly (not a refining handle).
 */
export function getActiveServerSpan(
  options: ServerInstrumentOptions = {},
): ServerRequestSpan | undefined {
  const client = safeGetClient(options.getClient ?? defaultGetClient);
  if (client === undefined) {
    return undefined;
  }
  return activeSpan(safeCurrent(resolveStore(client)));
}

/** Open the context (enterWith) AND start the http.server transaction — the common entry for hook adapters
 * and direct users. Refines instead when a context with an owner span is already active. */
export function openServerRequest(
  info: ServerRequestInfo,
  options: ServerInstrumentOptions = {},
): ServerRequestSpan {
  const client = safeGetClient(options.getClient ?? defaultGetClient);
  if (client === undefined) {
    return NOOP_SPAN;
  }
  const store = resolveStore(client);
  const existing = refinableSpan(safeCurrent(store));
  if (existing !== undefined) {
    return refiningHandle(existing, info, store, options);
  }
  try {
    store?.enterWith(buildContext(info, options.newContextId ?? defaultNewContextId));
  } catch {
    // never break the request
  }
  return makeSpan(client, info, options, false); // enterWith-based — NOT a refinable owner (see runScoped)
}

/**
 * Open the context via `store.run` and run `dispatch` inside it — the `run`-scoped entry for the node:http
 * emit patch, native serve wraps, and express/koa. Returns whatever `dispatch` returns. When a context
 * with an owner span is already active, this is a refiner: it runs `dispatch` in that context with a
 * refining span (no second context/transaction). With no store it starts a transaction-only span.
 */
export function runServerRequest<T>(
  info: ServerRequestInfo,
  options: ServerInstrumentOptions,
  dispatch: (span: ServerRequestSpan) => T,
): T {
  // Wave 2.1/2.3 — THE REQUEST PATH IS INERT. `dispatch` is where the framework calls `next()` / the route
  // handler, so if the SDK throws before invoking it, the customer's handler never runs and the SDK's own
  // error becomes the request's outcome: a 500 on a request that would have succeeded, with the app's error
  // middleware handed a Bugsee-internal Error as if it were their bug
  // (docs/review/backend-express-fastify-koa.md SEV1 #1, docs/review/backend-hono-hapi-elysia.md SEV1 #1 —
  // both reproduced against real servers). Any SDK-side failure degrades to running the request
  // UNINSTRUMENTED, which loses telemetry and nothing else.
  //
  // `dispatched` is what keeps that from swallowing the application's OWN error: once dispatch has been
  // entered, anything thrown belongs to the host and is rethrown untouched.
  let dispatched = false;
  const run = (span: ServerRequestSpan): T => {
    dispatched = true;
    return dispatch(span);
  };
  try {
    const client = safeGetClient(options.getClient ?? defaultGetClient);
    if (client === undefined) {
      return run(NOOP_SPAN);
    }
    const store = resolveStore(client);
    const existing = refinableSpan(safeCurrent(store));
    if (existing !== undefined) {
      return run(refiningHandle(existing, info, store, options));
    }
    if (store === undefined) {
      return run(makeSpan(client, info, options, true));
    }
    const context = buildContext(info, options.newContextId ?? defaultNewContextId);
    return store.run(context, () => run(makeSpan(client, info, options, true))); // run-scoped → refinable
  } catch (error) {
    if (dispatched) {
      throw error; // the HOST's error — never ours to swallow
    }
    // The sink itself is host-supplied and may throw. Unguarded it re-opened the exact hole this function
    // exists to close: the throw escaped into the request AND `dispatch` below never ran. Reproduced
    // through the public `wrapFetchHandler` (Bun/Deno): `handlerRan=0`.
    try {
      options.onError?.(error);
    } catch {
      // a broken sink must never become the request's outcome
    }
    return dispatch(NOOP_SPAN); // the SDK failed before the request ran: run it uninstrumented
  }
}

/** A refining handle over the owner's span: setRoute / captureError act on the owner; finish/cancel are
 * no-ops (the owner finishes). Propagates the refiner's user onto the active context and applies the
 * refiner's report policy. */
function refiningHandle(
  owner: ServerRequestSpan,
  info: ServerRequestInfo,
  store: RequestContextStore | undefined,
  options: ServerInstrumentOptions,
): ServerRequestSpan {
  if (info.user !== undefined) {
    try {
      store?.setUser(info.user);
    } catch {
      // A custom store whose mutator throws must not break refinement (or the request): the user
      // propagation is skipped, the owner span is still refined.
    }
  }
  const refinerShouldReport = options.shouldReport ?? defaultShouldReport;
  return {
    setRoute(route) {
      owner.setRoute(route);
    },
    captureError(err, opts) {
      return owner.captureError(err, { shouldReport: opts?.shouldReport ?? refinerShouldReport });
    },
    finish() {},
    cancel() {},
    // The OWNER holds the real transaction + the return-header policy; the refiner forwards to it.
    responseHeaders() {
      return owner.responseHeaders();
    },
  };
}

function makeSpan(
  client: BugseeClient,
  info: ServerRequestInfo,
  options: ServerInstrumentOptions,
  runScoped: boolean,
): ServerRequestSpan {
  const store = resolveStore(client);
  const shouldReportDefault = options.shouldReport ?? defaultShouldReport;
  let route = info.route;
  let transaction: Transaction | undefined;
  try {
    const perf = tryGetPerf(client);
    if (perf !== undefined) {
      const inbound = parseTraceparent(info.traceparent);
      transaction = perf.startTransaction({
        name: spanName(info, route),
        operation: 'http.server',
        // Continue the inbound trace as a true CHILD: adopt the trace id, make the http.server span a
        // child of the upstream span, and adopt the upstream sampling decision (Profile v1 §12).
        ...(inbound !== undefined
          ? {
              continuation: {
                traceId: inbound.traceId,
                parentSpanId: inbound.spanId,
                sampled: inbound.sampled,
              },
            }
          : {}),
      });
      store?.setTrace({
        traceId: transaction.getTraceId(),
        spanId: transaction.getSpanId(),
        sampled: transaction.isSampled(),
      });
    }
  } catch {
    // If startTransaction succeeded before a later APM call threw, the controller slot still holds
    // the live transaction while this handle is about to abandon it — an orphan no owner can ever
    // finish (on a lingering context the next request would even read it). Finish it instead: the
    // normal onFinish path clears the slot and still delivers the bounded transaction once. Status
    // CANCELLED (not the default OK): the outcome is unknown — the request may still succeed — so
    // the sample must be self-identifying and excludable downstream rather than a ~0-duration OK
    // dragging the http.server p50/p95 down. (It carries its start-time name + trace identity +
    // timing, but none of the http.* attributes finishWith would have added.)
    try {
      transaction?.finish('CANCELLED');
    } catch {
      // A hostile transaction's own finish must not break the request either.
    }
    transaction = undefined; // APM wiring failure must never break the request
  }

  const finishWith = (status: number, outcome: 'OK' | 'ERROR' | 'CANCELLED'): void => {
    try {
      if (transaction === undefined || transaction.isFinished()) {
        return;
      }
      // F-4: `client.ext('performance').setRouteName()` / `setActiveTransactionName()` rename the
      // transaction directly and stamp NAME_SOURCE_ATTRIBUTE ('bugsee.name_source') — the caller's
      // explicit rename. Without this check, the automatic route-derived name below ran unconditionally
      // on every finish and silently overwrote it. Skip the automatic name ONLY when a manual rename
      // happened this request; the manual name wins. `getAttributes()` is a REQUIRED, non-throwing member
      // of `Span` (span.ts: a plain `Object.fromEntries` read) — reading it needs no defensive try/catch of
      // its own; the outer try/catch around this whole block already covers a genuinely hostile Transaction.
      const manuallyRenamed = transaction.getAttributes()[NAME_SOURCE_ATTRIBUTE] !== undefined;
      if (!manuallyRenamed) {
        transaction.setName(spanName(info, route));
      }
      transaction.setAttribute('http.method', info.method);
      transaction.setAttribute('http.status_code', status);
      transaction.finish(outcome);
    } catch {
      // finishing APM must never break the response lifecycle
    }
  };

  const span: ServerRequestSpan = {
    setRoute(r) {
      route = r;
    },
    captureError(err, opts) {
      try {
        const shouldReport = opts?.shouldReport ?? shouldReportDefault;
        if (!shouldReport(err)) {
          return false;
        }
        try {
          store?.setAttribute('http.route', route ?? urlPath(info.url));
        } catch {
          // The context merge is enrichment, not the report: a custom store whose mutator throws
          // must not convert a reportable error into a silent "not reported".
        }
        void client.logException(err, { mechanism: 'http-error' });
        return true;
      } catch {
        return false; // reporting must never replace the app's own error handling
      }
    },
    finish(status, outcome) {
      finishWith(status, outcome ?? (status >= 500 ? 'ERROR' : 'OK'));
    },
    cancel() {
      finishWith(0, 'CANCELLED');
    },
    responseHeaders() {
      // Guarded: computing return headers must never throw into the response lifecycle. No transaction
      // (no perf ext) → nothing to link, so no headers.
      try {
        if (transaction === undefined) {
          return {};
        }
        return buildTraceResponseHeaders(
          {
            traceId: transaction.getTraceId(),
            spanId: transaction.getSpanId(),
            sampled: transaction.isSampled(),
          },
          options.traceResponse ?? {},
        );
      } catch {
        return {};
      }
    },
  };

  // Stash the owner span on the active context so a later opener in this request refines instead of
  // opening a second context/transaction (no-op when no context is active — e.g. the no-store path).
  const active = safeCurrent(store);
  if (active !== undefined) {
    try {
      stashSpan(active, span, runScoped);
    } catch {
      // A non-extensible active context (frozen/sealed foreign object) cannot carry the stash.
      // Skip refinement rather than breaking span start: the span stays usable transaction-only,
      // mirroring the request-scoped active-span store's drop semantics on the same object. Note
      // the consequence: a later opener in this request finds no stashed owner and opens a SECOND
      // context + transaction (first-owner-wins cannot apply to what was never stashed).
    }
  }
  return span;
}
