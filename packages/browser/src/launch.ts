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
  createInputProvider,
  createLogCaptureProvider,
  createSystemEventsProvider,
  createSystemTracesProvider,
  createVideoAuxProvider,
  deriveRefreshMs,
  installNetworkCapture,
  type NetworkCapture,
  type TraceSample,
} from '@bugsee/capture';
import {
  asInternalClient,
  BlackoutToken,
  BOOLEAN_OPTION,
  BUGSEE_SDK_VERSION,
  type BugseeApi,
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
  FAIL_CLOSED_BOOLEAN_OR_BAG_OPTION,
  FAIL_ON_BOOLEAN_OPTION,
  getCarrierClient,
  getCarrierPendingLaunch,
  getCarrierStatus,
  getOrCreateInterceptor,
  getProcessStatus,
  getServiceManifests,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  LifecycleEvents,
  type LifecycleEventsListener,
  type OptionDefinition,
  ReportMarkerStoreToken,
  recoverReports,
  relaunchWith,
  resolveFailOnBoolean,
  resolveLaunchOptions,
  runLaunchRecovery,
  type Scheduler,
  setCarrierClient,
  setCarrierLastLaunch,
  setCarrierPendingLaunch,
  setCarrierStatus,
  TransportToken,
  type TriggerPipeline,
  type UploadResult,
} from '@bugsee/core';
import { BugseeOption, type EnvironmentEnvelope } from '@bugsee/protocol';
import { reportGuarded } from '@bugsee/util';
import type { WindowEvents } from './detection-providers';
import { createUnhandledRejectionProvider, createWindowErrorProvider } from './detection-providers';
import { type DeviceIdEnv, realDeviceIdEnv, resolveBrowserDeviceId } from './device-id';
import {
  type BrowserProbe,
  BrowserProbeToken,
  buildBrowserEnvironment,
  realBrowserProbe,
} from './environment';
import { bindInputBlackout, createBrowserInputSource } from './input-source';
import { installPageHideFlush } from './page-lifecycle';
import {
  createReportDialogLauncher,
  type ReportDialogOptions,
  type SeverityName,
} from './report-dialog';
import { parseStack } from './stack';
import { createBrowserSystemEventsSource } from './system-events';
import { browserTraceEnvFrom, createBrowserSystemTraceProducers } from './trace-producers';
import { PageLifecycleTracker } from './trackers/page-lifecycle-tracker';
import { createUiBreadcrumbProvider, createUiBreadcrumbSource } from './ui-breadcrumb-source';
import { createUserIdentifierStore } from './user-identifier-store';
import { createBrowserViewportSource } from './viewport-source';
import { createViewtreeSnapshotSource } from './viewtree';

// @bugsee/browser launch() — the browser composition root, the fetch/DOM analog of node's
// launch(). It assembles the runtime-agnostic kernel (createClient) with the browser's platform pieces
// and the shared capture layer, then starts it:
//   fetch transport → BugseeApi + BundleUploader → UploadPipeline ─┐
//   browser EnvironmentEnvelope (navigator/screen) ────────────────┤→ createClient
//   in-memory capture store (IndexedDB persistence lands in B5) ────┘
//   providers: console→log · network (fetch/xhr/ws/sse/webtransport) · system traces (performance.memory)
//              · system events (process_started + pagehide)
//   detection: window error (crash) · unhandledrejection (error)
// Unlike node there is no process.exit window and no signal, so the last reliable moment is a page-hide:
// `pagehide` / `visibilitychange`→hidden commit the capture store and drain the client. The
// returned client IS the public surface.

const SDK_VERSION = BUGSEE_SDK_VERSION;
// How long the page-hide flush waits for the client to drain. Short on purpose: a hiding page
// has no guaranteed time at all, so this bounds the attempt rather than promising it completes — what makes
// the data safe is that it becomes DURABLE, and the next page load recovers it.
const PAGE_HIDE_FLUSH_MS = 1000;
const DEFAULT_ENDPOINT = 'https://api.bugsee.com';
// Browser/edge capture buffer ceiling (10 MB on browser, 50 MB on Node).
const DEFAULT_MAX_DATA_SIZE_MB = 10;

// Browser launch-option definitions = the shared cross-runtime set plus the browser's own maxDataSize
// (10 MB default vs node's 50 — its canonical identifier lives in @bugsee/protocol for wire parity).
/** Canonical identifier of the (browser-local) `replay` switch: no cross-SDK identity, so it lives here. */
const REPLAY_OPTION_KEY = 'com.bugsee.option.replay.enabled';
/** Canonical identifier of the (browser-local) `persist` switch: no cross-SDK identity, so it lives here. */
const PERSIST_OPTION_KEY = 'com.bugsee.option.browser.persist';

/** Whether the page exposes an IndexedDB object; a throwing getter (sandboxed frames) counts as absent. */
const indexedDbPresent = (): boolean => {
  try {
    return (globalThis as { indexedDB?: unknown }).indexedDB != null;
  } catch {
    return false;
  }
};

/**
 * Whether the page exposes Web Locks (`navigator.locks`, a secure-context API); a throwing getter counts as
 * absent. Without it a previous launch's durable data is never recovered or swept (liveness cannot tell a
 * dead sibling from a live one), so the unattended persist default requires it.
 */
const navigatorLocksPresent = (): boolean => {
  try {
    return (globalThis as { navigator?: { locks?: unknown } }).navigator?.locks != null;
  } catch {
    return false;
  }
};

const BROWSER_OPTION_DEFINITIONS: readonly OptionDefinition[] = [
  ...COMMON_OPTION_DEFINITIONS,
  { friendly: 'maxDataSize', key: BugseeOption.MaxDataSize, default: DEFAULT_MAX_DATA_SIZE_MB },
  // Input capture is browser/DOM-only (Node has no user input), so its gate lives here, not in COMMON.
  {
    friendly: 'captureInteractions',
    key: BugseeOption.CaptureInteractions,
    default: true,
    ...FAIL_CLOSED_BOOLEAN_OPTION,
  },
  // View hierarchy is browser/DOM-only too.
  {
    friendly: 'captureViewHierarchy',
    key: BugseeOption.CaptureViewHierarchy,
    default: true,
    ...FAIL_CLOSED_BOOLEAN_OPTION,
  },
  // A page that must load already blacked out (see BugseeLaunchOptions.startInBlackout).
  {
    friendly: 'startInBlackout',
    key: BugseeOption.CaptureStartInBlackout,
    default: false,
    // Safe side is ON: an invalid value (`'true'`, `1`, `null`) means DARK, never "not dark".
    ...FAIL_ON_BOOLEAN_OPTION,
  },
  // Session replay: on by default, `false` opts out, an object customises it. It COLLECTS data, so an invalid
  // scalar (`0`, `null`, `''`, `'false'`, ...) is OFF and reported; it must never throw.
  // Masking is fail-closed regardless.
  {
    friendly: 'replay',
    key: REPLAY_OPTION_KEY,
    default: true,
    ...FAIL_CLOSED_BOOLEAN_OR_BAG_OPTION,
  },
  // Persistence collects data at rest, so only boolean `true`/`false` count: anything else is OFF and reported
  // (the launch substitutes the IndexedDB default only when the option is absent).
  { friendly: 'persist', key: PERSIST_OPTION_KEY, default: false, ...FAIL_CLOSED_BOOLEAN_OPTION },
  // The report dialog (`showReportDialog`) is browser/DOM-only. Defaults are the mobile SDKs': nothing
  // required, labels and the severity picker hidden, new bugs start at `high`.
  {
    friendly: 'reportSummaryRequired',
    key: BugseeOption.ReportingUiSummaryRequired,
    default: false,
    ...BOOLEAN_OPTION,
  },
  {
    friendly: 'reportDescriptionRequired',
    key: BugseeOption.ReportingUiDescriptionRequired,
    default: false,
    ...BOOLEAN_OPTION,
  },
  {
    friendly: 'reportEmailRequired',
    key: BugseeOption.ReportingUiEmailRequired,
    default: false,
    ...BOOLEAN_OPTION,
  },
  {
    friendly: 'reportLabelsEnabled',
    key: BugseeOption.ReportingUiLabelsEnabled,
    default: false,
    ...BOOLEAN_OPTION,
  },
  {
    friendly: 'reportLabelsRequired',
    key: BugseeOption.ReportingUiLabelsRequired,
    default: false,
    ...BOOLEAN_OPTION,
  },
  {
    friendly: 'reportPrioritySelectorEnabled',
    key: BugseeOption.ReportingUiPrioritySelectorEnabled,
    default: false,
    ...BOOLEAN_OPTION,
  },
  // iOS persists the user identifier across launches; the browser does too (localStorage, per app token).
  // Browser-only: server tiers keep it in memory. Opt out when the identifier is PII not to be stored.
  {
    friendly: 'persistUserIdentifier',
    key: BugseeOption.PersistUserIdentifier,
    default: false,
    ...BOOLEAN_OPTION,
  },
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
  /** Minimum level of a log record to capture: `error | warning | info | debug | verbose`. Default `verbose`. */
  captureLogsLevel?: 'error' | 'warning' | 'info' | 'debug' | 'verbose' | 1 | 2 | 3 | 4 | 5;
  /**
   * Capture breadcrumbs (`addBreadcrumb` and the automatic UI-interaction ones). Default true. Mobile SDKs
   * default this to false; on the web UI breadcrumbs are a core signal, so JS keeps them on.
   */
  captureBreadcrumbs?: boolean;
  /** Capture network (fetch/xhr/ws/sse/webtransport). Default true. */
  captureNetwork?: boolean;
  /** Capture request/response bodies (bounded read). Default true. */
  captureNetworkBodies?: boolean;
  /**
   * Apply the built-in network PII sanitizer (URL, headers, bodies, error text). Default true. A
   * `setNetworkEventFilter` filter REPLACES it; compose with `getDefaultNetworkSanitizer()`.
   */
  captureNetworkDefaultSanitizer?: boolean;
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
  /**
   * Launch with a blackout ALREADY in force: visual and interaction capture (replay, input, wheel, UI
   * breadcrumbs, the view hierarchy) stays suppressed from the first instant until you call
   * `endBlackout()`. Use it when the page shows sensitive content from its first frame, so there is no
   * moment to call `startBlackout()` before capture could begin. Logs, network, traces and events carry on
   * (see `startBlackout()` for exactly what a blackout covers). Default false.
   */
  startInBlackout?: boolean;
  /**
   * INTERNAL (the Electron renderer): launch dark like `startInBlackout`, but as a SILENT hold the owner
   * releases with `getService(BlackoutToken).end({ silent: true })` — no lifecycle event for the hold
   * itself. Not a Bugsee option and not reported in `sdk.options`.
   */
  holdBlackout?: boolean;
  /** Report dialog: the summary must be filled in before Send. Default false (as on mobile). */
  reportSummaryRequired?: boolean;
  /** Report dialog: the description must be filled in. Default false. */
  reportDescriptionRequired?: boolean;
  /** Report dialog: the reporter email must be filled in. Default false. */
  reportEmailRequired?: boolean;
  /** Report dialog: show the labels field. Default false. */
  reportLabelsEnabled?: boolean;
  /** Report dialog: at least one label is required (only with `reportLabelsEnabled`). Default false. */
  reportLabelsRequired?: boolean;
  /** Report dialog: show the severity picker. Default false. */
  reportPrioritySelectorEnabled?: boolean;
  /** Severity a dialog report starts with: `low | medium | high | critical | blocker`. Default `high`. */
  reportDefaultBugPriority?: SeverityName;
  /**
   * Persist the user identifier (`setUserIdentifier`) in `localStorage` — one entry per app token — and
   * restore it on the next page load, before any report (iOS persists it across app launches).
   * **Opt-in, default false:** the identifier is often an email, i.e. PII, and a browser may be shared —
   * whoever opens the page next would be reported as the previous user. Enable it only for an app whose
   * users sign in on their own device, and call `clearUserIdentifier()` on logout. While off, nothing is
   * written, a value left by an earlier opted-in launch is removed at launch, and `clearUserIdentifier()`
   * always removes it. Storage failures never break the SDK; they go to `onError`.
   *
   * "Nothing is written" is about THIS identifier store only. A pending incident marker (the crash-recovery
   * record in IndexedDB) and a report already assembled into the upload queue keep the `userIdentifier` they
   * were created with until they are uploaded or expire, and `clearUserIdentifier()` does not rewrite them:
   * the clear applies to reports created afterwards.
   */
  persistUserIdentifier?: boolean;
  /** Detect window errors + unhandled rejections. Default true. */
  detectCrashes?: boolean;
  /** Report HTTP SERVER errors (500-599) as `error` reports, once per session per (method, templated URL, status); 4xx, transport failures and aborts are not reported (mobile parity). Default false. */
  detectHttpErrors?: boolean;
  /** Severity a crash report starts with. Default `blocker`. */
  reportDefaultCrashPriority?: SeverityName;
  /** Severity an error report starts with. Default `high`. */
  reportDefaultErrorPriority?: SeverityName;
  /**
   * `notify()` batching window in ms: after the first notification, wait this long so more can join its
   * request. Default 0 (send as soon as the current tick ends); `urgent` notifications skip the wait.
   */
  notifyFlushDelay?: number;
  /**
   * Session replay (rrweb). **On by default** — parity with the iOS/Android SDKs, which record by default.
   * An options object customises it; `false` opts out entirely. Masking is FAIL-CLOSED (mask all
   * text/inputs, block all media) whether or not the option is given.
   *
   * `@bugsee/replay` is lazy-`import()`ed, so it is a separate chunk that is fetched only when replay runs,
   * and `replay: false` therefore keeps the errors-only bundle genuinely free of it.
   *
   * An INVALID value (anything but a boolean or a plain options object: `0`, `null`, `''`, `'false'`, an array) is
   * treated as OFF and reported through `onError`: replay captures page content, so it never stays on by accident.
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
   * Keep the rolling capture window and the report queue in IndexedDB, so the recent past survives a
   * reload or a browser restart and a report interrupted mid-upload is re-uploaded on the next launch.
   * On by default wherever the page has BOTH IndexedDB and Web Locks (`navigator.locks`, or an injected
   * `locks`): without locks a previous launch's data is never recovered or cleaned up, so the default stays
   * in memory and nothing survives a reload. `true` persists anyway (best effort, no cross-tab recovery);
   * `false` keeps everything in memory. An explicit `bundleStore` or `captureStore` overrides the matching part.
   */
  persist?: boolean;
  /**
   * Re-upload any bundle left behind by a prior reload/crash on the next launch. Requires a persistent
   * bundle store (`persist` or an injected `bundleStore`); a no-op without one. Default true.
   */
  recover?: boolean;
  /** Internal-error sink (provider-start / operation failures). Default no-op. */
  onError?: (error: unknown) => void;
  /**
   * The application's lifecycle listener (Android `setLifecycleEventsListener`): Launching, Launched,
   * Stopping, Stopped, Blackout*, report events. Installed BEFORE the client launches, so Launching and
   * Launched are observable, and held on the process carrier, so it survives `relaunch()`. The same
   * listener can be set later with `client.setLifecycleEventsListener(...)`.
   */
  lifecycleEventsListener?: LifecycleEventsListener;

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
   * capture recorded no incident.
   *
   * Symmetric with `captureStore` above — the same shape of seam, for the read side of the same problem.
   */
  triggerPipeline?: TriggerPipeline;
  /** System probe for the environment envelope. Default realBrowserProbe. */
  systemProbe?: BrowserProbe;
  /**
   * LEGACY polled system-traces override. It REPLACES the default heap/connection/orientation traces (as on
   * Node); battery stays a tracker-backed producer. The defaults are producers, not a sampler.
   */
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
export type Bugsee = BugseeClient & {
  /**
   * Show the built-in bug-report form over the page (the web counterpart of the mobile
   * `showReportDialog()`), and send what the user fills in as a `code_dialog` report.
   *
   * Resolves the upload result, or `null` when the user cancels, a dialog is already open, or the SDK is
   * not running. Never throws into the page.
   */
  showReportDialog(options?: ReportDialogOptions): Promise<UploadResult | null>;
};

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
   * Where the performance controller's active transaction lives. ALWAYS `undefined` here:
   * the browser keeps the process-wide single slot, which is correct for its one in-flight
   * navigation/interaction. Declared REQUIRED rather than optional so the choice is stated, not
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

// The public composition root's lifecycle shell: publishes Launching while the (async) composition is in
// flight, Launched once it has built a client, and falls back to Stopped if it throws. A repeat launch
// (a client already owns the slot) leaves the state alone.
export async function launchCore(
  appToken: string,
  options: BugseeLaunchOptions = {},
): Promise<LaunchResult> {
  const carrier = options.carrier;
  const owned = getCarrierClient(carrier) === undefined;
  if (owned) {
    setCarrierStatus(BugseeStatus.Launching, carrier);
  }
  // The build is async, so `relaunch()` must be able to wait for it: until the client exists there is
  // nothing on the carrier to stop, and a relaunch that ran now would build a second client (or be handed
  // this one back with its own options dropped). Registered synchronously, cleared when it settles.
  const building = buildLaunch(appToken, options);
  const inFlight = owned ? building.then(noop, noop) : undefined;
  if (inFlight !== undefined) {
    setCarrierPendingLaunch(inFlight, carrier);
  }
  try {
    const result = await building;
    if (result.internals !== undefined) {
      setCarrierLastLaunch(appToken, options, carrier);
      setCarrierStatus(BugseeStatus.Launched, carrier);
    }
    return result;
  } catch (error) {
    if (owned && getCarrierClient(carrier) === undefined) {
      setCarrierStatus(BugseeStatus.Stopped, carrier);
    }
    throw error;
  } finally {
    if (inFlight !== undefined && getCarrierPendingLaunch(carrier) === inFlight) {
      setCarrierPendingLaunch(undefined, carrier);
    }
  }
}

const noop = (): void => {};

async function buildLaunch(
  appToken: string,
  options: BugseeLaunchOptions = {},
): Promise<LaunchResult> {
  const sdkVersion = options.sdkVersion ?? SDK_VERSION;
  const baseUrl = options.endpoint ?? DEFAULT_ENDPOINT;
  const win = options.window ?? window;
  const deviceId = await resolveBrowserDeviceId(realDeviceIdEnv(options.deviceIdEnv ?? {}));

  // Bugsee is a per-process singleton: if a client was already launched (same SDK version on
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
    options.onError,
  );

  // The internal service container (the client's "BugseeInternal"). Register the fetch transport, then
  // resolve it to assemble the pipeline; hand the SAME container to createClient.
  const services = createServiceContainer();
  services.addService(
    defineService(TransportToken, () => internalTagged(options.transport ?? fetchTransport)),
  );

  const transport = services.getProvider(TransportToken).getImmediate();
  const api = createBugseeApi(transport, { baseUrl, appToken, sdkVersion, sendUserAgent: false });
  const uploader = createBundleUploader(transport);
  const baseUploadPipeline = createUploadPipeline({ api, uploader });

  // Multi-instance-safe coexistence root: several tabs (+ the page's workers) share the origin's IndexedDB,
  // so each launch namespaces ALL its durable data — the bundle queue AND (when `persist`) the capture-chunk
  // + report-marker stores — under its own per-instance prefix in per-APP-TOKEN databases, holds ONE Web Lock
  // for liveness, and recovers only DEAD siblings (never one a live tab holds). `durableCapture` builds the
  // per-instance capture/marker VIEWS the launch wraps; `recoverEnabled` additionally records + recovers
  // markers. A fresh instanceId per launch ⇒ self's namespaces are empty, so a prior crash is a dead sibling.
  // Durable by default wherever an IndexedDB object AND Web Locks exist, so the rolling window survives a
  // reload or a browser restart. Locks are required because recovery and the sweep of a previous launch's
  // prefix both run through the liveness lock: without them the old data is never read or deleted and each
  // reload would strand up to `maxDataSize` in the origin's shared quota. An explicit `persist: true` still
  // opts into that no-locks degrade. `persist: false` opts out; a non-boolean value is OFF and reported.
  // Presence is all that is probed: if the store later cannot commit, writes fail into `onError`.
  const persist =
    options.persist === undefined
      ? (options.indexedDB !== undefined || indexedDbPresent()) &&
        (options.locks !== undefined || navigatorLocksPresent())
      : resolved.options.get<boolean>(PERSIST_OPTION_KEY, false);
  // The canonical record is what the client and `sdk.options` report as in effect: say what the capability
  // check decided instead of the static `false` default (for an explicit or invalid value this is a no-op).
  resolved.canonical[PERSIST_OPTION_KEY] = persist;
  const durableCapture = persist && options.captureStore === undefined;
  const recoverEnabled = (options.recover ?? true) && durableCapture;
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
  // The report-marker store records detected-incident metadata at incident time over the coexistence
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
  let clientRef: BugseeClient | undefined;
  const reportSnapshots = captureViewtree
    ? [
        createViewtreeSnapshotSource({
          document: domDocument,
          // The source is built before the client (it is an input to it), so it reads the client's blackout
          // through a late-bound reference. A report cannot be assembled before the client exists.
          blackout: { isActive: () => clientRef?.isBlackout() === true },
        }),
      ]
    : undefined;

  // Session replay (lazy). When enabled, a shared fileEncoders map is threaded into the client's report
  // assembly — @bugsee/replay writes its `replay.bin` encoder into it after the lazy import resolves.
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
  const replayEnabled =
    resolved.options.get<boolean>(REPLAY_OPTION_KEY, true) !== false && domDocument !== undefined;
  const fileEncoders: Record<'replay', (payloads: unknown[]) => Uint8Array> | undefined =
    replayEnabled ? ({} as Record<'replay', (payloads: unknown[]) => Uint8Array>) : undefined;

  const client = createClient({
    // Process-level state (the lifecycle listener, the blackout flag) lives on the carrier so it survives a
    // relaunch, which builds a new client.
    carrier: carrier ?? globalThis,
    // stop() tears down what this tier armed (the page-hide flush, the carrier slot, the liveness lock), so a
    // stopped client must not be restarted in place: a new one comes from `launch(appToken)`/`relaunch()`.
    restartable: false,
    ...(options.lifecycleEventsListener !== undefined
      ? { lifecycleEventsListener: options.lifecycleEventsListener }
      : {}),
    isEnabled: resolved.isEnabled,
    launchOptions: resolved.options,
    launchOptionsView: { effective: resolved.canonical, host: resolved.host },
    services,
    uploadPipeline,
    // `client.notify()` rides the same transport and app token as the session/issue calls.
    notifySender: (items) => api.notify(items),
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

  clientRef = client;

  // startInBlackout: raise the blackout BEFORE any provider is added or started (everything below, and
  // `client.launch()`, runs after this synchronously), so no visual/interaction source can observe a single
  // event before the app is able to call `startBlackout()` itself. Goes through the state service, the same
  // one `client.startBlackout()` drives; the lifecycle events fire as for any blackout.
  const blackout = client.getService(BlackoutToken);
  const startInBlackout = resolved.options.get(BugseeOption.CaptureStartInBlackout, false);
  const wasBlackedOut = blackout.isActive();
  if (startInBlackout || resolveFailOnBoolean(options.holdBlackout, false)) {
    // SILENT: the client has not launched yet, and a BlackoutStarted that precedes Launching describes a
    // client the application cannot observe. The event for a real `startInBlackout` is emitted after launch.
    blackout.start({ silent: true });
  }

  // The identifier store. Persistence is OPT-IN (PII): when off the store is still created, but only ever
  // used to REMOVE a value an earlier opted-in launch (or another tab) left behind. When on, restore the
  // persisted identifier NOW — synchronously, before any provider starts, any service manifest runs or the
  // client is handed back — so the first report already carries it and an identifier the app (or a
  // manifest) sets afterwards simply overwrites it.
  const persistIdentifier = resolved.options.get(BugseeOption.PersistUserIdentifier, false);
  const identifierStore = createUserIdentifierStore(appToken, {
    storage: options.deviceIdEnv?.localStorage,
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  if (persistIdentifier) {
    const restoredIdentifier = identifierStore.read();
    if (restoredIdentifier !== null) {
      client.setUserIdentifier(restoredIdentifier);
    }
  } else {
    identifierStore.clear();
  }

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
  // ONE lifecycle tracker over the injected window+document, shared by the traces' connection/orientation
  // producers and the events source: the listeners are bound in a single place.
  const lifecycle = new PageLifecycleTracker(
    { window: win, ...(domDocument !== undefined ? { document: domDocument } : {}) },
    options.onError,
  );
  client.addCaptureProvider(
    createSystemTracesProvider({
      // A `systemMetricsSampler` REPLACES the sensor traces (heap, connection, orientation), as on Node; battery still runs.
      ...(options.systemMetricsSampler !== undefined
        ? { sample: options.systemMetricsSampler }
        : {}),
      producers: createBrowserSystemTraceProducers(
        {
          // Every surface comes from the INJECTED window/document, never the host globals.
          ...browserTraceEnvFrom(win, domDocument),
          ...(options.systemMetricsSampler !== undefined ? { sensors: false } : {}),
          lifecycle,
          ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
        },
        options.onError,
      ),
      refreshMs: deriveRefreshMs(resolved.options.get(BugseeOption.Duration, 60) * 1000),
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
      ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    }),
  );
  client.addCaptureProvider(
    createSystemEventsProvider(
      createBrowserSystemEventsSource({
        window: win,
        lifecycle,
        ...(options.onError !== undefined ? { onError: options.onError } : {}),
      }),
    ),
  );
  // Input capture: one carrier-shared DOM source (capture-phase, passive, observe-only) → the dedicated
  // `input` stream (`input.json`). NOT `events.user` — that stream belongs to the application's own
  // `client.event()` data and SDK capture must never be written into a `user.*` stream.
  const inputSource = getOrCreateInterceptor(
    'browser-input',
    () => createBrowserInputSource({ target: domDocument, blackout }),
    carrier,
  );
  // The source is carrier-shared and may belong to an earlier (relaunched-away) client: bind it to THIS
  // client's blackout gate, or it keeps reading the dead client's state.
  bindInputBlackout(inputSource, blackout);
  client.addCaptureProvider(createInputProvider(inputSource, { blackout }));
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
    createUiBreadcrumbProvider(
      uiBreadcrumbSource,
      (crumb) => {
        client.addBreadcrumb(crumb);
      },
      blackout,
    ),
  );

  // Session replay: lazy-`import()` @bugsee/replay unless it was opted OUT (`replay: false`) or this host
  // has no DOM (SSR / pre-render) — a separate chunk, so the errors-only opt-out keeps its ≤15KB bundle,
  // nobody pays for rrweb who turned replay off, and no server render pays for it at all. Then install the
  // recorder + register the replay.bin encoder into the shared map. The
  // import resolves a tick after launch; recording starts then. Fire-and-forget (launch returns sync).
  if (replayEnabled && fileEncoders !== undefined) {
    // The bag is read from the host's own options (the resolved record only says "on"); an invalid value
    // resolved to OFF (never reaching here), so anything that is not a plain object is `{}`.
    const replayOptions: ReplayLaunchOptions =
      typeof options.replay === 'object' &&
      options.replay !== null &&
      !Array.isArray(options.replay)
        ? options.replay
        : {};
    const { canvas: canvasOption, ...replayMasking } = replayOptions;
    // Canvas pixels are recorded UNMASKED, so only boolean `true` or a plain object enables the add-on; anything
    // else (`0`, `null`, `''`, `'false'`, an array) is OFF and reported.
    const canvasIsBag =
      typeof canvasOption === 'object' && canvasOption !== null && !Array.isArray(canvasOption);
    const canvasEnabled = canvasOption === true || canvasIsBag;
    if (canvasOption !== undefined && canvasOption !== false && !canvasEnabled) {
      reportGuarded(
        options.onError,
        new Error(
          'Bugsee: replay.canvas must be a boolean or an options object; canvas replay stays OFF',
        ),
      );
    }
    void import('@bugsee/replay')
      .then(async (m) => {
        // Canvas is an opt-in add-on: lazy-`import()` @bugsee/replay-canvas ONLY when replay.canvas is set,
        // resolve the rrweb canvas options, and thread them into the recorder. A no-canvas
        // replay never loads it.
        const canvas = canvasEnabled
          ? (await import('@bugsee/replay-canvas')).createCanvasRecordConfig(
              canvasIsBag
                ? (canvasOption as Exclude<typeof canvasOption, boolean | undefined>)
                : {},
            )
          : undefined;
        m.registerReplay(client, fileEncoders, {
          ...replayMasking,
          // The recorder follows the client's blackout: stopped for its whole span, restarted (a fresh full
          // snapshot) at the end — and never started at all if a blackout began before this chunk loaded.
          blackout: client.getService(BlackoutToken),
          ...(canvas !== undefined ? { canvas } : {}),
          // Give replay's masking resolver a sink: it drops an invalid caller selector rather than letting
          // it disable privacy page-wide, and that downgrade must not be silent.
          ...(options.onError !== undefined ? { onError: options.onError } : {}),
        });
      })
      .catch((error) => {
        try {
          options.onError?.(error);
        } catch {
          // A throwing host sink must never become an unhandled rejection.
        }
      });
  }

  // Detection providers: window error → crash, unhandledrejection → error.
  client.addDetectionProvider(createWindowErrorProvider(win));
  client.addDetectionProvider(createUnhandledRejectionProvider(win));
  // fetch/xhr server errors (5xx) → `error` reports (mechanism http-error). Off unless `detectHttpErrors`.
  client.addDetectionProvider(createHttpErrorDetectionProvider(network.interceptor));

  // The deferred event of `startInBlackout`: owed only when this launch raised the blackout (a carried one is
  // not a new event; an internal hold never announces itself). Core announces it after Launching/Launched when
  // the client is still launched and dark, and ahead of the Ended of a Launching listener that lifts the blackout
  // at once, so the application never hears an Ended without its Started.
  if (startInBlackout && !wasBlackedOut) {
    asInternalClient(client).deferBlackoutStarted();
  }
  client.launch();

  // Recovery on the next launch. Self's own namespaces are empty (a fresh instanceId per launch), so the
  // prior crashed session is just a DEAD SIBLING — ALL recovery is dead-sibling recovery, gated by each
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
  // once even when the sibling left BOTH a staged bundle and that incident's marker (the recovery
  // double-upload — reconciled in browser-utils).
  let recoverySettled = false;
  let crashSignalled = false; // RelaunchedAfterCrash is told at most once per launch
  const recoveryDone = runLaunchRecovery({
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
                // A dead sibling that left an incident marker behind never settled that incident, which is
                // the honest evidence this tier has that the previous run did not end cleanly. (A tab closed
                // normally after a failed upload leaves one too, so this can over-report; it never invents one.)
                if (!crashSignalled && markers.list().length > 0 && client.isLaunched()) {
                  crashSignalled = true;
                  asInternalClient(client).emitLifecycleEvent(LifecycleEvents.RelaunchedAfterCrash);
                }
                const backend = createIdbChunkBackend(captureView, {
                  generation: -1,
                  cleanOtherGenerations: false,
                  ...(options.onError !== undefined ? { onError: options.onError } : {}),
                });
                await recoverReports({
                  backend,
                  currentGeneration: -1,
                  markers,
                  context: () => ({ appToken, environment: getEnvironment(), clock }),
                  uploadPipeline: baseUploadPipeline,
                  skipReportIds,
                  ...(options.onError !== undefined ? { onError: options.onError } : {}),
                });
                // recoverReports deletes the sibling's generations through the backend's write QUEUE, which
                // it does not await. Settle it here so the cleanup lands before this scan counts as done
                // (and before a stop() closes the connection under it).
                await backend.flush?.();
              },
            }
          : {}),
      }),
  }).finally(() => {
    recoverySettled = true;
  });

  // Flush on page hide. The browser is the one runtime with no shutdown hook at all — no
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
  // WHEN the lock is released: it follows the ONE shared real drain, not any single stop() call. Every
  // stop() leaves a background observer on that drain (a stop(timeout) that gave up still gets its release when
  // the upload finishes), and the caller of a stop() that sees the drain finish releases too; whoever is first
  // releases, once. Instances are distinct (their own lock + IndexedDB prefix), so a relaunch needs no guard.
  let released = false;
  const releaseIfSafe = (): void => {
    if (!released && recoverySettled) {
      released = true;
      coexistence.release();
    }
  };
  // Commit the capture store's queued writes ONCE per stop, however many paths (the caller, the background
  // observer) reach this point: closing IndexedDB under its write queue would lose the queue's tail.
  let storeFlushed: Promise<void> | undefined;
  /** A sink that throws must not turn a background step into an unhandled rejection. */
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
            // A FRESH flush, not the memoized one: a stop(timeout) that gave up memoized its flush
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
  const reportUi = resolved.options;
  // `reportDefaultBugPriority` is a COMMON option: the resolver has already validated it (an invalid value
  // was reported there, naming every severity) and core applies it to every derived bug severity - an
  // `upload()` included. The dialog only needs it to pre-select a severity.
  const defaultSeverity = reportUi.get<SeverityName>(
    BugseeOption.ReportingDefaultBugPriority,
    'high',
  );
  // The public setters: update the Environment (authoritative, in memory), then persist best-effort. The
  // report dialog goes through these too, so what the reporter types survives a reload.
  const clearUserIdentifier = (): void => {
    client.clearUserIdentifier();
    identifierStore.clear(); // always: a value stored by an earlier opted-in launch must be erasable
  };
  const setUserIdentifier = (id: string): void => {
    // `null` / `undefined` / a non-string is "clear" on the mobile SDKs; never store the text "null".
    if (typeof id !== 'string') {
      clearUserIdentifier();
      return;
    }
    client.setUserIdentifier(id);
    if (persistIdentifier) {
      identifierStore.write(id);
    }
  };
  const showReportDialog = createReportDialogLauncher({
    // No DOM (a worker, SSR) → there is nothing to draw on; the launcher then resolves null.
    document: domDocument as Document,
    prepare: () => asInternalClient(client).prepareUpload(),
    isLaunched: () => domDocument !== undefined && client.isLaunched(),
    getUserIdentifier: () => client.getUserIdentifier(),
    setUserIdentifier: (email) => setUserIdentifier(email),
    clearUserIdentifier: () => clearUserIdentifier(),
    sdkVersion: SDK_VERSION,
    emitLifecycleEvent: (eventType, data) =>
      asInternalClient(client).emitLifecycleEvent(eventType, data),
    ui: {
      summaryRequired: reportUi.get(BugseeOption.ReportingUiSummaryRequired, false),
      descriptionRequired: reportUi.get(BugseeOption.ReportingUiDescriptionRequired, false),
      emailRequired: reportUi.get(BugseeOption.ReportingUiEmailRequired, false),
      labelsEnabled: reportUi.get(BugseeOption.ReportingUiLabelsEnabled, false),
      labelsRequired: reportUi.get(BugseeOption.ReportingUiLabelsRequired, false),
      prioritySelectorEnabled: reportUi.get(BugseeOption.ReportingUiPrioritySelectorEnabled, false),
      defaultSeverity,
    },
  });
  const publicClient: Bugsee = {
    ...client,
    setUserIdentifier,
    clearUserIdentifier,
    showReportDialog,
    async stop(timeout?: number): Promise<boolean> {
      const wasLaunched = client.isLaunched();
      // Release the process slot, but only if it is still OURS: a repeat/late stop() must not evict a
      // client that has since been relaunched.
      const owned = getCarrierClient(carrier) === publicClient;
      if (owned) {
        setCarrierStatus(wasLaunched ? BugseeStatus.Stopping : BugseeStatus.Stopped, carrier);
        clearCarrierClient(publicClient, carrier);
      }
      uninstallPageHideFlush();
      let drained = false;
      try {
        const stopping = stopCore(timeout);
        observeDrain(wasLaunched);
        drained = await stopping;
        return drained;
      } finally {
        // Make the data durable first (a launched client only: a killed one has no live store to flush).
        if (wasLaunched) {
          await makeDurable();
        }
        // The launch-time dead-sibling scan may still be reading IndexedDB (a quick launch -> stop); closing
        // under it would just make it reopen the connection and leak it. Let it settle first — bounded by
        // the caller's own timeout, since a long recovery upload must not hold up a deadline-bound stop.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await (timeout === undefined
          ? recoveryDone
          : Promise.race([
              recoveryDone,
              new Promise<void>((r) => {
                timer = setTimeout(r, timeout);
              }),
            ]));
        clearTimeout(timer);
        // Let go of the instance liveness lock (this instance now reads as dead, so the NEXT launch can
        // recover any leftovers) and the IndexedDB connections ONLY when that is true: the drain
        // completed (a timed-out drain's upload may still be running here, and another tab that saw this
        // instance as dead would upload it again), the launch recovery has settled (it may still be
        // reading or writing). A killed client is released too: the collector switched it off, so nothing
        // of it is in flight.
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

/** The process lifecycle state (Stopped / Launching / Launched / Stopping), also while no client exists.
 *  `carrier` is the host the launch used (default `globalThis`). */
export function getStatus(carrier?: object): BugseeStatus {
  return getProcessStatus(carrier);
}

/** Stop the running client (if any) and launch again with the same token; `options` replace the previous
 *  launch options when given. Uses the process carrier of `options.carrier` (default `globalThis`). */
export function relaunch(options?: BugseeLaunchOptions): Promise<Bugsee> {
  return relaunchWith(launch, options, options?.carrier);
}

// The public composition root: the launched client. Equivalent to `(await launchCore(...)).client` —
// `launchCore` additionally surfaces the internal wiring (`LaunchInternals`) that the `bugsee` umbrella
// uses to wire on-by-default extensions; bare `@bugsee/browser` callers use this and never see the internals.
export async function launch(appToken: string, options: BugseeLaunchOptions = {}): Promise<Bugsee> {
  return (await launchCore(appToken, options)).client;
}
