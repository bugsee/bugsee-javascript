import { bugseeHono, type HonoAdapterOptions, type HonoMiddleware } from './middleware';

// One-call setup over the Bugsee Hono middleware (design: docs/design/framework-adapters.md). Call it once
// at startup; the single middleware opens the per-request context, runs the APM transaction, and reports
// handled errors (via c.error) without touching your `onError`.

/** The minimal Hono application surface setupHono needs. */
export interface HonoApp {
  use(middleware: HonoMiddleware): unknown;
}

/** Register the Bugsee middleware on the app. Call once at startup, before your routes. */
export function setupHono(app: HonoApp, options: HonoAdapterOptions = {}): void {
  app.use(bugseeHono(options));
}
