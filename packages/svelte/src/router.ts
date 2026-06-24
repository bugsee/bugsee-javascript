import type { Bugsee } from '@bugsee/browser';
import { getCarrierClient } from '@bugsee/core';
import type { PerformanceApi } from '@bugsee/performance';

// The @bugsee/svelte ROUTER NAMING integration (frontend-adapters §7 + the F5/D5 two-phase naming seam). On
// a navigation, SvelteKit's navigation target carries the route id (`/users/[id]` — SvelteKit's own
// parameterized route syntax, already low-cardinality); refine the active navigation transaction (opened
// raw-URL by the F1 navigation source) to that id via `ext('performance').setRouteName`. A STRUCTURAL PEER
// over SvelteKit's `afterNavigate` argument shape (no `$app/navigation` import) → version-agnostic +
// unit-testable. A no-op when the SDK / performance ext is absent. The user wires it once:
// `afterNavigate(instrumentSvelteKitNavigation())`.

/** The minimal SvelteKit `afterNavigate` argument we read — structurally matches `AfterNavigate`. */
export interface AfterNavigateLike {
  to?: { route?: { id?: string | null } } | null;
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

/** The SvelteKit route id for a navigation (`/users/[id]`), or undefined when absent (null id / no target). */
export function routeIdFromNavigation(navigation: AfterNavigateLike): string | undefined {
  const id = navigation.to?.route?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** Refine the active navigation transaction's name via the performance naming seam (F5/D5). A no-op when
 *  the SDK or the performance extension is not available. */
export function setRouteName(name: string, options: RouteNamingOptions = {}): void {
  const client = (options.getClient ?? defaultGetClient)();
  if (client === undefined) return;
  tryGetPerf(client)?.setRouteName(name);
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
