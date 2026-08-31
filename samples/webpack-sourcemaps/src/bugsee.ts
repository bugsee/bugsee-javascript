// The SDK launch/relaunch wiring for the sample — single place that owns the process-carrier client so
// every module reads the same instance via `getClient()`. Modeled on samples/react-spa/src/bugsee.ts;
// this sample has no framework, so it talks to the browser umbrella (`@bugsee/bugsee`) directly.
//
// `@bugsee/bugsee`'s browser entry wires @bugsee/performance (S9) + @bugsee/opentelemetry (S13) on by
// default on top of @bugsee/browser's bare kernel (packages/bugsee/src/launch.ts).
import { launch, type Bugsee, type BugseeLaunchOptionsWithPerformance } from '@bugsee/bugsee';
import {
  clearCapturedCalls,
  createTeeTransport,
  getCapturedBundles,
  getReplayDigest,
} from './bugsee-transport';

// Injected by webpack.config.js's DefinePlugin from THIS sample's own .env — always the REAL token,
// even when a build variant (build:bad-token-*) overrides the plugin's UPLOAD token via a separate env
// var. A broken source-map upload must never also break the deployed app's own ability to report.
// `NODE_ENV` is NOT one of the plugin's explicit DefinePlugin keys (webpack.config.js) — webpack itself
// replaces it from the `mode` option ('production' for `pnpm build`, 'development' for `pnpm dev`).
declare const process: {
  env: { BUGSEE_APP_TOKEN?: string; BUGSEE_ENDPOINT?: string; APP_BUILD?: string; NODE_ENV?: string };
};

export const APP_TOKEN = process.env.BUGSEE_APP_TOKEN ?? '';
export const ENDPOINT = process.env.BUGSEE_ENDPOINT ?? 'https://apidev.bugsee.com';
export const APP_BUILD = process.env.APP_BUILD ?? 'dev';
export const APP_VERSION = '1.0.0';
export const SAMPLE_USER_ID = 'sample-user@bugsee.dev';

// The tee (src/bugsee-transport.ts) is a VERIFICATION HARNESS: it exists so scripts/verify.mjs can
// assert on real bundle contents via `window.__bugseeTee`. Neither `pnpm verify` (dev server, mode
// development) nor `pnpm verify:sourcemaps` (drives the PRODUCTION dist build via page.on('response'),
// never `__bugseeTee`) needs the tee wired into a production build — so gate it out of `pnpm build`'s
// output (mode: 'production'). Without this guard, `pnpm build` would ship the test transport (with
// its recording overhead + @bugsee/util's unzip code) into the real app, and leak a debug global.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

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

/**
 * The full option set the app launches with (S1: "launch with ... every option set").
 *
 * "Full" means: every non-injectable field of `BugseeLaunchOptions`
 * (`packages/browser/src/launch.ts`) and of the umbrella's `UmbrellaExtensionOptions`
 * (`packages/bugsee/src/wire.ts`), with SEVEN documented exclusions in three groups (corrected in fix
 * round 4, R4-5 — this block said "THREE" and named `otelHeaders`, a field that does not exist):
 *
 * - `sdkVersion` (`launch.ts:132-133`) — deliberately left at its real default. It is stamped into the
 *   environment envelope AND the `user-agent: BugseeJS/<v>` header (`packages/core/src/bugsee-api.ts:72`),
 *   so overriding it would make every issue this sample files on staging report a version the SDK is
 *   not — poisoning the very evidence trail the sample exists to produce. Exercised by omission.
 * - `replay` — **CORRECTED (substrate-flip re-verification).** This entry used to read "S11 is N/A for
 *   this sample by design", and that is now simply false in two ways. Session replay is ON BY DEFAULT
 *   (`packages/browser/src/launch.ts`: `options.replay !== false && domDocument !== undefined`), so
 *   this sample RECORDS a session and ships `replay.bin` in every bundle it uploads whether or not it
 *   asks to. "Excluded because it is out of scope" therefore described neither the option nor the
 *   sample's behaviour: it described a state of the world that ended when the default flipped.
 *
 *   `replay` is STILL left unset here, but for the opposite reason, and it is no longer unverified.
 *   Setting `replay: true` would be behaviour-identical to the default and would make the sweep's
 *   `s11-replay-file` row ("the bundle carries replay.bin WITHOUT the sample asking for it") assert
 *   nothing — a regression that flipped the default back to opt-out would stay green because we had
 *   opted in. Leaving it unset is what makes the on-by-default behaviour itself observable, exactly
 *   the `sdkVersion` argument above: exercised BY OMISSION, and now asserted at wire depth by the
 *   three `s11-*` rows in `scripts/verify.mjs`. Honest gap: `ReplayLaunchOptions`' own sub-fields
 *   (`maskAllText`/`maskAllInputs`/`blockAllMedia`/`blockAllCanvas`/`maskTextSelector`/
 *   `blockSelector`/`ignoreSelector`/`checkoutEveryNms`/`canvas`) are consequently never set here —
 *   their fail-closed DEFAULTS are what `s11-replay-masking` verifies; `browser-vanilla` and
 *   `react-spa` remain the samples that drive the sub-options themselves.
 * - ALL FIVE public OTel options — `otelExportUrl` (`wire.ts:109`), `otelExportHeaders` (`:111`),
 *   `otelExportResource` (`:113`), `otelConsume` (`:119`), `onOtelSpanProcessor` (`:121`) — S13 is N/A
 *   here (no local collector, and no user TracerProvider to consume spans from; see `scenarios.md`
 *   S13). NB `tracePropagationOrigin` (`wire.ts:102`) is NOT an exclusion — it IS set, just below.
 *
 * The injectable test seams (`window`/`document`/`clock`/`scheduler`/`captureStore`/`triggerPipeline`/
 * `systemProbe`/`systemMetricsSampler`/`bundleStore`/`locks`/`indexedDB`) are deliberately NOT set — the
 * point of this sample is the REAL browser runtime. `transport` is the one exception (the verification
 * tee below), and `carrier` is supplied per-call by `doLaunch`.
 */
export const FULL_LAUNCH_OPTIONS: BugseeLaunchOptionsWithPerformance = {
  endpoint: ENDPOINT,
  appId: 'com.bugsee.sample.webpack-sourcemaps',
  appVersion: APP_VERSION,
  appBuild: APP_BUILD,

  captureLogs: true,
  captureNetwork: true,
  captureNetworkBodies: true,
  // Deliberately small so the Scenario panel's "large body" control exercises the bounded-read
  // truncation path (S7) without needing a multi-megabyte fixture.
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
  // Well under the 30s default so a sweep run (which takes far less than 30s per relaunch window)
  // actually observes a performance flush instead of only ever ending before the first one.
  performanceFlushIntervalMs: 5000,
  // Overrides the default pageload transaction name (`location.pathname` / `pageload`) — the whole
  // sample is one hash-routed page, so a path-derived name would say nothing.
  pageName: 'webpack-sourcemaps-sample',
  traceNavigations: true,
  traceInteractions: true,
  propagateTrace: true,
  tracePropagationTargets: ['/api/'],
  // Same-origin detection base for trace propagation. Set explicitly (rather than relying on the
  // `location.origin` default) so the option is exercised; guarded because this module is evaluated
  // at import time and `location` does not exist outside a browser.
  ...(typeof location !== 'undefined' ? { tracePropagationOrigin: location.origin } : {}),

  onError: reportInternalError,
  // Wire-depth verification (PLAN §4/§6.6): forwards every SDK call to real staging verbatim while
  // recording a parsed copy locally, so scripts/verify.mjs can assert on the ACTUAL bundle contents
  // (redaction, labels, dedupe) instead of only on the scenario panel's own filter-callback log — see
  // src/bugsee-transport.ts and FINDINGS.md. Dev/test builds only (IS_PRODUCTION guard above) — a
  // `pnpm build` production bundle gets the SDK's own default transport, untouched.
  ...(IS_PRODUCTION ? {} : { transport: createTeeTransport() }),
};

// Exposed for scripts/verify.mjs (Playwright `page.evaluate`) — the tee transport's recorded bundle
// summaries are otherwise invisible from outside the page. Dev/test builds only — see IS_PRODUCTION.
declare global {
  interface Window {
    __bugseeTee?: {
      getCapturedBundles: typeof getCapturedBundles;
      clearCapturedCalls: typeof clearCapturedCalls;
      /** S11 — decode one uploaded bundle's `replay.bin` on demand (see `ReplayDigest`). */
      getReplayDigest: typeof getReplayDigest;
    };
  }
}
if (typeof window !== 'undefined' && !IS_PRODUCTION) {
  window.__bugseeTee = { getCapturedBundles, clearCapturedCalls, getReplayDigest };
}

/**
 * S1: the CALLER-supplied options for the "relaunch minimal" control — deliberately empty, so anything
 * the sample does not itself have to pin stays at its SDK default.
 *
 * Corrected in fix round 4 (R4-6): this used to read "nothing but the token", which is not what runs.
 * `relaunch()` below always spreads `endpoint`, `appId`, `appVersion`, `appBuild` and `onError` BEFORE
 * the caller's options, and `doLaunch` adds `carrier` — so this control launches with SIX options set,
 * not zero. Pinning `endpoint` is not optional: a bare `launch(token, {})` would post to the PRODUCTION
 * collector, which the sample plan forbids.
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
  client.setAttribute('sample', 'webpack-sourcemaps');
  return client;
}

/** The current launched client, or undefined before `launchApp()` runs. */
export function getClient(): Bugsee | undefined {
  return client;
}

/**
 * S1: call `launch()` again on the SAME carrier the app already launched on. Per the design contract
 * this must be IGNORED (return the existing client, not build a second one).
 */
export function attemptDuplicateLaunch(): { sameInstance: boolean } {
  const before = client;
  const again = doLaunch({ endpoint: ENDPOINT }, carrier);
  return { sameInstance: again === before };
}

/**
 * Relaunch the SDK against the SAME (global) carrier with a new option set — used by the Scenario
 * panel to exercise option combinations that can only be observed by rebuilding the client. Stops the
 * current client first so the two clients never race on the same storage/network resources.
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
      appId: 'com.bugsee.sample.webpack-sourcemaps',
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
