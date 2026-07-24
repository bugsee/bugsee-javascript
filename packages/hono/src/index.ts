// @bugsee/hono — Hono middleware adapter (tier 4, design: docs/design/framework-adapters.md).
// A single middleware over the per-request context foundation. hono is a PEER (structural types only).
// Works on node/bun/deno-hosted Hono (wherever the launched @bugsee/node client provides the context store).

// Single-install re-export: surface the full public SDK (launch, Bugsee, options + manual-API
// types) so users install only `@bugsee/hono` and import everything from one place.
export * from '@bugsee/bugsee/node';
export {
  bugseeHono,
  type HonoAdapterOptions,
  type HonoContextLike,
  type HonoMiddleware,
  type HonoNext,
  type HonoRequestLike,
} from './middleware';
export { type HonoApp, setupHono } from './setup';
