import {
  createCoexistentBundleQueue,
  createIdbBlobStore,
  createIdbChunkBackend,
  createIdbChunkCaptureStore,
  createIdbKeyedStore,
  createPersistentReportMarkerStore,
  fetchTransport,
  type LockManagerLike,
} from '@bugsee/browser-utils';
import {
  createConsoleInterceptor,
  createLogCaptureProvider,
  createSystemEventsProvider,
  createSystemTracesProvider,
  createUserEventsProvider,
  installNetworkCapture,
  type NetworkCapture,
  type TraceSample,
} from '@bugsee/capture';
import {
  type BugseeApi,
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
  createSystemClock,
  createUploadPipeline,
  defineService,
  getCarrierClient,
  getOrCreateInterceptor,
  getServiceManifests,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  ReportMarkerStoreToken,
  recoverReports,
  resolveLaunchOptions,
  type Scheduler,
  setCarrierClient,
  TransportToken,
} from '@bugsee/core';
import { BugseeOption, type EnvironmentEnvelope } from '@bugsee/protocol';
import type { WindowEvents } from './detection-providers';
import { createUnhandledRejectionProvider, createWindowErrorProvider } from './detection-providers';
import {
  type BrowserProbe,
  BrowserProbeToken,
  buildBrowserEnvironment,
  realBrowserProbe,
} from './environment';
import { createBrowserInputSource } from './input-source';
import { createBrowserSystemEventsSource } from './system-events';
import { createBrowserSystemTracesSampler } from './system-metrics';
import { createViewtreeSnapshotSource } from './viewtree';

// @bugsee/browser launch() — the browser composition root (design §7.1), the fetch/DOM analog of node's
// launch(). It assembles the runtime-agnostic kernel (createClient) with the browser's platform pieces
// and the shared capture layer, then starts it:
//   fetch transport → BugseeApi + BundleUploader → UploadPipeline ─┐
//   browser EnvironmentEnvelope (navigator/screen) ────────────────┤→ createClient
//   in-memory capture store (IndexedDB persistence lands in B5) ────┘
//   providers: console→log · network (fetch/xhr/ws/sse/webtransport) · system traces (performance.memory)
//              · system events (process_started + pagehide)
//   detection: window error (crash) · unhandledrejection (error)
// Unlike node there is no process.exit window — the browser flushes via the pipeline / pagehide. The
// returned client IS the public surface.

const SDK_VERSION = '0.0.0';
const DEFAULT_ENDPOINT = 'https://api.bugsee.com';
// Browser/edge capture buffer ceiling (design §966: 10 MB on browser, 50 MB on Node).
const DEFAULT_MAX_DATA_SIZE_MB = 10;

// Browser launch-option definitions = the shared cross-runtime set plus the browser's own maxDataSize
// (10 MB default vs node's 50 — its canonical identifier lives in @bugsee/protocol for wire parity).
const BROWSER_OPTION_DEFINITIONS = [
  ...COMMON_OPTION_DEFINITIONS,
  { friendly: 'maxDataSize', key: BugseeOption.MaxDataSize, default: DEFAULT_MAX_DATA_SIZE_MB },
  // Input capture is browser/DOM-only (Node has no user input), so its gate lives here, not in COMMON.
  { friendly: 'captureInteractions', key: BugseeOption.CaptureInteractions, default: true },
  // View hierarchy is browser/DOM-only too.
  { friendly: 'captureViewHierarchy', key: BugseeOption.CaptureViewHierarchy, default: true },
];

export interface BugseeLaunchOptions {
  /** API origin (no trailing slash). Default https://api.bugsee.com. */
  endpoint?: string;
  /** SDK version reported in the environment. Default the package version. */
  sdkVersion?: string;
  /** app.package_id. */
  appId?: string;
  /** app.version. */
  appVersion?: string;
  /** app.build. */
  appBuild?: string;

  /** Capture console output as logs. Default true. */
  captureLogs?: boolean;
  /** Capture network (fetch/xhr/ws/sse/webtransport). Default true. */
  captureNetwork?: boolean;
  /** Capture request/response bodies (bounded read). Default true. */
  captureNetworkBodies?: boolean;
  /** Max captured request/response body size in bytes. Default 20480. */
  maxNetworkBodySize?: number;
  /** Capture a body even when its Content-Type is missing/blank. Default false. */
  captureNetworkBodyWithoutType?: boolean;
  /** Capture periodic system traces (performance.memory). Default true. */
  captureSystemTraces?: boolean;
  /** Capture system events (process_started + pagehide). Default true. */
  captureSystemEvents?: boolean;
  /** Capture user interactions (clicks/keys/changes/focus → events.user). Default true. */
  captureInteractions?: boolean;
  /** Capture a DOM view hierarchy (→ viewtree) at report time. Default true. */
  captureViewHierarchy?: boolean;
  /** Detect window errors + unhandled rejections. Default true. */
  detectCrashes?: boolean;

  /** Rolling recording window in seconds. Default 60. */
  maxRecordingTime?: number;
  /** Max captured data kept in the rolling buffer, in megabytes. Default 10. */
  maxDataSize?: number;
  /**
   * Persist the bundle queue to IndexedDB so a crash report survives a reload/kill mid-upload and is
   * re-uploaded on the next launch (guaranteed crash delivery). Off by default (in-memory only). An
   * explicit `bundleStore` overrides this.
   */
  persist?: boolean;
  /**
   * Re-upload any bundle left behind by a prior reload/crash on the next launch. Requires a persistent
   * bundle store (`persist` or an injected `bundleStore`); a no-op without one. Default true.
   */
  recover?: boolean;
  /** Internal-error sink (provider-start / operation failures). Default no-op. */
  onError?: (error: unknown) => void;

  // Injectable seams (advanced / tests) — defaults target the real browser runtime.
  /** HTTP primitive. Default the browser fetch transport. */
  transport?: HttpTransport;
  /** Window event target for detection + system events. Default the global `window`. */
  window?: WindowEvents;
  /** DOM document for input capture (clicks/keys/…) + the report-time viewtree. Default `window.document`. */
  document?: Document;
  /** Time source. Default the system clock (createClient's default). */
  clock?: Clock;
  /** Scheduler for the capture-store tick + system-traces sampling. Default global timers. */
  scheduler?: Scheduler;
  /** Capture store override. Default in-memory. */
  captureStore?: CaptureStore;
  /** System probe for the environment envelope. Default realBrowserProbe. */
  systemProbe?: BrowserProbe;
  /** System-traces sampler. Default the performance.memory sampler. */
  systemMetricsSampler?: () => readonly TraceSample[];
  /** Durable bundle store override (crash recovery across reloads). Default none (until B5). */
  bundleStore?: BundleStore;
  /** Carrier host for the process-global interceptor singletons; injectable for tests. Default `globalThis`. */
  carrier?: object;
  /** Web Locks manager for multi-instance liveness. Default `navigator.locks` (degrades when absent). */
  locks?: LockManagerLike;
  /** IDBFactory for the durable bundle queue; injectable for tests. Default `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
}

/** The launched Bugsee client — the public browser SDK surface. */
export type Bugsee = BugseeClient;

/**
 * The internal wiring `launchCore` hands back alongside the client — the seam the `bugsee` umbrella uses
 * to wire on-by-default extensions (performance) WITHOUT `@bugsee/browser` depending on them. It exposes
 * only what is NOT already resolvable from the client's DI container (the clock/scheduler ARE — read via
 * `getService(ClockToken/SchedulerToken)`): the authenticated api + transport + base URL + environment
 * builder (to construct an extension's `send`), the network capture umbrella (its `.interceptor` is the
 * listenable source for http spans), and the app version/build + error sink. NOT a stable public API —
 * it is the composition-root's internal handoff.
 */
export interface LaunchInternals {
  /** API origin (no trailing slash) for extension endpoints, e.g. `${baseUrl}/v2/performance/...`. */
  baseUrl: string;
  /** The authenticated control-plane API (session/Bearer); reused so extensions share the session. */
  api: BugseeApi;
  /** The internal-tagged transport (carries X-Bugsee-Internal) the SDK uses for all its own requests. */
  transport: HttpTransport;
  /** Rebuilds the environment envelope on demand (an extension's `send` needs it for `ensureSession`). */
  getEnvironment: () => EnvironmentEnvelope;
  /** The network capture umbrella — `.interceptor` is the listenable source of ALL network events. */
  network: NetworkCapture;
  /** app.version, if provided. */
  appVersion: string | undefined;
  /** app.build, if provided. */
  appBuild: string | undefined;
  /** The internal-error sink (defaults undefined → extensions use their own no-op). */
  onError: ((error: unknown) => void) | undefined;
}

/**
 * The result of `launchCore`: the public client plus the internal wiring. `internals` is `undefined` on
 * a repeat launch (a prior call already owns the process singleton, so there is nothing new to wire).
 */
export interface LaunchResult {
  client: Bugsee;
  internals: LaunchInternals | undefined;
}

// Wrap the transport so EVERY SDK request carries X-Bugsee-Internal — the network capture's default
// self-isolation skips it, so the SDK never records its own traffic.
const internalTagged =
  (transport: HttpTransport): HttpTransport =>
  (url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> =>
    transport(url, {
      ...options,
      headers: { ...options.headers, 'x-bugsee-internal': '1' },
    });

export function launchCore(appToken: string, options: BugseeLaunchOptions = {}): LaunchResult {
  const sdkVersion = options.sdkVersion ?? SDK_VERSION;
  const baseUrl = options.endpoint ?? DEFAULT_ENDPOINT;
  const win = options.window ?? window;

  // Bugsee is a per-process singleton (§1497): if a client was already launched (same SDK version on
  // the process Carrier), warn and return it rather than building a second client / second handler set.
  const carrier = options.carrier;
  const alreadyLaunched = getCarrierClient<Bugsee>(carrier);
  if (alreadyLaunched !== undefined) {
    options.onError?.(
      new Error(
        'Bugsee.launch() called more than once in this process; the repeat call is ignored',
      ),
    );
    return { client: alreadyLaunched, internals: undefined };
  }

  // Resolve friendly options to canonical com.bugsee.option.* form once (the gate, the OptionsContainer,
  // and the wire-form record in environment.sdk.options).
  const resolved = resolveLaunchOptions(
    options as unknown as Record<string, unknown>,
    BROWSER_OPTION_DEFINITIONS,
  );

  // The internal service container (the client's "BugseeInternal"). Register the fetch transport, then
  // resolve it to assemble the pipeline; hand the SAME container to createClient.
  const services = createServiceContainer();
  services.addService(
    defineService(TransportToken, () => internalTagged(options.transport ?? fetchTransport)),
  );

  const transport = services.getProvider(TransportToken).getImmediate();
  const api = createBugseeApi(transport, { baseUrl, appToken, sdkVersion });
  const uploader = createBundleUploader(transport);
  const baseUploadPipeline = createUploadPipeline({ api, uploader });

  // Durable bundle queue, multi-instance-safe: several tabs (+ the page's workers) share the origin's
  // IndexedDB, so each launch writes its bundles under its own per-instance prefix in a per-APP-TOKEN
  // database and recovers only DEAD siblings' leftovers (under a Web Lock) — never one held by a live tab.
  // An explicit bundleStore bypasses coexistence; else `persist` builds the per-instance IndexedDB store
  // (its in-memory mirror hydrates asynchronously — recover() is deferred to whenReady below). With
  // neither, nothing durable. (The capture-chunk + marker recovery dbs are NOT yet per-instance — slice 5.)
  const queue = createCoexistentBundleQueue({
    appToken,
    persist: options.persist === true,
    ...(options.bundleStore !== undefined ? { override: options.bundleStore } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    ...(options.locks !== undefined ? { locks: options.locks } : {}),
    ...(options.indexedDB !== undefined ? { indexedDB: options.indexedDB } : {}),
  });
  const bundleStore = queue.bundleStore;
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

  // Browser environment envelope, rebuilt at each report. Canonical options are wire-translated inside.
  const probe = options.systemProbe ?? realBrowserProbe;
  services.addService(defineService(BrowserProbeToken, () => probe));
  const getEnvironment = () =>
    buildBrowserEnvironment(
      {
        sdkVersion,
        options: resolved.canonical,
        ...(options.appId !== undefined ? { appId: options.appId } : {}),
        ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
        ...(options.appBuild !== undefined ? { appBuild: options.appBuild } : {}),
      },
      probe,
    );

  // Capture store: explicit override > (persist → IndexedDB-backed durable chunk store) > in-memory.
  // Bounds: maxRecordingTime (s → ms window) + maxDataSize (MB → byte cap). The persistent store is the
  // chunk store over an IndexedDB chunk backend (durable-as-captured: each entry is written through as
  // captured, only chunk metadata lives in RAM) in its own database ('bugsee-capture', distinct from the
  // bundle queue), so a post-reload/crash report can recover the prior generation's chunks.
  const maxRecordingTime = resolved.options.get(BugseeOption.Duration, 60);
  const maxDataSize = resolved.options.get(BugseeOption.MaxDataSize, DEFAULT_MAX_DATA_SIZE_MB);
  const storeBounds = {
    maxRecordingTimeMs: maxRecordingTime * 1000,
    maxDataSizeBytes: maxDataSize * 1024 * 1024,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  };
  // Capture recovery (the detected-incident gap): one generation shared by the live store, the marker
  // hook, and the recovery read-back. Enabled only for the IndexedDB store (persist, no captureStore
  // override) with recover on; preserve prior generations when recovering (the recovery pass sweeps
  // them), else clean-on-init. The capture keyed store is reused by the recovery read backend.
  const clock = options.clock ?? createSystemClock();
  const captureGeneration = clock.wallNow();
  const recoverEnabled =
    (options.recover ?? true) && options.persist === true && options.captureStore === undefined;
  const captureKeyed =
    options.persist === true && options.captureStore === undefined
      ? createIdbKeyedStore({ databaseName: 'bugsee-capture', storeName: 'capture' })
      : undefined;
  const reportMarkers = recoverEnabled
    ? createPersistentReportMarkerStore(
        createIdbBlobStore({ databaseName: 'bugsee-markers', storeName: 'markers' }),
        options.onError,
      )
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
          cleanOtherGenerations: !recoverEnabled,
          ...(options.onError !== undefined ? { onError: options.onError } : {}),
        })
      : createMemoryCaptureStore(storeBounds));

  // The DOM document drives BOTH input capture and the report-time viewtree (the same physical object).
  const domDocument: Document | undefined =
    options.document ?? (win as { document?: Document }).document;
  // View hierarchy: a DOM snapshot PULLED at report assembly → a `viewtree` entry (browser/DOM-only,
  // gated). The source self-noops where there is no DOM, so it is safe to register unconditionally when on.
  const captureViewtree = resolved.options.get(BugseeOption.CaptureViewHierarchy, true);
  const reportSnapshots = captureViewtree
    ? [createViewtreeSnapshotSource({ document: domDocument })]
    : undefined;

  const client = createClient({
    isEnabled: resolved.isEnabled,
    launchOptions: resolved.options,
    services,
    uploadPipeline,
    appToken,
    getEnvironment,
    captureStore,
    ...(reportSnapshots !== undefined ? { reportSnapshots } : {}),
    ...(reportMarkers !== undefined
      ? { reportMarkers: { store: reportMarkers, generation: captureGeneration } }
      : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  // Run every contributed service manifest against the now-populated container.
  for (const manifest of getServiceManifests(carrier)) {
    manifest(client);
  }

  // Capture providers (each gated by its controllingOption). Console→log; network umbrella over the
  // cross-runtime fetch/xhr/ws/sse/webtransport leaves; system traces (performance.memory); system
  // events (process_started + pagehide). Each global-patching interceptor is shared via the Carrier.
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
  client.addCaptureProvider(
    createSystemTracesProvider({
      sample: options.systemMetricsSampler ?? createBrowserSystemTracesSampler(),
      ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    }),
  );
  client.addCaptureProvider(
    createSystemEventsProvider(createBrowserSystemEventsSource({ window: win })),
  );
  // Input capture: one carrier-shared DOM source (capture-phase, passive, observe-only) → events.user.
  const inputSource = getOrCreateInterceptor(
    'browser-input',
    () => createBrowserInputSource({ target: domDocument }),
    carrier,
  );
  client.addCaptureProvider(createUserEventsProvider(inputSource));

  // Detection providers: window error → crash, unhandledrejection → error.
  client.addDetectionProvider(createWindowErrorProvider(win));
  client.addDetectionProvider(createUnhandledRejectionProvider(win));

  client.launch();

  // Recovery on the next launch, in order: (1) re-upload bundles a prior reload/crash already assembled +
  // persisted (durable queue); then (2) rebuild + deliver detected incidents whose bundle never got
  // assembled, from the preserved capture chunks. Each waits for its async IndexedDB mirror to hydrate
  // (so list() sees the leftovers); (2) runs AFTER (1) so a freshly rebuilt bundle the queue is
  // mid-uploading is not also re-enqueued by recover(). An injected (sync) bundle store recovers at once.
  const bundleRecovered =
    durable !== undefined
      ? ((bundleStore as { whenReady?: Promise<void> }).whenReady ?? Promise.resolve()).then(() =>
          durable.recover(),
        )
      : Promise.resolve();
  if (reportMarkers !== undefined && captureKeyed !== undefined) {
    void Promise.all([bundleRecovered, reportMarkers.whenReady]).then(() =>
      recoverReports({
        backend: createIdbChunkBackend(captureKeyed, {
          generation: captureGeneration,
          cleanOtherGenerations: false,
          ...(options.onError !== undefined ? { onError: options.onError } : {}),
        }),
        currentGeneration: captureGeneration,
        markers: reportMarkers,
        context: () => ({ appToken, environment: getEnvironment(), clock }),
        uploadPipeline,
        ...(options.onError !== undefined ? { onError: options.onError } : {}),
      }),
    );
  }
  // (3) Recover any DEAD sibling tab/worker's leftover bundles from the shared origin store, re-uploading
  // directly (no re-persist into our own queue). A no-op without coexistence (override / no persist / no
  // Web Locks); reads the shared store directly, so it needs no mirror hydration.
  void queue.recoverDeadSiblings(baseUploadPipeline);

  // The public client. stop() clears the process Carrier slot so a later launch() starts fresh. (No
  // process.exit handler to remove — the browser has none; the core client cleans up its providers.)
  const stopCore = client.stop;
  const publicClient: Bugsee = {
    ...client,
    stop(timeout?: number): Promise<boolean> {
      setCarrierClient(undefined, carrier);
      return stopCore(timeout);
    },
  };
  setCarrierClient(publicClient, carrier);

  // The internal wiring the umbrella needs (everything not already a DI service). The clock/scheduler
  // are intentionally omitted — they are resolvable via client.getService(ClockToken/SchedulerToken).
  const internals: LaunchInternals = {
    baseUrl,
    api,
    transport,
    getEnvironment,
    network,
    appVersion: options.appVersion,
    appBuild: options.appBuild,
    onError: options.onError,
  };
  return { client: publicClient, internals };
}

// The public composition root: the launched client. Equivalent to `launchCore(...).client` — `launchCore`
// additionally surfaces the internal wiring (`LaunchInternals`) that the `bugsee` umbrella uses to wire
// on-by-default extensions; bare `@bugsee/browser` callers use this and never see the internals.
export function launch(appToken: string, options: BugseeLaunchOptions = {}): Bugsee {
  return launchCore(appToken, options).client;
}
