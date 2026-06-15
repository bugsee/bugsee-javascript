import {
  type ErrorMiddleware,
  type ExpressAdapterOptions,
  errorHandler,
  type RequestMiddleware,
  requestHandler,
} from './middleware';

// Ergonomic one-call setup over the two middlewares (design: docs/design/framework-adapters.md). Express
// forces the error handler to be registered AFTER the routes (it only catches errors from layers before
// it). setupExpress installs the request middleware now and, by default, appends the error handler on the
// FIRST request — by which point all routes are registered (apps wire routes synchronously at startup),
// so it lands last. Express walks its middleware stack live, so even that first request's error is caught.
// If you have your OWN error-response middleware, set { autoErrorHandler: false } and call
// setupExpressErrorHandler() yourself, right before yours.

/** The minimal Express application surface setupExpress needs. */
export interface ExpressApp {
  use(handler: RequestMiddleware | ErrorMiddleware): unknown;
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
export function setupExpress(app: ExpressApp, options: SetupExpressOptions = {}): void {
  const { autoErrorHandler = true, ...adapter } = options;
  if (autoErrorHandler) {
    let installed = false;
    const installer: RequestMiddleware = (_req, _res, next) => {
      if (!installed) {
        installed = true;
        app.use(errorHandler(adapter));
      }
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
  app.use(errorHandler(options));
}
