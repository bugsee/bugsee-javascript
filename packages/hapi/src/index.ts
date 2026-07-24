// @bugsee/hapi — Hapi adapter (tier 4, design: docs/design/framework-adapters.md).
// Lifecycle-extension setup over the per-request context foundation. @hapi/hapi is a PEER (structural
// types only). Works on node/bun/deno-hosted Hapi (wherever the launched @bugsee/node client provides the
// context store).

// Single-install re-export: surface the full public SDK (launch, Bugsee, options + manual-API
// types) so users install only `@bugsee/hapi` and import everything from one place.
export * from '@bugsee/bugsee/node';
export {
  type HapiAdapterOptions,
  type HapiBoomLike,
  type HapiExtension,
  type HapiRequestLike,
  type HapiServerLike,
  type HapiToolkitLike,
  setupHapi,
} from './hooks';
