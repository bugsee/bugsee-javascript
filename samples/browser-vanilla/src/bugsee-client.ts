// The SDK bootstrap for the Widget Shop sample. Wraps `@bugsee/bugsee`'s browser `launch()` with:
//  - settings persisted in localStorage, editable from the Settings page (S1: every launch option,
//    each individually toggleable and re-launchable);
//  - a stable sample user identifier + starter attributes (S2);
//  - a single module-level client the rest of the app (scenario panel, pages, worker bridge) reads
//    via `getClient()`.
import { launch, type Bugsee, type BugseeLaunchOptionsWithPerformance } from '@bugsee/bugsee';

const SETTINGS_KEY = 'widget-shop.bugsee-settings.v1';
const SAMPLE_USER = 'widget-shop-sample-user';
const APP_VERSION = '1.0.0';
// Bumped by hand per notable rebuild so issues from different runs are distinguishable in the dashboard.
const APP_BUILD = '7';

export interface SampleSettings {
  captureLogs: boolean;
  captureNetwork: boolean;
  captureNetworkBodies: boolean;
  maxNetworkBodySize: number;
  captureNetworkBodyWithoutType: boolean;
  captureSystemTraces: boolean;
  captureSystemEvents: boolean;
  captureInteractions: boolean;
  captureViewHierarchy: boolean;
  detectCrashes: boolean;
  maxRecordingTime: number;
  maxDataSize: number;
  persist: boolean;
  recover: boolean;

  replay: boolean;
  maskAllText: boolean;
  maskAllInputs: boolean;
  blockAllMedia: boolean;
  blockAllCanvas: boolean;
  canvasReplay: boolean;
  canvasFps: number | 'all';

  performanceMonitoring: boolean;
  performanceSampleRate: number;
  traceNavigations: boolean;
  traceInteractions: boolean;
  propagateTrace: boolean;

  otelExportUrl: string;
  otelConsume: boolean;
}

export const DEFAULT_SETTINGS: SampleSettings = {
  captureLogs: true,
  captureNetwork: true,
  captureNetworkBodies: true,
  maxNetworkBodySize: 20480,
  captureNetworkBodyWithoutType: false,
  captureSystemTraces: true,
  captureSystemEvents: true,
  captureInteractions: true,
  captureViewHierarchy: true,
  detectCrashes: true,
  maxRecordingTime: 60,
  maxDataSize: 10,
  persist: true,
  recover: true,

  replay: true,
  maskAllText: true,
  maskAllInputs: true,
  blockAllMedia: true,
  blockAllCanvas: false,
  canvasReplay: false,
  canvasFps: 2,

  performanceMonitoring: true,
  performanceSampleRate: 1,
  traceNavigations: true,
  traceInteractions: true,
  propagateTrace: false,

  otelExportUrl: '',
  otelConsume: false,
};

export function loadSettings(): SampleSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<SampleSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: SampleSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

let currentClient: Bugsee | undefined;
export const sdkErrors: Array<{ at: number; error: unknown }> = [];

// See server/bugsee-proxy.ts + FINDINGS.md F-2 (blocker): the real staging endpoint's CORS config
// rejects every third-party browser origin outright, so the SDK is pointed at this sample's own
// same-origin reverse proxy instead — which relays byte-for-byte to the real BUGSEE_ENDPOINT
// server-side (not subject to browser CORS). The data still lands on the real staging app.
const PROXIED_ENDPOINT = `${window.location.origin}/bugsee-proxy`;

// See FINDINGS.md F-3 (blocker): every packed package is version 0.0.0 (pre-publish; see the
// cross-cutting samples/FINDINGS.md F-X2), and the staging backend's `isSupportedSdkVersion` floor for
// the `javascript` umbrella's `browser` runtime is `0.1.0` (appserver config/default.js
// `cfg.core.sdk.javascript.browser.version.minimum`) — so `env.sdk.version: '0.0.0'` is rejected
// outright with `UnsupportedSdkError` and no session is ever created. `sdkVersion` is a documented
// launch option, so this sample overrides it to a value the backend accepts; the underlying package
// versioning is not touched.
const SDK_VERSION_OVERRIDE = '1.0.0';

function toLaunchOptions(s: SampleSettings): BugseeLaunchOptionsWithPerformance {
  return {
    endpoint: PROXIED_ENDPOINT,
    sdkVersion: SDK_VERSION_OVERRIDE,
    appVersion: APP_VERSION,
    appBuild: APP_BUILD,
    captureLogs: s.captureLogs,
    captureNetwork: s.captureNetwork,
    captureNetworkBodies: s.captureNetworkBodies,
    maxNetworkBodySize: s.maxNetworkBodySize,
    captureNetworkBodyWithoutType: s.captureNetworkBodyWithoutType,
    captureSystemTraces: s.captureSystemTraces,
    captureSystemEvents: s.captureSystemEvents,
    captureInteractions: s.captureInteractions,
    captureViewHierarchy: s.captureViewHierarchy,
    detectCrashes: s.detectCrashes,
    maxRecordingTime: s.maxRecordingTime,
    maxDataSize: s.maxDataSize,
    persist: s.persist,
    recover: s.recover,
    replay: s.replay
      ? {
          maskAllText: s.maskAllText,
          maskAllInputs: s.maskAllInputs,
          blockAllMedia: s.blockAllMedia,
          blockAllCanvas: s.blockAllCanvas,
          ...(s.canvasReplay ? { canvas: { fps: s.canvasFps } } : {}),
        }
      : false,
    performanceMonitoring: s.performanceMonitoring,
    performanceSampleRate: s.performanceSampleRate,
    traceNavigations: s.traceNavigations,
    traceInteractions: s.traceInteractions,
    propagateTrace: s.propagateTrace,
    tracePropagationTargets: ['/api/'],
    ...(s.otelExportUrl.length > 0 ? { otelExportUrl: s.otelExportUrl } : {}),
    otelConsume: s.otelConsume,
    onError: (error) => {
      sdkErrors.push({ at: Date.now(), error });
      // eslint-disable-next-line no-console
      console.warn('[bugsee onError]', error);
    },
  };
}

/** Launch (or re-launch) the SDK with the given settings. Stops any existing client first so the
 *  Settings page's "apply & relaunch" is a real relaunch, not the documented no-op second `launch()`
 *  (that no-op is exercised separately and deliberately in the Scenario panel, S1). */
export async function relaunchBugsee(settings: SampleSettings): Promise<Bugsee> {
  if (currentClient !== undefined) {
    await currentClient.stop(2000);
    currentClient = undefined;
  }
  const token = import.meta.env.BUGSEE_APP_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error('BUGSEE_APP_TOKEN is not set — copy .env.example to .env and fill it in');
  }
  const client = launch(token, toLaunchOptions(settings));
  client.setUserIdentifier(SAMPLE_USER);
  client.setAttribute('sample', 'browser-vanilla');
  client.setAttribute('cartAttrSetAt', new Date().toISOString());
  currentClient = client;
  (window as unknown as { __bugsee: Bugsee }).__bugsee = client;
  return client;
}

export function getClient(): Bugsee | undefined {
  return currentClient;
}

/** Launch once at startup using persisted (or default) settings. */
export async function bootstrapBugsee(): Promise<Bugsee> {
  return relaunchBugsee(loadSettings());
}
