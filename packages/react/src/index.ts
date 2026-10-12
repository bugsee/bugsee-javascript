// @bugsee/react — React adapter. Error seam (BugseeErrorBoundary + HOC) + the reporting core.
// React is a structural peer — imported only in the boundary.

// Single-install re-export: surface the full public SDK (launch, Bugsee, options + manual-API types)
// through this adapter, so users install only `@bugsee/react` and import everything from one place.
export * from '@bugsee/bugsee';
export {
  BugseeErrorBoundary,
  type BugseeErrorBoundaryProps,
  withBugseeErrorBoundary,
} from './error-boundary';
export {
  createBugseeErrorHandlers,
  type ReactErrorInfo,
  type ReactRootErrorHandlers,
} from './handlers';
export {
  BugseeProfiler,
  type BugseeProfilerProps,
  type ReactRenderProfile,
  type RecordRenderOptions,
  recordReactRenderSpan,
  withBugseeProfiler,
} from './profiler';
export {
  linkComponentStack,
  type ReactErrorMechanism,
  type ReportReactErrorOptions,
  reportReactError,
  reportRouteError,
} from './report';
export {
  instrumentReactRouter,
  instrumentRouterMatches,
  type ReactDataRouterLike,
  type RouteMatchLike,
  type RouteNamingOptions,
  routePatternFromMatches,
  setRouteName,
} from './router';
