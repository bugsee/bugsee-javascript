import type { Bugsee } from '@bugsee/browser';
import { getCarrierClient } from '@bugsee/core';
import type { PerformanceApi } from '@bugsee/performance';

// The @bugsee/angular ROUTER NAMING integration (frontend-adapters §7 + the F5/D5 two-phase naming seam).
// Angular's activated-route snapshot tree carries the matched route config; walk it to build the
// parameterized pattern (`/users/:id` — Angular's colon syntax, same as the backend adapters) and refine
// the active navigation transaction (opened raw-URL by the F1 navigation source) via
// `ext('performance').setRouteName`. A STRUCTURAL PEER over the snapshot/router shapes (no `@angular/router`
// import) → version-agnostic + unit-testable. The user owns the `NavigationEnd` filter (they have the
// import), keeping this robust + decoupled — wire once after the router is ready:
//   router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => setRouteNameFromRouter(router));
// A no-op when the SDK / performance ext is absent.

/** The minimal `ActivatedRouteSnapshot` shape we walk — `routeConfig.path` + `firstChild`. */
export interface RouteSnapshotLike {
  routeConfig?: { path?: string } | null;
  firstChild?: RouteSnapshotLike | null;
}

/** The minimal Angular `Router` shape we read — the current activated snapshot tree root. */
export interface AngularRouterLike {
  routerState: { snapshot: { root: RouteSnapshotLike } };
}

export interface RouteNamingOptions {
  /** Resolve the client. Default: the process-singleton carrier client. Injectable for tests. */
  getClient?: () => Bugsee | undefined;
}

const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

const tryGetPerf = (client: Bugsee): PerformanceApi | undefined => {
  try {
    return client.ext('performance');
  } catch {
    return undefined; // the performance extension is not registered (performanceMonitoring off)
  }
};

const MAX_ROUTE_DEPTH = 64; // a safety bound against a malformed/cyclic snapshot tree

/** Build the parameterized pattern from an activated-route snapshot tree: join each level's non-empty
 *  `routeConfig.path` down the `firstChild` chain (`/users/:id`). Returns undefined when no usable path.
 *  Follows `firstChild` (the primary outlet in the common case); a route activated in a NAMED secondary
 *  outlet lives under `children`/`outlet` instead and is not reflected here — a known v1 limitation
 *  (named outlets are rare; full multi-outlet naming is a later refinement). */
export function routePatternFromSnapshot(
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

/** Refine the active navigation transaction's name via the performance naming seam (F5/D5). A no-op when
 *  the SDK or the performance extension is not available. */
export function setRouteName(name: string, options: RouteNamingOptions = {}): void {
  const client = (options.getClient ?? defaultGetClient)();
  if (client === undefined) return;
  tryGetPerf(client)?.setRouteName(name);
}

/** Refine the active transaction to the router's CURRENT activated route pattern (D5 phase-2). Call on each
 *  `NavigationEnd`. A no-op when the current route has no usable pattern. */
export function setRouteNameFromRouter(
  router: AngularRouterLike,
  options: RouteNamingOptions = {},
): void {
  const pattern = routePatternFromSnapshot(router.routerState.snapshot.root);
  if (pattern !== undefined) setRouteName(pattern, options);
}
