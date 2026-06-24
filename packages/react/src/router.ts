import type { Bugsee } from '@bugsee/browser';
import { getCarrierClient } from '@bugsee/core';
import type { PerformanceApi } from '@bugsee/performance';

// The @bugsee/react ROUTER NAMING integration (frontend-adapters D8 + the F5/D5 two-phase naming seam).
// On a navigation, react-router knows the matched route PATTERN (`/users/:id`); read it from the
// `matchRoutes()` result and REFINE the active navigation transaction (opened raw-URL by the F1 navigation
// source) to that parameterized route via `ext('performance').setRouteName`. A STRUCTURAL PEER over the
// match shape — no react-router import (the app passes its `matchRoutes(routes, location)` output), so this
// stays version-agnostic + unit-testable. Runtime-portable, React-free; a no-op when the SDK / performance
// ext is absent.

/** The minimal match shape we read — structurally matches a react-router `matchRoutes()` result element. */
export interface RouteMatchLike {
  route?: { path?: string };
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
 * Refine the active navigation transaction's name via the performance naming seam (F5/D5, source `route`).
 * The generic primitive — any router, or a manual call, uses it. A no-op when the SDK or the performance
 * extension is not available.
 */
export function setRouteName(name: string, options: RouteNamingOptions = {}): void {
  const client = (options.getClient ?? defaultGetClient)();
  if (client === undefined) return;
  tryGetPerf(client)?.setRouteName(name);
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
