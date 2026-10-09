import type { Interceptor } from './contracts';
import { type FilterStore, FiltersToken } from './filters';
import type { ServiceRegistrar, ServiceResolver } from './services';

/**
 * A package's SERVICE MANIFEST: registers its contract-first services into the internal container,
 * resolving any dependencies from it. Extensions / framework adapters CONTRIBUTE a manifest to the
 * carrier (typically at module init); the platform composition root then runs every contributed
 * manifest against the launched client's internal object — so a package's components join the SDK
 * WITHOUT `launch`/`createClient` ever naming them (auto-registration via an explicit manifest, not
 * import side-effects). The manifest gets the typed register+resolve facade, so a contributed service
 * can wire itself from `transport`/`captureStore`/… already in the container.
 */
export type ServiceManifest = (internal: ServiceRegistrar & ServiceResolver) => void;

// Process-global Carrier (design §4.2 §214): a version-keyed slot on `globalThis.__BUGSEE__` holding
// the SDK's process-global singletons — currently the interceptor registry. Routing interceptor
// creation through it means that even if a bundler emits multiple copies of @bugsee/capture /
// @bugsee/core (mixed dep ranges, framework adapters), all copies WITHIN ONE SDK VERSION converge on
// the SAME interceptor instance — so a runtime global (fetch/console/...) is patched exactly once.
// Different SDK versions get separate slots so they coexist without fighting over the same global
// (the documented Sentry-carrier trade-off). The carrier is reached only via a `globalThis` cast (no
// node:/DOM imports), so core stays runtime-portable.

/** The SDK's own version — the carrier slot key. Distinct from the user-facing `sdkVersion` option. */
export const BUGSEE_SDK_VERSION = '0.1.0-beta.1';

const CARRIER_PROPERTY = '__BUGSEE__';

/** A process-global slot holding one SDK version's singletons. */
export interface BugseeCarrier {
  /** The SDK version this slot belongs to (=== its key in `__BUGSEE__`). */
  readonly version: string;
  /** Interceptor singletons keyed by interceptor `name` — one global patch per name. */
  readonly interceptors: Map<string, Interceptor<unknown>>;
  /** The process-global launched client (Bugsee is a per-process singleton, §1497/§473); else undefined. */
  client?: unknown;
  /** Service manifests contributed by extensions / other packages; run against the launched container. */
  serviceManifests?: ServiceManifest[];
}

type CarrierHost = { [CARRIER_PROPERTY]?: Record<string, BugseeCarrier> };

/**
 * Get (creating if absent) the carrier slot for this SDK version on `globalObj`. Idempotent: repeated
 * calls on the SAME global return the SAME slot — the mechanism by which duplicated module copies
 * share state. `globalObj` is injectable so tests pass a fresh object instead of the real globalThis.
 */
export function getCarrier(globalObj: object = globalThis): BugseeCarrier {
  const host = globalObj as CarrierHost;
  let registry = host[CARRIER_PROPERTY];
  if (registry === undefined) {
    // Null-prototype so a version string like `__proto__` can never pollute Object.prototype.
    registry = Object.create(null) as Record<string, BugseeCarrier>;
    host[CARRIER_PROPERTY] = registry;
  }
  let slot = registry[BUGSEE_SDK_VERSION];
  if (slot === undefined) {
    slot = { version: BUGSEE_SDK_VERSION, interceptors: new Map() };
    registry[BUGSEE_SDK_VERSION] = slot;
  }
  return slot;
}

/**
 * Return the process-global interceptor registered under `name`, creating it via `factory()` on the
 * first request and storing it on the carrier. Subsequent calls (any module copy, same global +
 * version) return the SAME instance and do NOT invoke `factory` — so the runtime global is patched
 * once and the first caller's configuration wins.
 */
export function getOrCreateInterceptor<StageMap>(
  name: string,
  factory: () => Interceptor<StageMap>,
  globalObj: object = globalThis,
): Interceptor<StageMap> {
  const { interceptors } = getCarrier(globalObj);
  const existing = interceptors.get(name);
  if (existing !== undefined) {
    return existing as Interceptor<StageMap>;
  }
  const created = factory();
  interceptors.set(name, created as Interceptor<unknown>);
  return created;
}

/**
 * Contribute a {@link ServiceManifest} to the carrier — appended in contribution order. An extension /
 * framework adapter calls this (at module init or explicitly); the launched client runs it. Idempotent
 * only in that it appends; contributing the same manifest twice runs it twice (and a duplicate service
 * name then throws on the second registration — register each contract once).
 */
export function contributeServiceManifest(
  manifest: ServiceManifest,
  globalObj: object = globalThis,
): void {
  const carrier = getCarrier(globalObj);
  if (carrier.serviceManifests === undefined) {
    carrier.serviceManifests = [];
  }
  carrier.serviceManifests.push(manifest);
}

/** Every service manifest contributed to the carrier, in contribution order (empty if none). */
export function getServiceManifests(globalObj: object = globalThis): readonly ServiceManifest[] {
  return getCarrier(globalObj).serviceManifests ?? [];
}

/** The process-global launched client (Bugsee is a per-process singleton), or undefined if none. */
export function getCarrierClient<T = unknown>(globalObj: object = globalThis): T | undefined {
  return getCarrier(globalObj).client as T | undefined;
}

/** Set (or, with `undefined`, clear) the process-global launched client. */
export function setCarrierClient(client: unknown, globalObj: object = globalThis): void {
  getCarrier(globalObj).client = client;
}

/**
 * The internal aggregated object (the singleton client's service resolver) for in-process consumers —
 * e.g. the capture pipeline resolving services without importing the Client. Undefined until launched.
 */
export function getInternal(globalObj: object = globalThis): ServiceResolver | undefined {
  return getCarrierClient<ServiceResolver>(globalObj);
}

/**
 * The process-global redaction filters (the singleton client's `filters` service), for the capture
 * pipeline to read live. Undefined when no client is launched (capture then applies defaults).
 */
export function getFilters(globalObj: object = globalThis): FilterStore | undefined {
  return getInternal(globalObj)?.getService(FiltersToken);
}
