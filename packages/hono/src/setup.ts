import { neverThrow } from '@bugsee/node';
import { bugseeHono, type HonoAdapterOptions, type HonoMiddleware } from './middleware';

// One-call setup over the Bugsee Hono middleware (design: docs/design/framework-adapters.md). Call it once
// at startup; the single middleware opens the per-request context, runs the APM transaction, and reports
// handled errors (via c.error) without touching your `onError`.

/** The minimal Hono application surface setupHono needs. */
export interface HonoApp {
  use(middleware: HonoMiddleware): unknown;
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
export function setupHono(app: HonoApp, options: HonoAdapterOptions = {}): void {
  neverThrow(() => setupHonoUnsafe(app, options), options.onError);
}

function setupHonoUnsafe(app: HonoApp, options: HonoAdapterOptions = {}): void {
  app.use(bugseeHono(options));
}
