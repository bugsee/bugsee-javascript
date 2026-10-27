import {
  neverThrow,
  type RouteNamingOptions,
  setRouteName,
  setViewName,
} from '@bugsee/web-adapter';

// The @bugsee/angular ROUTER NAMING integration (the two-phase naming seam).
// Angular's activated-route snapshot tree carries the matched route config; walk it to build the
// parameterized pattern (`/users/:id` — Angular's colon syntax, same as the backend adapters) and refine
// the active navigation transaction (opened raw-URL by the navigation source) via the shared
// `setRouteName` seam. A STRUCTURAL PEER over the snapshot/router shapes (no `@angular/router` import) →
// version-agnostic + unit-testable. The user owns the `NavigationEnd` filter (they have the import),
// keeping this robust + decoupled — wire once after the router is ready:
//   router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => setRouteNameFromRouter(router));

// Re-export the shared route-naming seam + options (API stability — these are the generic primitives).
export { type RouteNamingOptions, setRouteName } from '@bugsee/web-adapter';

/** The minimal `ActivatedRouteSnapshot` shape we walk — `routeConfig.path` + `firstChild`. */
export interface RouteSnapshotLike {
  routeConfig?: { path?: string } | null;
  /** The component class the activated route renders (set for `component` AND lazy `loadComponent` routes). */
  component?: unknown;
  firstChild?: RouteSnapshotLike | null;
}

/** The minimal Angular `Router` shape we read — the current activated snapshot tree root. */
export interface AngularRouterLike {
  routerState: { snapshot: { root: RouteSnapshotLike } };
}

const MAX_ROUTE_DEPTH = 64; // a safety bound against a malformed/cyclic snapshot tree

/** Build the parameterized pattern from an activated-route snapshot tree: join each level's non-empty
 *  `routeConfig.path` down the `firstChild` chain (`/users/:id`). Returns undefined when no usable path.
 *  Follows `firstChild` (the primary outlet in the common case); a route activated in a NAMED secondary
 *  outlet lives under `children`/`outlet` instead and is not reflected here — a known v1 limitation
 *  (named outlets are rare; full multi-outlet naming is a later refinement). */
export function routePatternFromSnapshot(
  root: RouteSnapshotLike | null | undefined,
): string | undefined {
  // CONTAINED. The snapshot tree is HOST-supplied and this WALKS it — every `routeConfig` / `firstChild`
  // read is a chance for an exotic or proxied node to throw. Failing to name a route must never cost the
  // report, let alone the app.
  return neverThrow(() => routePatternFromSnapshotUnsafe(root));
}

function routePatternFromSnapshotUnsafe(
  root: RouteSnapshotLike | null | undefined,
): string | undefined {
  const segments: string[] = [];
  let node: RouteSnapshotLike | null | undefined = root;
  for (let depth = 0; node && depth < MAX_ROUTE_DEPTH; depth++) {
    const path = node.routeConfig?.path;
    if (typeof path === 'string' && path !== '') segments.push(path);
    node = node.firstChild;
  }
  return segments.length > 0 ? `/${segments.join('/')}` : undefined;
}

/**
 * The component name of the page the router committed to (the `view` trace, best effort): the DEEPEST activated route
 * snapshot's `.component` down the `firstChild` chain (`routeConfig.component` is undefined for lazy `loadComponent`
 * routes, the snapshot's is not). A class name, which production builds mangle unless names are kept: whether it is
 * obtainable is decided by `setViewName`. Undefined when the deepest snapshot renders no component.
 */
export function viewNameFromSnapshot(
  root: RouteSnapshotLike | null | undefined,
): string | undefined {
  return neverThrow(() => {
    let node: RouteSnapshotLike | null | undefined = root;
    let deepest: RouteSnapshotLike | null | undefined;
    for (let depth = 0; node && depth < MAX_ROUTE_DEPTH; depth++) {
      deepest = node;
      node = node.firstChild;
    }
    const component = deepest?.component;
    if (typeof component !== 'function') return undefined;
    const name = (component as { name?: unknown }).name;
    return typeof name === 'string' && name !== '' ? name : undefined;
  });
}

/** Refine the active transaction to the router's CURRENT activated route pattern. Call on each
 *  `NavigationEnd`. A no-op when the current route has no usable pattern. */
export function setRouteNameFromRouter(
  router: AngularRouterLike,
  options: RouteNamingOptions = {},
): void {
  // CONTAINED. `router` is Angular's own Router instance, handed in by the app, and reaching the snapshot
  // walks three host-controlled properties before any inner guard can help.
  neverThrow(() => {
    const root = router.routerState.snapshot.root;
    const pattern = routePatternFromSnapshot(root);
    if (pattern !== undefined) setRouteName(pattern, options);
    setViewName(viewNameFromSnapshot(root), 'angular', options);
  }, options.onError);
}
