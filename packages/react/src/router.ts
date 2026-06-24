import { type RouteNamingOptions, setRouteName } from '@bugsee/web-adapter';

// The @bugsee/react ROUTER NAMING integration (frontend-adapters D8 + the F5/D5 two-phase naming seam).
// On a navigation, react-router knows the matched route PATTERN (`/users/:id`); read it from the
// `matchRoutes()` result and REFINE the active navigation transaction (opened raw-URL by the F1 navigation
// source) via the shared `setRouteName` seam. A STRUCTURAL PEER over the match shape — no react-router import
// (the app passes its `matchRoutes(routes, location)` output), so this stays version-agnostic + unit-testable.

// Re-export the shared route-naming seam + options (API stability — the generic primitives any router uses).
export { type RouteNamingOptions, setRouteName } from '@bugsee/web-adapter';

/** The minimal match shape we read — structurally matches a react-router `matchRoutes()` result element. */
export interface RouteMatchLike {
  route?: { path?: string };
}

/**
 * Build the parameterized route pattern from a react-router `matchRoutes()` result: join the matched routes'
 * non-empty path segments into one path (`/users/:id`), normalizing slashes. Pathless / layout / index
 * routes contribute nothing. Returns `'/'` for the root route, or `undefined` when no usable path is present.
 */
export function routePatternFromMatches(
  matches: readonly RouteMatchLike[] | null | undefined,
): string | undefined {
  if (!matches || matches.length === 0) return undefined;
  const segments: string[] = [];
  for (const m of matches) {
    const path = m.route?.path;
    if (path === undefined || path === '') continue; // pathless / layout / index route
    const trimmed = path.replace(/^\/+|\/+$/g, ''); // strip leading/trailing slashes for the join
    if (trimmed !== '') segments.push(trimmed);
  }
  if (segments.length === 0) {
    return matches.some((m) => m.route?.path === '/') ? '/' : undefined; // root route, else nothing usable
  }
  return `/${segments.join('/')}`;
}

/**
 * react-router glue: refine the active navigation to the matched route PATTERN (D5 phase-2). Call on each
 * navigation with `matchRoutes(routes, location)`. A no-op when there is no usable pattern.
 */
export function instrumentRouterMatches(
  matches: readonly RouteMatchLike[] | null | undefined,
  options: RouteNamingOptions = {},
): void {
  const pattern = routePatternFromMatches(matches);
  if (pattern === undefined) return;
  setRouteName(pattern, options);
}

/** The minimal react-router DATA router shape we touch — structurally matches a `createBrowserRouter(...)` /
 *  `createHashRouter(...)` / `createMemoryRouter(...)` result: the current `state` (whose `matches` each carry
 *  the matched `route.path`) + a `subscribe(listener) => unsubscribe` for state changes. No react-router
 *  import → version-agnostic across react-router v6.4+ / v7. */
export interface ReactDataRouterLike {
  state: { matches?: readonly RouteMatchLike[] };
  subscribe: (listener: (state: { matches?: readonly RouteMatchLike[] }) => void) => () => void;
}

/** Auto-instrument a react-router DATA router (`createBrowserRouter` & friends): name the CURRENT route now,
 *  then refine the active navigation transaction to the matched route PATTERN on every navigation — the
 *  data-router parallel to Vue's `instrumentVueRouter` (wire once, self-subscribing; no per-navigation call,
 *  no hook/renderer). The app passes its router instance IN, so the SDK never imports react-router. Returns
 *  the router's unsubscribe function for teardown. A no-op per navigation when there is no usable pattern. */
export function instrumentReactRouter(
  router: ReactDataRouterLike,
  options: RouteNamingOptions = {},
): () => void {
  const apply = (state: { matches?: readonly RouteMatchLike[] }): void => {
    const pattern = routePatternFromMatches(state.matches);
    if (pattern !== undefined) setRouteName(pattern, options);
  };
  apply(router.state); // name the current/initial route immediately (refines the active pageload transaction)
  return router.subscribe(apply);
}
