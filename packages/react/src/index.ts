// @bugsee/react — React adapter (tier 4). Error seam (BugseeErrorBoundary + HOC) + the reporting core.
// See docs/design/frontend-adapters.md §6 (D8). React is a structural peer — imported only in the boundary.
export {
  BugseeErrorBoundary,
  type BugseeErrorBoundaryProps,
  withBugseeErrorBoundary,
} from './error-boundary';
export {
  linkComponentStack,
  type ReactErrorMechanism,
  type ReportReactErrorOptions,
  reportReactError,
} from './report';
export {
  instrumentRouterMatches,
  type RouteMatchLike,
  type RouteNamingOptions,
  routePatternFromMatches,
  setRouteName,
} from './router';
