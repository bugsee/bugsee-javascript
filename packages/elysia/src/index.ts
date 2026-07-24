// @bugsee/elysia — Elysia plugin adapter (tier 4, design: docs/design/framework-adapters.md).
// Hook-based setup over the per-request context foundation. elysia is a PEER (structural types only).
// Works on node/bun/deno-hosted Elysia (wherever the launched @bugsee/node client provides the context store).

// Single-install re-export: surface the full public SDK (launch, Bugsee, options + manual-API
// types) so users install only `@bugsee/elysia` and import everything from one place.
export * from '@bugsee/bugsee/node';
export {
  type ElysiaAdapterOptions,
  type ElysiaAppLike,
  type ElysiaContextLike,
  type ElysiaErrorContextLike,
  type ElysiaRequestLike,
  setupElysia,
} from './hooks';
