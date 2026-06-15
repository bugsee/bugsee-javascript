import { bugseeKoa, type KoaAdapterOptions, type KoaMiddleware } from './middleware';

// One-call setup over the Bugsee Koa middleware (design: docs/design/framework-adapters.md). Install it
// FIRST (before your routes/error middleware) so the single middleware wraps the whole chain.

/** The minimal Koa application surface setupKoa needs. */
export interface KoaApp {
  use(middleware: KoaMiddleware): unknown;
}

/** Register the Bugsee middleware on the app. Call once at startup, before your routes. */
export function setupKoa(app: KoaApp, options: KoaAdapterOptions = {}): void {
  app.use(bugseeKoa(options));
}
