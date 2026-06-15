// @bugsee/restify — Restify adapter (tier 4, design: docs/design/framework-adapters.md).
// use-middleware + after-event setup over the per-request context foundation. restify is a PEER (structural
// types only). NOTE: restify 11.x does not import on Node >= 18 (spdy/http-deceiver uses the removed
// process.binding('http_parser')); the adapter is structural and runs wherever restify itself runs.
export {
  type RestifyAdapterOptions,
  type RestifyAfterHandler,
  type RestifyMiddleware,
  type RestifyNext,
  type RestifyRequestLike,
  type RestifyResponseLike,
  type RestifyRouteLike,
  type RestifyServerLike,
  setupRestify,
} from './setup';
