// @bugsee/nestjs — NestJS adapter (tier 4, design: docs/design/framework-adapters.md).
// One-call setupNest over the per-request context foundation + a configurable error/APM seam:
//   - DEFAULT interceptor (non-intrusive: report + rethrow, no @nestjs/core import, no filter conflict)
//   - opt-in global ExceptionFilter (broadest coverage incl. guards) and/or `both` (deduped).
// @nestjs/common, @nestjs/core and rxjs are PEER dependencies.

// Single-install re-export: surface the full public SDK (launch, Bugsee, options + manual-API
// types) so users install only `@bugsee/nestjs` and import everything from one place.
export * from '@bugsee/bugsee/node';
export { BugseeExceptionCaptured, BugseeExceptionFilter } from './filter';
export {
  BugseeInterceptor,
  type CallHandlerLike,
  type ExecutionContextLike,
} from './interceptor';
export {
  createBugseeMiddleware,
  type NestNextFunction,
  type NestRequestMiddleware,
} from './middleware';
export { type ErrorCapture, type NestApp, type SetupNestOptions, setupNest } from './setup';
export type { NestAdapterOptions, NestHttpRequest, NestHttpResponse } from './shared';
