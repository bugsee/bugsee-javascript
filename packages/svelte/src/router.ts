import { type RouteNamingOptions, setRouteName } from '@bugsee/web-adapter';

// The @bugsee/svelte ROUTER NAMING integration (frontend-adapters §7 + the F5/D5 two-phase naming seam). On
// a navigation, SvelteKit's navigation target carries the route id (`/users/[id]` — SvelteKit's own
// parameterized route syntax, already low-cardinality); refine the active navigation transaction (opened
// raw-URL by the F1 navigation source) via the shared `setRouteName` seam. We DELIBERATELY keep SvelteKit's
// native bracket syntax (not normalized to the colon style the backend adapters use) — each adapter reports
// its framework's own route format; normalizing would be lossy and opinionated. A STRUCTURAL PEER over
// SvelteKit's `afterNavigate` argument shape (no `$app/navigation` import) → version-agnostic + unit-testable.
// The user wires it once: `afterNavigate(instrumentSvelteKitNavigation())`.

// Re-export the shared route-naming seam + options (API stability — these are the generic primitives).
export { type RouteNamingOptions, setRouteName } from '@bugsee/web-adapter';

/** The minimal SvelteKit `afterNavigate` argument we read — structurally matches `AfterNavigate`. */
export interface AfterNavigateLike {
  to?: { route?: { id?: string | null } } | null;
}

/** The SvelteKit route id for a navigation (`/users/[id]`), or undefined when absent (null id / no target). */
export function routeIdFromNavigation(navigation: AfterNavigateLike): string | undefined {
  const id = navigation.to?.route?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** Build an `afterNavigate` callback that refines the active transaction to the navigation's route id (D5
 *  phase-2). Wire once after mount: `afterNavigate(instrumentSvelteKitNavigation())`. A no-op for a
 *  navigation with no route id. */
export function instrumentSvelteKitNavigation(
  options: RouteNamingOptions = {},
): (navigation: AfterNavigateLike) => void {
  return (navigation) => {
    const id = routeIdFromNavigation(navigation);
    if (id !== undefined) setRouteName(id, options);
  };
}
