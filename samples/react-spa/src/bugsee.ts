// The SDK launch/relaunch wiring for the sample. Single place that owns the process-carrier client so
// every page/component reads the same instance via `getClient()`.
//
// @bugsee/react re-exports the FULL `@bugsee/bugsee` browser umbrella (single-install design), so
// `launch` here already wires @bugsee/performance (S9) + @bugsee/opentelemetry (S13) on by default —
// not just @bugsee/browser's bare kernel.
import { launch, type Bugsee, type BugseeLaunchOptionsWithPerformance } from '@bugsee/react';

export const APP_TOKEN = (import.meta.env.VITE_BUGSEE_APP_TOKEN as string) || '';
export const ENDPOINT =
  (import.meta.env.VITE_BUGSEE_ENDPOINT as string) || 'https://apidev.bugsee.com';
export const APP_BUILD = (import.meta.env.VITE_APP_BUILD as string) || 'dev';
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
let carrier: object = globalThis;

/** The full option set the app launches with (S1: "launch with ... every option set"). Exported so the
 *  Settings + Scenario pages can display/relaunch against it. */
export const FULL_LAUNCH_OPTIONS: BugseeLaunchOptionsWithPerformance = {
  endpoint: ENDPOINT,
  // The default SDK_VERSION baked into @bugsee/browser (packages/browser/src/launch.ts:79) is the
  // literal string "0.0.0" (every package in this monorepo is unversioned pre-publish — see
  // samples/FINDINGS.md F-X2). Staging's session endpoint actively REJECTS that version
  // (UnsupportedSdkError, code 99098) rather than merely recording it — see FINDINGS.md F-2. Override
  // it here so this sample's data can land at all; a real published SDK would carry a real version.
  sdkVersion: '1.0.0',
  appId: 'com.bugsee.sample.react-spa',
  appVersion: APP_VERSION,
  appBuild: APP_BUILD,

  captureLogs: true,
  captureNetwork: true,
  captureNetworkBodies: true,
  // Deliberately small so /scenarios' "large body" control exercises the bounded-read truncation path
  // (S7) without needing a multi-megabyte fixture.
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
  traceNavigations: true,
  traceInteractions: true,
  propagateTrace: true,
  tracePropagationTargets: ['/api/'],

  onError: reportInternalError,
};

/** S1: the minimum viable launch — nothing but the token. Used by the Scenario panel to prove the SDK
 *  works with every option left at its default. */
export const MINIMAL_LAUNCH_OPTIONS: BugseeLaunchOptionsWithPerformance = {};

function doLaunch(options: BugseeLaunchOptionsWithPerformance, useCarrier: object): Bugsee {
  const c = launch(APP_TOKEN, { ...options, carrier: useCarrier });
  return c;
}

/** Launch (or return the already-launched) client with the app's full option set. Called once from
 *  main.tsx. */
export function launchApp(): Bugsee {
  if (client !== undefined) return client;
  client = doLaunch(FULL_LAUNCH_OPTIONS, carrier);
  client.setUserIdentifier(SAMPLE_USER_ID);
  client.setAttribute('build', APP_BUILD);
  client.setAttribute('sample', 'react-spa');
  return client;
}

/** The current launched client, or undefined before `launchApp()` runs. */
export function getClient(): Bugsee | undefined {
  return client;
}

/**
 * S1: call `launch()` again on the SAME carrier the app already launched on. Per the design contract
 * this must be IGNORED (return the existing client, not build a second one) and route a diagnostic
 * through `onError` rather than throwing. Returns whether the returned client is the SAME instance.
 */
export function attemptDuplicateLaunch(): { sameInstance: boolean } {
  const before = client;
  const again = doLaunch({ endpoint: ENDPOINT }, carrier);
  return { sameInstance: again === before };
}

/**
 * Relaunch the SDK against a FRESH process carrier with a new option set — used by the Scenario panel
 * to exercise option combinations (e.g. replay variants, a minimal launch) that can only be observed by
 * actually rebuilding the client. Stops the current client first (draining its pending uploads) so the
 * two clients never race on the same IndexedDB/network resources.
 */
export async function relaunch(
  options: BugseeLaunchOptionsWithPerformance,
  { stopTimeoutMs = 2000 }: { stopTimeoutMs?: number } = {},
): Promise<Bugsee> {
  if (client !== undefined) {
    await client.stop(stopTimeoutMs);
  }
  // Relaunch on the SAME (global) carrier. `stop()` clears the carrier's client slot SYNCHRONOUSLY
  // (packages/browser/src/launch.ts:569) before it awaits the drain, so the "already launched" guard is
  // already satisfied and no second carrier is needed.
  //
  // This used to be `carrier = {}` — a private object — and that quietly broke every adapter API that
  // resolves the client from the carrier by DEFAULT: `reportReactError`, `createBugseeErrorHandlers`,
  // `reportRouteError` and `BugseeErrorBoundary` all call `getCarrierClient()` against `globalThis`.
  // From the first relaunch onward they found nothing there and became silent no-ops, so the scenario
  // panel's React reporting controls did nothing at all — while the sweep still reported PASS, because
  // it was reading a neighbouring scenario's late upload inside a fixed time window.
  client = doLaunch(
    { endpoint: ENDPOINT, appId: 'com.bugsee.sample.react-spa', appVersion: APP_VERSION, appBuild: APP_BUILD, onError: reportInternalError, ...options },
    carrier,
  );
  client.setUserIdentifier(SAMPLE_USER_ID);
  return client;
}
