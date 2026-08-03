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

/** The launched WebView client — the public SDK surface. */
export type Bugsee = BugseeClient;

/** Launch the Bugsee WebView SDK. A per-WebView singleton (a repeat call is ignored). Returns the started client. */
export function launch(appToken: string, options: BugseeWebViewLaunchOptions = {}): Bugsee {
  const sdkVersion = options.sdkVersion ?? SDK_VERSION;
  const carrier = options.carrier;
  const global = (options.global ?? globalThis) as { __bugsee_bridge?: unknown };

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
  let childComposer: ObscuringComposer | undefined; // SUB-frame: bubbles its rects up to the parent
  const control = createBridgeControl({
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
      } else if (command === 'snapshot') {
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
  //   - a SUB-frame runs a composer that `postMessage`s its (composed) viewport rects to its parent — it does
  //     NOT post to native and does NOT declare the cap (only the top frame's union reaches native).
  // (Native owns the final "is coverage complete → fully drop legacy" decision: it knows its D9 injection set.)
  const w = win as { top?: unknown; self?: unknown } | undefined;
  const isTopFrame = w?.top === undefined || w.top === (w.self ?? w);
  const obscuringDoc = domDocument as unknown as ComposerDocument;
  const obscuringWin = win !== undefined ? { window: win as unknown as ComposerWindow } : {};
  const obscuringErr = options.onError !== undefined ? { onError: options.onError } : {};
  if ((options.captureObscuring ?? true) && domDocument !== undefined) {
    if (isTopFrame) {
      obscuring = createObscuringChannel({
        bridge,
        document: obscuringDoc,
        ...obscuringWin,
        ...obscuringErr,
        seq,
      });
    } else {
      childComposer = createObscuringComposer({
        document: obscuringDoc,
        ...obscuringWin,
        ...obscuringErr,
        isTopFrame: false,
      });
    }
  }
  // Only the TOP frame declares `obscuring` (it alone reports the composed whole-page union to native), and
  // only once a collection has been PROVEN to work. Declaring the capability is what makes native stand its
  // legacy masking script down (D10), and the protocol has no retraction message — so on a page where
  // collection already throws, staying silent leaves native's own masking in place, which is the fail-closed
  // answer (docs/review/webview.md SEV1 #2).
  const caps = obscuring?.probe() === true ? [...CAPABILITIES, 'obscuring'] : [...CAPABILITIES];

  // The native→JS control entry point: native calls `__bugsee_bridge.control(json)` via evaluateJavascript for
  // the handshake reply + commands; it also PULLS the current secure-area rects synchronously at frame-capture
  // time via `__bugsee_bridge.snapshot()` (serialized rects; `[]` when obscuring is off).
  global.__bugsee_bridge = Object.freeze({
    control: control.control,
    snapshot: (): string => obscuring?.snapshot() ?? '[]',
  });

  // Open the handshake BEFORE capture starts so it is the first thing native sees. Declaring `caps` is what
  // lets native decide legacy coexistence (D10).
  bridge.post(encode(helloMessage({ sdk: sdkVersion, caps, session: randomId() })));

  client.launch();
  // Begin secure-area tracking once the SDK is live (top frame posts to native; a sub-frame bubbles to parent).
  obscuring?.start();
  // The channel guards the TOP frame; a SUB-frame composer is called directly, so its failures escaped
  // launch() itself — and `window.parent` is [Replaceable], so one line of page script was enough
  // (measured: `launch()` threw `hostile parent`, onError never fired).
  neverThrow(() => childComposer?.start(), options.onError);

  // The public client. stop() clears the per-WebView carrier slot + removes the control global so a later
  // launch() starts fresh.
  const stopCore = client.stop;
  publicClient = {
    ...client,
    stop(timeout?: number): Promise<boolean> {
      obscuring?.stop(); // detach the secure-area observers/listeners
      neverThrow(() => childComposer?.stop(), options.onError);
      bridge.post(encode(byeMessage())); // signal teardown so native can finalize this WebView's stream
      setCarrierClient(undefined, carrier);
      global.__bugsee_bridge = undefined;
      return stopCore(timeout);
    },
  };
  setCarrierClient(publicClient, carrier);
  return publicClient;
}
