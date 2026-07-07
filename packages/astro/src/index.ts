// @bugsee/astro — the package `.` entry, which will be the Astro Integration (`bugsee()`, AS3) that wires a
// browser launch (`injectScript('page')`) + the request middleware (error capture + trace) + server/edge
// init. Until AS3, the middleware surface is re-exported here for convenience (also at `@bugsee/astro/
// middleware`, the Astro `addMiddleware` entrypoint).
export {
  type AstroMiddleware,
  type AstroMiddlewareContext,
  type AstroMiddlewareNext,
  type CreateBugseeMiddlewareOptions,
  createBugseeMiddleware,
  onRequest,
} from './middleware';
