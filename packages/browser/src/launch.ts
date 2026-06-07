import {
  createIdbBlobStore,
  createIdbChunkBackend,
  createIdbChunkCaptureStore,
  createIdbKeyedStore,
  createPersistentBundleStore,
  createPersistentReportMarkerStore,
  fetchTransport,
} from '@bugsee/browser-utils';
import {
  createConsoleInterceptor,
  createLogCaptureProvider,
  createSystemEventsProvider,
  createSystemTracesProvider,
  createUserEventsProvider,
  installNetworkCapture,
  type TraceSample,
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
import { BugseeOption } from '@bugsee/protocol';
import type { WindowEvents } from './detection-providers';
import { createUnhandledRejectionProvider, createWindowErrorProvider } from './detection-providers';
import {
  type BrowserProbe,
  BrowserProbeToken,
  buildBrowserEnvironment,
  realBrowserProbe,
} from './environment';
import { type BrowserInputEnv, createBrowserInputSource } from './input-source';
import { createBrowserSystemEventsSource } from './system-events';
import { createBrowserSystemTracesSampler } from './system-metrics';

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
  /** DOM event target for input capture (clicks/keys/changes/focus). Default `window.document`. */
  document?: BrowserInputEnv['target'];
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
}

/** The launched Bugsee client — the public browser SDK surface. */
export type Bugsee = BugseeClient;

// Wrap the transport so EVERY SDK request carries X-Bugsee-Internal — the network capture's default
// self-isolation skips it, so the SDK never records its own traffic.
const internalTagged =
  (transport: HttpTransport): HttpTransport =>
  (url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> =>
    transport(url, {
      ...options,
      headers: { ...options.headers, 'x-bugsee-internal': '1' },
    });

export function launch(appToken: string, options: BugseeLaunchOptions = {}): Bugsee {
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
    return alreadyLaunched;
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

  // Durable bundle queue: persist each bundle before upload and re-upload any left by a prior reload/
  // crash. An explicit bundleStore wins; else `persist` builds an IndexedDB-backed store (its in-memory
  // mirror hydrates asynchronously — recover() is deferred to whenReady below). With neither, nothing
  // durable.
  const bundleStore =
    options.bundleStore ??
    (options.persist === true
      ? createPersistentBundleStore(createIdbBlobStore(), options.onError)
      : undefined);
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

  const client = createClient({
    isEnabled: resolved.isEnabled,
    launchOptions: resolved.options,
    services,
    uploadPipeline,
    appToken,
    getEnvironment,
    captureStore,
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
  const inputDocument =
    options.document ?? (win as { document?: BrowserInputEnv['target'] }).document;
  const inputSource = getOrCreateInterceptor(
    'browser-input',
    () => createBrowserInputSource({ target: inputDocument }),
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
  return publicClient;
}
