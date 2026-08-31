// The SDK launch/relaunch wiring for the sample. Single place that owns the process-carrier client so
// every page/component reads the same instance via `getClient()`.
//
// @bugsee/solid re-exports the FULL `@bugsee/bugsee` browser umbrella (single-install design), so
// `launch` here already wires @bugsee/performance (S9) + @bugsee/opentelemetry (S13) on by default —
// not just @bugsee/browser's bare kernel.
import { launch, type Bugsee, type BugseeLaunchOptionsWithPerformance } from '@bugsee/solid';

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
const carrier: object = globalThis;

/** The full option set the app launches with (S1: "launch with ... every option set"). Exported so the
 *  Settings + Scenario pages can display/relaunch against it. */
export const FULL_LAUNCH_OPTIONS: BugseeLaunchOptionsWithPerformance = {
  endpoint: ENDPOINT,
  // The default SDK_VERSION baked into @bugsee/browser (packages/browser/src/launch.ts:79) is the
  // literal string "0.0.0" (every package in this monorepo is unversioned pre-publish — see
  // samples/FINDINGS.md F-X2). Staging's session endpoint actively REJECTS that version
  // (UnsupportedSdkError) rather than merely recording it. Override it here so this sample's data
  // can land at all; a real published SDK would carry a real version.
  sdkVersion: '1.0.0',
  appId: 'com.bugsee.sample.solid-spa',
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
  // Short enough that `pnpm verify`'s wire-level checks (intercepting POST /v2/performance/transactions)
  // don't need to wait out the 30s default — see FINDINGS.md finding A and scripts/verify.mjs's
  // `waitForPerfTransactions`.
  performanceFlushIntervalMs: 1000,
  traceNavigations: true,
  traceInteractions: true,
  propagateTrace: true,
  tracePropagationTargets: ['/api/'],

  onError: reportInternalError,
};

/**
 * S1: the minimum viable launch. Used by the Scenario panel to prove the SDK works with every option
 * left at its default.
 *
 * NOT literally `launch(token, {})` at the wire, and the docs must not claim it is: `relaunch()` below
 * always merges `endpoint`, `appId`, `appVersion`, `appBuild`, `onError` (+ `carrier`) UNDER whatever is
 * passed here, so those five are never at their default for this control. `endpoint` is the load-bearing
 * one — a launch without it posts to PRODUCTION, which `docs/samples/PLAN.md` §3 forbids for a sample —
 * and the other four exist so a report from this client is still attributable and its internal errors
 * still reach the panel. Everything else (including `sdkVersion`, `captureNetwork`, `persist`,
 * `performanceMonitoring`, the replay options, …) really is at its default here.
 *
 * NOTE on "at its default" for replay: that used to mean OFF and now means ON. `@bugsee/browser` records
 * session replay unless the app opts out — `options.replay !== false && domDocument !== undefined`
 * (`packages/browser/src/launch.ts`) — so this minimal launch, and `FULL_LAUNCH_OPTIONS` below (which
 * also names no `replay` key), both RECORD. Every bundle this sample uploads therefore carries
 * `replay.bin`. `replay: false` is the opt-out; a DOM-less host self-skips silently.
 */
export const MINIMAL_LAUNCH_OPTIONS: BugseeLaunchOptionsWithPerformance = {};

function doLaunch(options: BugseeLaunchOptionsWithPerformance, useCarrier: object): Bugsee {
  return launch(APP_TOKEN, { ...options, carrier: useCarrier });
}

/** Launch (or return the already-launched) client with the app's full option set. Called once from
 *  main.tsx. */
export function launchApp(): Bugsee {
  if (client !== undefined) return client;
  client = doLaunch(FULL_LAUNCH_OPTIONS, carrier);
  client.setUserIdentifier(SAMPLE_USER_ID);
  client.setAttribute('build', APP_BUILD);
  client.setAttribute('sample', 'solid-spa');
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
 * Relaunch the SDK against the SAME (global) carrier with a new option set — used by the Scenario
 * panel to exercise option combinations (e.g. replay variants, a minimal launch) that can only be
 * observed by actually rebuilding the client. Stops the current client first (draining its pending
 * uploads) so the two clients never race on the same IndexedDB/network resources.
 *
 * Deliberately does NOT relaunch onto a fresh/private carrier object (`carrier = {}`) — see
 * samples/FINDINGS.md F-X21 (found by react-spa): `stop()` clears the carrier's client slot
 * SYNCHRONOUSLY (packages/browser/src/launch.ts) before it awaits the drain, so the "already
 * launched" guard is already satisfied and no second carrier is needed. Relaunching onto a PRIVATE
 * carrier would silently disable every adapter API that resolves the client from `globalThis` by
 * default — `reportSolidError`, `solidErrorHandler`, `setRouteNameFromSolidMatches`.
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
      appId: 'com.bugsee.sample.solid-spa',
      appVersion: APP_VERSION,
      appBuild: APP_BUILD,
      onError: reportInternalError,
      ...options,
    },
    carrier,
  );
  client.setUserIdentifier(SAMPLE_USER_ID);
  return client;
}
