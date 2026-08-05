import { guarded, neverThrow, type RouteNamingOptions, setRouteName } from '@bugsee/web-adapter';

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
  // CONTAINED. `route` is host-supplied — a vue-router location, or whatever an app passes to this public
  // export — and every property read here can throw on an exotic or proxied object.
  return neverThrow(() => {
    const matched = route.matched;
    const deepest =
      matched !== undefined && matched.length > 0 ? matched[matched.length - 1] : undefined;
    const pattern = deepest?.path;
    return typeof pattern === 'string' && pattern !== '' ? pattern : undefined;
  });
}

/** Instrument a vue-router instance: on each navigation, refine the active transaction to the matched route
 *  PATTERN (D5 phase-2). Call once after `createRouter(...)`. A no-op for a navigation with no usable pattern. */
export function instrumentVueRouter(router: VueRouterLike, options: RouteNamingOptions = {}): void {
  // CONTAINED at BOTH boundaries. `router.afterEach` is host-supplied and runs during app setup, where a
  // throw takes the whole mount down rather than costing one report; the callback registered with it is
  // invoked by vue-router on EVERY navigation, long after this returned, where a throw would fail the app's
  // route change.
  //
  // The callback guard is REDUNDANT TODAY — verified, not assumed: a mutation removing it survives, because
  // `routePatternFromVueRoute` and `setRouteName` now contain themselves, so nothing inside can throw. It
  // stays because Wave 2.1's rule is enforced by construction at every host callback rather than re-derived
  // from what the callees currently happen to do. Identical situation to @bugsee/react's `apply`.
  const onNavigation = guarded((to: VueRouteLike): void => {
    const pattern = routePatternFromVueRoute(to);
    if (pattern !== undefined) setRouteName(pattern, options);
  }, options.onError);
  neverThrow(() => router.afterEach(onNavigation), options.onError);
}
