import {
  createUnhandledRejectionProvider,
  createWindowErrorProvider,
  parseStack,
  type WindowEvents,
} from '@bugsee/browser';
import {
  createCoexistence,
  createIdbChunkBackend,
  createIdbChunkCaptureStore,
  createPersistentReportMarkerStore,
  fetchTransport,
  type LockManagerLike,
} from '@bugsee/browser-utils';
import {
  createConsoleInterceptor,
  createHttpErrorDetectionProvider,
  createLogCaptureProvider,
  installNetworkCapture,
} from '@bugsee/capture';
import {
  asInternalClient,
  BUGSEE_SDK_VERSION,
  type BugseeClient,
  BugseeStatus,
  type BundleStore,
  BundleStoreToken,
  type CaptureStore,
  type Clock,
  COMMON_OPTION_DEFINITIONS,
  clearCarrierClient,
  createBugseeApi,
  createBundleUploader,
  createClient,
  createDurableUploadPipeline,
  createMemoryCaptureStore,
  createServiceContainer,
  createSystemClock,
  createUploadPipeline,
  defineService,
  FAIL_CLOSED_BOOLEAN_OPTION,
  getCarrierClient,
  getCarrierStatus,
  getOrCreateInterceptor,
  getServiceManifests,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  LifecycleEvents,
  type LifecycleEventsListener,
  type OptionDefinition,
  ReportMarkerStoreToken,
  recoverReports,
  resolveLaunchOptions,
  runLaunchRecovery,
  type Scheduler,
  setCarrierClient,
  setCarrierLastLaunch,
  setCarrierStatus,
  TransportToken,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { isServiceWorker } from '@bugsee/util';
import {
  buildWorkerEnvironment,
  realWorkerProbe,
  type WorkerPlatformType,
  type WorkerProbe,
} from './environment';

// @bugsee/webworker launch() — the worker composition root (design §3.2/§3.3): a DOM-LESS browser-family SDK
// for Web Workers + Service Workers. It assembles the runtime-agnostic kernel (createClient) with the browser
// fetch transport + an in-memory capture store + the worker environment, then wires the capture/detection a
// worker actually supports: console→log + network (fetch/ws; xhr active in a dedicated worker / self-skips in a
// Service Worker; sse self-skips where absent), and global `error`/`unhandledrejection` detection on `self`
// (REUSING @bugsee/browser's providers — they take any addEventListener target, and the worker global
// satisfies it). NO DOM capture (input/viewtree), NO performance.memory traces, NO pagehide events, NO
// AsyncLocalStorage / per-request context (workers are stack-based).
//
// A long-lived DEDICATED/SHARED Web Worker runs memory-only + fire-and-forget flush (complete — it lives for
// the page's lifetime). A SERVICE WORKER is terminated when idle, so it gets two extra pieces: (1) a durable
// IndexedDB BUNDLE queue (`persist`, default ON for 'service-worker') so an assembled incident bundle survives
// a kill mid-upload + re-uploads next activation, and (2) the `withBugseeEvent` wrapper (event.ts) which hands
// the flush to `event.waitUntil` so the upload completes before the worker is killed (the SW analog of edge's
// ctx.waitUntil). Remaining follow-up: persisting the ROLLING capture buffer across activations (an IDB chunk
// capture store + marker recovery — only the rarer cross-activation case). The returned client IS the surface.

const SDK_VERSION = BUGSEE_SDK_VERSION;
const DEFAULT_ENDPOINT = 'https://api.bugsee.com';
// Browser/worker capture buffer ceiling (design §966: 10 MB on browser/worker).
const DEFAULT_MAX_DATA_SIZE_MB = 10;

/** Worker-local identifier of the `persist` switch: no cross-SDK identity. */
const PERSIST_OPTION_KEY = 'com.bugsee.option.worker.persist';

const WORKER_OPTION_DEFINITIONS: readonly OptionDefinition[] = [
  ...COMMON_OPTION_DEFINITIONS,
  { friendly: 'maxDataSize', key: BugseeOption.MaxDataSize, default: DEFAULT_MAX_DATA_SIZE_MB },
  // Persisting writes captured data to IndexedDB, so only boolean `true` turns it on; any other supplied value
  // (`'false'`, `0`, `null`) is OFF and reported, even on a Service Worker whose default is on (R3V-3). The
  // default here is only for an ABSENT option; `launch` substitutes the platform default below.
  { friendly: 'persist', key: PERSIST_OPTION_KEY, default: false, ...FAIL_CLOSED_BOOLEAN_OPTION },
];

/** A report severity / priority name (the `Severity` scale of the report). */
type SeverityLevel = 'verylow' | 'low' | 'medium' | 'high' | 'critical' | 'blocker';

export interface BugseeWorkerLaunchOptions {
  /** API origin (no trailing slash). Default https://api.bugsee.com. */
  endpoint?: string;
  /** SDK version reported in the environment. Default the package version. */
  sdkVersion?: string;
  /** app.package_id / app.version / app.build. */
  appId?: string;
  appVersion?: string;
  appBuild?: string;

  /** Capture console output as logs. Default true. */
  captureLogs?: boolean;
  /** Capture network (fetch/ws; xhr/sse/webtransport self-skip where the global is absent). Default true. */
  captureNetwork?: boolean;
  /** Capture request/response bodies (bounded read). Default true. */
  captureNetworkBodies?: boolean;
  /** Max captured request/response body size in bytes. Default 20480. */
  maxNetworkBodySize?: number;
  /** Minimum level of a log record to capture: `error | warning | info | debug | verbose`, or the integer 1-5. Default `verbose`. */
  captureLogsLevel?: 'error' | 'warning' | 'info' | 'debug' | 'verbose' | 1 | 2 | 3 | 4 | 5;
  /** Capture breadcrumbs (`addBreadcrumb`). Default true (mobile defaults to false). */
  captureBreadcrumbs?: boolean;
  /**
   * Apply the built-in network PII sanitizer (URL, headers, bodies, error text). Default true; off ONLY for an
   * explicit `false`. A `setNetworkEventFilter` filter REPLACES it; compose with `getDefaultNetworkSanitizer()`.
   */
  captureNetworkDefaultSanitizer?: boolean;
  /**
   * Report HTTP SERVER errors (status 500-599) of fetch/XHR exchanges as `error` reports, once per session per
   * (method, templated URL, status), severity High, domain `HttpError::Server`. 4xx, transport failures and
   * aborted requests are not reported (mobile parity). Default false.
   */
  detectHttpErrors?: boolean;
  /** Severity a crash report starts with. Default `blocker`. */
  reportDefaultCrashPriority?: SeverityLevel;
  /** Severity an error report starts with. Default `high`. */
  reportDefaultErrorPriority?: SeverityLevel;
  /** Severity a bug report (an `upload()`, a shake, ...) starts with when none is given. Default `high`. */
  reportDefaultBugPriority?: SeverityLevel;
  /** `notify()` batching window in ms (0 = send as soon as the tick ends). Default 0. */
  notifyFlushDelay?: number;
  /** Capture a body even when its Content-Type is missing/blank. Default false. */
  captureNetworkBodyWithoutType?: boolean;
  /** Detect global `error` + `unhandledrejection` on the worker scope. Default true. */
  detectCrashes?: boolean;

  /** Rolling recording window in seconds. Default 60. */
  maxRecordingTime?: number;
  /** Max captured data kept in the rolling buffer, in megabytes. Default 10. */
  maxDataSize?: number;
  /**
   * Persist the capture + bundle queue to IndexedDB so an incident survives the worker being TERMINATED mid-
   * upload (or before its bundle is assembled) and is re-uploaded on the next activation — essential for a
   * Service Worker (killed when idle), unneeded for a long-lived Web Worker. Default ON for `service-worker`,
   * OFF for `web-worker`. An explicit `captureStore`/`bundleStore` overrides the respective store.
   */
  persist?: boolean;
  /** Re-upload any bundle/incident a prior activation left behind, on the next launch. Default true. */
  recover?: boolean;
  /** Internal-error sink (provider-start / operation failures). Default no-op. */
  onError?: (error: unknown) => void;

  /** environment.platform.type. DETECTED from the runtime (`ServiceWorkerGlobalScope`); pass this only to
   *  override that. It also decides the `persist` default, so detection is what makes a Service Worker
   *  durable without the developer knowing this option exists. */
  platformType?: WorkerPlatformType;
  /** Durable bundle store override (crash recovery across restarts). Default: IndexedDB when `persist`. */
  bundleStore?: BundleStore;

  // Injectable seams (advanced / tests) — defaults target the real worker runtime.
  /** HTTP primitive. Default the browser fetch transport. */
  transport?: HttpTransport;
  /** The worker global event target for detection. Default the worker `self`. */
  globalScope?: WindowEvents;
  /** Time source. Default the system clock. */
  clock?: Clock;
  /** Scheduler for the capture-store tick. Default global timers. */
  scheduler?: Scheduler;
  /** Capture store override. Default in-memory. */
  captureStore?: CaptureStore;
  /** System probe for the environment envelope. Default realWorkerProbe (navigator). */
  systemProbe?: WorkerProbe;
  /** Carrier host for the process-global singletons; injectable for tests. Default `globalThis`. */
  carrier?: object;
  /**
   * The application's lifecycle listener (Android `setLifecycleEventsListener`): Launching, Launched,
   * Stopping, Stopped, Blackout*, report events. Installed BEFORE the client launches, so Launching and
   * Launched are observable, and held on the process carrier, so it survives a relaunch. `RelaunchedAfterCrash`
   * is told when the launch recovery finds a dead sibling's unsettled incident marker. The same listener can
   * be set later with `client.setLifecycleEventsListener(...)`.
   */
  lifecycleEventsListener?: LifecycleEventsListener;
  /** Web Locks manager for multi-instance liveness. Default `navigator.locks` (degrades when absent). */
  locks?: LockManagerLike;
  /** IDBFactory for the durable queue; injectable for tests. Default `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
}

/** The launched worker client — the public worker SDK surface. */
export type Bugsee = BugseeClient;

// Tag every SDK request with X-Bugsee-Internal so the network capture self-skips the SDK's own traffic.
const internalTagged =
  (transport: HttpTransport): HttpTransport =>
  (url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> =>
    transport(url, { ...options, headers: { ...options.headers, 'x-bugsee-internal': '1' } });

/** Launch the Bugsee worker SDK. A per-worker singleton (a repeat call is ignored). Returns the started client. */
export function launch(appToken: string, options: BugseeWorkerLaunchOptions = {}): Bugsee {
  const sdkVersion = options.sdkVersion ?? SDK_VERSION;
  const baseUrl = options.endpoint ?? DEFAULT_ENDPOINT;
  const carrier = options.carrier;
  // The worker global (`self` === globalThis in a worker) is the detection event target.
  const scope = options.globalScope ?? (globalThis as { self?: WindowEvents }).self;

  const alreadyLaunched = getCarrierClient<Bugsee>(carrier);
  if (alreadyLaunched !== undefined) {
    options.onError?.(
      new Error('Bugsee.launch() called more than once in this worker; the repeat call is ignored'),
    );
    return alreadyLaunched;
  }

  const resolved = resolveLaunchOptions(
    options as unknown as Record<string, unknown>,
    WORKER_OPTION_DEFINITIONS,
    options.onError,
  );

  const services = createServiceContainer();
  services.addService(
    defineService(TransportToken, () => internalTagged(options.transport ?? fetchTransport)),
  );
  const transport = services.getProvider(TransportToken).getImmediate();
  const api = createBugseeApi(transport, { baseUrl, appToken, sdkVersion, sendUserAgent: false });
  const uploader = createBundleUploader(transport);
  const baseUploadPipeline = createUploadPipeline({ api, uploader });

  // Persistence defaults ON for a Service Worker (terminated when idle) and OFF for a long-lived Web Worker.
  // DETECTED, not declared. `platformType` defaulted to 'web-worker' and `persist` derives from it, so a
  // Service Worker installed the documented way silently ran memory-only and lost everything each time the
  // worker was terminated for idleness — nothing errored, nothing warned. `isServiceWorker()` has been in
  // @bugsee/util the whole time with zero callers (Wave 4.2). An explicit option still wins.
  const platformType: WorkerPlatformType =
    options.platformType ?? (isServiceWorker() ? 'service-worker' : 'web-worker');
  const persist =
    options.persist === undefined
      ? platformType === 'service-worker'
      : resolved.options.get<boolean>(PERSIST_OPTION_KEY, false);
  // Persist the ROLLING capture buffer too (durable IDB chunk store + marker recovery) when persisting and no
  // capture-store override — so a Service Worker killed BEFORE its incident bundle is assembled still delivers
  // the report, rebuilt from its preserved capture chunks, on the next activation. `recoverEnabled` additionally
  // records incident markers + runs recovery (#165).
  const durableCapture = persist && options.captureStore === undefined;
  const recoverEnabled = (options.recover ?? true) && durableCapture;

  // Durable bundle queue + (when `durableCapture`) capture-chunk/marker stores, multi-instance-safe: several
  // tabs/workers share the origin's IndexedDB, so each launch writes under its own per-instance prefix in a
  // per-APP-TOKEN database and recovers only DEAD siblings' leftovers (under a Web Lock). An explicit bundleStore
  // bypasses bundle coexistence (the caller owns durability); else `persist` builds the per-instance IndexedDB
  // store (mirror hydrates async — recover() is deferred to whenReady below).
  const coexistence = createCoexistence({
    appToken,
    persist,
    captureRecovery: durableCapture,
    ...(options.bundleStore !== undefined ? { bundleOverride: options.bundleStore } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    ...(options.locks !== undefined ? { locks: options.locks } : {}),
    ...(options.indexedDB !== undefined ? { indexedDB: options.indexedDB } : {}),
  });
  const bundleStore = coexistence.bundleStore;
  if (bundleStore !== undefined) {
    services.addService(defineService(BundleStoreToken, () => bundleStore));
  }
  const durable =
    (options.recover ?? true) && bundleStore !== undefined
      ? createDurableUploadPipeline({
          store: bundleStore,
          pipeline: baseUploadPipeline,
          ...(options.onError !== undefined ? { onError: options.onError } : {}),
        })
      : undefined;
  const uploadPipeline = durable ?? baseUploadPipeline;

  const probe = options.systemProbe ?? realWorkerProbe;
  const getEnvironment = () =>
    buildWorkerEnvironment(
      {
        sdkVersion,
        platformType,
        options: resolved.canonical,
        ...(options.appId !== undefined ? { appId: options.appId } : {}),
        ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
        ...(options.appBuild !== undefined ? { appBuild: options.appBuild } : {}),
      },
      probe,
    );

  const maxRecordingTime = resolved.options.get(BugseeOption.Duration, 60);
  const maxDataSize = resolved.options.get(BugseeOption.MaxDataSize, DEFAULT_MAX_DATA_SIZE_MB);
  const storeBounds = {
    maxRecordingTimeMs: maxRecordingTime * 1000,
    maxDataSizeBytes: maxDataSize * 1024 * 1024,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  };
  const clock = options.clock ?? createSystemClock();
  const captureGeneration = clock.wallNow();
  // Capture store: explicit override > (durableCapture → per-instance IndexedDB chunk store, durable-as-captured
  // over the coexistence capture VIEW so the ROLLING buffer survives a termination) > in-memory. The report-
  // marker store records detected-incident metadata at incident time over the coexistence marker VIEW (only when
  // recovery is on), so a killed activation's incident is rebuilt from its preserved chunks on the next launch.
  const captureKeyed = coexistence.captureView;
  const reportMarkers =
    recoverEnabled && coexistence.markerView !== undefined
      ? createPersistentReportMarkerStore(coexistence.markerView, options.onError)
      : undefined;
  if (reportMarkers !== undefined) {
    services.addService(defineService(ReportMarkerStoreToken, () => reportMarkers));
  }
  const captureStore =
    options.captureStore ??
    (captureKeyed !== undefined
      ? createIdbChunkCaptureStore(captureKeyed, {
          ...storeBounds,
          generation: captureGeneration,
          ...(options.onError !== undefined ? { onError: options.onError } : {}),
        })
      : createMemoryCaptureStore(storeBounds));

  const client = createClient({
    // Process-level state (the lifecycle listener, the blackout flag) lives on the carrier, so a listener set
    // by option or by `setProcessLifecycleEventsListener` is the same one every client of the worker sees (R2L-4).
    carrier: carrier ?? globalThis,
    // stop() releases the carrier slot, the liveness lock and the IndexedDB handles, so a stopped client must
    // not be restarted in place (R2L-3): a new one comes from `launch(appToken)`.
    restartable: false,
    // The browser's multi-engine parser: core's default is V8-only, so a Safari/Firefox worker stack would
    // ship `frames: []` in crash.json (R3P-1).
    stackParser: parseStack,
    ...(options.lifecycleEventsListener !== undefined
      ? { lifecycleEventsListener: options.lifecycleEventsListener }
      : {}),
    isEnabled: resolved.isEnabled,
    launchOptions: resolved.options,
    launchOptionsView: { effective: resolved.canonical, host: resolved.host },
    services,
    uploadPipeline,
    appToken,
    getEnvironment,
    captureStore,
    ...(reportMarkers !== undefined
      ? { reportMarkers: { store: reportMarkers, generation: captureGeneration } }
      : {}),
    // No contextProvider — a worker is stack-based (no ALS) and has no per-request model.
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  for (const manifest of getServiceManifests(carrier)) {
    manifest(client);
  }

  // Capture providers: console→log + network (fetch/ws; xhr/sse/webtransport self-skip where absent).
  const consoleInterceptor = getOrCreateInterceptor(
    'console',
    // A worker runs in the SAME engine as the page that spawned it, so it needs the browser tier's
    // dialect-dispatching parser too — core's default is V8-only and yields zero frames for the
    // `fn@loc` stacks Firefox and Safari produce, silently dropping `console.trace()`'s stack.
    () => createConsoleInterceptor({ stackParser: parseStack }),
    carrier,
  );
  client.addCaptureProvider(createLogCaptureProvider(consoleInterceptor));
  const captureBodies = resolved.options.get(BugseeOption.CaptureNetworkBodies, true);
  const maxBodyBytes = resolved.options.get(BugseeOption.CaptureNetworkBodySizeLimit, 20480);
  const network = installNetworkCapture({ carrier, captureBodies, maxBodyBytes });
  client.addCaptureProvider(network.provider);
  // HTTP server errors (5xx) → `error` reports (mechanism http-error). Off unless `detectHttpErrors`.
  client.addDetectionProvider(createHttpErrorDetectionProvider(network.interceptor));

  // Detection: global `error` → crash, `unhandledrejection` → error, on the worker scope (gated by
  // detectCrashes via each provider's controllingOption). Skipped if there is no worker global (non-worker).
  if (scope !== undefined) {
    client.addDetectionProvider(createWindowErrorProvider(scope));
    client.addDetectionProvider(createUnhandledRejectionProvider(scope));
  }

  client.launch();

  // Recovery on the next activation: re-upload any bundle a prior activation assembled + persisted but
  // didn't deliver (e.g. the worker was killed mid-upload).
  //
  // The SEQUENCE — own queue, dead-sibling scan, release pass — is core's `runLaunchRecovery`: ONE
  // definition, which the node and browser tiers had copied verbatim. This tier supplies only what is
  // genuinely its own: the IndexedDB scan, and the mirror-hydration promise below.
  //
  // The queue is only readable once its mirror has hydrated — an IndexedDB-backed store serves list()
  // from RAM, so reading it earlier simply sees nothing. A synchronous (injected) store has none.
  const queueReady = (bundleStore as { whenReady?: Promise<void> } | undefined)?.whenReady;
  // The scan: every DEAD sibling instance (a crashed/terminated activation or a crashed tab on the same
  // origin), each under its own Web Lock so a LIVE sibling's data is never touched — re-upload its
  // leftover bundles directly AND, when recovery is on, rebuild + deliver its detected incidents from
  // its preserved capture chunks (core `recoverReports` over the sibling's prefixed views;
  // `currentGeneration: -1` ⇒ every generation is eligible). A no-op without coexistence. Reads the
  // shared stores directly (no mirror hydration). The coordinator hands this callback the sibling's
  // hydrated marker store plus the incidents its bundle-queue leg already settled with, so an incident
  // that left BOTH a staged bundle and a marker (the SEV1 double-upload) is delivered exactly once.
  let recoverySettled = false;
  let crashSignalled = false; // RelaunchedAfterCrash is told at most once per launch
  const recoveryDone = runLaunchRecovery({
    ...(durable !== undefined ? { queue: durable } : {}),
    // An explicit `bundleStore` bypasses coexistence: it is the integrator's own and stable across
    // activations, so the dead-sibling scan must get first refusal on it (docs on the option in core).
    shared: options.bundleStore !== undefined,
    pipeline: baseUploadPipeline,
    ...(queueReady !== undefined ? { whenReady: queueReady } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    scan: (reconcileOwnQueue) =>
      coexistence.recoverDeadSiblings({
        uploadPipeline: baseUploadPipeline,
        ...(reconcileOwnQueue !== undefined ? { reconcileOwnQueue } : {}),
        ...(recoverEnabled
          ? {
              recoverReportsForSibling: async ({ captureView, markers, skipReportIds }) => {
                // R2D-2: an unsettled incident marker left by a dead sibling is this tier's honest evidence that
                // the previous activation did not end cleanly (told at most once, to a client still running).
                if (!crashSignalled && markers.list().length > 0 && client.isLaunched()) {
                  crashSignalled = true;
                  asInternalClient(client).emitLifecycleEvent(LifecycleEvents.RelaunchedAfterCrash);
                }
                await recoverReports({
                  backend: createIdbChunkBackend(captureView, {
                    generation: -1,
                    cleanOtherGenerations: false,
                    ...(options.onError !== undefined ? { onError: options.onError } : {}),
                  }),
                  currentGeneration: -1,
                  markers,
                  context: () => ({ appToken, environment: getEnvironment(), clock }),
                  uploadPipeline: baseUploadPipeline,
                  skipReportIds,
                  ...(options.onError !== undefined ? { onError: options.onError } : {}),
                });
              },
            }
          : {}),
      }),
  }).finally(() => {
    recoverySettled = true;
  });

  // The public client. stop() releases the per-worker carrier slot (only if it is still OURS: a late stop()
  // must not take the slot from a client that has since been relaunched) and, once it is SAFE, the
  // coexistence lock + IndexedDB handles: the same contract as the browser tier (review L7/L9).
  // WHEN the lock is released (R3L-1): it follows the ONE shared real drain, not any single stop() call. Every
  // stop() leaves a background observer on that drain (a stop(timeout) that gave up still gets its release when
  // the upload finishes), and the caller of a stop() that sees the drain finish releases too; whoever is first
  // releases, once. Instances are distinct (their own lock + IndexedDB prefix), so a relaunch needs no guard.
  const stopCore = client.stop;
  let released = false;
  const releaseIfSafe = (): void => {
    if (!released && recoverySettled) {
      released = true;
      coexistence.release();
    }
  };
  // Commit the capture store's queued writes ONCE per stop, however many paths (the caller, the background
  // observer) reach this point: closing IndexedDB under its write queue would lose the queue's tail (R2L-10).
  let storeFlushed: Promise<void> | undefined;
  /** A sink that throws must not turn a background step into an unhandled rejection (R4L-4 / R4H-7). */
  const reportSafe = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // the host's own sink threw: nothing left to tell
    }
  };
  const flushStore = async (): Promise<void> => {
    try {
      await captureStore.flush?.();
    } catch (error) {
      reportSafe(error);
    }
  };
  const makeDurable = (): Promise<void> => {
    storeFlushed ??= flushStore();
    return storeFlushed;
  };
  let observingDrain = false;
  const observeDrain = (wasLaunched: boolean): void => {
    if (observingDrain) {
      return;
    }
    observingDrain = true;
    stopCore().then(
      async (drained) => {
        if (!drained) {
          return;
        }
        try {
          if (wasLaunched) {
            // A FRESH flush, not the memoized one (R4L-4): a stop(timeout) that gave up memoized its flush
            // BEFORE the drain finished, and the drain's own writes (deferred chunk deletes) must be durable
            // before the connections are released.
            await flushStore();
          }
          await recoveryDone;
          releaseIfSafe();
        } catch (error) {
          reportSafe(error); // a throwing release()/sink is reported, never an unhandled rejection
        }
      },
      /* v8 ignore next -- defensive: the shared drain never rejects (every pipeline flush swallows its failures); the caller's own stop() promise would carry a rejection */
      () => undefined,
    );
  };
  const publicClient: Bugsee = {
    ...client,
    async stop(timeout?: number): Promise<boolean> {
      const wasLaunched = client.isLaunched();
      const owned = getCarrierClient(carrier) === publicClient;
      if (owned) {
        setCarrierStatus(wasLaunched ? BugseeStatus.Stopping : BugseeStatus.Stopped, carrier);
        clearCarrierClient(publicClient, carrier);
      }
      let drained = false;
      try {
        const stopping = stopCore(timeout);
        observeDrain(wasLaunched);
        drained = await stopping;
        return drained;
      } finally {
        // Make the data durable first (a launched client only: a killed one has no live store to flush), as the
        // browser tier does (R2L-10): closing IndexedDB under the capture store's write queue loses its tail.
        if (wasLaunched) {
          await makeDurable();
        }
        // The launch-time dead-sibling scan may still be reading IndexedDB; closing under it would only
        // make it reopen the connection. Wait for it, bounded by the caller's own deadline.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await (timeout === undefined
          ? recoveryDone
          : Promise.race([
              recoveryDone,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeout);
              }),
            ]));
        clearTimeout(timer);
        // Release ONLY when the drain completed (a timed-out upload may still be running here and another
        // context that saw this instance as dead would upload it again) and the recovery has settled.
        if (drained) {
          releaseIfSafe();
        }
        if (owned && getCarrierStatus(carrier) === BugseeStatus.Stopping) {
          setCarrierStatus(BugseeStatus.Stopped, carrier);
        }
      }
    },
  };
  setCarrierClient(publicClient, carrier);
  setCarrierLastLaunch(appToken, options, carrier);
  setCarrierStatus(BugseeStatus.Launched, carrier);
  return publicClient;
}
