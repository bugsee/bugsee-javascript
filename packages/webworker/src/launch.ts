import {
  createUnhandledRejectionProvider,
  createWindowErrorProvider,
  type WindowEvents,
} from '@bugsee/browser';
import { createCoexistence, fetchTransport, type LockManagerLike } from '@bugsee/browser-utils';
import {
  createConsoleInterceptor,
  createLogCaptureProvider,
  installNetworkCapture,
} from '@bugsee/capture';
import {
  type BugseeClient,
  type BundleStore,
  BundleStoreToken,
  type CaptureStore,
  type Clock,
  COMMON_OPTION_DEFINITIONS,
  createBugseeApi,
  createBundleUploader,
  createClient,
  createDurableUploadPipeline,
  createMemoryCaptureStore,
  createServiceContainer,
  createUploadPipeline,
  defineService,
  getCarrierClient,
  getOrCreateInterceptor,
  getServiceManifests,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  resolveLaunchOptions,
  type Scheduler,
  setCarrierClient,
  TransportToken,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
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

const SDK_VERSION = '0.0.0';
const DEFAULT_ENDPOINT = 'https://api.bugsee.com';
// Browser/worker capture buffer ceiling (design §966: 10 MB on browser/worker).
const DEFAULT_MAX_DATA_SIZE_MB = 10;

const WORKER_OPTION_DEFINITIONS = [
  ...COMMON_OPTION_DEFINITIONS,
  { friendly: 'maxDataSize', key: BugseeOption.MaxDataSize, default: DEFAULT_MAX_DATA_SIZE_MB },
];

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

  /** environment.platform.type. Default 'web-worker' (pass 'service-worker' from a Service Worker). */
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
  );

  const services = createServiceContainer();
  services.addService(
    defineService(TransportToken, () => internalTagged(options.transport ?? fetchTransport)),
  );
  const transport = services.getProvider(TransportToken).getImmediate();
  const api = createBugseeApi(transport, { baseUrl, appToken, sdkVersion });
  const uploader = createBundleUploader(transport);
  const baseUploadPipeline = createUploadPipeline({ api, uploader });

  // Persistence defaults ON for a Service Worker (terminated when idle) and OFF for a long-lived Web Worker.
  const persist = options.persist ?? options.platformType === 'service-worker';

  // Durable bundle queue, multi-instance-safe: several tabs/workers share the origin's IndexedDB, so each
  // launch writes under its own per-instance prefix in a per-APP-TOKEN database and recovers only DEAD
  // siblings' leftovers (under a Web Lock). An explicit bundleStore bypasses coexistence (the caller owns
  // durability); else `persist` builds the per-instance IndexedDB store (mirror hydrates async — recover()
  // is deferred to whenReady below).
  const coexistence = createCoexistence({
    appToken,
    persist,
    // The webworker has no capture-recovery path yet (#165) → bundle queue only, no captureRecovery.
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
        platformType: options.platformType ?? 'web-worker',
        options: resolved.canonical,
        ...(options.appId !== undefined ? { appId: options.appId } : {}),
        ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
        ...(options.appBuild !== undefined ? { appBuild: options.appBuild } : {}),
      },
      probe,
    );

  const maxRecordingTime = resolved.options.get(BugseeOption.Duration, 60);
  const maxDataSize = resolved.options.get(BugseeOption.MaxDataSize, DEFAULT_MAX_DATA_SIZE_MB);
  // Capture store: override > in-memory. (The rolling buffer stays in RAM; the in-activation capture is what a
  // SW incident reports. Persisting the rolling buffer across restarts — the IDB chunk store + marker recovery,
  // for the rarer cross-activation case — is a follow-up; the durable BUNDLE queue above already makes an
  // assembled incident bundle survive a termination.)
  const captureStore =
    options.captureStore ??
    createMemoryCaptureStore({
      maxRecordingTimeMs: maxRecordingTime * 1000,
      maxDataSizeBytes: maxDataSize * 1024 * 1024,
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    });

  const client = createClient({
    isEnabled: resolved.isEnabled,
    launchOptions: resolved.options,
    services,
    uploadPipeline,
    appToken,
    getEnvironment,
    captureStore,
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
    () => createConsoleInterceptor(),
    carrier,
  );
  client.addCaptureProvider(createLogCaptureProvider(consoleInterceptor));
  const captureBodies = resolved.options.get(BugseeOption.CaptureNetworkBodies, true);
  const maxBodyBytes = resolved.options.get(BugseeOption.CaptureNetworkBodySizeLimit, 20480);
  const network = installNetworkCapture({ carrier, captureBodies, maxBodyBytes });
  client.addCaptureProvider(network.provider);

  // Detection: global `error` → crash, `unhandledrejection` → error, on the worker scope (gated by
  // detectCrashes via each provider's controllingOption). Skipped if there is no worker global (non-worker).
  if (scope !== undefined) {
    client.addDetectionProvider(createWindowErrorProvider(scope));
    client.addDetectionProvider(createUnhandledRejectionProvider(scope));
  }

  client.launch();

  // Recovery on the next activation: re-upload any bundle a prior activation assembled + persisted but didn't
  // deliver (e.g. the worker was killed mid-upload). Waits for the IndexedDB mirror to hydrate so list() sees
  // the leftovers; a synchronous (injected) store recovers at once.
  if (durable !== undefined) {
    void ((bundleStore as { whenReady?: Promise<void> }).whenReady ?? Promise.resolve()).then(() =>
      durable.recover(),
    );
  }
  // Then recover any DEAD sibling instance's leftover bundles (a crashed tab/worker on the same origin),
  // re-uploading directly (no re-persist into our queue). A no-op without coexistence (override / no persist /
  // no Web Locks). Reads the shared store directly, so it needs no mirror hydration.
  void coexistence.recoverDeadSiblings({ uploadPipeline: baseUploadPipeline });

  // The public client. stop() clears the per-worker carrier slot so a later launch() starts fresh.
  const stopCore = client.stop;
  const publicClient: Bugsee = {
    ...client,
    stop(timeout?: number): Promise<boolean> {
      setCarrierClient(undefined, carrier);
      return stopCore(timeout);
    },
  };
  setCarrierClient(publicClient, carrier);
  return publicClient;
}
