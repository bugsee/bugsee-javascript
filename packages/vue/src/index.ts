// @bugsee/vue — Vue 3 adapter (tier 4). Error seam (app.config.errorHandler) + vue-router naming.
// See docs/design/frontend-adapters.md §7. Vue is a structural peer — no `vue`/`vue-router` import.
// v1: error + routing only (component-render depth is the shared depth pass).

// Single-install re-export: surface the full public SDK (launch, Bugsee, options + manual-API
// types) so users install only `@bugsee/vue` and import everything from one place.
export * from '@bugsee/bugsee';
export {
  type BugseeVueComponentMixin,
  createBugseeVueComponentMixin,
  type VueComponentInstanceLike,
} from './component-annotate';
export {
  installBugseeErrorHandler,
  type ReportVueErrorOptions,
  reportVueError,
  type VueAppLike,
  type VueErrorMechanism,
  type VueErrorOptions,
} from './error';
export {
  type BugseeVueRenderMixin,
  createBugseeVueRenderMixin,
  type VueRenderInstanceLike,
  type VueRenderMixinOptions,
} from './render-mixin';
export {
  instrumentVueRouter,
  type RouteNamingOptions,
  routePatternFromVueRoute,
  setRouteName,
  type VueRouteLike,
  type VueRouterLike,
} from './router';
