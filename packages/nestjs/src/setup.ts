import type { BaseExceptionFilter } from '@nestjs/core';
import { BugseeExceptionFilter } from './filter';
import { BugseeInterceptor } from './interceptor';
import { createBugseeMiddleware, type NestRequestMiddleware } from './middleware';
import type { NestAdapterOptions } from './shared';

// One-call setup for @bugsee/nestjs. Call it in main.ts after NestFactory.create(...). It installs the
// per-request context middleware plus the chosen error/APM seam(s) over the foundation. By default it
// uses the non-intrusive interceptor (the studied trade-off lives in docs/design/framework-adapters.md):
//   setupNest(app)                              // interceptor: handler/service/pipe errors + APM
//   setupNest(app, { errorCapture: 'filter' })  // global filter: ALSO guard/pipe errors (broadest)
//   setupNest(app, { errorCapture: 'both' })    // both, deduped (an error seen by both reports once)
// The building blocks (createBugseeMiddleware / BugseeInterceptor / BugseeExceptionFilter /
// BugseeExceptionCaptured) are also exported for DI-style wiring (APP_INTERCEPTOR / APP_FILTER).

/** Which seam(s) capture unhandled errors. Default `interceptor`. */
export type ErrorCapture = 'interceptor' | 'filter' | 'both';

export interface SetupNestOptions extends NestAdapterOptions {
  /**
   * Which error-capture seam(s) to install. `interceptor` (default) is non-intrusive and catches
   * handler/service/pipe errors; `filter` adds a global ExceptionFilter that also catches guard-thrown
   * errors (at the cost of importing @nestjs/core + a possible collision with your own global filter);
   * `both` installs both with cross-seam dedup.
   */
  errorCapture?: ErrorCapture;
}

/** The minimal NestJS application surface setupNest needs. */
export interface NestApp {
  use(middleware: NestRequestMiddleware): unknown;
  useGlobalInterceptors(...interceptors: object[]): unknown;
  useGlobalFilters(...filters: object[]): unknown;
  /** The underlying http adapter, handed to BaseExceptionFilter so it can format the response. */
  getHttpAdapter(): unknown;
}

export function setupNest(app: NestApp, options: SetupNestOptions = {}): void {
  const { errorCapture = 'interceptor', ...adapter } = options;

  // 1) Context middleware — registered first so it opens the per-request context before guards run.
  app.use(createBugseeMiddleware(adapter));

  // 2) Error/APM seam(s). `both` shares a dedup set so an error caught by the interceptor AND the filter
  // is reported exactly once.
  const reported = errorCapture === 'both' ? new WeakSet<object>() : undefined;
  if (errorCapture === 'interceptor' || errorCapture === 'both') {
    app.useGlobalInterceptors(new BugseeInterceptor(adapter, reported));
  }
  if (errorCapture === 'filter' || errorCapture === 'both') {
    const applicationRef = app.getHttpAdapter() as ConstructorParameters<
      typeof BaseExceptionFilter
    >[0];
    app.useGlobalFilters(new BugseeExceptionFilter(adapter, reported, applicationRef));
  }
}
