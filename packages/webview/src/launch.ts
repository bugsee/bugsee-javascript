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
  type BugseeClient,
  type CaptureStore,
  type Clock,
  COMMON_OPTION_DEFINITIONS,
  createClient,
  createServiceContainer,
  getCarrierClient,
  getOrCreateInterceptor,
  getServiceManifests,
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
import type { SecureDocument, SecureWindow } from './obscuring-source';
import { byeMessage, encode, helloMessage } from './protocol';
import { createWebViewReportPipeline } from './webview-report-pipeline';

// @bugsee/webview launch() — the WebView composition root (docs/design/webview-bridge.md §5/§10). A WebView is a
// browser environment whose OUTPUT SINK is the native host, not the network: this reuses @bugsee/browser-family
// capture (console→log + network in slice 1; full parity in slice 2) over a HostBridgeCaptureStore that STREAMS
// each entry across the WebView boundary — NO transport / upload pipeline / bundle store / IndexedDB (native is
// the ring buffer + the bundler). On launch it opens a `hello` handshake (declaring its capabilities, which
// drive native's legacy-coexistence decision, D10) and exposes `__bugsee_bridge.control` for native→JS control.
// WebView-originated report TRIGGERING is gated behind `reportTrigger` (D5, default off) — wired in slice 2.

const SDK_VERSION = '0.0.0';

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
  /** Carrier host for the per-WebView singleton + shared interceptors; injectable for tests. Default global. */
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
  let obscuring: ObscuringChannel | undefined;
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
  const captureStore =
    options.captureStore ?? createHostBridgeCaptureStore({ bridge, seq, paused: () => paused });
  // The report path replaces bundle-assembly+upload (D2): every detected incident / logException streams up as
  // a `crash` entry (always, D5), plus a report TRIGGER gated on `reportTrigger` (read dynamically).
  const triggerPipeline = createWebViewReportPipeline({
    bridge,
    reportTriggerEnabled: () => control.config.reportTrigger,
    seq,
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

  // Obscuring (D10): when there is a DOM and it isn't opted out, stream the secure-area rects so native masks
  // sensitive pixels in its frames — and declare the `obscuring` capability so native drops its legacy masking
  // script. Without a DOM (or opted out) we neither track nor declare it, so native keeps legacy masking.
  // TOP-FRAME ONLY (legacy parity): a sub-frame's rects are viewport-relative to the SUB-frame and the native
  // mask is composed over the whole page, so only the top frame may track + declare obscuring — a sub-frame
  // declaring it would make native suppress legacy while masking the wrong/partial area. (Sub-frame rect
  // composition/bubbling is the open D9 frame-attribution item — until built, a sub-frame keeps legacy masking.)
  const w = win as { top?: unknown; self?: unknown } | undefined;
  const isTopFrame = w?.top === undefined || w.top === (w.self ?? w);
  if ((options.captureObscuring ?? true) && domDocument !== undefined && isTopFrame) {
    obscuring = createObscuringChannel({
      bridge,
      document: domDocument as unknown as SecureDocument,
      ...(win !== undefined ? { window: win as unknown as SecureWindow } : {}),
      seq,
    });
  }
  const caps = obscuring !== undefined ? [...CAPABILITIES, 'obscuring'] : [...CAPABILITIES];

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
  obscuring?.start(); // begin secure-area change tracking once the SDK is live

  // The public client. stop() clears the per-WebView carrier slot + removes the control global so a later
  // launch() starts fresh.
  const stopCore = client.stop;
  publicClient = {
    ...client,
    stop(timeout?: number): Promise<boolean> {
      obscuring?.stop(); // detach the secure-area observers/listeners
      bridge.post(encode(byeMessage())); // signal teardown so native can finalize this WebView's stream
      setCarrierClient(undefined, carrier);
      global.__bugsee_bridge = undefined;
      return stopCore(timeout);
    },
  };
  setCarrierClient(publicClient, carrier);
  return publicClient;
}
