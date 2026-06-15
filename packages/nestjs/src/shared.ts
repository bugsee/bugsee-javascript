import { getCarrierClient, type RequestContext } from '@bugsee/core';
import { type Bugsee, type RequestContextStore, RequestContextStoreToken } from '@bugsee/node';
import type { PerformanceApi } from '@bugsee/performance';

// Shared foundation for the @bugsee/nestjs seams (context middleware + interceptor + filter), over the
// per-request context foundation (design: docs/design/framework-adapters.md). NestJS is a PEER; these
// helpers use minimal STRUCTURAL request/response types and reach the client through the same DI seams
// as @bugsee/express / @bugsee/fastify. Nothing here imports @nestjs/* — the default (interceptor) path
// stays framework-import-free; only the opt-in filter pulls in @nestjs/core.

/** Minimal structural HTTP request, covering BOTH express- and fastify-based Nest. */
export interface NestHttpRequest {
  method?: string;
  url?: string;
  /** express: the full original URL (before route matching). */
  originalUrl?: string;
  /** express: the matched route, available once routing has run. */
  route?: { path?: string };
  /** fastify: the matched route pattern (`/users/:id`), available once routing has run. */
  routeOptions?: { url?: string };
  headers: Record<string, string | string[] | undefined>;
}
/** Minimal structural HTTP response. */
export interface NestHttpResponse {
  statusCode?: number;
}

/** Options shared by every @bugsee/nestjs seam. */
export interface NestAdapterOptions {
  /**
   * Extract the end-user identity for reports produced during this request. Privacy-safe default: OFF —
   * nothing identity-bearing is read unless this getter is provided. Return undefined to skip a request.
   */
  user?: (req: NestHttpRequest) => string | undefined;
  /** Resolve the active client; default the process-singleton carrier client. Injectable for tests. */
  getClient?: () => Bugsee | undefined;
  /** Mint a context id; default `crypto.randomUUID`. Injectable for tests. */
  newContextId?: () => string;
  /**
   * Decide whether a thrown error should be reported. Default {@link defaultShouldReport}: skip Nest
   * HttpExceptions (control flow), report genuine unhandled errors.
   */
  shouldReport?: (err: unknown) => boolean;
}

export const headerValue = (
  headers: NestHttpRequest['headers'],
  lowercaseName: string,
): string | undefined => {
  const value = headers[lowercaseName];
  return Array.isArray(value) ? value[0] : value;
};

/** The matched route pattern (`/users/:id`) — express `route.path` or fastify `routeOptions.url`; undefined before routing. */
export const matchedRoute = (req: NestHttpRequest): string | undefined =>
  req.route?.path ?? req.routeOptions?.url;

/** A human transaction name: `METHOD route` (or the raw URL before routing). */
export const requestName = (req: NestHttpRequest): string => {
  const method = req.method ?? 'GET';
  const path = matchedRoute(req) ?? req.originalUrl ?? req.url ?? '';
  return `${method} ${path}`;
};

/** Build the per-request context from the request + an id minter + the (optional) resolved user. */
export const buildContext = (
  req: NestHttpRequest,
  newContextId: () => string,
  user: string | undefined,
): RequestContext => {
  const method = req.method ?? 'GET';
  const url = req.originalUrl ?? req.url ?? '';
  return {
    contextId: newContextId(),
    attributes: { 'http.method': method, 'http.url': url },
    ...(user !== undefined ? { user } : {}),
  };
};

export const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

export const resolveStore = (client: Bugsee): RequestContextStore | undefined =>
  client.getServiceProvider(RequestContextStoreToken).getImmediate({ optional: true }) ?? undefined;

/** The performance extension is optional; ext() throws when it is not registered (bare @bugsee/node). */
export const tryGetPerf = (client: Bugsee): PerformanceApi | undefined => {
  try {
    return client.ext('performance');
  } catch {
    return undefined;
  }
};

/**
 * The HTTP status of a Nest `HttpException`-like error — duck-typed by a `getStatus()` method that returns
 * a number — or `undefined` when the value is not an HttpException. Single source of truth for the
 * HttpException-vs-genuine-error distinction used by both the report policy and the transaction outcome.
 */
export const httpExceptionStatus = (err: unknown): number | undefined => {
  const getStatus = (err as { getStatus?: unknown } | null | undefined)?.getStatus;
  if (typeof getStatus !== 'function') {
    return undefined;
  }
  const status = (err as { getStatus: () => unknown }).getStatus();
  return typeof status === 'number' ? status : undefined;
};

/**
 * Default report policy (matches the studied Sentry behavior): a Nest `HttpException` (4xx AND 5xx) is
 * deliberate control flow, so it is NOT reported; everything else (uncaught plain Errors, etc.) is a
 * genuine unhandled error and IS reported.
 */
export const defaultShouldReport = (err: unknown): boolean =>
  httpExceptionStatus(err) === undefined;

/**
 * Whether a thrown error represents a SERVER failure for the http.server transaction outcome: a
 * non-HttpException (genuine unhandled error) or an HttpException with a 5xx status → ERROR; a 4xx
 * HttpException is client-side control flow → OK. Mirrors express/fastify's `status >= 500` rule but uses
 * the reliable THROWN-error status (the response status is not yet written at the rxjs stream's terminal).
 */
export const isServerError = (err: unknown): boolean => {
  const status = httpExceptionStatus(err);
  return status === undefined || status >= 500;
};

/**
 * Report an error once, applying the report policy + (optional) cross-seam dedup + route enrichment.
 * Returns whether it actually reported. Never throws into the caller's request pipeline beyond what
 * `logException` (fire-and-forget) does.
 */
export function reportErrorOnce(
  client: Bugsee,
  err: unknown,
  options: {
    shouldReport: (err: unknown) => boolean;
    /** The matched route to stamp as `http.route` before reporting (known once routing has run). */
    route?: string;
    /** Shared set for `both`-seam dedup; object errors already in it are skipped. Omit to disable dedup. */
    reported?: WeakSet<object>;
  },
): boolean {
  if (!options.shouldReport(err)) {
    return false;
  }
  if (options.reported !== undefined && typeof err === 'object' && err !== null) {
    if (options.reported.has(err)) {
      return false;
    }
    options.reported.add(err);
  }
  if (options.route !== undefined) {
    resolveStore(client)?.setAttribute('http.route', options.route);
  }
  void client.logException(err, { mechanism: 'http-error' });
  return true;
}
