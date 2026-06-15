import { parseTraceparent } from '@bugsee/capture';
import type { Bugsee } from '@bugsee/node';
import type { Transaction } from '@bugsee/performance';
import { type Observable, throwError } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
import {
  defaultGetClient,
  defaultShouldReport,
  headerValue,
  isServerError,
  matchedRoute,
  type NestAdapterOptions,
  type NestHttpRequest,
  type NestHttpResponse,
  reportErrorOnce,
  requestName,
  resolveStore,
  tryGetPerf,
} from './shared';

// The DEFAULT error seam for @bugsee/nestjs: a global NestInterceptor. It is non-intrusive — its
// catchError REPORTS then RE-THROWS, so Nest's own exception filters still format the response exactly
// as before (zero app-behavior change), and it never conflicts with a user's own global filter. It also
// owns the `http.server` APM transaction (start before the handler, finish on the stream's terminal).
//
// Coverage (empirically verified, see docs/design/framework-adapters.md): catchError sees errors from the
// route handler, services, pipes, and HttpExceptions — i.e. essentially all real unhandled bugs. It does
// NOT see errors thrown in GUARDS or MIDDLEWARE (they run before the interceptor's stream is subscribed);
// that gap is the reason to opt into the global filter (errorCapture: 'filter' | 'both').
//
// Structural Nest types only — nothing here imports @nestjs/* (rxjs is the sole runtime peer).

/** Minimal structural NestJS ExecutionContext (HTTP view). */
export interface ExecutionContextLike {
  switchToHttp(): {
    getRequest<T = NestHttpRequest>(): T;
    getResponse<T = NestHttpResponse>(): T;
  };
}
/** Minimal structural NestJS CallHandler. */
export interface CallHandlerLike {
  handle(): Observable<unknown>;
}

export class BugseeInterceptor {
  private readonly getClient: () => Bugsee | undefined;
  private readonly shouldReport: (err: unknown) => boolean;
  /** Shared cross-seam dedup set (injected by setupNest in `both` mode); undefined disables dedup. */
  private readonly reported: WeakSet<object> | undefined;

  constructor(options: NestAdapterOptions = {}, reported?: WeakSet<object>) {
    this.getClient = options.getClient ?? defaultGetClient;
    this.shouldReport = options.shouldReport ?? defaultShouldReport;
    this.reported = reported;
  }

  intercept(context: ExecutionContextLike, next: CallHandlerLike): Observable<unknown> {
    let client: Bugsee | undefined;
    try {
      client = this.getClient();
    } catch {
      return next.handle(); // client resolution failed → never touch the request
    }
    if (client === undefined) {
      return next.handle();
    }

    let req: NestHttpRequest;
    let res: NestHttpResponse;
    try {
      const http = context.switchToHttp();
      req = http.getRequest<NestHttpRequest>();
      res = http.getResponse<NestHttpResponse>();
    } catch {
      return next.handle(); // non-HTTP context (RPC/WS/GraphQL) → out of scope, pass through
    }

    let transaction: Transaction | undefined;
    try {
      transaction = this.startTransaction(client, req);
    } catch {
      transaction = undefined; // APM wiring failure must never break the request
    }

    const activeClient = client;
    // Outcome for the transaction: success defaults to OK; an error sets it from the THROWN error's status
    // (a 4xx HttpException is client control flow → still OK; a 5xx / non-HttpException → ERROR).
    let outcome: 'OK' | 'ERROR' = 'OK';
    return next.handle().pipe(
      catchError((err) => {
        outcome = isServerError(err) ? 'ERROR' : 'OK';
        try {
          reportErrorOnce(activeClient, err, {
            shouldReport: this.shouldReport,
            route: matchedRoute(req),
            reported: this.reported,
          });
        } catch {
          // reporting must never replace the app's own error handling
        }
        return throwError(() => err); // re-throw untouched → Nest's filters format the response
      }),
      finalize(() => {
        try {
          this.finishTransaction(transaction, req, res, outcome);
        } catch {
          // finishing APM must never break the response lifecycle
        }
      }),
    );
  }

  private startTransaction(client: Bugsee, req: NestHttpRequest): Transaction | undefined {
    const perf = tryGetPerf(client);
    if (perf === undefined) {
      return undefined;
    }
    const inbound = parseTraceparent(headerValue(req.headers, 'traceparent'));
    const transaction = perf.startTransaction({
      name: requestName(req),
      operation: 'http.server',
      ...(inbound !== undefined ? { continuation: { traceId: inbound.traceId } } : {}),
    });
    // Publish the server transaction's trace onto the context so capture entries are stamped with it.
    resolveStore(client)?.setTrace({
      traceId: transaction.getTraceId(),
      spanId: transaction.getSpanId(),
    });
    return transaction;
  }

  private finishTransaction(
    transaction: Transaction | undefined,
    req: NestHttpRequest,
    res: NestHttpResponse,
    outcome: 'OK' | 'ERROR',
  ): void {
    if (transaction === undefined || transaction.isFinished()) {
      return;
    }
    transaction.setName(requestName(req)); // route now parametrized (routing has run)
    transaction.setAttribute('http.method', req.method ?? 'GET');
    // Best-effort: at the stream's terminal Nest may not have written the final status yet, so this is the
    // response's current status — the OK/ERROR outcome comes from the reliable thrown-error status instead.
    transaction.setAttribute('http.status_code', res.statusCode ?? 0);
    transaction.finish(outcome);
  }
}
