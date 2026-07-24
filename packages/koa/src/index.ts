// @bugsee/koa — Koa middleware adapter (tier 4, design: docs/design/framework-adapters.md).
// A single middleware over the per-request context foundation. koa is a PEER (structural types only).
// Works on node/bun/deno-hosted Koa (wherever the launched @bugsee/node client provides the context store).

// Single-install re-export: surface the full public SDK (launch, Bugsee, options + manual-API
// types) so users install only `@bugsee/koa` and import everything from one place.
export * from '@bugsee/bugsee/node';
export {
  bugseeKoa,
  type KoaAdapterOptions,
  type KoaContextLike,
  type KoaMiddleware,
  type KoaNext,
} from './middleware';
export { type KoaApp, setupKoa } from './setup';
