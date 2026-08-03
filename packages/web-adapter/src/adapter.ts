import type { Bugsee } from '@bugsee/browser';
import { getCarrierClient, guarded, type LogExceptionOptions, neverThrow } from '@bugsee/core';
import type { PerformanceApi } from '@bugsee/performance';

// Re-exported so each adapter can contain its OWN pre-report work (component-name lookup, route extraction)
// without taking a direct @bugsee/core dependency — those run inside the same host seam and carry the same
// hazard as the report itself.
export { guarded, neverThrow };

// Shared plumbing for the web framework adapters (@bugsee/react / vue / svelte / angular / solid). Each
// adapter layers its framework-specific error context (component stack / name / unwrap / labels) + route-
// pattern extraction on top of these three primitives, so the carrier-client resolution, the `logException`
// call (+ mechanism/labels), and the performance naming seam live in ONE place instead of duplicated 5×.

/** Capture mechanism for an adapter error report (the `logException` mechanism vocabulary). */
export type AdapterMechanism = NonNullable<LogExceptionOptions['mechanism']>;

/** Base options shared by every adapter entry point. */
export interface AdapterClientOptions {
  /** Resolve the client. Default: the process-singleton carrier client. Injectable for tests. */
  getClient?: () => Bugsee | undefined;
  /** Where an SDK-internal failure at this host boundary is reported. Never rethrown into the framework. */
  onError?: (error: unknown) => void;
}

export interface ReportErrorOptions extends AdapterClientOptions {
  /** Capture mechanism. Default `uncaught`. */
  mechanism?: AdapterMechanism;
  /** Searchable issue labels (e.g. a framework's component name / error-info). */
  labels?: string[];
}

/** Options for the route-naming seam (just the client resolver). */
export type RouteNamingOptions = AdapterClientOptions;

const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

/** Resolve the launched client: the injected `getClient`, else the process-singleton carrier. */
export function resolveClient(getClient?: () => Bugsee | undefined): Bugsee | undefined {
  return (getClient ?? defaultGetClient)();
}

const tryGetPerf = (client: Bugsee): PerformanceApi | undefined => {
  try {
    return client.ext('performance');
  } catch {
    return undefined; // the performance extension is not registered (performanceMonitoring off)
  }
};

/** The launched client's performance extension (`ext('performance')`) — for adapters that record spans on
 *  the active transaction (e.g. the React Profiler). Undefined when the SDK / performance ext is absent. */
export function getPerformanceApi(
  getClient?: () => Bugsee | undefined,
): PerformanceApi | undefined {
  const client = resolveClient(getClient);
  return client === undefined ? undefined : tryGetPerf(client);
}

/**
 * Report an (already framework-preprocessed) error to the launched client. A no-op when no SDK is launched.
 *
 * Wave 2.1: contained. This runs INSIDE the host framework's error seam — the one place whose purpose is to
 * make an error survivable — so an SDK-internal failure here did two things at once: it escaped into the
 * framework, and it stopped the customer's own handler from ever running. Measured against real Vue, that
 * turned a fully-recovered mount into a throw out of `app.mount()` and an empty DOM
 * (docs/review/frontend-adapters-vue-angular-svelte-solid.md SEV1 #1). `neverThrow` also attaches a rejection
 * handler to `logException`'s promise, so the fire-and-forget call cannot surface as an unhandled rejection
 * in the host either.
 */
export function reportError(error: unknown, options: ReportErrorOptions = {}): void {
  neverThrow(() => {
    const client = resolveClient(options.getClient);
    if (client === undefined) return;
    return client.logException(error, {
      mechanism: options.mechanism ?? 'uncaught',
      ...(options.labels !== undefined ? { labels: options.labels } : {}),
    });
  }, options.onError);
}

/** Refine the active navigation transaction's name via the performance naming seam (F5/D5). A no-op when
 *  the SDK or the performance extension is not available. */
export function setRouteName(name: string, options: RouteNamingOptions = {}): void {
  const client = resolveClient(options.getClient);
  if (client === undefined) return;
  tryGetPerf(client)?.setRouteName(name);
}
