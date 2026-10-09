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
  createInputProvider,
  createLogCaptureProvider,
  createSystemEventsProvider,
  createSystemTracesProvider,
  createVideoAuxProvider,
  installNetworkCapture,
  type NetworkCapture,
  type TraceSample,
} from '@bugsee/capture';
import {
  BUGSEE_SDK_VERSION,
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
  runLaunchRecovery,
  type Scheduler,
  setCarrierClient,
  TransportToken,
  type TriggerPipeline,
} from '@bugsee/core';
import { BugseeOption, type EnvironmentEnvelope } from '@bugsee/protocol';
import type { WindowEvents } from './detection-providers';
import { createUnhandledRejectionProvider, createWindowErrorProvider } from './detection-providers';
import { type DeviceIdEnv, realDeviceIdEnv, resolveBrowserDeviceId } from './device-id';
import {
  type BrowserProbe,
  BrowserProbeToken,
  buildBrowserEnvironment,
  realBrowserProbe,
} from './environment';
import { createBrowserInputSource } from './input-source';
import { installPageHideFlush } from './page-lifecycle';
import { parseStack } from './stack';
import { createBrowserSystemEventsSource } from './system-events';
import { createBrowserSystemTracesSampler } from './system-metrics';
import { createUiBreadcrumbProvider, createUiBreadcrumbSource } from './ui-breadcrumb-source';
import { createBrowserViewportSource } from './viewport-source';
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
// Unlike node there is no process.exit window and no signal, so the last reliable moment is a page-hide:
// `pagehide` / `visibilitychange`→hidden commit the capture store and drain the client (Wave 6.2). The
// returned client IS the public surface.

const SDK_VERSION = BUGSEE_SDK_VERSION;
// How long the page-hide flush waits for the client to drain (Wave 6.2). Short on purpose: a hiding page
// has no guaranteed time at all, so this bounds the attempt rather than promising it completes — what makes
// the data safe is that it becomes DURABLE, and the next page load recovers it.
const PAGE_HIDE_FLUSH_MS = 1000;
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

/** Session-replay options (a structural subset of `@bugsee/replay`'s options — no runtime dep here; replay
 *  is lazy-loaded). All masking defaults are fail-closed. */
export interface ReplayLaunchOptions {
  /** Mask every text node. Default true. */
  maskAllText?: boolean;
  /** Mask every input value. Default true. */
  maskAllInputs?: boolean;
  /** Block all media/iframes. Default true. */
  blockAllMedia?: boolean;
  /** Block all `<canvas>` — record only canvases opted in via `.bugsee-show`/`[data-bugsee-show]`. Default
   *  false (the opt-in `canvas` add-on is the primary gate; this is the extra-strict per-canvas mode). */
  blockAllCanvas?: boolean;
  /** Additional CSS selector whose text to mask. */
  maskTextSelector?: string;
  /** Additional CSS selector to block. */
  blockSelector?: string;
  /** Additional CSS selector whose input events to ignore. */
  ignoreSelector?: string;
  /** Full-snapshot cadence (ms) — bounds the retained window. Default 60000. */
  checkoutEveryNms?: number;
  /**
   * Opt-in canvas recording (rrweb `<canvas>` capture). `true` or an options object enables it;
   * `@bugsee/replay-canvas` is lazy-`import()`ed only then, so a no-canvas replay never loads it. Off by
   * default. A structural subset of `@bugsee/replay-canvas`'s `CanvasReplayOptions` (no static dep here).
   */
  canvas?:
    | boolean
    | { fps?: number | 'all'; quality?: number; imageType?: 'image/webp' | 'image/jpeg' };
}

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
  /**
   * Capture user interactions. Device presses (pointer/key) become entries on the SDK-captured `input`
   * stream; state changes (change/submit/focus) become `ui.*` breadcrumbs. Never `events.user`, which is
   * reserved for application-supplied `client.event()` data. Default true.
   */
  captureInteractions?: boolean;
  /** Capture a DOM view hierarchy (→ viewtree) at report time. Default true. */
  captureViewHierarchy?: boolean;
  /** Detect window errors + unhandled rejections. Default true. */
  detectCrashes?: boolean;
  /**
   * Session replay (rrweb). **On by default** — parity with the iOS/Android SDKs, which record by default.
   * An options object customises it; `false` opts out entirely. Masking is FAIL-CLOSED (mask all
   * text/inputs, block all media) whether or not the option is given.
   *
   * `@bugsee/replay` is lazy-`import()`ed, so it is a separate chunk that is fetched only when replay runs
   * (design D2/D8): `replay: false` therefore keeps the errors-only bundle genuinely free of it.
   *
   * Replay also requires a DOM. In a DOM-less host — an SSR / pre-render pass of any of the five
   * meta-framework adapters — the chunk is not fetched and nothing is recorded, whatever this option
   * says, silently. See the gate in `launchCore` for why the skip does not report through `onError`.
   */
  replay?: boolean | ReplayLaunchOptions;

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
  /**
   * Replace the report path: every detected incident and explicit `logException` is routed here INSTEAD of
   * being assembled into a bundle and uploaded. Default: the built-in assemble + upload.
   *
   * Exists for hosts where this process is not the uploader. `@bugsee/electron` renderers stream their
   * capture UP to the main process, so a renderer that assembled locally would produce a bundle from a
   * streaming store that yields nothing, under its own session id, while the main session holding all the
   * capture recorded no incident (docs/design/electron-renderer-incident-convergence.md §4.2).
   *
   * Symmetric with `captureStore` above — the same shape of seam, for the read side of the same problem.
   */
  triggerPipeline?: TriggerPipeline;
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
  /** Injectable device-id storage seams (tests). Default real browser stores. */
  deviceIdEnv?: DeviceIdEnv;
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
  /** Persisted browser device id resolved once per page. */
  deviceId: string;
  /** The internal-error sink (defaults undefined → extensions use their own no-op). */
  onError: ((error: unknown) => void) | undefined;
  /**
   * Where the performance controller's active transaction lives (D2 part 2). ALWAYS `undefined` here:
   * the browser keeps the process-wide single slot, which is correct for its one in-flight
   * navigation/interaction. Declared REQUIRED rather than optional (R-16) so the choice is stated, not
   * defaulted — a platform that forgets the field fails to typecheck at `wireUmbrella` instead of
   * silently inheriting a slot that is wrong under concurrency. Typed `undefined` rather than
   * `ActiveSpanStore | undefined` so this package needs no `@bugsee/performance` import.
   */
  activeSpanStore: undefined;
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

export async function launchCore(
  appToken: string,
  options: BugseeLaunchOptions = {},
): Promise<LaunchResult> {
  const sdkVersion = options.sdkVersion ?? SDK_VERSION;
  const baseUrl = options.endpoint ?? DEFAULT_ENDPOINT;
  const win = options.window ?? window;
  const deviceId = await resolveBrowserDeviceId(realDeviceIdEnv(options.deviceIdEnv ?? {}));

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

  // Multi-instance-safe coexistence root: several tabs (+ the page's workers) share the origin's IndexedDB,
  // so each launch namespaces ALL its durable data — the bundle queue AND (when `persist`) the capture-chunk
  // + report-marker stores — under its own per-instance prefix in per-APP-TOKEN databases, holds ONE Web Lock
  // for liveness, and recovers only DEAD siblings (never one a live tab holds). `durableCapture` builds the
  // per-instance capture/marker VIEWS the launch wraps; `recoverEnabled` additionally records + recovers
  // markers. A fresh instanceId per launch ⇒ self's namespaces are empty, so a prior crash is a dead sibling.
  const durableCapture = options.persist === true && options.captureStore === undefined;
  const recoverEnabled = (options.recover ?? true) && durableCapture;
  const coexistence = createCoexistence({
    appToken,
    persist: options.persist === true,
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

  // Browser environment envelope, rebuilt at each report. Canonical options are wire-translated inside.
  const probe = options.systemProbe ?? realBrowserProbe;
  services.addService(defineService(BrowserProbeToken, () => probe));
  const getEnvironment = () =>
    buildBrowserEnvironment(
      {
        sdkVersion,
        deviceId,
        options: resolved.canonical,
        ...(options.appId !== undefined ? { appId: options.appId } : {}),
        ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
        ...(options.appBuild !== undefined ? { appBuild: options.appBuild } : {}),
      },
      probe,
    );

  // Capture store: explicit override > (persist → per-instance IndexedDB durable chunk store) > in-memory.
  // Bounds: maxRecordingTime (s → ms window) + maxDataSize (MB → byte cap). The persistent store is the
  // chunk store over the coexistence capture VIEW (per-instance prefix in db 'bugsee-capture-<hash>'),
  // durable-as-captured: each entry written through as captured, only chunk metadata in RAM. `generation`
  // can stay wall-time — collisions across tabs are impossible (each tab has a distinct instance prefix), and
  // self's namespace is fresh, so `cleanOtherGenerations` is left at its harmless default (nothing to clean).
  const maxRecordingTime = resolved.options.get(BugseeOption.Duration, 60);
  const maxDataSize = resolved.options.get(BugseeOption.MaxDataSize, DEFAULT_MAX_DATA_SIZE_MB);
  const storeBounds = {
    maxRecordingTimeMs: maxRecordingTime * 1000,
    maxDataSizeBytes: maxDataSize * 1024 * 1024,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  };
  const clock = options.clock ?? createSystemClock();
  const captureGeneration = clock.wallNow();
  // The report-marker store records detected-incident metadata at incident time (R1) over the coexistence
  // marker VIEW; built only when recovery is on. The capture VIEW backs the durable chunk store.
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

  // The DOM document drives BOTH input capture and the report-time viewtree (the same physical object).
  const domDocument: Document | undefined =
    options.document ?? (win as { document?: Document }).document;
  // View hierarchy: a DOM snapshot PULLED at report assembly → a `viewtree` entry (browser/DOM-only,
  // gated). The source self-noops where there is no DOM, so it is safe to register unconditionally when on.
  const captureViewtree = resolved.options.get(BugseeOption.CaptureViewHierarchy, true);
  const reportSnapshots = captureViewtree
    ? [createViewtreeSnapshotSource({ document: domDocument })]
    : undefined;

  // Session replay (lazy). When enabled, a shared fileEncoders map is threaded into the client's report
  // assembly (RP5a) — @bugsee/replay writes its `replay.bin` encoder into it after the lazy import resolves.
  // ON BY DEFAULT (an opt-OUT): video is Bugsee's headline feature and both mobile SDKs record by default,
  // so a web integrator who never sets the option gets a session recording too. `replay: false` is the
  // explicit errors-only path — the value that keeps @bugsee/replay out of the loaded bundle.
  //
  // …AND a DOM must exist. rrweb records the DOM, so replay is meaningless without one. This matters
  // BECAUSE the option is now an opt-out: `@bugsee/browser` is launched in DOM-less hosts for real — all
  // five meta-framework adapters (nextjs/nuxt/remix/sveltekit/astro) server-render — and without this gate
  // every server render would dynamic-`import()` ~56KB of rrweb, call `record()`, throw, and have the
  // rejection swallowed by the `.catch(onError)` below whenever no onError is configured. The probe is the
  // SAME `domDocument` binding the input source and the viewtree snapshot already gate on (resolved just
  // above), not a bespoke `typeof window` test: one definition of "this host has a DOM" for the whole file,
  // and it honours the injected `document` seam. `@bugsee/replay` self-skips too (defence in depth, for a
  // consumer that imports it directly) — but only THIS gate keeps the chunk from being fetched at all,
  // which is the entire point of the import being dynamic.
  //
  // The skip is SILENT — no onError. A DOM-less host is a supported environment, not a misconfiguration,
  // and this is now the DEFAULT path: reporting it would fire an internal "error" on every single server
  // render. It is also not actionable, since meta-framework integrations share one options object across
  // the server and client renders — an explicit `replay: true` legitimately reaches the server render, and
  // the correct behaviour there is to record nothing and say nothing. This matches how every cross-runtime
  // capture interceptor treats a missing global (see @bugsee/capture's sse/web-socket interceptors).
  const replayEnabled = options.replay !== false && domDocument !== undefined;
  const fileEncoders: Record<'replay', (payloads: unknown[]) => Uint8Array> | undefined =
    replayEnabled ? ({} as Record<'replay', (payloads: unknown[]) => Uint8Array>) : undefined;

  const client = createClient({
    isEnabled: resolved.isEnabled,
    launchOptions: resolved.options,
    services,
    uploadPipeline,
    appToken,
    getEnvironment,
    captureStore,
    ...(options.triggerPipeline !== undefined ? { triggerPipeline: options.triggerPipeline } : {}),
    // The browser's multi-engine (V8/SpiderMonkey/JavaScriptCore) stack parser → so logException's crash.json
    // parses non-V8 stacks too (the detection providers already use it directly).
    stackParser: parseStack,
    ...(fileEncoders !== undefined ? { fileEncoders } : {}),
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
    // Same dialect-dispatching parser the client's `logException` path uses above. Without it the
    // interceptor falls back to core's V8-only parser, and `console.trace()`'s stack — the entire point
    // of that method — is silently dropped on Firefox and Safari: `Error.captureStackTrace` EXISTS on
    // both, so a stack is produced, just in the `fn@loc` dialect that the V8 parser yields zero frames
    // for. One parser per platform, chosen once, used by every stack-reading path in it.
    () => createConsoleInterceptor({ stackParser: parseStack }),
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
  // Input capture: one carrier-shared DOM source (capture-phase, passive, observe-only) → the dedicated
  // `input` stream (`input.json`). NOT `events.user` — that stream belongs to the application's own
  // `client.event()` data and SDK capture must never be written into a `user.*` stream.
  const inputSource = getOrCreateInterceptor(
    'browser-input',
    () => createBrowserInputSource({ target: domDocument }),
    carrier,
  );
  client.addCaptureProvider(createInputProvider(inputSource));
  // The FRAME those coordinates belong to, over time → the `video.aux` stream. Without it a consumer has
  // to guess the frame from `environment.hardware.screen` — the whole monitor, captured once at launch,
  // in CSS px, so it shrinks under page zoom while `clientX` does not, and the click renders off the
  // frame. Carrier-shared and gated by the same option as `input`, because it exists to place `input`.
  const viewportSource = getOrCreateInterceptor(
    'browser-viewport',
    () => createBrowserViewportSource({ window: win }),
    carrier,
  );
  client.addCaptureProvider(createVideoAuxProvider(viewportSource));
  // STATE-CHANGE signals (change / submit / focusin) are NOT input — they are breadcrumbs. Android draws
  // the same line inside its input-interception coordinator: the INPUT dispatcher feeds `input.json`,
  // while the GESTURE dispatcher feeds `BreadcrumbInputGesture`, whose `ui.<gesture>` breadcrumb shape
  // this source reproduces. Emitted through `client.addBreadcrumb`, so the app's breadcrumb filter runs
  // over them like any other crumb. Gated by `captureInteractions` (see the provider's own note): the
  // option means "do not watch what I click and type", which must hold whatever stream it lands on.
  const uiBreadcrumbSource = getOrCreateInterceptor(
    'browser-ui-breadcrumbs',
    () => createUiBreadcrumbSource({ target: domDocument }),
    carrier,
  );
  client.addCaptureProvider(
    createUiBreadcrumbProvider(uiBreadcrumbSource, (crumb) => {
      client.addBreadcrumb(crumb);
    }),
  );

  // Session replay: lazy-`import()` @bugsee/replay unless it was opted OUT (`replay: false`) or this host
  // has no DOM (SSR / pre-render) — a separate chunk, so the errors-only opt-out keeps its ≤15KB bundle,
  // nobody pays for rrweb who turned replay off, and no server render pays for it at all. Then install the
  // recorder + register the replay.bin encoder into the shared map. The
  // import resolves a tick after launch; recording starts then. Fire-and-forget (launch returns sync).
  if (replayEnabled && fileEncoders !== undefined) {
    const replayOptions: ReplayLaunchOptions =
      typeof options.replay === 'object' ? options.replay : {};
    const { canvas: canvasOption, ...replayMasking } = replayOptions;
    const canvasEnabled = canvasOption !== undefined && canvasOption !== false;
    void import('@bugsee/replay')
      .then(async (m) => {
        // Canvas is an opt-in add-on: lazy-`import()` @bugsee/replay-canvas ONLY when replay.canvas is set,
        // resolve the rrweb canvas options, and thread them into the recorder (design RPC3). A no-canvas
        // replay never loads it.
        const canvas = canvasEnabled
          ? (await import('@bugsee/replay-canvas')).createCanvasRecordConfig(
              typeof canvasOption === 'object' ? canvasOption : {},
            )
          : undefined;
        m.registerReplay(client, fileEncoders, {
          ...replayMasking,
          ...(canvas !== undefined ? { canvas } : {}),
          // Give replay's masking resolver a sink: it drops an invalid caller selector rather than letting
          // it disable privacy page-wide, and that downgrade must not be silent (Wave 1.4).
          ...(options.onError !== undefined ? { onError: options.onError } : {}),
        });
      })
      .catch((error) => options.onError?.(error));
  }

  // Detection providers: window error → crash, unhandledrejection → error.
  client.addDetectionProvider(createWindowErrorProvider(win));
  client.addDetectionProvider(createUnhandledRejectionProvider(win));

  client.launch();

  // Recovery on the next launch. Self's own namespaces are empty (a fresh instanceId per launch), so the
  // prior crashed session is just a DEAD SIBLING — ALL recovery is dead-sibling recovery (BD9), gated by each
  // sibling's Web Lock so a LIVE tab's data is never read, recovered, or swept (this is what closes the
  // multi-tab capture-sweep hazard).
  //
  // The SEQUENCE — own queue, dead-sibling scan, release pass — is core's `runLaunchRecovery`: ONE
  // definition, which the node and worker tiers had copied verbatim. This tier supplies only what is
  // genuinely its own: the IndexedDB scan, and the mirror-hydration promise below.
  //
  // The queue is only readable once its mirror has hydrated — an IndexedDB-backed store serves list()
  // from RAM, so reading it earlier simply sees nothing. A synchronous (injected) store has none.
  const queueReady = (bundleStore as { whenReady?: Promise<void> } | undefined)?.whenReady;
  // The scan: per DEAD sibling, under its lock, re-upload its leftover bundles AND — when recovery is
  // enabled — rebuild + deliver its detected incidents from its preserved capture chunks (core
  // `recoverReports` over the sibling's prefixed views, `currentGeneration: -1` ⇒ every one of its
  // generations is eligible). A recovered report uploads via the BASE pipeline (its marker + chunks ARE
  // the durability — kept + retried on failure). The coordinator reads the shared stores directly (no
  // mirror hydration needed) and hands this callback the sibling's hydrated marker store plus the
  // incidents its bundle-queue leg already settled with (`skipReportIds`), so one incident is delivered
  // once even when the sibling left BOTH a staged bundle and that incident's marker (the SEV1
  // double-upload — reconciled in browser-utils).
  void runLaunchRecovery({
    ...(durable !== undefined ? { queue: durable } : {}),
    // An explicit `bundleStore` bypasses coexistence: it is the integrator's own and stable across
    // launches, so the dead-sibling scan must get first refusal on it (see the option's docs in core).
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
  });

  // Flush on page hide (Wave 6.2). The browser is the one runtime with no shutdown hook at all — no
  // `'exit'`, no signal — and a mobile browser kills a backgrounded tab with no further callbacks. Until
  // now the SDK listened to `pagehide` only to RECORD a `process_exiting` event; nothing consumed it, so
  // "the browser flushes via the pipeline / pagehide" was an intention rather than a code path.
  //
  // Two legs, because they lose different things:
  //   · the capture store commits whatever it still has queued for IndexedDB (the async write queue is
  //     what makes `add()` non-blocking, and it is exactly what a kill discards);
  //   · `client.flush()` drains a report still ASSEMBLING, which has not reached the durable queue yet —
  //     the last crash before a tab is backgrounded is the one most likely to be lost.
  //
  // Neither races the kill: what they buy is that the data is DURABLE, so the next page load recovers and
  // uploads it. A page-hide window is far too short to rely on the network.
  const uninstallPageHideFlush = installPageHideFlush(
    () => {
      void captureStore.flush?.();
      void publicClient.flush(PAGE_HIDE_FLUSH_MS);
    },
    {
      ...(win !== undefined ? { window: win } : {}),
      ...(domDocument !== undefined ? { document: domDocument } : {}),
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
    },
  );
  // The public client. stop() clears the process Carrier slot so a later launch() starts fresh.
  const stopCore = client.stop;
  const publicClient: Bugsee = {
    ...client,
    stop(timeout?: number): Promise<boolean> {
      setCarrierClient(undefined, carrier);
      uninstallPageHideFlush();
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
    deviceId,
    onError: options.onError,
    activeSpanStore: undefined, // the single-slot default is correct here — see the interface note
  };
  return { client: publicClient, internals };
}

// The public composition root: the launched client. Equivalent to `(await launchCore(...)).client` —
// `launchCore` additionally surfaces the internal wiring (`LaunchInternals`) that the `bugsee` umbrella
// uses to wire on-by-default extensions; bare `@bugsee/browser` callers use this and never see the internals.
export async function launch(appToken: string, options: BugseeLaunchOptions = {}): Promise<Bugsee> {
  return (await launchCore(appToken, options)).client;
}
