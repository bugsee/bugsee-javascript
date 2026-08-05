import { neverThrow } from '@bugsee/node';
import { bugseeKoa, type KoaAdapterOptions, type KoaMiddleware } from './middleware';

// One-call setup over the Bugsee Koa middleware (design: docs/design/framework-adapters.md). Install it
// FIRST (before your routes/error middleware) so the single middleware wraps the whole chain.

/** The minimal Koa application surface setupKoa needs. */
export interface KoaApp {
  use(middleware: KoaMiddleware): unknown;
}

/** Register the Bugsee middleware on the app. Call once at startup, before your routes. */
/**
 * CONTAINED. This runs at SERVER BOOTSTRAP, walking a host-supplied app/server object and calling its
 * registration methods. An unguarded throw here does not cost one report — it stops the application
 * starting at all, which is the most severe form of the failure Wave 2.1 exists to prevent.
 *
 * The failure is routed to `onError`, NOT swallowed. Containing a bootstrap failure silently would trade
 * this defect for the one Wave 4 is about ("features that silently do nothing"); reporting it keeps the
 * app alive AND tells anyone who wired a sink that instrumentation did not install.
 */
export function setupKoa(app: KoaApp, options: KoaAdapterOptions = {}): void {
  neverThrow(() => setupKoaUnsafe(app, options), options.onError);
}

function setupKoaUnsafe(app: KoaApp, options: KoaAdapterOptions = {}): void {
  app.use(bugseeKoa(options));
}
