import type { Bugsee } from '@bugsee/browser';
import { getCarrierClient, type LogExceptionOptions } from '@bugsee/core';
import type { PerformanceApi } from '@bugsee/performance';

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

/** Report an (already framework-preprocessed) error to the launched client. A no-op when no SDK is launched. */
export function reportError(error: unknown, options: ReportErrorOptions = {}): void {
  const client = resolveClient(options.getClient);
  if (client === undefined) return;
  void client.logException(error, {
    mechanism: options.mechanism ?? 'uncaught',
    ...(options.labels !== undefined ? { labels: options.labels } : {}),
  });
}

/** Refine the active navigation transaction's name via the performance naming seam (F5/D5). A no-op when
 *  the SDK or the performance extension is not available. */
export function setRouteName(name: string, options: RouteNamingOptions = {}): void {
  const client = resolveClient(options.getClient);
  if (client === undefined) return;
  tryGetPerf(client)?.setRouteName(name);
}
