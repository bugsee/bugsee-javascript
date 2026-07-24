// @bugsee/solid — Solid adapter (tier 4). Error reporting (onError/ErrorBoundary) + @solidjs/router naming.
// See docs/design/frontend-adapters.md §7. Structural peer — no solid-js / @solidjs/router import.
// v1: error + routing only.

// Single-install re-export: surface the full public SDK (launch, Bugsee, options + manual-API
// types) so users install only `@bugsee/solid` and import everything from one place.
export * from '@bugsee/bugsee';
export {
  reportSolidError,
  type SolidErrorMechanism,
  type SolidErrorOptions,
  solidErrorHandler,
} from './error';
export {
  type RouteNamingOptions,
  routePatternFromSolidMatches,
  type SolidRouteMatchLike,
  setRouteName,
  setRouteNameFromSolidMatches,
} from './router';
