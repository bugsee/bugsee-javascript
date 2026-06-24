import type { Bugsee } from '@bugsee/browser';
import { getCarrierClient } from '@bugsee/core';
import type { PerformanceApi } from '@bugsee/performance';

// The @bugsee/vue ROUTER NAMING integration (frontend-adapters §7 + the F5/D5 two-phase naming seam). On a
// navigation, vue-router knows the matched route PATTERN (`/users/:id` — vue-router normalizes nested
// children to absolute paths, so the DEEPEST matched record carries the full pattern); refine the active
// navigation transaction (opened raw-URL by the F1 navigation source) to that pattern via
// `ext('performance').setRouteName`. A STRUCTURAL PEER over the vue-router route/router shapes (no
// `vue-router` import) → version-agnostic + unit-testable. A no-op when the SDK / performance ext is absent.
// (The generic plumbing here mirrors the other adapters; extracting a shared module is the depth pass.)

/** The minimal vue-router route shape we read — structurally matches `RouteLocationNormalized`. */
export interface VueRouteLike {
  matched?: ReadonlyArray<{ path?: string }>;
}

/** The minimal vue-router router shape we touch — structurally matches the `Router`'s `afterEach`. */
export interface VueRouterLike {
  afterEach: (guard: (to: VueRouteLike) => void) => void;
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

/** The parameterized pattern for a vue-router navigation: the deepest matched record's `path` (the full
 *  pattern). Returns undefined when there is no matched record or no usable path. */
export function routePatternFromVueRoute(route: VueRouteLike): string | undefined {
  const matched = route.matched;
  const deepest =
    matched !== undefined && matched.length > 0 ? matched[matched.length - 1] : undefined;
  const pattern = deepest?.path;
  return typeof pattern === 'string' && pattern !== '' ? pattern : undefined;
}

/** Refine the active navigation transaction's name via the performance naming seam (F5/D5). A no-op when
 *  the SDK or the performance extension is not available. */
export function setRouteName(name: string, options: RouteNamingOptions = {}): void {
  const client = (options.getClient ?? defaultGetClient)();
  if (client === undefined) return;
  tryGetPerf(client)?.setRouteName(name);
}

/** Instrument a vue-router instance: on each navigation, refine the active transaction to the matched route
 *  PATTERN (D5 phase-2). Call once after `createRouter(...)`. A no-op for a navigation with no usable pattern. */
export function instrumentVueRouter(router: VueRouterLike, options: RouteNamingOptions = {}): void {
  router.afterEach((to) => {
    const pattern = routePatternFromVueRoute(to);
    if (pattern !== undefined) setRouteName(pattern, options);
  });
}
