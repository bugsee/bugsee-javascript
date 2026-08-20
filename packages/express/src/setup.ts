import { neverThrow } from '@bugsee/node';
import {
  type ErrorMiddleware,
  type ExpressAdapterOptions,
  errorHandler,
  type RequestMiddleware,
  requestHandler,
} from './middleware';

// Ergonomic one-call setup over the two middlewares (design: docs/design/framework-adapters.md). Express
// forces the error handler to be registered AFTER the routes (it only catches errors from layers before
// it). setupExpress installs the request middleware now and, by default, the error handler after the
// routes via two paths sharing an install-once flag:
//   1. PRIMARY (deterministic) — wrap app.listen so the first listen() installs the handler before any
//      request is served; routes are already registered (apps wire them synchronously before listen()).
//   2. FALLBACK — apps that never call app.listen (http.createServer(app) / serverless) install on the
//      first request instead. Express walks its stack live, so even that first request's error is caught.
// If you have your OWN error-response middleware, set { autoErrorHandler: false } and call
// setupExpressErrorHandler() yourself, right before yours.

/**
 * Register Bugsee's error handler so it runs BEFORE any error middleware the app already has.
 *
 * `app.use` appends, and Express runs error middleware in registration order. The ordinary way to
 * write an Express app is setup → routes → your own error responder → listen, so appending at listen
 * put Bugsee's handler AFTER that responder — and a responder that sends a response without calling
 * `next(err)`, which is what every real one does, means Bugsee's handler is never reached. Errors went
 * unreported on the DEFAULT path, silently.
 *
 * So: append as usual, then move the layer ahead of the app's first error-handling layer. Express
 * keeps its layers on `app.router.stack` (v5) / `app._router.stack` (v4), each with a `handle` whose
 * ARITY distinguishes error middleware (4) from request middleware (3). Every step is guarded — an
 * app whose internals do not look like this (a wrapper, a future layout) keeps today's behaviour
 * rather than losing the handler altogether.
 */
function insertErrorHandler(
  app: ExpressApp,
  handler: ErrorMiddleware,
  onError?: (error: unknown) => void,
): void {
  // Where the app's own error middleware starts, decided BEFORE appending — an append cannot shift
  // any earlier index, so this stays valid afterwards.
  const stack = routerStack(app, onError);
  const at =
    stack?.findIndex((layer) => typeof layer.handle === 'function' && layer.handle.length === 4) ??
    -1;
  app.use(handler); // let Express build the layer, however it does that in this version
  if (stack === undefined || at === -1) return; // unrecognised app, or nothing to get in front of
  // Move the layer Express just appended to the front of the app's error middleware.
  neverThrow(() => {
    stack.splice(at, 0, ...stack.splice(stack.length - 1, 1));
  }, onError);
}

/** Express's live middleware layers — `app.router.stack` (v5) / `app._router.stack` (v4). */
function routerStack(
  app: ExpressApp,
  onError?: (error: unknown) => void,
): Array<{ handle?: unknown }> | undefined {
  let stack: unknown;
  neverThrow(() => {
    const internals = app as { router?: { stack?: unknown }; _router?: { stack?: unknown } };
    stack = internals.router?.stack ?? internals._router?.stack;
  }, onError);
  return Array.isArray(stack) ? (stack as Array<{ handle?: unknown }>) : undefined;
}

/** The minimal Express application surface setupExpress needs. */
export interface ExpressApp {
  use(handler: RequestMiddleware | ErrorMiddleware): unknown;
  /** Present on a real express app; wrapped so the error handler installs deterministically at listen. */
  listen?: (...args: never[]) => unknown;
}

export interface SetupExpressOptions extends ExpressAdapterOptions {
  /**
   * Auto-append the error handler after your routes (on the first request). Default true. Set false when
   * you place {@link setupExpressErrorHandler} yourself — e.g. you have a custom error-response middleware
   * and need Bugsee's handler to run just before it.
   */
  autoErrorHandler?: boolean;
}

/**
 * One-call Express setup: installs the request middleware immediately and (by default) the error handler
 * after your routes. Call once at startup, before you register routes.
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
export function setupExpress(app: ExpressApp, options: SetupExpressOptions = {}): void {
  neverThrow(() => setupExpressUnsafe(app, options), options.onError);
}

function setupExpressUnsafe(app: ExpressApp, options: SetupExpressOptions = {}): void {
  const { autoErrorHandler = true, ...adapter } = options;
  if (autoErrorHandler) {
    let installed = false;
    const installErrorHandler = (): void => {
      if (!installed) {
        installed = true;
        insertErrorHandler(app, errorHandler(adapter), options.onError);
      }
    };
    // (1) Primary: install deterministically when the server starts listening — after the routes, before
    // any request. Wrap app.listen so the first call installs the handler, then delegates to the original.
    const originalListen = app.listen;
    if (typeof originalListen === 'function') {
      app.listen = (...args) => {
        installErrorHandler();
        return originalListen.apply(app, args);
      };
    }
    // (2) Fallback for apps that never call app.listen (http.createServer(app) / serverless): install on
    // the first request. Shares the install-once flag, so it never double-installs.
    const installer: RequestMiddleware = (_req, _res, next) => {
      installErrorHandler();
      next();
    };
    app.use(installer);
  }
  app.use(requestHandler(adapter));
}

/**
 * Install Bugsee's Express error handler explicitly. Place it after your routes and just before your own
 * error-response middleware. Use this (with `setupExpress(app, { autoErrorHandler: false })`) when you
 * have a custom error handler.
 */
export function setupExpressErrorHandler(
  app: ExpressApp,
  options: ExpressAdapterOptions = {},
): void {
  // CONTAINED for the same reason as setupExpress — see its doc comment. Registration runs at bootstrap.
  neverThrow(() => app.use(errorHandler(options)), options.onError);
}
