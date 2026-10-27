import {
  neverThrow,
  type RouteNamingOptions,
  setRouteName,
  setViewName,
} from '@bugsee/web-adapter';

// The @bugsee/solid ROUTER NAMING integration (and the two-phase naming seam). On a
// navigation, @solidjs/router's matched routes carry the parameterized pattern (`/users/:id`); the deepest
// match's `route.pattern` is the full pattern. Refine the active navigation transaction (opened raw-URL by
// the navigation source) via the shared `setRouteName` seam. A STRUCTURAL PEER over the match shape (no
// `@solidjs/router` import) → version-agnostic + unit-testable. Solid Router is reactive (no afterEach hook),
// so the user wires it in an effect:
//   const matches = useCurrentMatches();
//   createEffect(() => setRouteNameFromSolidMatches(matches()));

// Re-export the shared route-naming seam + options (API stability — these are the generic primitives).
export { type RouteNamingOptions, setRouteName } from '@bugsee/web-adapter';

/** The minimal @solidjs/router match shape we read — structurally matches a `useCurrentMatches()` element. */
export interface SolidRouteMatchLike {
  route?: { pattern?: string; component?: unknown };
}

/** The parameterized pattern for a Solid Router navigation: the deepest match's `route.pattern` (the full
 *  pattern). Returns undefined when there is no match or no usable pattern. */
export function routePatternFromSolidMatches(
  matches: readonly SolidRouteMatchLike[] | null | undefined,
): string | undefined {
  // CONTAINED. The argument is HOST-supplied — a framework navigation/match object, or whatever an app
  // passes to this public export — and any property read on it can throw (measured against a proxied one).
  // Failing to name a route must never cost the report, let alone the app.
  return neverThrow(() => {
    if (!matches || matches.length === 0) return undefined;
    const pattern = matches[matches.length - 1]?.route?.pattern;
    return typeof pattern === 'string' && pattern !== '' ? pattern : undefined;
  });
}

/**
 * The component name of the page a Solid Router navigation committed to (the `view` trace, best effort): the deepest
 * match's `route.component` (`RouteDescription.component`), by its function `name` or `displayName`. Undefined when
 * there is none; whether the name is obtainable (not minified) is decided by `setViewName`.
 */
export function viewNameFromSolidMatches(
  matches: readonly SolidRouteMatchLike[] | null | undefined,
): string | undefined {
  return neverThrow(() => {
    if (!matches || matches.length === 0) return undefined;
    const component = matches[matches.length - 1]?.route?.component;
    if (typeof component !== 'function') return undefined;
    const fn = component as { displayName?: unknown; name?: unknown };
    const name = fn.displayName ?? fn.name;
    return typeof name === 'string' && name !== '' ? name : undefined;
  });
}

/** Refine the active transaction to the matched route PATTERN. Call (in a reactive effect) with
 *  `useCurrentMatches()`'s value on each navigation. A no-op when there is no usable pattern. */
export function setRouteNameFromSolidMatches(
  matches: readonly SolidRouteMatchLike[] | null | undefined,
  options: RouteNamingOptions = {},
): void {
  const pattern = routePatternFromSolidMatches(matches);
  if (pattern !== undefined) setRouteName(pattern, options);
  setViewName(viewNameFromSolidMatches(matches), 'solid', options);
}
