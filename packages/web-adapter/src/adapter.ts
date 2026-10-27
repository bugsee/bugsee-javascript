import type { Bugsee } from '@bugsee/browser';
import {
  asInternalClient,
  getCarrierClient,
  guarded,
  type InternalLogExceptionOptions,
  neverThrow,
} from '@bugsee/core';
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
export type AdapterMechanism = NonNullable<InternalLogExceptionOptions['mechanism']>;

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
 * Contained. This runs INSIDE the host framework's error seam — the one place whose purpose is to
 * make an error survivable — so an SDK-internal failure here did two things at once: it escaped into the
 * framework, and it stopped the customer's own handler from ever running. Measured against real Vue, that
 * turned a fully-recovered mount into a throw out of `app.mount()` and an empty DOM.
 * `neverThrow` also attaches a rejection
 * handler to `logException`'s promise, so the fire-and-forget call cannot surface as an unhandled rejection
 * in the host either.
 */
export function reportError(error: unknown, options: ReportErrorOptions = {}): void {
  neverThrow(() => {
    const client = resolveClient(options.getClient);
    if (client === undefined) return;
    return asInternalClient(client).logException(error, {
      mechanism: options.mechanism ?? 'uncaught',
      ...(options.labels !== undefined ? { labels: options.labels } : {}),
    });
  }, options.onError);
}

/** Resolve the client's `method` when it exists. A client from another copy of the SDK that predates `setRoute` /
 *  `setView` lacks it: the adapter then simply has nothing to feed, and must not report an error on every navigation. */
const clientMethod = <K extends 'setRoute' | 'setView'>(
  client: Bugsee,
  name: K,
): Bugsee[K] | undefined => (typeof client[name] === 'function' ? client[name] : undefined);

/**
 * Report the route the user is on, as the router's PATTERN (`/users/:id`): feeds the `route` trace (`client.setRoute`) and
 * refines the active navigation transaction's name via the performance naming seam. The two feeds are independent (either
 * may be absent: no performance extension, or an older client without `setRoute`). A no-op when no SDK is launched: a
 * navigation reported before a client exists is DROPPED, not held. This is a public export (re-exported by every
 * adapter), so a direct caller of `setRouteName` now writes the `route` trace too.
 * Callers pass COMMITTED navigations only (a held `route` would otherwise record a route the user never reached).
 */
export function setRouteName(name: string, options: RouteNamingOptions = {}): void {
  // Contained for the same reason `reportError` is: this runs from a host callback (a router subscription,
  // a navigation hook), and `getClient` is a public option that can throw. The rule is "every
  // host-facing entry point", and this one was missed in the first pass.
  // The client is resolved ONCE per call (a hot path: every navigation), and the two feeds are independent.
  const client = neverThrow(() => resolveClient(options.getClient), options.onError);
  if (client === undefined) return;
  neverThrow(() => {
    tryGetPerf(client)?.setRouteName(name);
  }, options.onError);
  neverThrow(() => {
    clientMethod(client, 'setRoute')?.call(client, name);
  }, options.onError);
}

/**
 * Names that are a framework's WRAPPER, never the page: `wrap` is what solid-js `lazy()` returns,
 * `AsyncComponentWrapper` what Vue's `defineAsyncComponent` returns, and `Navigate` / `RequireAuth` / `Outlet` /
 * `Suspense` / `Fragment` are the usual element types of a React route that only redirects, guards or lays out. Reporting
 * one would be a fabricated view name. The list is a floor, not a guarantee: an application's own guard component has
 * a name nothing here can know, which is why `client.setView` is the only reliable source.
 */
const WRAPPER_VIEW_NAMES: ReadonlySet<string> = new Set([
  'wrap',
  'AsyncComponentWrapper',
  'Navigate',
  'RequireAuth',
  'Outlet',
  'Suspense',
  'Fragment',
  'anonymous',
  'Anonymous',
]);

/** True when `name` is usable as a `view` name: a string that is not empty, not one or two characters (the mark of a
 *  minified class or function name) and not a known framework wrapper name. A heuristic, as the spec says: the
 *  application's own `setView` is the only guaranteed source. */
export function isObtainableViewName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length > 2 && !WRAPPER_VIEW_NAMES.has(name.trim());
}

/**
 * Report the view (component) the user is looking at, as the `view` trace: `client.setView({ name, type })`, where `type`
 * is the adapter id. BEST EFFORT: a name that is empty or looks minified writes NOTHING (never a fabricated name, never
 * the route in its place; the previous view then stays held: a known spec question). A no-op when no SDK is launched.
 */
export function setViewName(name: unknown, type: string, options: AdapterClientOptions = {}): void {
  if (!isObtainableViewName(name)) return;
  neverThrow(() => {
    const client = resolveClient(options.getClient);
    if (client === undefined) return;
    clientMethod(client, 'setView')?.call(client, { name: name.trim(), type });
  }, options.onError);
}
