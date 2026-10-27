import {
  guarded,
  neverThrow,
  type RouteNamingOptions,
  setRouteName,
  setViewName,
} from '@bugsee/web-adapter';

// The @bugsee/vue ROUTER NAMING integration (and the two-phase naming seam). On a
// navigation, vue-router knows the matched route PATTERN (`/users/:id` — the matcher rewrites a
// relatively-configured child to its absolute path at addRoute time, and an absolute-configured child is
// already full, so the DEEPEST matched record's `path` is the full pattern either way); refine the active
// navigation transaction (opened raw-URL by the navigation source) via the shared `setRouteName` seam. A
// STRUCTURAL PEER over the vue-router route/router shapes (no `vue-router` import) → version-agnostic +
// unit-testable.

// Re-export the shared route-naming seam + options (API stability — these are the generic primitives).
export { type RouteNamingOptions, setRouteName } from '@bugsee/web-adapter';

/** The minimal vue-router route shape we read — structurally matches `RouteLocationNormalized`. */
export interface VueRouteLike {
  matched?: ReadonlyArray<{ path?: string; components?: { default?: unknown } | null }>;
}

/** The minimal vue-router router shape we touch — structurally matches the `Router`'s `afterEach`. */
export interface VueRouterLike {
  // `failure` (the third argument) is set for an aborted, redirected-away or duplicated navigation: `afterEach` fires for those too.
  afterEach: (guard: (to: VueRouteLike, from?: unknown, failure?: unknown) => void) => void;
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

/**
 * The component name of the route a navigation committed to (the `view` trace, best effort): the deepest matched record's
 * resolved default component (`matched[last].components.default`, so a lazy route works once the navigation commits):
 * its `name`, `__name` (`<script setup>`) or `displayName`. Undefined when there is none; whether a name is obtainable
 * (not minified) is decided by `setViewName`.
 */
export function viewNameFromVueRoute(route: VueRouteLike): string | undefined {
  return neverThrow(() => {
    const matched = route.matched;
    const component = matched?.[matched.length - 1]?.components?.default as
      | { name?: unknown; __name?: unknown; displayName?: unknown }
      | undefined;
    const name = component?.name ?? component?.__name ?? component?.displayName;
    return typeof name === 'string' && name !== '' ? name : undefined;
  });
}

/** Instrument a vue-router instance: on each navigation, refine the active transaction to the matched route
 * PATTERN. Call once after `createRouter(...)`. A no-op for a navigation with no usable pattern. */
export function instrumentVueRouter(router: VueRouterLike, options: RouteNamingOptions = {}): void {
  // CONTAINED at BOTH boundaries. `router.afterEach` is host-supplied and runs during app setup, where a
  // throw takes the whole mount down rather than costing one report; the callback registered with it is
  // invoked by vue-router on EVERY navigation, long after this returned, where a throw would fail the app's
  // route change.
  //
  // The callback guard is REDUNDANT TODAY — verified, not assumed: a mutation removing it survives, because
  // `routePatternFromVueRoute` and `setRouteName` now contain themselves, so nothing inside can throw. It
  // stays because the rule is enforced by construction at every host callback rather than re-derived
  // from what the callees currently happen to do. Identical situation to @bugsee/react's `apply`.
  const onNavigation = guarded((to: VueRouteLike, _from?: unknown, failure?: unknown): void => {
    // COMMITTED navigations only: `afterEach` also fires with a `failure` for an aborted, cancelled, redirected-away or
    // duplicated navigation, and a held `route` would record a route the user never reached.
    if (failure !== undefined && failure !== null) return;
    const pattern = routePatternFromVueRoute(to);
    if (pattern !== undefined) setRouteName(pattern, options);
    setViewName(viewNameFromVueRoute(to), 'vue', options);
  }, options.onError);
  neverThrow(() => router.afterEach(onNavigation), options.onError);
}
