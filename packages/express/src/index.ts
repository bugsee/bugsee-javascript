// @bugsee/express — Express middleware adapter (tier 4, design: docs/design/framework-adapters.md).
// Opt-in middlewares over the per-request context foundation. express is a PEER dependency.

// Single-install re-export: surface the full public SDK (launch, Bugsee, options + manual-API
// types) so users install only `@bugsee/express` and import everything from one place.
export * from '@bugsee/bugsee/node';
export {
  type ErrorMiddleware,
  type ExpressAdapterOptions,
  type ExpressRequest,
  type ExpressResponse,
  errorHandler,
  type NextFunction,
  type RequestMiddleware,
  requestHandler,
} from './middleware';
export {
  type ExpressApp,
  type SetupExpressOptions,
  setupExpress,
  setupExpressErrorHandler,
} from './setup';
