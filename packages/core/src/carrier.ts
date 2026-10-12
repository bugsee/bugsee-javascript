import type { Interceptor } from './contracts';
import { type FilterStore, FiltersToken } from './filters';
import { BugseeStatus } from './launch-status';
import type {
  LifecycleDeliveryState,
  LifecycleEventsListener,
  LifecycleListenerSlot,
} from './lifecycle-events';
import type { ServiceRegistrar, ServiceResolver } from './services';
import type { NotifyItem } from './transport';

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
export const BUGSEE_SDK_VERSION = '0.1.0-beta.2';

const CARRIER_PROPERTY = '__BUGSEE__';

/** What a stale client handle needs of the client that owns the process blackout (R3L-4). */
export interface CarrierBlackoutOwner {
  /** Start the blackout on the owner (refused by the owner itself when it is not launched). */
  start(): void;
  /** Whether the owner is launched, i.e. a forwarded `start()` can take effect. */
  isLaunched(): boolean;
}

/** A process-global slot holding one SDK version's singletons. */
export interface BugseeCarrier {
  /** The SDK version this slot belongs to (=== its key in `__BUGSEE__`). */
  readonly version: string;
  /** Interceptor singletons keyed by interceptor `name` — one global patch per name. */
  readonly interceptors: Map<string, Interceptor<unknown>>;
  /** The process-global launched client (Bugsee is a per-process singleton, §1497/§473); else undefined. */
  client?: unknown;
  /** The process lifecycle state; absent means {@link BugseeStatus.Stopped}. */
  status?: BugseeStatus;
  /**
   * On the DEFAULT (`globalThis`) slot only: the custom carrier host the last launch used, so a plain
   * `relaunch()` (which is not told the host) finds the client and the remembered launch there (R2L-12).
   */
  lastHost?: object;
  /** What the last launch that built a client leaves for `relaunch()`: the token + only the integration seams (never secrets or the full options). */
  lastLaunch?: { appToken: string; options: unknown };
  /**
   * The application's lifecycle listener (Android keeps ONE static listener). Process-level so that
   * Launching/Launched are observable by a listener registered before any client exists, and so it
   * survives `relaunch()` (a new client has a new emitter, but reads the same slot).
   */
  lifecycleListener?: LifecycleEventsListener | null;
  /** The delivery queue of that listener (R2L-5): shared by every emitter of the process, like the slot. */
  lifecycleDelivery?: LifecycleDeliveryState;
  /**
   * Whether a blackout is in force. Process-level, like mobile: a relaunch builds a new client, and
   * silently ending the blackout there would resume capture of a screen the app asked to hide.
   */
  blackout?: boolean;
  /**
   * The client that currently owns the process-wide blackout (R3L-4): the newest one created or launched on
   * this carrier. Only it may change {@link BugseeCarrier.blackout}; a stale handle's start is forwarded to it.
   */
  blackoutOwner?: CarrierBlackoutOwner;
  /** True while `relaunch()` is stopping the old client and building the new one (notify backlog handover). */
  relaunching?: boolean;
  /** Notifications the old client could not deliver, waiting for the client `relaunch()` builds (R2L-6). */
  notifyBacklog?: NotifyItem[];
  /**
   * The launched client that takes over notifications another client hands back (R3L-5): a late hand-back
   * after the new client already adopted the backlog goes straight to it instead of parking on the carrier.
   * `owner` is the registering client's own token, so a client never hands items to itself.
   */
  notifyAdopter?: { owner: object; adopt(items: NotifyItem[]): void };
  /** The launch currently being built (async platforms), so `relaunch()` can wait for it. */
  pendingLaunch?: Promise<unknown>;
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
 * Clear the process-global client slot, but ONLY if it still holds `client`. A stale `stop()` (called
 * twice, or after a relaunch) must not evict the newer client that has since taken the slot.
 */
export function clearCarrierClient(client: unknown, globalObj: object = globalThis): void {
  const carrier = getCarrier(globalObj);
  if (carrier.client === client) {
    carrier.client = undefined;
  }
}

/** The process lifecycle state (Stopped until a launch begins). */
export function getCarrierStatus(globalObj: object = globalThis): BugseeStatus {
  return getCarrier(globalObj).status ?? BugseeStatus.Stopped;
}

/** Record the process lifecycle state. */
export function setCarrierStatus(status: BugseeStatus, globalObj: object = globalThis): void {
  getCarrier(globalObj).status = status;
}

/**
 * The process lifecycle state a top-level `getStatus()` reports: the launched client's own state when
 * there is one (so a killed SDK reads Stopped), else the carrier's (Launching during an async launch,
 * Stopping while the previous client drains, Stopped otherwise).
 */
export function getProcessStatus(globalObj: object = globalThis): BugseeStatus {
  const client = getCarrierClient<{ getStatus(): BugseeStatus }>(globalObj);
  return client !== undefined ? client.getStatus() : getCarrierStatus(globalObj);
}

/**
 * The launch options a carrier slot retains for `relaunch()`. Two kinds, both of which say WHERE and HOW the
 * SDK lives in this process rather than WHAT it should capture:
 *
 *  - INTEGRATION SEAMS (transport, carrier host, time source, stores, runtime handles, the error sink);
 *  - DEPLOYMENT IDENTITY (endpoint, app id/version/build, platform type, persistence and recovery, the
 *    tenant partitioning, the runtime scope handles). A relaunch that forgot these would upload to the
 *    DEFAULT production endpoint (a data-residency breach) and under the wrong app version.
 *
 * Everything else (host Bugsee options, identifiers, tokens other than the app token) is deliberately NOT
 * kept, so a relaunch without options starts from the defaults like Android and iOS. The slot sits on
 * `globalThis` next to the client itself, which already exposes more than these. Note that it therefore pins
 * the kept objects (transport, stores, `window`/`document`, `indexedDB`...) for the life of the process, after
 * the client that used them is gone: accepted, and the reason secrets and the full options are never kept.
 *
 * This list is the SINGLE source of truth: a table test in `@bugsee/bugsee` requires every launch option of
 * every platform to be classified as kept (here) or reset (listed in that test), so a new option cannot be
 * forgotten.
 */
export const RELAUNCH_KEPT_OPTIONS: readonly string[] = [
  // integration seams
  'transport',
  'carrier',
  'clock',
  'scheduler',
  'captureStore',
  'bundleStore',
  'capturedDataStore',
  'dataDir',
  'dataRootBase',
  'systemProbe',
  'cpuProfiler',
  'hangWatchdogFactory',
  'systemMetricsSampler',
  'requestContextStore',
  'triggerPipeline',
  'reportSnapshots',
  'fileEncoders',
  'process',
  'window',
  'document',
  'locks',
  'indexedDB',
  'deviceIdEnv',
  'onError',
  'asyncLocalStorage',
  'globalScope',
  'globalTarget',
  'global',
  'logger',
  'captureWriter',
  'serverInterceptor',
  'serverInstrumentations',
  'appRoot',
  'appStartTimeMs',
  // redaction hooks: forgetting one is a FAIL-OPEN privacy regression (the defaults keep the built-in
  // sanitizer, but whatever the application added on top would silently stop applying)
  'breadcrumbFilter',
  'logFilter',
  'networkFilter',
  'reportHandler',
  // deployment identity
  'endpoint',
  'appId',
  'appVersion',
  'appBuild',
  'platformType',
  'sdkVersion',
  'runtimeVersion',
  'deviceId',
  'persist',
  'recover',
  'partitionCaptureByTenant',
  'maxTenantPartitions',
];

/** Remember the token and the integration seams of a launch that built a client, for `relaunch()`. */
export function setCarrierLastLaunch(
  appToken: string,
  options: unknown,
  globalObj: object = globalThis,
): void {
  const retained: Record<string, unknown> = {};
  if (typeof options === 'object' && options !== null) {
    for (const key of RELAUNCH_KEPT_OPTIONS) {
      const value = (options as Record<string, unknown>)[key];
      if (value !== undefined) {
        retained[key] = value;
      }
    }
  }
  getCarrier(globalObj).lastLaunch = { appToken, options: retained };
  // Remember the custom host on the default slot, so a plain relaunch() can find it (R2L-12).
  const host = retained.carrier;
  getCarrier().lastHost =
    typeof host === 'object' && host !== null && host !== globalThis ? host : undefined;
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

/** The carrier's lifecycle-listener slot, in the shape the lifecycle emitter reads and writes. */
export function getCarrierLifecycleSlot(globalObj: object = globalThis): LifecycleListenerSlot {
  const carrier = getCarrier(globalObj);
  carrier.lifecycleDelivery ??= { queue: [], delivering: false };
  return {
    delivery: carrier.lifecycleDelivery,
    get: () => carrier.lifecycleListener ?? null,
    set: (listener) => {
      carrier.lifecycleListener = listener;
    },
  };
}

/**
 * Install the process-level lifecycle listener (replacing any previous one; `null` clears it). Callable
 * BEFORE `launch()`, so Launching and Launched are observable, and it survives `relaunch()`.
 */
export function setProcessLifecycleEventsListener(
  listener: LifecycleEventsListener | null,
  globalObj: object = globalThis,
): void {
  getCarrierLifecycleSlot(globalObj).set(listener);
}

/** Whether a blackout is in force process-wide. */
export function getCarrierBlackout(globalObj: object = globalThis): boolean {
  return getCarrier(globalObj).blackout === true;
}

/** Record the process-wide blackout state. */
export function setCarrierBlackout(active: boolean, globalObj: object = globalThis): void {
  getCarrier(globalObj).blackout = active;
}

/** The client that owns the process-wide blackout, if any client was ever created on this carrier. */
export function getCarrierBlackoutOwner(
  globalObj: object = globalThis,
): CarrierBlackoutOwner | undefined {
  return getCarrier(globalObj).blackoutOwner;
}

/** Make `owner` the client that owns the process-wide blackout (the newest created or launched wins). */
export function claimCarrierBlackoutOwner(
  owner: CarrierBlackoutOwner,
  globalObj: object = globalThis,
): void {
  getCarrier(globalObj).blackoutOwner = owner;
}

/** The launch that is still being built (async platforms), if any. */
export function getCarrierPendingLaunch(
  globalObj: object = globalThis,
): Promise<unknown> | undefined {
  return getCarrier(globalObj).pendingLaunch;
}

/** Record (or, with `undefined`, clear) the launch that is still being built. */
export function setCarrierPendingLaunch(
  pending: Promise<unknown> | undefined,
  globalObj: object = globalThis,
): void {
  getCarrier(globalObj).pendingLaunch = pending;
}

/** Whether `relaunch()` is in progress on this carrier (the old client hands its notify backlog over). */
export function getCarrierRelaunching(globalObj: object = globalThis): boolean {
  return getCarrier(globalObj).relaunching === true;
}

/** Mark `relaunch()` in progress (or finished). */
export function setCarrierRelaunching(active: boolean, globalObj: object = globalThis): void {
  getCarrier(globalObj).relaunching = active;
}
