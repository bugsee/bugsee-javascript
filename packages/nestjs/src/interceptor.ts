import {
  type Bugsee,
  type ServerInstrumentOptions,
  type ServerRequestInfo,
  type ServerRequestSpan,
  startServerSpan,
} from '@bugsee/node';
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
} from './shared';

// The DEFAULT error seam for @bugsee/nestjs: a global NestInterceptor. It is non-intrusive — its
// catchError REPORTS then RE-THROWS, so Nest's own exception filters still format the response exactly
// as before (zero app-behavior change), and it never conflicts with a user's own global filter. It also
// owns the `http.server` APM transaction (started before the handler, finished on the stream's terminal)
// over the shared server-instrumentation core (`startServerSpan`): standalone it OWNS the transaction; when
// the node:http auto-instrument also runs it REFINES that owner's span instead (first-owner-wins
// re-entrancy) — exactly one context + one transaction either way. Error reporting stays direct via
// `reportErrorOnce` (NOT the span's captureError) because the cross-seam `both`-mode dedup (the shared
// WeakSet) is a Nest-specific concern the core span does not model.
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
  private readonly user: ((req: NestHttpRequest) => string | undefined) | undefined;
  /** Shared cross-seam dedup set (injected by setupNest in `both` mode); undefined disables dedup. */
  private readonly reported: WeakSet<object> | undefined;

  constructor(options: NestAdapterOptions = {}, reported?: WeakSet<object>) {
    this.getClient = options.getClient ?? defaultGetClient;
    this.shouldReport = options.shouldReport ?? defaultShouldReport;
    this.user = options.user;
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

    const activeClient = client;
    // Start (standalone) or refine (re-entrancy with the node:http owner) the http.server span.
    const span = this.openSpan(activeClient, req);
    // Outcome for the transaction: success defaults to OK; an error sets it from the THROWN error's status
    // (a 4xx HttpException is client control flow → still OK; a 5xx / non-HttpException → ERROR). Under
    // re-entrancy the refining span's finish is a no-op and the node:http owner finishes by response status
    // (which Nest writes to match the exception), so the two outcomes agree.
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
          const route = matchedRoute(req);
          if (route !== undefined) {
            span.setRoute(route); // route now parametrized (routing has run) — refines the txn name
          }
          span.finish(res.statusCode ?? 0, outcome);
        } catch {
          // finishing APM must never break the response lifecycle
        }
      }),
    );
  }

  /**
   * Start the http.server span in the active context via the shared core. When the node:http auto-instrument
   * already owns this request (re-entrancy), `startServerSpan` returns a REFINING handle over that owner's
   * span (no second transaction) and propagates this adapter's resolved user onto the owner's context;
   * otherwise it starts a new transaction (the middleware has already opened the context + set the user).
   * Fully defensive — a throwing user getter degrades to "no user" rather than losing the transaction; the
   * core never throws into the request.
   */
  private openSpan(client: Bugsee, req: NestHttpRequest): ServerRequestSpan {
    let user: string | undefined;
    try {
      user = this.user?.(req);
    } catch {
      user = undefined; // a throwing user getter must not lose the transaction
    }
    const route = matchedRoute(req);
    const traceparent = headerValue(req.headers, 'traceparent');
    const info: ServerRequestInfo = {
      method: req.method ?? 'GET',
      url: req.originalUrl ?? req.url ?? '',
      ...(route !== undefined ? { route } : {}),
      ...(traceparent !== undefined ? { traceparent } : {}),
      ...(user !== undefined ? { user } : {}),
    };
    const options: ServerInstrumentOptions = {
      getClient: () => client,
      shouldReport: this.shouldReport,
    };
    return startServerSpan(info, options);
  }
}
