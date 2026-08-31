// The SDK launch/relaunch wiring for the sample. Single place that owns the process-carrier client so
// every page/component reads the same instance via `getClient()`. Mirrors samples/react-spa/src/bugsee.ts
// (the wave-1 reference) so the two samples' launch wiring is directly comparable.
//
// @bugsee/svelte re-exports the FULL `@bugsee/bugsee` browser umbrella (single-install design), so
// `launch` here already wires @bugsee/performance (S9) + @bugsee/opentelemetry (S13) on by default —
// not just @bugsee/browser's bare kernel.
import {
  handleErrorWithBugsee,
  launch,
  reportSvelteError,
  type Bugsee,
  type BugseeLaunchOptionsWithPerformance,
  type HandleErrorInput,
} from '@bugsee/svelte';
import {
  clearCapturedCalls,
  createTeeTransport,
  getCapturedBundles,
  inspectReplay,
} from './bugsee-transport';

export const APP_TOKEN = (import.meta.env.VITE_BUGSEE_APP_TOKEN as string) || '';
export const ENDPOINT =
  (import.meta.env.VITE_BUGSEE_ENDPOINT as string) || 'https://apidev.bugsee.com';
export const APP_VERSION = '1.0.0';
export const APP_BUILD = '1';
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
  // The default SDK_VERSION baked into @bugsee/browser is the literal string "0.1.0" as of the F-X2
  // fix (samples/FINDINGS.md), so this override is no longer load-bearing the way it was for react-spa
  // at build time — kept anyway so this sample is self-describing and immune to a future regression.
  sdkVersion: '0.1.0',
  appId: 'com.bugsee.sample.svelte-spa',
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
  // Deliberately short (default 30000) so scripts/verify.mjs can observe the continuous
  // /v2/performance/transactions upload within a single sweep run (PLAN §6.6's "wire" depth) instead of
  // stopping at "not visible via MCP" — see FIX §8 in the review that drove this.
  performanceFlushIntervalMs: 3000,
  traceNavigations: true,
  traceInteractions: true,
  propagateTrace: true,
  tracePropagationTargets: ['/api/'],

  // S11: replay is ON for the whole app with the fail-closed masking defaults.
  //
  // This line is REDUNDANT and kept only for readability. Session replay is now ON BY DEFAULT in
  // `@bugsee/browser` (`launch.ts`: `options.replay !== false && domDocument !== undefined`) — recording
  // is what happens unless you opt OUT with `replay: false`. It was NOT always so: an earlier version of
  // this sample omitted the key entirely and replay really was off everywhere outside the Scenario
  // panel's transient S11 relaunches, which is why it was added. Under the current SDK the same effect
  // would hold with the line deleted, so do not read it as "this is what enables recording" — the
  // Scenario panel's `s11-replay-default-on` control is the check that pins the default itself.
  replay: true,

  onError: reportInternalError,
  // Wire-depth verification (PLAN §4/§6.6): forwards every SDK call to real staging verbatim while
  // recording a parsed copy locally, so scripts/verify.mjs can assert on the ACTUAL uploaded bundle
  // contents (redaction, labels, dedupe) instead of only on the Scenario panel's own filter-callback
  // log — see src/bugsee-transport.ts and FINDINGS.md's S8 note.
  transport: createTeeTransport(),
};

// Exposed for scripts/verify.mjs (Playwright `page.evaluate`) — the tee transport's recorded bundle
// summaries are otherwise invisible from outside the page.
declare global {
  interface Window {
    __bugseeTee?: {
      getCapturedBundles: typeof getCapturedBundles;
      clearCapturedCalls: typeof clearCapturedCalls;
      /** S11 wire evidence: decode ONE uploaded bundle's `replay.bin` on demand (see bugsee-transport.ts). */
      inspectReplay: typeof inspectReplay;
    };
  }
}
if (typeof window !== 'undefined') {
  window.__bugseeTee = { getCapturedBundles, clearCapturedCalls, inspectReplay };
}

/**
 * S1: the minimum option set — this object contributes NOTHING, so every capture/behaviour option is
 * left at its SDK default.
 *
 * It is NOT a literal `launch(token, {})`, and the Scenario panel must not claim it is: it is fed to
 * `relaunch()` below, which always injects `endpoint`, `appId`, `appVersion`, `appBuild` and `onError`
 * (the sample cannot talk to staging, identify itself, or surface an internal error without them), and
 * `doLaunch` adds `carrier`. A true zero-option launch is `browser-vanilla`'s territory; what this
 * proves is that the SDK runs with every DEFAULT in force.
 */
export const MINIMAL_LAUNCH_OPTIONS: BugseeLaunchOptionsWithPerformance = {};

function doLaunch(options: BugseeLaunchOptionsWithPerformance, useCarrier: object): Bugsee {
  return launch(APP_TOKEN, { ...options, carrier: useCarrier });
}

/** Launch (or return the already-launched) client with the app's full option set. Called once from
 *  main.ts. */
export function launchApp(): Bugsee {
  if (client !== undefined) return client;
  client = doLaunch(FULL_LAUNCH_OPTIONS, carrier);
  client.setUserIdentifier(SAMPLE_USER_ID);
  client.setAttribute('build', APP_BUILD);
  client.setAttribute('sample', 'svelte-spa');
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
 * Relaunch the SDK against the SAME (global) process carrier with a new option set — used by the
 * Scenario panel to exercise option combinations (e.g. a minimal launch) that can only be observed by
 * actually rebuilding the client. Stops the current client first (draining its pending uploads) so the
 * two clients never race on the same IndexedDB/network resources.
 *
 * Deliberately reuses `carrier` rather than a fresh private object — see FINDINGS.md's note on
 * `samples/FINDINGS.md` F-X21 (react-spa found that a private relaunch carrier silently disables every
 * carrier-resolved adapter API, including this sample's own `handleAppError`/`reportSvelteError`
 * defaults). `stop()` clears the carrier's client slot synchronously before it awaits the drain, so the
 * "already launched" guard is already satisfied without needing a second carrier.
 *
 * Re-applies the identity + attributes `launchApp()` sets on the first launch (user identifier AND every
 * `setAttribute` call) — a relaunched client is a fresh instance with no state of its own, and a previous
 * version of this function only re-applied `setUserIdentifier`, silently dropping `build`/`sample` off
 * every issue reported after any relaunch (found reviewing scenarios.md's S2 row, which had mis-blamed the
 * gap on an MCP surface limitation instead of this).
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
      appId: 'com.bugsee.sample.svelte-spa',
      appVersion: APP_VERSION,
      appBuild: APP_BUILD,
      onError: reportInternalError,
      ...options,
    },
    carrier,
  );
  client.setUserIdentifier(SAMPLE_USER_ID);
  client.setAttribute('build', APP_BUILD);
  client.setAttribute('sample', 'svelte-spa');
  return client;
}

// -----------------------------------------------------------------------------------------------
// @bugsee/svelte error seam. `handleErrorWithBugsee` is shaped for SvelteKit's `handleError` hook
// (`src/hooks.client.ts`) — this sample is a plain Svelte SPA (no SvelteKit), but the package is a
// STRUCTURAL PEER (no `@sveltejs/kit` import: `packages/svelte/src/error.ts`), so it works against any
// object matching `HandleErrorInput` (`{ error, event?: { route?: { id } } }`). We build that shape by
// hand from our own hand-rolled router (`router.ts`) + a Svelte 5 `<svelte:boundary>`, which is exactly
// what a real SvelteKit host would hand it — proving the seam works without requiring SvelteKit itself.
// -----------------------------------------------------------------------------------------------

/** The app's own last-resort error handler — what a customer would put alongside the Bugsee report. */
function appErrorHandler(input: HandleErrorInput): { message: string } {
  // eslint-disable-next-line no-console
  console.error('[app handleError]', input.error);
  return { message: 'Something went wrong.' };
}

/** The wired hook: reports to Bugsee (labeled with the current route id) then delegates to the app's
 *  own handler, exactly as `src/hooks.client.ts` would wire it in a real SvelteKit app. */
export const handleAppError = handleErrorWithBugsee(appErrorHandler);

/** Direct call to `reportSvelteError` (bypassing the hook), for the Scenario panel's explicit-API
 *  control. */
export function reportSvelteErrorDirect(error: unknown, routeId?: string): void {
  reportSvelteError(error, { routeId });
}
