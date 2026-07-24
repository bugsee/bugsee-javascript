// @bugsee/angular — Angular adapter (tier 4). Error seam (ErrorHandler) + Router naming.
// See docs/design/frontend-adapters.md §7. Structural peer — no @angular/core / @angular/router import.
// v1: error + routing only (component/change-detection depth is the shared depth pass).

// Single-install re-export: surface the full public SDK (launch, Bugsee, options + manual-API
// types) so users install only `@bugsee/angular` and import everything from one place.
export * from '@bugsee/bugsee';
export {
  type AngularErrorHandlerOptions,
  type AngularErrorMechanism,
  type AngularErrorOptions,
  BugseeErrorHandler,
  createAngularErrorHandler,
  reportAngularError,
} from './error';
export {
  type AngularRenderTrackerOptions,
  type BugseeRenderTracker,
  createBugseeRenderTracker,
} from './render-tracker';
export {
  type AngularRouterLike,
  type RouteNamingOptions,
  type RouteSnapshotLike,
  routePatternFromSnapshot,
  setRouteName,
  setRouteNameFromRouter,
} from './router';
