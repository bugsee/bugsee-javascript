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
  type CaptureStore,
  type Clock,
  COMMON_OPTION_DEFINITIONS,
  createBugseeApi,
  createBundleUploader,
  createClient,
  createDurableUploadPipeline,
  createFileCaptureStore,
  createUploadPipeline,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  resolveLaunchOptions,
  type Scheduler,
} from '@bugsee/core';
import {
  createNodeBundleStore,
  createNodeFileStorageAdapter,
  httpRequest,
} from '@bugsee/node-utils';
import { BugseeOption } from '@bugsee/protocol';
import {
  createUncaughtExceptionProvider,
  createUnhandledRejectionProvider,
  type ProcessEvents,
} from './detection-providers';
import { buildNodeEnvironment, realSystemProbe, type SystemProbe } from './environment';
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

// Node's launch-option definitions = the shared cross-runtime set (Node adds none of its own yet;
// a Node-specific option would be appended here with a com.bugsee.option.<...> identifier).
const NODE_OPTION_DEFINITIONS = COMMON_OPTION_DEFINITIONS;

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
  /** Capture periodic system traces (memory/cpu/event-loop lag). Default true. */
  captureSystemTraces?: boolean;
  /** Capture system events (process lifecycle). Default true. */
  captureSystemEvents?: boolean;
  /** Detect uncaught exceptions + unhandled rejections. Default true. */
  detectCrashes?: boolean;

  /** Rolling recording window in seconds. Default 60. */
  maxRecordingTime?: number;
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

  // Resolve the friendly launch options to canonical com.bugsee.option.* form ONCE: the gate the
  // coordinators query (by each provider's controllingOption identifier), the OptionsContainer
  // providers read, and the canonical record sent (wire-form) in environment.sdk.options.
  const resolved = resolveLaunchOptions(
    options as unknown as Record<string, unknown>,
    NODE_OPTION_DEFINITIONS,
  );

  // Transport → control plane + data plane → upload pipeline.
  const transport = internalTagged(options.transport ?? httpRequest);
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

  // Capture store: explicit override > file-backed (dataDir) > in-memory (createClient default).
  const maxRecordingTime = resolved.options.get(BugseeOption.Duration, 60);
  let captureStore = options.captureStore;
  if (captureStore === undefined && options.dataDir !== undefined) {
    captureStore = createFileCaptureStore(createNodeFileStorageAdapter(options.dataDir), {
      maxRecordingTimeMs: maxRecordingTime * 1000,
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    });
  }

  const client = createClient({
    isEnabled: resolved.isEnabled,
    launchOptions: resolved.options,
    uploadPipeline,
    appToken,
    getEnvironment,
    maxRecordingTime,
    ...(captureStore !== undefined ? { captureStore } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  // Capture providers (each gated by its controllingOption). Console→log, network umbrella with the
  // Node-native node:http source folded in, periodic system traces, and process system events.
  client.addCaptureProvider(createLogCaptureProvider(createConsoleInterceptor()));
  const network = installNetworkCapture({ additionalSources: [createNodeHttpInterceptor()] });
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

  if (!resolved.isEnabled(BugseeOption.DetectCrash)) {
    return client;
  }

  // Crash flush-then-exit (design §15): on uncaughtException the detection provider (its listener
  // was registered during launch, so BEFORE this one) submits the crash report; flush() now awaits
  // that in-flight report, so the bundle is delivered before we exit. With the durable queue the
  // bundle is also persisted pre-upload, so even a hard exit before the upload lands is recovered.
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const exitOnUncaught = options.exitOnUncaught ?? true;
  const onUncaughtException = (): void => {
    void client.flush(shutdownTimeoutMs).finally(() => {
      if (exitOnUncaught) {
        proc.exit(1);
      }
    });
  };
  proc.on('uncaughtException', onUncaughtException);

  // stop() must also remove THIS process listener: the core client owns the detection providers'
  // cleanup but knows nothing about launch's crash handler, so without this a stopped SDK would
  // still flush + exit on a later uncaughtException (and re-launching would pile up handlers).
  const stopCore = client.stop;
  return {
    ...client,
    stop(timeout?: number): Promise<boolean> {
      proc.off('uncaughtException', onUncaughtException);
      return stopCore(timeout);
    },
  };
}
