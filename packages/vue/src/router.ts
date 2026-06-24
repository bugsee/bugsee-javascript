import { type RouteNamingOptions, setRouteName } from '@bugsee/web-adapter';

// The @bugsee/vue ROUTER NAMING integration (frontend-adapters §7 + the F5/D5 two-phase naming seam). On a
// navigation, vue-router knows the matched route PATTERN (`/users/:id` — the matcher rewrites a
// relatively-configured child to its absolute path at addRoute time, and an absolute-configured child is
// already full, so the DEEPEST matched record's `path` is the full pattern either way); refine the active
// navigation transaction (opened raw-URL by the F1 navigation source) via the shared `setRouteName` seam. A
// STRUCTURAL PEER over the vue-router route/router shapes (no `vue-router` import) → version-agnostic +
// unit-testable.

// Re-export the shared route-naming seam + options (API stability — these are the generic primitives).
export { type RouteNamingOptions, setRouteName } from '@bugsee/web-adapter';

/** The minimal vue-router route shape we read — structurally matches `RouteLocationNormalized`. */
export interface VueRouteLike {
  matched?: ReadonlyArray<{ path?: string }>;
}

/** The minimal vue-router router shape we touch — structurally matches the `Router`'s `afterEach`. */
export interface VueRouterLike {
  afterEach: (guard: (to: VueRouteLike) => void) => void;
}

/** The parameterized pattern for a vue-router navigation: the deepest matched record's `path` (the full
 *  pattern — the matcher assembles `matched` child-last + rewrites relative children to absolute). Returns
 *  undefined when there is no matched record or no usable path. */
export function routePatternFromVueRoute(route: VueRouteLike): string | undefined {
  const matched = route.matched;
  const deepest =
    matched !== undefined && matched.length > 0 ? matched[matched.length - 1] : undefined;
  const pattern = deepest?.path;
  return typeof pattern === 'string' && pattern !== '' ? pattern : undefined;
}

/** Instrument a vue-router instance: on each navigation, refine the active transaction to the matched route
 *  PATTERN (D5 phase-2). Call once after `createRouter(...)`. A no-op for a navigation with no usable pattern. */
export function instrumentVueRouter(router: VueRouterLike, options: RouteNamingOptions = {}): void {
  router.afterEach((to) => {
    const pattern = routePatternFromVueRoute(to);
    if (pattern !== undefined) setRouteName(pattern, options);
  });
}
