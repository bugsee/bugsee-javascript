// @bugsee/express — Express middleware adapter (tier 4, design: docs/design/framework-adapters.md).
// Opt-in middlewares over the per-request context foundation. express is a PEER dependency.
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
