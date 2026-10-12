// @bugsee/svelte — SvelteKit adapter. Error seam (handleError hook) + navigation naming.
// Structural peer — no svelte/@sveltejs/kit import.
// v1: client error + routing only (server hooks + component depth are follow-ups / the shared depth pass).

// Single-install re-export: surface the full public SDK (launch, Bugsee, options + manual-API
// types) so users install only `@bugsee/svelte` and import everything from one place.
export * from '@bugsee/bugsee';
export {
  type HandleErrorHook,
  type HandleErrorInput,
  handleErrorWithBugsee,
  type ReportSvelteErrorOptions,
  reportSvelteError,
  type SvelteErrorMechanism,
  type SvelteErrorOptions,
} from './error';
export { type SvelteRenderSpanOptions, startSvelteRenderSpan } from './render-span';
export {
  type AfterNavigateLike,
  instrumentSvelteKitNavigation,
  type RouteNamingOptions,
  routeIdFromNavigation,
  setRouteName,
} from './router';
