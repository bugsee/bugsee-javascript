import { parseTraceparent } from '@bugsee/capture';
import { getCarrierClient, type RequestContext } from '@bugsee/core';
import { type Bugsee, type RequestContextStore, RequestContextStoreToken } from '@bugsee/node';
import type { PerformanceApi, Transaction } from '@bugsee/performance';

// Framework-agnostic server-instrumentation engine (design: docs/design/generic-server-adapter.md).
// It takes PLAIN VALUES (no framework objects) and is usable from ANY backend framework / raw http.Server,
// and is the shared substrate the per-framework adapters delegate to. The context is opened via
// `enterWith` (the uniformly-safe primitive); the caller computes the final status and the engine maps it
// to OK/ERROR (`finish`) or CANCELLED (`cancel`). Fully defensive: with no client launched every call is a
// safe no-op, and nothing here throws into the caller's request pipeline beyond a fire-and-forget report.

/** Plain request facts the caller extracts from its framework (no framework objects). */
export interface BugseeRequestInfo {
  method: string;
  /** The request URL/path → `http.url` (and, with `?`-query stripped, the route-name fallback). */
  url: string;
  /** The matched route pattern (`/users/:id`) → `http.route` + span name; refine later via `setRoute`. */
  route?: string;
  /** The inbound W3C `traceparent` header value, for distributed-trace continuation. */
  traceparent?: string;
  /** The resolved end-user identity for reports produced during this request (privacy-safe — opt-in). */
  user?: string;
}

export interface BugseeServerOptions {
  /** Resolve the active client; default the process-singleton carrier client. */
  getClient?: () => Bugsee | undefined;
  /** Mint a context id; default `crypto.randomUUID`. */
  newContextId?: () => string;
  /** Decide whether a thrown error is reported. Default {@link defaultShouldReport} (status-based). */
  shouldReport?: (err: unknown) => boolean;
}

/** A handle over the in-flight request. All methods are safe no-ops when no client is launched. */
export interface BugseeRequestSpan {
  /** Refine the matched route once routing has run (updates `http.route` + the finished span name). */
  setRoute(route: string): void;
  /** Report `err` iff it should be reported. Returns whether it reported (lets callers dedup across seams). */
  captureError(err: unknown, opts?: { shouldReport?: (err: unknown) => boolean }): boolean;
  /** Finish the http.server transaction: `OK` if `status < 500`, else `ERROR`. */
  finish(status: number): void;
  /** Finish the http.server transaction as `CANCELLED` (e.g. a client abort). */
  cancel(): void;
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

const urlPath = (url: string): string => {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
};

const spanName = (info: BugseeRequestInfo, route: string | undefined): string =>
  `${info.method} ${route || urlPath(info.url)}`;

/**
 * Default report policy: report a genuine unhandled error, skip an "expected" 4xx. Duck-types the common
 * HTTP-error shapes across frameworks — `getStatus()` (Nest), `status`/`statusCode` (Koa/http-errors/
 * restify), `output.statusCode` (Boom). A value with no resolvable status (a plain Error) is reported.
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
const NOOP_SPAN: BugseeRequestSpan = Object.freeze({
  setRoute() {},
  captureError() {
    return false;
  },
  finish() {},
  cancel() {},
});

const safeGetClient = (getClient: () => Bugsee | undefined): Bugsee | undefined => {
  try {
    return getClient();
  } catch {
    return undefined;
  }
};

/** Open the per-request context (via store.enterWith) for the active async chain. No-op without a store. */
export function openBugseeContext(
  info: BugseeRequestInfo,
  options: BugseeServerOptions = {},
): void {
  const client = safeGetClient(options.getClient ?? defaultGetClient);
  if (client === undefined) {
    return;
  }
  try {
    enterContext(client, info, options.newContextId ?? defaultNewContextId);
  } catch {
    // never break the request
  }
}

/** Start an http.server transaction in the ALREADY-ACTIVE context. Returns a no-op span without a client. */
export function startBugseeServerSpan(
  info: BugseeRequestInfo,
  options: BugseeServerOptions = {},
): BugseeRequestSpan {
  const client = safeGetClient(options.getClient ?? defaultGetClient);
  if (client === undefined) {
    return NOOP_SPAN;
  }
  return makeSpan(client, info, options);
}

/** Open the context AND start the http.server transaction. The common entry for most adapters / users. */
export function openBugseeRequest(
  info: BugseeRequestInfo,
  options: BugseeServerOptions = {},
): BugseeRequestSpan {
  const client = safeGetClient(options.getClient ?? defaultGetClient);
  if (client === undefined) {
    return NOOP_SPAN;
  }
  try {
    enterContext(client, info, options.newContextId ?? defaultNewContextId);
  } catch {
    // never break the request
  }
  return makeSpan(client, info, options);
}

const defaultNewContextId = (): string => crypto.randomUUID();

function enterContext(client: Bugsee, info: BugseeRequestInfo, newContextId: () => string): void {
  const store = resolveStore(client);
  if (store === undefined) {
    return;
  }
  const context: RequestContext = {
    contextId: newContextId(),
    attributes: { 'http.method': info.method, 'http.url': info.url },
    ...(info.user !== undefined ? { user: info.user } : {}),
  };
  store.enterWith(context);
}

function makeSpan(
  client: Bugsee,
  info: BugseeRequestInfo,
  options: BugseeServerOptions,
): BugseeRequestSpan {
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
        ...(inbound !== undefined ? { continuation: { traceId: inbound.traceId } } : {}),
      });
      resolveStore(client)?.setTrace({
        traceId: transaction.getTraceId(),
        spanId: transaction.getSpanId(),
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

  return {
    setRoute(r) {
      route = r;
    },
    captureError(err, opts) {
      try {
        const shouldReport = opts?.shouldReport ?? shouldReportDefault;
        if (!shouldReport(err)) {
          return false;
        }
        resolveStore(client)?.setAttribute('http.route', route ?? urlPath(info.url));
        void client.logException(err, { mechanism: 'http-error' });
        return true;
      } catch {
        return false; // reporting must never replace the app's own error handling
      }
    },
    finish(status) {
      finishWith(status, status >= 500 ? 'ERROR' : 'OK');
    },
    cancel() {
      finishWith(0, 'CANCELLED');
    },
  };
}
