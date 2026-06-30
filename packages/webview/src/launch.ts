import {
  createConsoleInterceptor,
  createLogCaptureProvider,
  installNetworkCapture,
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
import { encode, helloMessage } from './protocol';

// @bugsee/webview launch() — the WebView composition root (docs/design/webview-bridge.md §5/§10). A WebView is a
// browser environment whose OUTPUT SINK is the native host, not the network: this reuses @bugsee/browser-family
// capture (console→log + network in slice 1; full parity in slice 2) over a HostBridgeCaptureStore that STREAMS
// each entry across the WebView boundary — NO transport / upload pipeline / bundle store / IndexedDB (native is
// the ring buffer + the bundler). On launch it opens a `hello` handshake (declaring its capabilities, which
// drive native's legacy-coexistence decision, D10) and exposes `__bugsee_bridge.control` for native→JS control.
// WebView-originated report TRIGGERING is gated behind `reportTrigger` (D5, default off) — wired in slice 2.

const SDK_VERSION = '0.0.0';

// The capture FileTypes this SDK currently emits — declared in the hello so native can negotiate (D10). Slice 1
// = console→log + network; grows with the full-parity providers (slice 2) + the obscuring source (slice 4).
const CAPABILITIES = ['log', 'network'] as const;

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
   * Allow the WebView to emit report TRIGGERS (an uncaught error / `logException` opening a native bug). D5:
   * default OFF — native is the authority on opening bugs; web data just enriches whatever report native opens.
   * Capture (incl. error entries) always streams up regardless. Native may also push this via the handshake.
   */
  reportTrigger?: boolean;
  /** Internal-error sink (provider-start / bridge-post failures). Default no-op. */
  onError?: (error: unknown) => void;

  // Injectable seams (advanced / tests) — defaults target the real WebView runtime.
  /** The WebView global hosting the native bridge + the `__bugsee_bridge` control entry. Default `globalThis`. */
  global?: object;
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
  const captureStore = options.captureStore ?? createHostBridgeCaptureStore({ bridge });

  const client = createClient({
    isEnabled: resolved.isEnabled,
    launchOptions: resolved.options,
    services,
    captureStore,
    appToken,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  for (const manifest of getServiceManifests(carrier)) {
    manifest(client);
  }

  // Capture providers (slice 1 set): console→log + network. Each carrier-shared interceptor self-skips when its
  // controllingOption is off. Full parity (DOM/viewtree, performance, events, traces) + the obscuring source land
  // in slices 2/4.
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

  // The native→JS control entry point: native calls `__bugsee_bridge.control(json)` via evaluateJavascript. It
  // receives the handshake reply (native session + the reportTrigger gate) + (slice 3) commands.
  const control = createBridgeControl({ reportTrigger: options.reportTrigger ?? false });
  global.__bugsee_bridge = Object.freeze({ control: control.control });

  // Open the handshake BEFORE capture starts so it is the first thing native sees. Declaring `caps` is what
  // lets native decide legacy coexistence (D10).
  bridge.post(
    encode(helloMessage({ sdk: sdkVersion, caps: [...CAPABILITIES], session: randomId() })),
  );

  client.launch();

  // The public client. stop() clears the per-WebView carrier slot + removes the control global so a later
  // launch() starts fresh.
  const stopCore = client.stop;
  const publicClient: Bugsee = {
    ...client,
    stop(timeout?: number): Promise<boolean> {
      setCarrierClient(undefined, carrier);
      global.__bugsee_bridge = undefined;
      return stopCore(timeout);
    },
  };
  setCarrierClient(publicClient, carrier);
  return publicClient;
}
