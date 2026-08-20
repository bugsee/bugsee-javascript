import { launch, type Bugsee } from '@bugsee/vue';

// The composition root for Bugsee in this sample. Called once from src/main.ts, before the Vue app is
// created, so every capture source (console/network/crash detection) is live before the app does
// anything. Every BugseeLaunchOptions field that makes sense for a demo app is set explicitly (rather
// than left at the default) so the option itself is exercised (S1).
//
// A `?perf=0|1` query param lets the verify sweep exercise `performanceSampleRate` at both ends (S9)
// without a second running process — reading location.search here, before launch, is the whole trick.

const params = new URLSearchParams(window.location.search);
const perfSampleRateParam = params.get('perf');
const performanceSampleRate =
  perfSampleRateParam === '0' ? 0 : perfSampleRateParam === '1' ? 1 : undefined;
// `?minimal=1` exercises the "launch with the minimum options" leg of S1 — everything else in this file
// exercises "launch with every option set".
const minimalLaunch = params.get('minimal') === '1';

export const SAMPLE_USER_ID = 'vue-spa-sample-user';
// A fresh value per page load — every manual scenario stamps this into a label/breadcrumb/attribute so
// a run can be told apart from a previous one when polling the backend (see scripts/verify.mts and
// src/views/Scenarios.vue).
export const RUN_ID = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let client: Bugsee | undefined;

export function launchBugsee(): Bugsee {
  if (client) return client;

  if (minimalLaunch) {
    client = launch(import.meta.env.VITE_BUGSEE_APP_TOKEN as string, {
      endpoint: import.meta.env.VITE_BUGSEE_ENDPOINT as string,
    });
    client.setUserIdentifier(SAMPLE_USER_ID);
    client.setAttribute('sample', 'vue-spa');
    client.setAttribute('runId', RUN_ID);
    client.setAttribute('launchMode', 'minimal');
    return client;
  }

  client = launch(import.meta.env.VITE_BUGSEE_APP_TOKEN as string, {
    endpoint: import.meta.env.VITE_BUGSEE_ENDPOINT as string,
    // WORKAROUND for FINDINGS.md F-4 (blocker): @bugsee/browser hardcodes SDK_VERSION = '0.0.0'
    // (packages/browser/src/launch.ts:79 — the same repo-wide unpublished-version gap as
    // samples/FINDINGS.md F-X2), and the staging collector rejects sdk.version "0.0.0" outright with
    // `UnsupportedSdkError: SDK version is no longer supported`, before any session is even created.
    // Overriding the injectable `sdkVersion` option is the only way past it from a sample.
    sdkVersion: '9.9.9',
    appVersion: '1.0.0',
    appBuild: String(import.meta.env.VITE_BUGSEE_APP_BUILD ?? '1'),

    // Capture sources — every one stated explicitly (S1: "every option set").
    captureLogs: true,
    captureNetwork: true,
    captureNetworkBodies: true,
    maxNetworkBodySize: 20_480,
    captureNetworkBodyWithoutType: false,
    captureSystemTraces: true,
    captureSystemEvents: true,
    captureInteractions: true,
    captureViewHierarchy: true,
    detectCrashes: true,

    // Session replay is FORCED OFF — see samples/vue-spa/FINDINGS.md F-1 (blocker): @bugsee/replay and
    // @bugsee/replay-canvas are packaged without publishConfig.exports, so the installed tarballs are
    // missing files their own entry point imports. @bugsee/browser's dist unconditionally contains
    // `await import('@bugsee/replay')`, which crashes BOTH `vite dev` and `vite build` unless the two
    // packages are excluded/externalized (see vite.config.ts) — and even then, actually turning replay
    // on would hit the same broken module at runtime. S11 is therefore UNTESTABLE in this sample, not
    // merely undemonstrated.
    replay: false,

    maxRecordingTime: 60,
    maxDataSize: 10,
    persist: true,
    recover: true,
    onError: (error) => {
      // eslint-disable-next-line no-console
      console.error('[bugsee] internal error', error);
    },

    // Umbrella (performance) extension options — @bugsee/vue re-exports @bugsee/bugsee's launch(), which
    // wires @bugsee/performance on by default.
    performanceMonitoring: true,
    ...(performanceSampleRate !== undefined ? { performanceSampleRate } : {}),
    performanceFlushIntervalMs: 5_000,
    traceNavigations: true,
    traceInteractions: true,
  });

  client.setUserIdentifier(SAMPLE_USER_ID);
  client.setAttribute('sample', 'vue-spa');
  client.setAttribute('runId', RUN_ID);
  client.setAttribute('launchMode', 'full');

  return client;
}

export function getBugsee(): Bugsee {
  if (!client) throw new Error('Bugsee not launched yet — call launchBugsee() first');
  return client;
}

/**
 * S1: "a second launch() while launched must be ignored, not duplicated". Returns the SAME client
 * instance both times, and the SDK itself routes a warning to `onError` (see the launch() call above).
 */
export function attemptRelaunch(): Bugsee {
  return launchBugsee();
}
