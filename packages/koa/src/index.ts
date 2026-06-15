// @bugsee/koa — Koa middleware adapter (tier 4, design: docs/design/framework-adapters.md).
// A single middleware over the per-request context foundation. koa is a PEER (structural types only).
// Works on node/bun/deno-hosted Koa (wherever the launched @bugsee/node client provides the context store).
export {
  bugseeKoa,
  type KoaAdapterOptions,
  type KoaContextLike,
  type KoaMiddleware,
  type KoaNext,
} from './middleware';
export { type KoaApp, setupKoa } from './setup';
