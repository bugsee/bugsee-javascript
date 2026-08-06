import { neverThrow, type RouteNamingOptions, setRouteName } from '@bugsee/web-adapter';

// The @bugsee/angular ROUTER NAMING integration (frontend-adapters §7 + the F5/D5 two-phase naming seam).
// Angular's activated-route snapshot tree carries the matched route config; walk it to build the
// parameterized pattern (`/users/:id` — Angular's colon syntax, same as the backend adapters) and refine
// the active navigation transaction (opened raw-URL by the F1 navigation source) via the shared
// `setRouteName` seam. A STRUCTURAL PEER over the snapshot/router shapes (no `@angular/router` import) →
// version-agnostic + unit-testable. The user owns the `NavigationEnd` filter (they have the import),
// keeping this robust + decoupled — wire once after the router is ready:
//   router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => setRouteNameFromRouter(router));

// Re-export the shared route-naming seam + options (API stability — these are the generic primitives).
export { type RouteNamingOptions, setRouteName } from '@bugsee/web-adapter';

/** The minimal `ActivatedRouteSnapshot` shape we walk — `routeConfig.path` + `firstChild`. */
export interface RouteSnapshotLike {
  routeConfig?: { path?: string } | null;
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

/** Refine the active transaction to the router's CURRENT activated route pattern (D5 phase-2). Call on each
 *  `NavigationEnd`. A no-op when the current route has no usable pattern. */
export function setRouteNameFromRouter(
  router: AngularRouterLike,
  options: RouteNamingOptions = {},
): void {
  // CONTAINED. `router` is Angular's own Router instance, handed in by the app, and reaching the snapshot
  // walks three host-controlled properties before any inner guard can help.
  neverThrow(() => {
    const pattern = routePatternFromSnapshot(router.routerState.snapshot.root);
    if (pattern !== undefined) setRouteName(pattern, options);
  }, options.onError);
}
