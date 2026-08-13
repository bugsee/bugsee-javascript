import {
  createBrowserInputSource,
  createBrowserSystemEventsSource,
  createBrowserSystemTracesSampler,
  createUnhandledRejectionProvider,
  createWindowErrorProvider,
  type WindowEvents,
} from '@bugsee/browser';
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
  type BreadcrumbFilter,
  type BugseeClient,
  type CaptureStore,
  type Clock,
  COMMON_OPTION_DEFINITIONS,
  createClient,
  createServiceContainer,
  type FilterStore,
  FiltersToken,
  getCarrierClient,
  getOrCreateInterceptor,
  getServiceManifests,
  type LogEventFilter,
  type NetworkEventFilter,
  neverThrow,
  type ReportHandler,
  resolveLaunchOptions,
  type Scheduler,
  setCarrierClient,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { randomId } from '@bugsee/util';
import { mintControlToken } from './control-token';
import { createHostBridge } from './host-bridge';
import { createHostBridgeCaptureStore } from './host-bridge-capture-store';
import { createBridgeControl } from './host-bridge-control';
import { createObscuringChannel, type ObscuringChannel } from './obscuring-channel';
import {
  type ComposerDocument,
  type ComposerWindow,
  createObscuringComposer,
  type ObscuringComposer,
} from './obscuring-composer';
import { byeMessage, encode, helloMessage } from './protocol';
import { createRedactionProvenance } from './redaction-provenance';
import { createWebViewReportPipeline } from './webview-report-pipeline';

// @bugsee/webview launch() — the WebView composition root (docs/design/webview-bridge.md §5/§10). A WebView is a
// browser environment whose OUTPUT SINK is the native host, not the network: this reuses @bugsee/browser-family
// capture (console→log + network in slice 1; full parity in slice 2) over a HostBridgeCaptureStore that STREAMS
// each entry across the WebView boundary — NO transport / upload pipeline / bundle store / IndexedDB (native is
// the ring buffer + the bundler). On launch it opens a `hello` handshake (declaring its capabilities, which
// drive native's legacy-coexistence decision, D10) and exposes `__bugsee_bridge.control` for native→JS control.
// WebView-originated report TRIGGERING is gated behind `reportTrigger` (D5, default off) — wired in slice 2.

/** The SDK version reported in the handshake (default) + published on the injectable `BugseeWebView` global. */
export const SDK_VERSION = '0.0.0';

// The capture FileTypes this SDK emits — declared in the hello so native can negotiate (D10). The `obscuring`
// capability is added DYNAMICALLY (only when the obscuring channel is active — a DOM is present + not opted out)
// so native knows whether the advanced SDK masks sensitive pixels itself; if absent native keeps its legacy
// masking script (D10). The DOM viewtree + performance streams land in later slices.
const CAPABILITIES = [
  'log',
  'network',
  'traces.system',
  'events.system',
  'events.user',
  'crash',
] as const;

export interface BugseeWebViewLaunchOptions {
  /** SDK version reported in the handshake. Default the package version. */
  sdkVersion?: string;

  /** Capture console output as logs. Default true. */
  captureLogs?: boolean;
  /** Capture network (fetch/xhr/ws/sse). Default true. */
  captureNetwork?: boolean;
  /** Capture request/response bodies (bounded read). Default true. */
  captureNetworkBodies?: boolean;
  /** Max captured request/response body size in bytes. Default 20480. */
  maxNetworkBodySize?: number;
  /**
   * Stream the viewport rects of sensitive elements (password / payment inputs + `.bugsee-hide`) so native masks
   * them in its captured frames (D10 obscuring). Default true. When on, the SDK declares the `obscuring`
   * capability so native drops its legacy masking script; turn off (or run without a DOM) to keep legacy masking.
   */
  captureObscuring?: boolean;

  /**
   * Allow the WebView to emit report TRIGGERS — an uncaught error / `logException` OPENING a native bug. D5:
   * default OFF. Native is the authority on opening bugs; the incident ALWAYS streams up as a `crash` timeline
   * entry regardless, so the web error enriches whatever report native opens. Native may also toggle this via
   * the handshake config.
   */
  reportTrigger?: boolean;

  // Redaction filters (D3) — optional JS-side scrubbing. By default the FilterStore is empty, content streams
  // un-redacted (`red:false`) and native applies its canonical filters; setting any of these runs it in JS
  // before crossing (the crossing is stamped `red:true`) AND native re-applies, so the union is enforced.
  /** Per-network-event filter: mutate the event, or return null to DROP it. */
  networkFilter?: NetworkEventFilter;
  /** Per-log-event filter: mutate, or return null to DROP. */
  logFilter?: LogEventFilter;
  /** Per-breadcrumb filter: mutate, or return null to DROP. */
  breadcrumbFilter?: BreadcrumbFilter;
  /** Report handler: `before` mutates/returns a new report or null to VETO it. */
  reportHandler?: ReportHandler;

  /**
   * A secret minted by NATIVE and passed in through the injected bootstrap (D-A10).
   *
   * Native chooses the bytes of the bundle it injects and, via document-start, runs them before any page
   * script — the one asymmetry native holds over the page. A nonce carried that way is a secret the page
   * never sees, which the JS-minted control token can never be: `launch` is itself reachable from the page,
   * so anything minted here a page script can mint too.
   *
   * When set, the control channel is closed from the FIRST message and this value is NOT published in
   * `hello` — native already has it, and putting it on the wire would hand it to whatever sink is listening.
   */
  controlNonce?: string;

  /**
   * A second native-minted secret, stamped on every OUTGOING message so native can drop capture it did not
   * send (D-A11). Also arrives through the injected bootstrap.
   *
   * Separate from {@link controlNonce} on purpose. This one has to travel the wire to do its job, so a page
   * script that shadowed `BugseeBridge` before the sink was pinned will read it — and that is survivable,
   * because such a script can already forge capture today. Sharing one secret across both directions would
   * mean the same exposure also granted `cmd:"stop"`, upgrading a capture tap into a capture kill switch.
   */
  captureNonce?: string;

  /** Internal-error sink (provider-start / bridge-post failures). Default no-op. */
  onError?: (error: unknown) => void;

  // Injectable seams (advanced / tests) — defaults target the real WebView runtime.
  /** The WebView global hosting the native bridge + the `__bugsee_bridge` control entry. Default `globalThis`. */
  global?: object;
  /** Window event target for system events (pagehide…). Default the global `window`. */
  window?: WindowEvents;
  /** DOM document for user-input capture (clicks/keys/…). Default `window.document`. */
  document?: Document;
  /** System-traces sampler (performance.memory…). Default the browser sampler. */
  systemMetricsSampler?: () => readonly TraceSample[];
  /** Time source. Default the system clock. */
  clock?: Clock;
  /** Scheduler for the capture-store tick. Default global timers. */
  scheduler?: Scheduler;
  /** Capture store override (advanced / tests). Default the streaming host-bridge store. */
  captureStore?: CaptureStore;
  /**
   * Carrier host for the per-WebView singleton + shared interceptors; injectable for tests. Default the global
   * carrier. TEST-ONLY: the core capture providers resolve redaction filters from the GLOBAL carrier, so a
   * non-global carrier is only consistent for the default. (Native re-redacts unconditionally regardless, so a
   * mismatched `red` provenance flag is never a privacy hazard — see redaction-provenance.ts.)
   */
  carrier?: object;
}

/** What `__bugsee_bridge` forwards to for the CURRENT session (swapped on launch/stop). */
interface BridgeSession {
  control(raw: string): void;
  snapshot(): string;
}

/** The stopped state. `snapshot()` must still answer `'[]'` rather than throw: native pulls it synchronously
 *  at frame-capture time, and an exception there propagates into `evaluateJavascript` — the fail-open shape
 *  fixed as SEV1-1. A stopped SDK legitimately has no rects. */
const INERT_SESSION: BridgeSession = {
  control: (): void => {},
  snapshot: (): string => '[]',
};

/**
 * Per-global state behind the immutable `__bugsee_bridge` binding.
 *
 * `session` is re-pointed across launches. `installed` records whether the binding is actually OURS — a
 * page script that pre-owns the name makes `defineProperty` throw, and the SDK must then fail closed
 * rather than advertise a control surface it does not have. `auth` holds the one-way latch at GLOBAL
 * scope, not per-launch: `launch` is itself a page global, so a per-launch latch could be reset simply by
 * relaunching (review round 1).
 */
interface BridgeSlot {
  session: BridgeSession;
  installed: boolean;
  auth: { authenticated: boolean };
}

const BRIDGE_SLOTS = new WeakMap<object, BridgeSlot>();

/**
 * Install `__bugsee_bridge` on a CLOSED binding and return the slot its methods delegate to
 * (Wave 0.3 / D-A3, docs/design/webview-bridge-auth.md).
 *
 * `Object.freeze(obj)` — what this used to do — protects the object and leaves the binding
 * `{writable: true, configurable: true}`, so a page script could swap the whole thing: `snapshot()` then
 * returned `[]` while real secure areas existed, and native had already dropped its own masking script.
 * `writable: false, configurable: false` is what actually closes it.
 *
 * The cost is that teardown can no longer delete the property, so the object is permanent and the SESSION
 * behind it is what changes — inert after `stop()`, live again after a later `launch()`.
 */
function bridgeSlotFor(
  global: object,
  onError: ((error: unknown) => void) | undefined,
): BridgeSlot {
  const existing = BRIDGE_SLOTS.get(global);
  if (existing !== undefined) {
    return existing; // a previous launch already closed the binding on this global
  }
  const slot: BridgeSlot = {
    session: INERT_SESSION,
    installed: false,
    auth: { authenticated: false },
  };
  const api = Object.freeze({
    control: (raw: string): void => slot.session.control(raw),
    snapshot: (): string => slot.session.snapshot(),
  });
  try {
    Object.defineProperty(global, '__bugsee_bridge', {
      value: api,
      writable: false,
      configurable: false,
      enumerable: true,
    });
    slot.installed = true;
  } catch (error) {
    // Something already owns the name on a non-configurable binding — a hostile page that ran first, or a
    // host that pre-defined it. Nothing can be reclaimed here, so report and let the session run WITHOUT a
    // control entry rather than throwing out of launch(). `installed` stays false, and the caller uses it
    // to fail CLOSED — see the `obscuring` capability. `onError` is contained: it belongs to the host app
    // and must not take launch() down (capture may never alter app behaviour).
    neverThrow(() => onError?.(error), undefined);
  }
  // Cached either way, so a repeat launch does not retry a defineProperty that is guaranteed to throw and
  // re-report the same failure once per launch.
  BRIDGE_SLOTS.set(global, slot);
  return slot;
}

/** The launched WebView client — the public SDK surface. */
export type Bugsee = BugseeClient;

/** Launch the Bugsee WebView SDK. A per-WebView singleton (a repeat call is ignored). Returns the started client. */
export function launch(appToken: string, options: BugseeWebViewLaunchOptions = {}): Bugsee {
  const sdkVersion = options.sdkVersion ?? SDK_VERSION;
  const carrier = options.carrier;
  const global = (options.global ?? globalThis) as { __bugsee_bridge?: unknown };

  const bridgeSlot = bridgeSlotFor(global, options.onError);

  const alreadyLaunched = getCarrierClient<Bugsee>(carrier);
  if (alreadyLaunched !== undefined) {
    options.onError?.(
      new Error(
        'Bugsee.launch() called more than once in this WebView; the repeat call is ignored',
      ),
    );
    return alreadyLaunched;
  }

  const resolved = resolveLaunchOptions(
    options as unknown as Record<string, unknown>,
    COMMON_OPTION_DEFINITIONS,
  );

  const services = createServiceContainer();

  // The JS→native channel + the streaming capture store: every captured entry is posted across the boundary
  // immediately (native is the ring + bundler). No transport / upload pipeline / bundle store / IndexedDB.
  const bridge = createHostBridge({
    global,
    // Stamped on every outgoing message so native can distinguish this SDK's capture from a page script's
    // (D-A11). A SEPARATE secret from `controlNonce`, deliberately: this one necessarily travels the wire,
    // so a script that shadowed `BugseeBridge` before we pinned it (the page-ready fallback) reads it. That
    // costs forged capture, which such a script could already produce. Reusing the control nonce here would
    // additionally hand it `cmd:"stop"` — turning a tap into a kill switch.
    ...(options.captureNonce !== undefined ? { nonce: options.captureNonce } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  // One per-session monotonic sequence shared by the capture stream + the report path (so seq is global).
  let seqN = 0;
  const seq = (): number => seqN++;
  // Control state flipped by native commands (§7): `paused` drops the capture stream while backgrounded; flush
  // + stop delegate to `publicClient`, assigned at the end of launch — the onCommand closure reads it only when
  // native actually sends a command (always after launch returns). `snapshot` re-pushes the current secure-area
  // rects via the obscuring channel (assigned below; native usually PULLS them synchronously via
  // `__bugsee_bridge.snapshot()`, but the command path lets it request an async refresh).
  let paused = false;
  let publicClient: Bugsee;
  let obscuring: ObscuringChannel | undefined; // TOP frame: the native I/O channel
  // Set once the probe has run (below). Read by BOTH the start() path and the native snapshot command.
  let obscuringWorks = false;
  // The per-session control token (Wave 0.3 / D-A1). Minted from a CSPRNG — NOT `randomId()`, whose
  // fallback is `Math.random()` and which documents itself as unsuitable for secrets (see control-token.ts).
  // `undefined` when the runtime has no CSPRNG: the channel then stays unauthenticated, which is the
  // documented pre-upgrade state and strictly better than a token the page can predict.
  //
  // Read `bridge.available` HERE, before anything is posted, and use the one answer for both the published
  // hello and the enforcing side. Deciding twice would risk the two disagreeing — enforcing a token the
  // handshake never published locks native out permanently.
  // `mintControlToken()` reads `globalThis`, NOT the injected `global`: that option is a seam for the
  // bridge SURFACE (`BugseeBridge` / `__bugsee_bridge`), not a realm, and the CSPRNG must come from the
  // realm actually executing this code.
  //
  // A NATIVE-minted nonce supersedes all of that when present (D-A10). Native interpolates it into the
  // bundle it injects, so it reaches this SDK by a route the page never observes, and native knew it before
  // the first message — no publication in `hello`, no open period, no latch to arm. The JS-minted token
  // remains for hosts that pass no nonce.
  const nativeSecret = options.controlNonce;
  const controlToken =
    nativeSecret === undefined && bridge.available ? mintControlToken() : undefined;
  const control = createBridgeControl({
    token: controlToken,
    ...(nativeSecret !== undefined ? { nativeSecret } : {}),
    // The latch lives on the per-global slot, not in this closure, so a page-forced relaunch inherits it.
    auth: bridgeSlot.auth,
    onError: options.onError,
    reportTrigger: options.reportTrigger ?? false,
    onCommand: (command) => {
      if (command === 'pause') {
        paused = true;
      } else if (command === 'resume') {
        paused = false;
      } else if (command === 'flush') {
        // native calls flush before capturing a frame / opening a report so the timeline is current; it awaits
        // the client's pending work (and will additionally drain the capture batch once batching lands).
        void publicClient.flush();
      } else if (command === 'stop') {
        void publicClient.stop();
      } else if (command === 'snapshot' && obscuringWorks) {
        // Gated on the same probe as `start()`. Ungated, native asking for a frame got a `secure` message
        // it had never negotiated — on the page whose collection was just declared broken. "Silent on the
        // wire" has to cover every path that reaches the wire, not the one the fix was looking at.
        obscuring?.emit();
      }
      // unknown → ignored.
    },
  });
  // D3 redaction provenance: read the live `filters` service (registered by createClient into `services` below,
  // mutated by the JS-side filter options + the returned client's set* methods) to stamp each crossing's `red`
  // flag — per entry type for the stream, per report handler for incidents. Lazy: the store/pipeline are built
  // before the service is registered, and a filter may be set after launch.
  const provenance = createRedactionProvenance((): FilterStore | null =>
    services.getProvider(FiltersToken).getImmediate({ optional: true }),
  );
  const captureStore =
    options.captureStore ??
    createHostBridgeCaptureStore({
      bridge,
      seq,
      paused: () => paused,
      redactedFor: provenance.forEntry,
    });
  // The report path replaces bundle-assembly+upload (D2): every detected incident / logException streams up as
  // a `crash` entry (always, D5), plus a report TRIGGER gated on `reportTrigger` (read dynamically).
  const triggerPipeline = createWebViewReportPipeline({
    bridge,
    reportTriggerEnabled: () => control.config.reportTrigger,
    seq,
    redacted: provenance.forReport,
  });

  const client = createClient({
    isEnabled: resolved.isEnabled,
    launchOptions: resolved.options,
    services,
    captureStore,
    triggerPipeline,
    appToken,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  // Install any JS-side redaction filters (D3) into the `filters` service via the facade. The capture providers
  // + the report path then run them before crossing; the provenance above stamps `red` accordingly.
  if (options.networkFilter !== undefined) {
    client.setNetworkEventFilter(options.networkFilter);
  }
  if (options.logFilter !== undefined) {
    client.setLogEventFilter(options.logFilter);
  }
  if (options.breadcrumbFilter !== undefined) {
    client.setBreadcrumbFilter(options.breadcrumbFilter);
  }
  if (options.reportHandler !== undefined) {
    client.setReportHandler(options.reportHandler);
  }

  for (const manifest of getServiceManifests(carrier)) {
    manifest(client);
  }

  // Capture providers: console→log; network umbrella (fetch/xhr/ws/sse); system traces (performance.memory);
  // system events (process_started + pagehide); user input (clicks/keys → events.user). Each carrier-shared
  // interceptor self-skips when its controllingOption is off. (The DOM viewtree + obscuring + error/crash +
  // performance streams land in later slices.)
  const win = options.window ?? (globalThis as { window?: WindowEvents }).window;
  const domDocument = options.document ?? (globalThis as { document?: Document }).document;

  // === SUB-FRAME: obscuring only, and nothing else =============================================
  //
  // A WebView has ONE Bugsee session, owned by the top frame. A sub-frame that is injected (D9) exists to
  // contribute its secure-area rects to the top frame's composed union — that is the whole job.
  //
  // Everything below this branch is deliberately skipped in a sub-frame:
  //  - `hello`: the protocol is one handshake per WebView. N frames posting N hellos makes the session id,
  //    the retained control token and the D10 obscuring decision a RACE between frames.
  //  - the control token: a sub-frame can never RECEIVE control — `evaluateJavascript` targets the top
  //    frame — so a token minted here is unusable, and if native retained it the TOP frame's own control
  //    would be rejected as a mismatch.
  //  - capture: each frame keeps its own `seq` from 0, so entries from different frames collide in
  //    ordering. And D9 exists to keep Bugsee OUT of third-party content (webview-bridge.md:66) — running
  //    a full capture stack inside every ad/OAuth/payment iframe is the opposite of that.
  //  - `client.launch()`: `isLaunched()` stays false, which is truthful. This frame captures nothing.
  //
  // The client is still constructed and returned so the public signature holds and the host's `stop()`
  // works; it simply never starts.
  const w = win as { top?: unknown; self?: unknown } | undefined;
  const isTopFrame = w?.top === undefined || w.top === (w.self ?? w);
  // `win !== undefined` is not a redundant guard: it is what tells the type system that a sub-frame always
  // HAS a window. `isTopFrame` is derived from `win`, so `!isTopFrame` already implies it is defined —
  // spelling it here keeps the composer's `window` unconditional instead of leaving an unreachable branch.
  if (win !== undefined && !isTopFrame) {
    if ((options.captureObscuring ?? true) && domDocument !== undefined) {
      const childComposer = createObscuringComposer({
        document: domDocument as unknown as ComposerDocument,
        window: win as unknown as ComposerWindow,
        ...(options.onError !== undefined ? { onError: options.onError } : {}),
        isTopFrame: false,
      });
      // The composer is called directly here, so its failures would escape launch() — and `window.parent`
      // is [Replaceable], so one line of page script is enough to make it throw.
      neverThrow(() => childComposer.start(), options.onError);
      publicClient = {
        ...client,
        stop(timeout?: number): Promise<boolean> {
          neverThrow(() => childComposer.stop(), options.onError);
          return client.stop(timeout);
        },
      };
    } else {
      publicClient = client;
    }
    setCarrierClient(publicClient, carrier);
    return publicClient;
  }

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
  if (win !== undefined) {
    client.addCaptureProvider(
      createSystemEventsProvider(
        createBrowserSystemEventsSource({
          window: win,
          ...(domDocument !== undefined ? { document: domDocument } : {}),
        }),
      ),
    );
  }
  // Input capture: one carrier-shared DOM source (capture-phase, passive, observe-only) → events.user.
  const inputSource = getOrCreateInterceptor(
    'webview-input',
    () => createBrowserInputSource({ target: domDocument }),
    carrier,
  );
  client.addCaptureProvider(createUserEventsProvider(inputSource));

  // Detection: window `error` → crash, `unhandledrejection` → error, on the WebView window. The report path
  // (triggerPipeline above) ALWAYS streams the incident as a `crash` entry; whether it ALSO opens a native bug
  // is gated by `reportTrigger` (D5, default off). Skipped if there is no window.
  if (win !== undefined) {
    client.addDetectionProvider(createWindowErrorProvider(win));
    client.addDetectionProvider(createUnhandledRejectionProvider(win));
  }

  // Obscuring (D10/D9): when there is a DOM and it isn't opted out, track the secure-area rects so native masks
  // sensitive pixels. Obscuring runs in EVERY injected frame, but the frame's role differs (sub-frame rect
  // COMPOSITION — the legacy VIEWS_BUBBLE port):
  //   - the TOP frame owns the native I/O (the channel): it composes its own rects + the rects bubbled up from
  //     sub-frames into DOCUMENT-ABSOLUTE coordinates, posts the union as `secure`, and declares the `obscuring`
  //     capability so native drops its legacy masking (D10);
  //   - a SUB-frame runs a composer that `postMessage`s its (composed) viewport rects to its parent — handled
  //     by the sub-frame branch above, which returns before reaching here.
  // (Native owns the final "is coverage complete → fully drop legacy" decision: it knows its D9 injection set.)
  if ((options.captureObscuring ?? true) && domDocument !== undefined) {
    obscuring = createObscuringChannel({
      bridge,
      document: domDocument as unknown as ComposerDocument,
      ...(win !== undefined ? { window: win as unknown as ComposerWindow } : {}),
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
      seq,
    });
  }
  // Only the TOP frame declares `obscuring` (it alone reports the composed whole-page union to native), and
  // only once a collection has been PROVEN to work. Declaring the capability is what makes native stand its
  // legacy masking script down (D10), and the protocol has no retraction message — so on a page where
  // collection already throws, staying silent leaves native's own masking in place, which is the fail-closed
  // answer (docs/review/webview.md SEV1 #2).
  //
  // The probe result gates the CHANNEL as well as the capability. Declaring nothing but starting anyway
  // still put `secure` frames on the wire — messages native never negotiated, on the exact page whose
  // collection was just proven broken. "Staying silent" has to mean silent on the wire, not merely absent
  // from `caps`.
  // Fail CLOSED on both counts (review round 1). The probe already covered "collection is broken"; the
  // second half is that a control surface we do not own is just as disqualifying. Declaring `obscuring` is
  // what makes native DROP its own masking script — so advertising it while the page owns
  // `__bugsee_bridge` leaves sensitive pixels masked by nobody, which is worse than not declaring at all.
  obscuringWorks = obscuring?.probe() === true && bridgeSlot.installed;
  const caps = obscuringWorks ? [...CAPABILITIES, 'obscuring'] : [...CAPABILITIES];

  // The native→JS control entry point: native calls `__bugsee_bridge.control(json)` via evaluateJavascript for
  // the handshake reply + commands; it also PULLS the current secure-area rects synchronously at frame-capture
  // time via `__bugsee_bridge.snapshot()` (serialized rects; `[]` when obscuring is off).
  // The binding itself is immutable (D-A3); what a launch swaps is the SESSION behind it.
  const mySession: BridgeSession = {
    control: control.control,
    snapshot: (): string => obscuring?.snapshot() ?? '[]',
  };
  bridgeSlot.session = mySession;

  // Open the handshake BEFORE capture starts so it is the first thing native sees. Declaring `caps` is what
  // lets native decide legacy coexistence (D10).
  //
  // The token rides this message ONLY when a native sink is already attached (review round 1, SEV1). When
  // it is not, `hello` goes into the host bridge's backlog and is delivered to whichever sink turns up
  // later — and a page script can be that sink, which is precisely the tap this whole wave exists to stop.
  // Handing it the token would be worse than sending none: it could then authenticate, arm the one-way
  // latch, and lock the real native receiver out of its own channel.
  //
  // Withholding costs an unauthenticated session in the late-attach case, which is the pre-upgrade state
  // the design already accepts. It is NOT the common case: native adds the interface before the page
  // loads, so by `hello` the sink is normally there.
  bridge.post(
    encode(helloMessage({ sdk: sdkVersion, caps, session: randomId(), token: controlToken })),
  );

  client.launch();
  // Begin secure-area tracking once the SDK is live (top frame posts to native; a sub-frame bubbles to parent).
  // Only when the probe proved collection works — see `obscuringWorks` above.
  if (obscuringWorks) {
    obscuring?.start();
  }

  // The public client. stop() clears the per-WebView carrier slot + removes the control global so a later
  // launch() starts fresh.
  const stopCore = client.stop;
  publicClient = {
    ...client,
    stop(timeout?: number): Promise<boolean> {
      obscuring?.stop(); // detach the secure-area observers/listeners
      bridge.post(encode(byeMessage())); // signal teardown so native can finalize this WebView's stream
      setCarrierClient(undefined, carrier);
      // The binding cannot be removed (D-A3) — the session behind it goes inert instead, so a page script
      // cannot drive a stopped SDK and a later launch() can re-point the same binding at a live session.
      // Only revert if this session is still the CURRENT one (review round 1). The slot is shared per
      // global, so a late/duplicate stop() from a stale handle would otherwise make a NEWER live session
      // inert — control and the frame-time snapshot dead while capture keeps flowing.
      if (bridgeSlot.session === mySession) {
        bridgeSlot.session = INERT_SESSION;
      }
      return stopCore(timeout);
    },
  };
  setCarrierClient(publicClient, carrier);
  return publicClient;
}
