import { tmpdir } from 'node:os';
import process from 'node:process';
import {
  createConsoleInterceptor,
  createLogCaptureProvider,
  createSystemEventsProvider,
  createSystemTracesProvider,
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
  ChunkStorageToken,
  type Clock,
  COMMON_OPTION_DEFINITIONS,
  createBugseeApi,
  createBundleUploader,
  createClient,
  createDurableUploadPipeline,
  createFileCaptureStore,
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
  type ReportSnapshotSource,
  resolveLaunchOptions,
  type Scheduler,
  SchedulerToken,
  setCarrierClient,
  TransportToken,
} from '@bugsee/core';
import {
  createBatchedFsChunkStorage,
  createNodeBundleStore,
  createNodeReportMarkerStore,
  httpRequest,
} from '@bugsee/node-utils';
import { BugseeOption, type EnvironmentEnvelope } from '@bugsee/protocol';
import { type CpuProfiler, createCpuProfiler } from './cpu-profiler';
import { type CapturedDataStore, resolveDataLocation } from './data-location';
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
import type { EventLoopWatchdog, EventLoopWatchdogDeps } from './event-loop-watchdog';
import { createHangDetectionProvider } from './hang-detection-provider';
import { createNodeHttpInterceptor } from './http-interceptor';
import { createHttpServerInterceptor, type ServerInstallable } from './http-server-interceptor';
import { createInstanceLayout, type InstanceIdentity, writeInstanceOwner } from './instance-layout';
import { startLivenessHeartbeat } from './liveness-heartbeat';
import { PROFILING_OPTION_DEFINITIONS, ProfilingOption } from './options';
import { createProfilingController, type ProfilingController } from './profiling-controller';
import { recoverInstances } from './recover-instances';
import {
  createNodeRequestContextStore,
  type RequestContextStore,
  RequestContextStoreToken,
} from './request-context-store';
import { sweepAgedInstances } from './sweep-instances';
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
// Periodic flush cadence for the batched capture writer — bounds the un-catchable-kill loss window.
const CAPTURE_FLUSH_MS = 1000;

// Node's launch-option definitions = the shared cross-runtime set plus Node's own. maxDataSize is
// platform-local because its default differs per runtime (50 MB on Node/Electron vs 10 MB on
// browser/edge), so it does not belong in COMMON_OPTION_DEFINITIONS; its canonical identifier still
// lives in @bugsee/protocol (BugseeOption.MaxDataSize) for cross-SDK / wire parity.
const NODE_OPTION_DEFINITIONS = [
  ...COMMON_OPTION_DEFINITIONS,
  { friendly: 'maxDataSize', key: BugseeOption.MaxDataSize, default: DEFAULT_MAX_DATA_SIZE_MB },
  ...PROFILING_OPTION_DEFINITIONS,
  // Hang detection (Android BugseeDetectionHang parity). Default ON — the worker heartbeat is ~free
  // (benchmarked); thresholds are Android-canonical (3000 / 5000 / 10000 ms).
  { friendly: 'detectHangs', key: BugseeOption.DetectHang, default: true },
  { friendly: 'hangFairMs', key: BugseeOption.DetectHangFairMs, default: 3000 },
  { friendly: 'hangMediumMs', key: BugseeOption.DetectHangMediumMs, default: 5000 },
  { friendly: 'hangSevereMs', key: BugseeOption.DetectHangSevereMs, default: 10_000 },
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
  /** Detect main-thread/event-loop hangs and report them (Android BugseeDetectionHang). Default true. */
  detectHangs?: boolean;
  /** Hang escalation thresholds in ms. Defaults 3000 (fair) / 5000 (medium) / 10000 (severe). */
  hangFairMs?: number;
  hangMediumMs?: number;
  hangSevereMs?: number;
  /** Attach a rolling V8 CPU profile to incident bundles (profile.json). Default false (overhead). */
  profiling?: boolean;
  /** CPU profiler sampling interval in microseconds. Default 1000 (1ms; <1% overhead). */
  profilingSamplingIntervalMicros?: number;

  /** Rolling recording window in seconds. Default 60. */
  maxRecordingTime?: number;
  /** Max captured data kept in the rolling buffer, in megabytes (memory/disk bound). Default 50. */
  maxDataSize?: number;
  /**
   * Where the rolling capture buffer lives: `'disk'` (the default on node/bun/deno — durable capture out of
   * the box, so a crash/OOM that beats bundle assembly still delivers the recording on the next launch) or
   * `'memory'` (the legacy in-RAM path, no disk/recovery). On disk with no `dataDir`, data lives under
   * `os.tmpdir()/bugsee`. See docs/design/server-disk-capture-write-path.md (D3).
   */
  capturedDataStore?: CapturedDataStore;
  /** Persist on-disk data (capture chunks + durable bundles) to this directory. Default `os.tmpdir()/bugsee`. */
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
  /** Capture store override; wins over dataDir/capturedDataStore. Default file-backed on disk (D3); 'memory' opts out. */
  captureStore?: CaptureStore;
  /** System probe for the environment envelope. Default realSystemProbe. */
  systemProbe?: SystemProbe;
  /** CPU profiler override (advanced / tests — avoids the real node:inspector). Default the V8 profiler. */
  cpuProfiler?: CpuProfiler;
  /** Hang watchdog factory (advanced / tests — avoids the real worker_threads). Default the real one. */
  hangWatchdogFactory?: (deps: EventLoopWatchdogDeps) => EventLoopWatchdog;
  /** System-traces sampler. Default the Node memory/cpu/event-loop sampler. */
  systemMetricsSampler?: () => readonly TraceSample[];
  /** Durable bundle store override; wins over dataDir/pending. Default fs-backed when dataDir is set. */
  bundleStore?: BundleStore;
  /** Carrier host for the process-global interceptor singletons; injectable for tests. Default `globalThis`. */
  carrier?: object;
  /**
   * Per-request context store (framework adapters; design: framework-adapters.md). Wired by default as
   * the core ContextProvider so the Express adapter can open per-request contexts; a no-op until a
   * context is opened. Injectable for tests. Default a fresh AsyncLocalStorage-backed store.
   */
  requestContextStore?: RequestContextStore;

  /**
   * Auto-instrument INCOMING HTTP servers (the node:http emit patch + any injected native serve wraps) for
   * a per-request context + an `http.server` APM transaction. ON BY DEFAULT — set `false` to opt out (the
   * escape hatch). Captures NO handled errors (the framework swallows them before node:http) and NO
   * headers/bodies; coexists with the framework adapters via first-owner-wins re-entrancy (exactly one
   * context + one transaction per request). See docs/design/incoming-server-instrumentation.md.
   */
  instrumentIncomingRequests?: boolean;
  /**
   * Additional server instrumentations installed (when `instrumentIncomingRequests` is on) AFTER node's own
   * node:http interceptor — the seam `@bugsee/bun` / `@bugsee/deno` use to inject their native Bun.serve /
   * Deno.serve wraps. Concatenated (not spread-replaced), so a caller's array never drops the platform's.
   */
  serverInstrumentations?: ServerInstallable[];
  /** The node:http server interceptor (advanced / tests — avoids patching the real prototype). Default the real one. */
  serverInterceptor?: ServerInstallable;
  /**
   * Override the per-instance identity (`<pid>-<threadId>-<nonce>`) that names this aggregator's on-disk
   * subtree under `dataDir` (multi-instance coexistence). Advanced / tests — pin a deterministic id. Default
   * derives from the real process + worker_threads + a random nonce.
   */
  instanceIdentity?: InstanceIdentity;
}

/** The launched Bugsee client — the public Node SDK surface. */
export type Bugsee = BugseeClient;

/**
 * The internal wiring `launchCore` hands back alongside the client — the seam the `bugsee` umbrella uses
 * to wire on-by-default extensions (performance / OpenTelemetry) WITHOUT `@bugsee/node` depending on them.
 * Structurally identical to `@bugsee/browser`'s `LaunchInternals` so the umbrella's wiring is
 * runtime-agnostic. Exposes only what is NOT already resolvable from the client's DI container (the
 * clock/scheduler ARE): the authenticated api + transport + base URL + environment builder, the network
 * capture umbrella (its `.interceptor` is the listenable source + request-decorator seam), and the app
 * version/build + error sink. NOT a stable public API — the composition root's internal handoff.
 */
export interface LaunchInternals {
  /** API origin (no trailing slash) for extension endpoints. */
  baseUrl: string;
  /** The authenticated control-plane API (session/Bearer); reused so extensions share the session. */
  api: BugseeApi;
  /** The internal-tagged transport (carries X-Bugsee-Internal) the SDK uses for all its own requests. */
  transport: HttpTransport;
  /** Rebuilds the environment envelope on demand (an extension's `send` needs it for `ensureSession`). */
  getEnvironment: () => EnvironmentEnvelope;
  /** The network capture umbrella — `.interceptor` is the listenable source + accepts request decorators. */
  network: NetworkCapture;
  /** app.version, if provided. */
  appVersion: string | undefined;
  /** app.build, if provided. */
  appBuild: string | undefined;
  /** The internal-error sink. */
  onError: ((error: unknown) => void) | undefined;
}

/**
 * The result of `launchCore`: the public client plus the internal wiring. `internals` is `undefined` on a
 * repeat launch (a prior call already owns the process singleton, so there is nothing new to wire).
 */
export interface LaunchResult {
  client: Bugsee;
  internals: LaunchInternals | undefined;
}

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

export function launchCore(appToken: string, options: BugseeLaunchOptions = {}): LaunchResult {
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
    return { client: alreadyLaunched, internals: undefined };
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

  // Per-instance on-disk subtree (multi-instance coexistence; design: multi-instance-disk-coexistence.md).
  // When file-backed, every store lives under <dataDir>/<instanceId>/ so several aggregators (worker_threads
  // / processes) sharing one dataDir never collide. owner.json is written up front so a peer can attribute +
  // liveness-check this subtree. `clock` is hoisted here (used by the owner timestamp + later wiring).
  const clock = options.clock ?? createSystemClock();
  // Resolve where on-disk data lives + whether capture goes to disk (D3: disk is the default on servers).
  // `effectiveDataDir` is the explicit dataDir, else os.tmpdir()/bugsee/<appTokenHash> when disk capture is
  // on, else undefined (a pure in-memory launch). Every on-disk seam below keys off `effectiveDataDir`.
  // (let, not const: a disk-setup failure below clears them to degrade to the in-memory path.)
  let { dataDir: effectiveDataDir, diskCapture } = resolveDataLocation(options, tmpdir(), appToken);
  let instanceLayout =
    effectiveDataDir !== undefined
      ? createInstanceLayout(effectiveDataDir, options.instanceIdentity ?? {})
      : undefined;
  if (instanceLayout !== undefined) {
    try {
      // The first eager fs write — the canary that the data root is usable. If it fails (a contended/
      // read-only/full tmp, or a foreign-owned shared root), an observability SDK must NEVER crash the host
      // app: report it and DEGRADE this launch to in-memory capture by clearing the on-disk seams.
      writeInstanceOwner(instanceLayout, clock.wallNow(), sdkVersion);
    } catch (error) {
      options.onError?.(error);
      instanceLayout = undefined;
      effectiveDataDir = undefined;
      diskCapture = false;
    }
  }

  // Durable bundle queue (guaranteed crash delivery): persist each bundle before upload and re-upload
  // any left behind by a crashed/killed run. Needs a stable on-disk location — the bundleStore
  // override, else <subtree>/pending; with neither (in-memory store) there's nothing durable to do.
  const bundleStore =
    options.bundleStore ??
    (instanceLayout !== undefined ? createNodeBundleStore(instanceLayout.pendingDir) : undefined);
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
  // The live capture chunk medium is the BATCHED writer (server write-path P1): per-entry appends are
  // buffered + `writev`-coalesced off the open-fd-per-chunk, instead of an open+write+close syscall per
  // entry — turning a blocking write's multi-second event-loop freeze into a ~10 ms tail (design §10).
  const chunkStorage =
    options.captureStore === undefined && instanceLayout !== undefined && diskCapture
      ? createBatchedFsChunkStorage(instanceLayout.captureDir, {
          ...(options.onError !== undefined ? { onError: options.onError } : {}),
        })
      : undefined;
  if (chunkStorage !== undefined) {
    services.addService(defineService(ChunkStorageToken, () => chunkStorage));
  }
  // Capture recovery (the detected-incident gap): keep this launch's generation explicit and shared by
  // the live store, the marker hook, and the recovery read-back. The marker store is a stable on-disk
  // location under this instance's subtree, distinct from chunks.
  const captureGeneration = clock.wallNow();
  const recoverEnabled = (options.recover ?? true) && chunkStorage !== undefined;
  const reportMarkers =
    recoverEnabled && instanceLayout !== undefined
      ? createNodeReportMarkerStore(instanceLayout.incidentsDir, options.onError)
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

  // CPU profiling (opt-in): a rolling V8 profiler whose current segment is pulled into the incident
  // bundle as profile.json at report time. The controller is built AFTER createClient (it needs the
  // resolved scheduler service), so the report-snapshot source is late-bound to it here.
  const profilingEnabled = resolved.isEnabled(ProfilingOption.Enabled);
  let profilingController: ProfilingController | undefined;
  const profilingSnapshot: ReportSnapshotSource = (now) =>
    profilingController !== undefined ? profilingController.snapshot(now) : [];

  // Per-request context store (framework adapters): one AsyncLocalStorage-backed store, wired as the core
  // ContextProvider (so capture entries are stamped + reports merge the active context) AND registered as
  // a container service so adapters resolve it for run()/setUser/setAttribute. A no-op until run() opens a
  // context, so non-adapter apps are unaffected.
  const requestContextStore = options.requestContextStore ?? createNodeRequestContextStore();
  services.addService(defineService(RequestContextStoreToken, () => requestContextStore));

  const client = createClient({
    isEnabled: resolved.isEnabled,
    launchOptions: resolved.options,
    services, // the internal container launch populated (transport + later seams)
    uploadPipeline,
    appToken,
    getEnvironment,
    captureStore,
    contextProvider: requestContextStore,
    ...(reportMarkers !== undefined
      ? { reportMarkers: { store: reportMarkers, generation: captureGeneration } }
      : {}),
    ...(profilingEnabled ? { reportSnapshots: [profilingSnapshot] } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  if (profilingEnabled) {
    profilingController = createProfilingController({
      profiler:
        options.cpuProfiler ??
        createCpuProfiler({
          samplingIntervalMicros: resolved.options.get(ProfilingOption.SamplingInterval, 1000),
        }),
      scheduler: client.getService(SchedulerToken),
      rollingIntervalMs: maxRecordingTime * 1000, // bound a single segment to the recording window
    });
  }

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

  // Detection providers: uncaughtException → crash, unhandledRejection → error, event-loop hang → error
  // (Android BugseeDetectionHang). Each is gated by its controllingOption (the coordinator skips it when
  // disabled), so they are added unconditionally.
  client.addDetectionProvider(createUncaughtExceptionProvider(proc));
  client.addDetectionProvider(createUnhandledRejectionProvider(proc));
  client.addDetectionProvider(
    createHangDetectionProvider({
      thresholds: {
        fairMs: resolved.options.get(BugseeOption.DetectHangFairMs, 3000),
        mediumMs: resolved.options.get(BugseeOption.DetectHangMediumMs, 5000),
        severeMs: resolved.options.get(BugseeOption.DetectHangSevereMs, 10_000),
      },
      scheduler: client.getService(SchedulerToken),
      ...(options.hangWatchdogFactory !== undefined
        ? { createWatchdog: options.hangWatchdogFactory }
        : {}),
    }),
  );

  client.launch();

  // Start the rolling CPU profiler (after launch, so the scheduler service is live).
  profilingController?.start();

  // Liveness heartbeat: while this instance lives it re-writes its `.live` (mtime) so a peer's recovery does
  // not reclaim its subtree (multi-instance coexistence). Started after launch (scheduler service is live).
  const heartbeat =
    instanceLayout !== undefined
      ? startLivenessHeartbeat({
          liveFile: instanceLayout.liveFile,
          scheduler: client.getService(SchedulerToken),
          ...(options.onError !== undefined ? { onError: options.onError } : {}),
        })
      : undefined;

  // Periodic flush of the batched capture writer's buffers to the OS page cache — bounds the data an
  // un-catchable kill (SIGKILL/OOM) can lose to ~CAPTURE_FLUSH_MS (a chunk seal flushes sooner under load).
  const captureFlushTimer = chunkStorage?.flushSync
    ? client.getService(SchedulerToken).setInterval(() => {
        try {
          chunkStorage.flushSync?.();
        } catch (error) {
          options.onError?.(error);
        }
      }, CAPTURE_FLUSH_MS)
    : undefined;

  // Re-upload any bundles THIS instance's own subtree left persisted (durable queue recovery — a no-op on a
  // fresh per-launch subtree, kept for symmetry/safety).
  durable?.recover();

  // Disk hygiene (D3): with disk capture default-on, reclaim ABANDONED sibling subtrees (a dead process,
  // aged past the TTL) so os.tmpdir()/bugsee doesn't accumulate. Runs synchronously BEFORE recovery (so the
  // two never race on the same subtree) and regardless of `recoverEnabled` — it's pure hygiene. The TTL is
  // generous, so the FRESH dead siblings recovery wants are untouched here.
  if (instanceLayout !== undefined && effectiveDataDir !== undefined) {
    sweepAgedInstances({
      dataDir: effectiveDataDir,
      ownInstanceId: instanceLayout.instanceId,
      now: () => clock.wallNow(), // the launch clock (testable; matches the owner.startedAt timebase)
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
    });
  }

  // Multi-instance recovery: scan the SIBLING instance subtrees under the shared dataDir and recover each
  // dead one's pending bundles + detected-incident markers (rebuilt from its capture chunks) through THIS
  // instance's upload pipeline, then remove the fully-delivered subtree. This subsumes the old "recover my
  // own prior generations" — a prior crashed run is just a dead sibling. Best-effort; never throws into
  // launch. (Liveness skip + atomic-rename claim land in slice 4; for now every non-own subtree is recovered,
  // correct while no live siblings exist.)
  if (recoverEnabled && instanceLayout !== undefined && effectiveDataDir !== undefined) {
    void recoverInstances({
      dataDir: effectiveDataDir,
      ownInstanceId: instanceLayout.instanceId,
      uploadPipeline,
      context: () => ({ appToken, environment: getEnvironment(), clock }),
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
    // Synchronously flush the batched capture writer FIRST, so the crash report (assembled from capture)
    // and the rolling buffer are durable before we exit — a catchable crash loses nothing.
    try {
      chunkStorage?.flushSync?.();
    } catch {
      // a flush failure must never replace the crash's own handling
    }
    void client.flush(shutdownTimeoutMs).finally(() => {
      if (exitOnUncaught) {
        proc.exit(1);
      }
    });
  };
  if (detectCrash) {
    proc.on('uncaughtException', onUncaughtException);
  }

  // Flush-on-exit (P1.4): node's `'exit'` event is the LAST synchronous hook before the process goes — it
  // fires on a drained event loop, an explicit process.exit(), and after the crash handler's exit. Flush the
  // batched writer's buffers here so a graceful/clean shutdown reaches the page cache and loses nothing
  // (bounding the un-flushed window the 1 s timer otherwise covers to ~0). Non-intrusive: it only does sync
  // work DURING exit and never alters exit behavior (unlike installing a SIGTERM handler, which would swallow
  // the signal). Installed only when the batched writer is in use; removed on stop().
  const onProcessExit = (): void => {
    try {
      chunkStorage?.flushSync?.();
    } catch (error) {
      options.onError?.(error);
    }
  };
  const flushesOnExit = chunkStorage?.flushSync !== undefined;
  if (flushesOnExit) {
    proc.on('exit', onProcessExit);
  }

  // Incoming-server auto-instrumentation (ON BY DEFAULT; `instrumentIncomingRequests: false` opts out —
  // design D3, flipped default-on). When on, install the node:http emit patch + any injected native serve
  // wraps (bun/deno). getClient is lazy (the carrier client, resolved per request, so install order vs
  // setCarrierClient does not matter). One patch per process — launch is a per-process singleton, so this
  // install runs once; uninstalled on stop(). The framework adapters coexist via first-owner-wins
  // re-entrancy (the owner here run-scopes the context + http.server txn; an adapter refines it).
  const serverInstallables: ServerInstallable[] = [];
  if (options.instrumentIncomingRequests !== false) {
    serverInstallables.push(
      options.serverInterceptor ??
        createHttpServerInterceptor({ getClient: () => getCarrierClient<Bugsee>(carrier) }),
    );
    serverInstallables.push(...(options.serverInstrumentations ?? []));
    try {
      for (const installable of serverInstallables) {
        installable.install();
      }
    } catch (error) {
      // Instrumentation must never break launch: undo any partial install (restoring the patched globals)
      // and report. The client is still returned + registered, so a retry launch won't double-patch.
      for (const installable of serverInstallables) {
        installable.uninstall();
      }
      options.onError?.(error);
    }
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
      if (flushesOnExit) {
        proc.off('exit', onProcessExit); // the dispose() below already flushes + closes
      }
      profilingController?.stop(); // clear the rolling timer + stop the profiler
      heartbeat?.stop(); // stop touching .live (this instance is shutting down cleanly)
      if (captureFlushTimer !== undefined) {
        client.getService(SchedulerToken).clearInterval(captureFlushTimer);
      }
      chunkStorage?.dispose?.(); // flush + close the batched writer's handles
      for (const installable of serverInstallables) {
        installable.uninstall(); // restore http.Server.prototype / Bun.serve / Deno.serve
      }
      setCarrierClient(undefined, carrier);
      return stopCore(timeout);
    },
  };
  setCarrierClient(publicClient, carrier);

  // The internal wiring the umbrella needs (everything not already a DI service). The clock/scheduler are
  // intentionally omitted — they are resolvable via client.getService(ClockToken/SchedulerToken).
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
// additionally surfaces the internal wiring (`LaunchInternals`) the `bugsee` umbrella uses to wire
// on-by-default extensions; bare `@bugsee/node` callers use this and never see the internals.
export function launch(appToken: string, options: BugseeLaunchOptions = {}): Bugsee {
  return launchCore(appToken, options).client;
}
