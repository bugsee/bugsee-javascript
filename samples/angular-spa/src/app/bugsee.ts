// The SDK launch/relaunch wiring for the sample. Single place that owns the process-carrier client so
// every component/service reads the same instance via `getClient()`. A plain module (no Angular DI) —
// mirrors react-spa's src/bugsee.ts and vue-spa's equivalent, and stays usable from a route guard
// (manager.guard.ts) which runs outside any component's injector-friendly lifecycle.
//
// @bugsee/angular re-exports the FULL `@bugsee/bugsee` browser umbrella (single-install design), so
// `launch` here already wires @bugsee/performance (S9) + @bugsee/opentelemetry (S13) on by default —
// not just @bugsee/browser's bare kernel.
import { launch, type Bugsee, type BugseeLaunchOptionsWithPerformance } from '@bugsee/angular';
import { environment } from '../environments/environment';
import {
  clearCapturedCalls,
  createTeeTransport,
  getCapturedBundles,
  getReplayText,
} from './bugsee-transport';

export const APP_TOKEN = environment.bugseeAppToken;
export const ENDPOINT = environment.bugseeEndpoint;
export const APP_BUILD = environment.appBuild;
export const APP_VERSION = '1.0.0';
export const SAMPLE_USER_ID = 'sample-user@bugsee.dev';

/** Internal-error sink: every provider/relaunch failure lands in the console AND a ring buffer the
 *  Scenario panel can display, so "the SDK swallowed an internal error" is still visible in the app. */
export type InternalErrorListener = (error: unknown) => void;
const internalErrorListeners = new Set<InternalErrorListener>();
export function onInternalError(listener: InternalErrorListener): () => void {
  internalErrorListeners.add(listener);
  return () => internalErrorListeners.delete(listener);
}
function reportInternalError(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[bugsee:onError]', error);
  for (const listener of internalErrorListeners) listener(error);
}

let client: Bugsee | undefined;
const carrier: object = globalThis;

/** The full option set the app launches with (S1: "launch with ... every option set"). */
export const FULL_LAUNCH_OPTIONS: BugseeLaunchOptionsWithPerformance = {
  endpoint: ENDPOINT,
  // The 0.x SDK_VERSION baked into @bugsee/browser is a pre-publish placeholder; staging's session
  // endpoint has rejected unversioned SDKs before (see samples/react-spa/FINDINGS.md F-2/F-3 —
  // confirmed cross-cutting in samples/FINDINGS.md). Overriding here matches every other sample's
  // convention so this sample's own data lands regardless of that in-flight versioning question.
  sdkVersion: '1.0.0',
  appId: 'com.bugsee.sample.angular-spa',
  appVersion: APP_VERSION,
  appBuild: APP_BUILD,

  captureLogs: true,
  captureNetwork: true,
  captureNetworkBodies: true,
  // Deliberately small so /scenarios' "large body" control exercises the over-cap body path (S7)
  // without needing a multi-megabyte fixture. NB: over the cap the captured copy is DROPPED entirely
  // (`custom.no_body_reason: 'size_too_large'`), not truncated — see network-body.ts's `boundedText`.
  maxNetworkBodySize: 2048,
  captureNetworkBodyWithoutType: true,
  captureSystemTraces: true,
  captureSystemEvents: true,
  captureInteractions: true,
  captureViewHierarchy: true,
  detectCrashes: true,

  maxRecordingTime: 120,
  maxDataSize: 10,
  persist: true,
  recover: true,

  performanceMonitoring: true,
  performanceSampleRate: 1,
  // The uploader's default batched-flush interval is 30s (`packages/performance/src/performance-uploader.ts`'s
  // DEFAULT_FLUSH_INTERVAL_MS). Shortened here — as every other SPA sample does — so the sweep can assert
  // on the ACTUAL `POST /v2/performance/transactions` body within a click's lifetime (s9-manual-transaction).
  // Deliberately NOT shorter than the sweep's shortest quiet window (1500ms), so periodic performance
  // uploads can never keep `waitForQuiet` from settling.
  performanceFlushIntervalMs: 5000,
  traceNavigations: true,
  traceInteractions: true,
  propagateTrace: true,
  tracePropagationTargets: ['/api/'],

  onError: reportInternalError,
  // Wire-depth verification (PLAN §4/§6.6, item 2 of the fix pass): forwards every SDK call to real
  // staging verbatim while recording a parsed copy locally, so scripts/verify.mjs can assert on the
  // ACTUAL uploaded bundle contents (redaction, masking-file presence, dropped over-cap bodies) instead of
  // only on the Scenario panel's own filter-callback log — see src/app/bugsee-transport.ts and
  // FINDINGS.md.
  transport: createTeeTransport(),
};

// Exposed for scripts/verify.mjs (Playwright `page.evaluate`) — the tee transport's recorded bundle
// summaries are otherwise invisible from outside the page.
declare global {
  interface Window {
    __bugseeTee?: {
      getCapturedBundles: typeof getCapturedBundles;
      clearCapturedCalls: typeof clearCapturedCalls;
      // Deliberately NOT folded into getCapturedBundles()' payload — see bugsee-transport.ts's
      // `replayBlobs` note on why the decoded replay stream is fetched on demand instead.
      getReplayText: typeof getReplayText;
    };
  }
}
if (typeof window !== 'undefined') {
  window.__bugseeTee = { getCapturedBundles, clearCapturedCalls, getReplayText };
}

/**
 * S1: the caller-supplied options are empty — but NOT a truly-minimal launch end to end. `relaunch()`
 * below always injects `endpoint`/`appId`/`appVersion`/`appBuild`/`onError` ahead of whatever is passed
 * here, deliberately: a genuinely-default `endpoint` resolves to Bugsee PRODUCTION, and this sample's
 * data must land on staging only (`docs/samples/PLAN.md` §3). So "relaunch minimal" demonstrates every
 * OTHER option left at its default (capture toggles, `maxRecordingTime`, `persist`/`recover`, performance
 * sampling, etc.) — not `endpoint`, which can never be defaulted here. See FINDINGS.md for the earlier,
 * incorrect claim that this was a fully-default launch.
 */
export const MINIMAL_LAUNCH_OPTIONS: BugseeLaunchOptionsWithPerformance = {};

function doLaunch(options: BugseeLaunchOptionsWithPerformance, useCarrier: object): Bugsee {
  return launch(APP_TOKEN, { ...options, carrier: useCarrier });
}

/** Launch (or return the already-launched) client with the app's full option set. Called once from
 *  main.ts, before `bootstrapApplication`. */
export function launchApp(): Bugsee {
  if (client !== undefined) return client;
  client = doLaunch(FULL_LAUNCH_OPTIONS, carrier);
  client.setUserIdentifier(SAMPLE_USER_ID);
  client.setAttribute('build', APP_BUILD);
  client.setAttribute('sample', 'angular-spa');
  return client;
}

/** The current launched client, or undefined before `launchApp()` runs. */
export function getClient(): Bugsee | undefined {
  return client;
}

/**
 * S1: call `launch()` again on the SAME carrier the app already launched on. Per the design contract
 * this must be IGNORED (return the existing client, not build a second one). Returns whether the
 * returned client is the SAME instance.
 */
export function attemptDuplicateLaunch(): { sameInstance: boolean } {
  const before = client;
  const again = doLaunch({ endpoint: ENDPOINT }, carrier);
  return { sameInstance: again === before };
}

/**
 * Relaunch the SDK against the SAME (global) carrier with a new option set — used by the Scenario
 * panel to exercise option combinations (e.g. replay variants, a minimal launch) that can only be
 * observed by actually rebuilding the client. Stops the current client first (draining its pending
 * uploads). Kept on the GLOBAL carrier deliberately (see samples/react-spa/FINDINGS.md F-X21): every
 * carrier-resolved adapter API (`reportAngularError`, `createAngularErrorHandler`'s default resolver,
 * `setRouteNameFromRouter`) reads `getCarrierClient()` against `globalThis` by default — moving to a
 * private carrier here would silently break every one of them.
 */
export async function relaunch(
  options: BugseeLaunchOptionsWithPerformance,
  { stopTimeoutMs = 2000 }: { stopTimeoutMs?: number } = {},
): Promise<Bugsee> {
  if (client !== undefined) {
    await client.stop(stopTimeoutMs);
  }
  client = doLaunch(
    {
      endpoint: ENDPOINT,
      appId: 'com.bugsee.sample.angular-spa',
      appVersion: APP_VERSION,
      appBuild: APP_BUILD,
      onError: reportInternalError,
      ...options,
    },
    carrier,
  );
  client.setUserIdentifier(SAMPLE_USER_ID);
  // Re-applied: relaunch() builds a BRAND NEW client, which starts with no attributes even though
  // launchApp() set 'build'/'sample' on the original one. Without this, every issue created after the
  // first Scenario-panel relaunch (which is most of them, since S1's relaunch controls run first) would
  // carry no identifying attributes at all.
  client.setAttribute('build', APP_BUILD);
  client.setAttribute('sample', 'angular-spa');
  return client;
}
