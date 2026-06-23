import { parseTraceparent } from '@bugsee/capture';
import { type BugseeClient, getCarrierClient, type RequestContext } from '@bugsee/core';
import type { PerformanceApi, Transaction } from '@bugsee/performance';
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
  /** The request URL/path → `http.url` (raw; the redaction pipeline scrubs query secrets). The
   * query-stripped path is the route-name fallback. */
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

const urlPath = (url: string): string => {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
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

const buildContext = (info: ServerRequestInfo, newContextId: () => string): RequestContext => ({
  contextId: newContextId(),
  attributes: { 'http.method': info.method, 'http.url': info.url },
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
    if (store === undefined || store.getCurrent() !== undefined) {
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
  const existing = refinableSpan(store?.getCurrent());
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
  return activeSpan(resolveStore(client)?.getCurrent());
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
  const existing = refinableSpan(store?.getCurrent());
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
  const client = safeGetClient(options.getClient ?? defaultGetClient);
  if (client === undefined) {
    return dispatch(NOOP_SPAN);
  }
  const store = resolveStore(client);
  const existing = refinableSpan(store?.getCurrent());
  if (existing !== undefined) {
    return dispatch(refiningHandle(existing, info, store, options));
  }
  if (store === undefined) {
    return dispatch(makeSpan(client, info, options, true));
  }
  const context = buildContext(info, options.newContextId ?? defaultNewContextId);
  return store.run(context, () => dispatch(makeSpan(client, info, options, true))); // run-scoped → refinable
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
    store?.setUser(info.user);
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
    transaction = undefined; // APM wiring failure must never break the request
  }

  const finishWith = (status: number, outcome: 'OK' | 'ERROR' | 'CANCELLED'): void => {
    try {
      if (transaction === undefined || transaction.isFinished()) {
        return;
      }
      transaction.setName(spanName(info, route));
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
        store?.setAttribute('http.route', route ?? urlPath(info.url));
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
  const active = store?.getCurrent();
  if (active !== undefined) {
    stashSpan(active, span, runScoped);
  }
  return span;
}
