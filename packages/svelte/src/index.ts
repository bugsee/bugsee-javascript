// @bugsee/svelte — SvelteKit adapter (tier 4). Error seam (handleError hook) + navigation naming.
// See docs/design/frontend-adapters.md §7. Structural peer — no svelte/@sveltejs/kit import.
// v1: client error + routing only (server hooks + component depth are follow-ups / the shared depth pass).
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
