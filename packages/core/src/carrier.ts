import type { Interceptor } from './contracts';

// Process-global Carrier (design §4.2 §214): a version-keyed slot on `globalThis.__BUGSEE__` holding
// the SDK's process-global singletons — currently the interceptor registry. Routing interceptor
// creation through it means that even if a bundler emits multiple copies of @bugsee/capture /
// @bugsee/core (mixed dep ranges, framework adapters), all copies WITHIN ONE SDK VERSION converge on
// the SAME interceptor instance — so a runtime global (fetch/console/...) is patched exactly once.
// Different SDK versions get separate slots so they coexist without fighting over the same global
// (the documented Sentry-carrier trade-off). The carrier is reached only via a `globalThis` cast (no
// node:/DOM imports), so core stays runtime-portable.

/** The SDK's own version — the carrier slot key. Distinct from the user-facing `sdkVersion` option. */
export const BUGSEE_SDK_VERSION = '0.0.0';

const CARRIER_PROPERTY = '__BUGSEE__';

/** A process-global slot holding one SDK version's singletons. */
export interface BugseeCarrier {
  /** The SDK version this slot belongs to (=== its key in `__BUGSEE__`). */
  readonly version: string;
  /** Interceptor singletons keyed by interceptor `name` — one global patch per name. */
  readonly interceptors: Map<string, Interceptor<unknown>>;
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
