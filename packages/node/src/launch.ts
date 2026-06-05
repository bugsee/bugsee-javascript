import { join } from 'node:path';
import process from 'node:process';
import {
  createConsoleInterceptor,
  createLogCaptureProvider,
  createSystemEventsProvider,
  createSystemTracesProvider,
  installNetworkCapture,
  type TraceSample,
} from '@bugsee/capture';
import {
  type BugseeClient,
  type BundleStore,
  BundleStoreToken,
  type CaptureStore,
  ChunkStorageToken,
  type Clock,
  COMMON_OPTION_DEFINITIONS,
  createBugseeApi,
  createBundleUploader,
  createClient,
  createDurableUploadPipeline,
  createFileCaptureStore,
  createFileChunkBackend,
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
import {
  createFsChunkStorage,
  createNodeBundleStore,
  createNodeReportMarkerStore,
  httpRequest,
} from '@bugsee/node-utils';
import { BugseeOption } from '@bugsee/protocol';
import {
  createUncaughtExceptionProvider,
  createUnhandledRejectionProvider,
  type ProcessEvents,
} from './detection-providers';
import {
  buildNodeEnvironment,
  realSystemProbe,
  type SystemProbe,
  SystemProbeToken,
} from './environment';
import { createNodeHttpInterceptor } from './http-interceptor';
import { createNodeSystemEventsSource } from './system-events';
import { createNodeSystemMetricsSampler } from './system-metrics';

// @bugsee/node launch() — the Node composition root (design §7.1). It assembles the runtime-agnostic
// kernel (createClient) with Node's platform pieces and the shared capture layer, then starts it:
//   transport (node:http) → BugseeApi + BundleUploader → UploadPipeline ─┐
//   node EnvironmentEnvelope ───────────────────────────────────────────┤→ createClient
//   capture store (in-memory, or file-backed when dataDir is set) ───────┘
//   providers: console→log · network (fetch/xhr/ws/sse/wt + node:http) · system traces · system events
//   detection: uncaughtException (crash) · unhandledRejection (error)
//   crash policy: on uncaughtException, flush the just-submitted crash report then exit (opt-in).
// Each option toggle gates its provider via the coordinator; the returned client IS the public
// surface (event/trace/log/addBreadcrumb/logException/setUserIdentifier/stop/flush).

const SDK_VERSION = '0.0.0';
const DEFAULT_ENDPOINT = 'https://api.bugsee.com';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3000;
// Node/Electron capture buffer ceiling (design §966: 50 MB on Node, 10 MB on browser/edge).
const DEFAULT_MAX_DATA_SIZE_MB = 50;

// Node's launch-option definitions = the shared cross-runtime set plus Node's own. maxDataSize is
// platform-local because its default differs per runtime (50 MB on Node/Electron vs 10 MB on
// browser/edge), so it does not belong in COMMON_OPTION_DEFINITIONS; its canonical identifier still
// lives in @bugsee/protocol (BugseeOption.MaxDataSize) for cross-SDK / wire parity.
const NODE_OPTION_DEFINITIONS = [
  ...COMMON_OPTION_DEFINITIONS,
  { friendly: 'maxDataSize', key: BugseeOption.MaxDataSize, default: DEFAULT_MAX_DATA_SIZE_MB },
];

/** The Node runtime surface launch needs: process lifecycle events + a way to exit on crash. */
export interface NodeRuntime extends ProcessEvents {
  exit(code?: number): void;
}

export interface BugseeLaunchOptions {
  /** API origin (no trailing slash). Default https://api.bugsee.com. */
  endpoint?: string;
  /** SDK version reported in the environment + user-agent. Default the package version. */
  sdkVersion?: string;
  /** app.package_id. */
  appId?: string;
  /** app.version. */
  appVersion?: string;
  /** app.build. */
  appBuild?: string;

  /** Capture console output as logs. Default true. */
  captureLogs?: boolean;
  /** Capture network (fetch/xhr/ws/sse/webtransport + node:http). Default true. */
  captureNetwork?: boolean;
  /** Capture request/response bodies (bounded read). Default true. */
  captureNetworkBodies?: boolean;
  /** Max captured request/response body size in bytes. Default 20480. */
  maxNetworkBodySize?: number;
  /** Capture a body even when its Content-Type is missing/blank. Default false. */
  captureNetworkBodyWithoutType?: boolean;
  /** Capture periodic system traces (memory/cpu/event-loop lag). Default true. */
  captureSystemTraces?: boolean;
  /** Capture system events (process lifecycle). Default true. */
  captureSystemEvents?: boolean;
  /** Detect uncaught exceptions + unhandled rejections. Default true. */
  detectCrashes?: boolean;

  /** Rolling recording window in seconds. Default 60. */
  maxRecordingTime?: number;
  /** Max captured data kept in the rolling buffer, in megabytes (memory/disk bound). Default 50. */
  maxDataSize?: number;
  /** Persist capture to this directory (file-backed store). Default in-memory. */
  dataDir?: string;
  /** Budget (ms) to flush the crash report before exiting. Default 3000. */
  shutdownTimeoutMs?: number;
  /** Call process.exit(1) after flushing an uncaught exception. Default true. */
  exitOnUncaught?: boolean;
  /**
   * Durably persist each bundle before upload and re-upload any left behind by a crashed/killed run
   * on the next launch (guaranteed crash delivery). Requires a persistent location (dataDir or an
   * injected bundleStore); a no-op for an in-memory store. Default true.
   */
  recover?: boolean;
  /** Internal-error sink (provider-start / operation failures). Default no-op. */
  onError?: (error: unknown) => void;

  // Injectable seams (advanced / tests) — defaults target the real Node runtime.
  /** HTTP primitive. Default node-utils httpRequest. */
  transport?: HttpTransport;
  /** Process for lifecycle events + exit. Default the global process. */
  process?: NodeRuntime;
  /** Time source. Default the system clock (createClient's default). */
  clock?: Clock;
  /** Scheduler for the capture-store tick + system-traces sampling. Default global timers. */
  scheduler?: Scheduler;
  /** Capture store override; wins over dataDir. Default in-memory (or file-backed when dataDir set). */
  captureStore?: CaptureStore;
  /** System probe for the environment envelope. Default realSystemProbe. */
  systemProbe?: SystemProbe;
  /** System-traces sampler. Default the Node memory/cpu/event-loop sampler. */
  systemMetricsSampler?: () => readonly TraceSample[];
  /** Durable bundle store override; wins over dataDir/pending. Default fs-backed when dataDir is set. */
  bundleStore?: BundleStore;
  /** Carrier host for the process-global interceptor singletons; injectable for tests. Default `globalThis`. */
  carrier?: object;
}

/** The launched Bugsee client — the public Node SDK surface. */
export type Bugsee = BugseeClient;

// Wrap the transport so EVERY SDK request (control-plane sessions/issues AND the signed S3 PUT)
// carries X-Bugsee-Internal — the network capture's default self-isolation skips it, so the SDK
// never records its own traffic. An extra unsigned header is harmless to the S3 signature.
const internalTagged =
  (transport: HttpTransport): HttpTransport =>
  (url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> =>
    transport(url, {
      ...options,
      headers: { ...options.headers, 'x-bugsee-internal': '1' },
    });

export function launch(appToken: string, options: BugseeLaunchOptions = {}): Bugsee {
  const proc = options.process ?? (process as unknown as NodeRuntime);
  const sdkVersion = options.sdkVersion ?? SDK_VERSION;
  const baseUrl = options.endpoint ?? DEFAULT_ENDPOINT;

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

  // Resolve the friendly launch options to canonical com.bugsee.option.* form ONCE: the gate the
  // coordinators query (by each provider's controllingOption identifier), the OptionsContainer
  // providers read, and the canonical record sent (wire-form) in environment.sdk.options.
  const resolved = resolveLaunchOptions(
    options as unknown as Record<string, unknown>,
    NODE_OPTION_DEFINITIONS,
  );

  // The internal service container (the client's "BugseeInternal"). Node registers its platform
  // services into it here (the register() step, design §294); launch resolves them to assemble the
  // pipeline, then hands the SAME container to createClient. Increment 1: the HTTP transport.
  const services = createServiceContainer();
  services.addService(
    defineService(TransportToken, () => internalTagged(options.transport ?? httpRequest)),
  );

  // Transport → control plane + data plane → upload pipeline.
  const transport = services.getProvider(TransportToken).getImmediate();
  const api = createBugseeApi(transport, { baseUrl, appToken, sdkVersion });
  const uploader = createBundleUploader(transport);
  const baseUploadPipeline = createUploadPipeline({ api, uploader });

  // Durable bundle queue (guaranteed crash delivery): persist each bundle before upload and re-upload
  // any left behind by a crashed/killed run. Needs a stable on-disk location — the bundleStore
  // override, else <dataDir>/pending; with neither (in-memory store) there's nothing durable to do.
  const bundleStore =
    options.bundleStore ??
    (options.dataDir !== undefined
      ? createNodeBundleStore(join(options.dataDir, 'pending'))
      : undefined);
  if (bundleStore !== undefined) {
    services.addService(defineService(BundleStoreToken, () => bundleStore)); // container service (DI Phase 3)
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

  // Node environment envelope, rebuilt at each report so it reflects current state. The canonical
  // (dotted) options are wire-translated to colon form inside buildNodeEnvironment.
  const probe = options.systemProbe ?? realSystemProbe;
  services.addService(defineService(SystemProbeToken, () => probe)); // container service (DI Phase 3)
  const getEnvironment = () =>
    buildNodeEnvironment(
      {
        sdkVersion,
        options: resolved.canonical,
        ...(options.appId !== undefined ? { appId: options.appId } : {}),
        ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
        ...(options.appBuild !== undefined ? { appBuild: options.appBuild } : {}),
      },
      probe,
    );

  // Capture store: explicit override > file-backed (dataDir) > in-memory. The platform owns store
  // construction (and its byte/time bounds) for both paths so the maxDataSize ceiling is wired the
  // same way regardless of backend. Bounds: maxRecordingTime (s → ms window) + maxDataSize (MB →
  // byte cap, drop-oldest parts past either).
  const maxRecordingTime = resolved.options.get(BugseeOption.Duration, 60);
  const maxDataSize = resolved.options.get(BugseeOption.MaxDataSize, DEFAULT_MAX_DATA_SIZE_MB);
  const storeOptions = {
    maxRecordingTimeMs: maxRecordingTime * 1000,
    maxDataSizeBytes: maxDataSize * 1024 * 1024,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  };
  // The chunk-storage medium exists only when a dataDir is used without an explicit captureStore; it is
  // a container service (DI Phase 3) and the input to the file-backed store.
  const chunkStorage =
    options.captureStore === undefined && options.dataDir !== undefined
      ? createFsChunkStorage(join(options.dataDir, 'capture'))
      : undefined;
  if (chunkStorage !== undefined) {
    services.addService(defineService(ChunkStorageToken, () => chunkStorage));
  }
  // Capture recovery (the detected-incident gap): keep this launch's generation explicit and shared by
  // the live store, the marker hook, and the recovery read-back. When recovery is on (file-backed +
  // recover) we PRESERVE prior generations for the recovery pass (it cleans them up afterwards); else we
  // clean-on-init so nothing leaks. The marker store is a stable on-disk location, distinct from chunks.
  const clock = options.clock ?? createSystemClock();
  const captureGeneration = clock.wallNow();
  const recoverEnabled = (options.recover ?? true) && chunkStorage !== undefined;
  const reportMarkers =
    recoverEnabled && options.dataDir !== undefined
      ? createNodeReportMarkerStore(join(options.dataDir, 'incidents'), options.onError)
      : undefined;
  if (reportMarkers !== undefined) {
    services.addService(defineService(ReportMarkerStoreToken, () => reportMarkers)); // container service
  }
  const captureStore =
    options.captureStore ??
    (chunkStorage !== undefined
      ? createFileCaptureStore(chunkStorage, {
          ...storeOptions,
          generation: captureGeneration,
          cleanOtherGenerations: !recoverEnabled,
        })
      : createMemoryCaptureStore(storeOptions));

  const client = createClient({
    isEnabled: resolved.isEnabled,
    launchOptions: resolved.options,
    services, // the internal container launch populated (transport + later seams)
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

  // Run every service manifest contributed to the carrier (extensions / framework adapters / user code):
  // their contract-first services join the internal container — resolving deps from it — without launch
  // naming them. The container is fully populated (transport + the core seams) by this point, so a
  // contributed service can wire itself from any of them.
  for (const manifest of getServiceManifests(carrier)) {
    manifest(client);
  }

  // Capture providers (each gated by its controllingOption). Console→log, network umbrella with the
  // Node-native node:http source folded in, periodic system traces, and process system events. Each
  // interceptor that patches a global is obtained through the process Carrier (getOrCreateInterceptor,
  // keyed by name), so duplicated module copies share ONE instance / ONE patch (#47).
  const consoleInterceptor = getOrCreateInterceptor(
    'console',
    () => createConsoleInterceptor(),
    carrier,
  );
  client.addCaptureProvider(createLogCaptureProvider(consoleInterceptor));
  // Body-capture policy (shared by node:http + the cross-runtime fetch/xhr leaves).
  const captureBodies = resolved.options.get(BugseeOption.CaptureNetworkBodies, true);
  const maxBodyBytes = resolved.options.get(BugseeOption.CaptureNetworkBodySizeLimit, 20480);
  const nodeHttp = getOrCreateInterceptor(
    'node-http',
    () => createNodeHttpInterceptor({ captureBodies, maxBodyBytes }),
    carrier,
  );
  const network = installNetworkCapture({
    additionalSources: [nodeHttp],
    carrier,
    captureBodies,
    maxBodyBytes,
  });
  client.addCaptureProvider(network.provider);
  client.addCaptureProvider(
    createSystemTracesProvider({
      sample: options.systemMetricsSampler ?? createNodeSystemMetricsSampler(),
      ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    }),
  );
  client.addCaptureProvider(createSystemEventsProvider(createNodeSystemEventsSource(proc)));

  // Detection providers: uncaughtException → crash, unhandledRejection → error.
  client.addDetectionProvider(createUncaughtExceptionProvider(proc));
  client.addDetectionProvider(createUnhandledRejectionProvider(proc));

  client.launch();

  // Re-upload any bundles a prior crashed/killed run left persisted (durable queue recovery).
  durable?.recover();

  // Capture recovery: rebuild + re-deliver any detected incident whose bundle never reached the durable
  // queue (the process died during assembly), from its prior generation's preserved capture chunks. Runs
  // AFTER the durable-queue recover; best-effort (failures → onError, never throws), then it sweeps the
  // recovered + no-incident prior generations.
  if (reportMarkers !== undefined && chunkStorage !== undefined) {
    void recoverReports({
      backend: createFileChunkBackend(chunkStorage, {
        generation: captureGeneration,
        cleanOtherGenerations: false,
      }),
      currentGeneration: captureGeneration,
      markers: reportMarkers,
      context: () => ({ appToken, environment: getEnvironment(), clock }),
      uploadPipeline,
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
    });
  }

  // Crash flush-then-exit (design §15): on uncaughtException the detection provider (its listener
  // was registered during launch, so BEFORE this one) submits the crash report; flush() now awaits
  // that in-flight report, so the bundle is delivered before we exit. With the durable queue the
  // bundle is also persisted pre-upload, so even a hard exit before the upload lands is recovered.
  // Installed only when crash detection is enabled.
  const detectCrash = resolved.isEnabled(BugseeOption.DetectCrash);
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const exitOnUncaught = options.exitOnUncaught ?? true;
  const onUncaughtException = (): void => {
    void client.flush(shutdownTimeoutMs).finally(() => {
      if (exitOnUncaught) {
        proc.exit(1);
      }
    });
  };
  if (detectCrash) {
    proc.on('uncaughtException', onUncaughtException);
  }

  // The public client. stop() also (a) removes launch's crash handler — the core client cleans up the
  // detection providers but knows nothing about this listener — and (b) clears the process Carrier slot
  // so a later launch() starts a fresh client (the singleton is released on stop).
  const stopCore = client.stop;
  const publicClient: Bugsee = {
    ...client,
    stop(timeout?: number): Promise<boolean> {
      if (detectCrash) {
        proc.off('uncaughtException', onUncaughtException);
      }
      setCarrierClient(undefined, carrier);
      return stopCore(timeout);
    },
  };
  setCarrierClient(publicClient, carrier);
  return publicClient;
}
