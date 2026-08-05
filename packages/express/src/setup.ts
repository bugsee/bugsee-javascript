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
        app.use(errorHandler(adapter));
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
