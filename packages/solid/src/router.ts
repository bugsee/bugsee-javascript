import type { Bugsee } from '@bugsee/browser';
import { getCarrierClient } from '@bugsee/core';
import type { PerformanceApi } from '@bugsee/performance';

// The @bugsee/solid ROUTER NAMING integration (frontend-adapters §7 + the F5/D5 two-phase naming seam). On a
// navigation, @solidjs/router's matched routes carry the parameterized pattern (`/users/:id`); the deepest
// match's `route.pattern` is the full pattern. Refine the active navigation transaction (opened raw-URL by
// the F1 navigation source) to that pattern via `ext('performance').setRouteName`. A STRUCTURAL PEER over
// the match shape (no `@solidjs/router` import) → version-agnostic + unit-testable. Solid Router is reactive
// (no afterEach hook), so the user wires it in an effect:
//   const matches = useCurrentMatches();
//   createEffect(() => setRouteNameFromSolidMatches(matches()));
// A no-op when the SDK / performance ext is absent.

/** The minimal @solidjs/router match shape we read — structurally matches a `useCurrentMatches()` element. */
export interface SolidRouteMatchLike {
  route?: { pattern?: string };
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

/** The parameterized pattern for a Solid Router navigation: the deepest match's `route.pattern` (the full
 *  pattern). Returns undefined when there is no match or no usable pattern. */
export function routePatternFromSolidMatches(
  matches: readonly SolidRouteMatchLike[] | null | undefined,
): string | undefined {
  if (!matches || matches.length === 0) return undefined;
  const pattern = matches[matches.length - 1]?.route?.pattern;
  return typeof pattern === 'string' && pattern !== '' ? pattern : undefined;
}

/** Refine the active navigation transaction's name via the performance naming seam (F5/D5). A no-op when
 *  the SDK or the performance extension is not available. */
export function setRouteName(name: string, options: RouteNamingOptions = {}): void {
  const client = (options.getClient ?? defaultGetClient)();
  if (client === undefined) return;
  tryGetPerf(client)?.setRouteName(name);
}

/** Refine the active transaction to the matched route PATTERN (D5 phase-2). Call (in a reactive effect) with
 *  `useCurrentMatches()`'s value on each navigation. A no-op when there is no usable pattern. */
export function setRouteNameFromSolidMatches(
  matches: readonly SolidRouteMatchLike[] | null | undefined,
  options: RouteNamingOptions = {},
): void {
  const pattern = routePatternFromSolidMatches(matches);
  if (pattern !== undefined) setRouteName(pattern, options);
}
