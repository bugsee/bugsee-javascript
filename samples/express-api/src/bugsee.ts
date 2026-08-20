// Bugsee wiring for the Task API. Single-install re-export: everything (launch, manual-API types) is
// imported from @bugsee/express itself — see packages/express/src/index.ts — so this file never
// imports @bugsee/bugsee directly. The one exception is @bugsee/node, added as a direct dependency
// purely to reach RequestContextStoreToken for the per-request-attribute concurrency scenario (S2 +
// the framework-adapter concurrency contract) — @bugsee/express does not re-export that token.
import { type RequestContextStore, RequestContextStoreToken } from '@bugsee/node';
import { type Bugsee, launch } from '@bugsee/express';
import { createTeeTransport } from './bugsee-transport';

export const APP_VERSION = '1.0.0';
export const APP_BUILD = process.env.APP_BUILD ?? '1';
export const SAMPLE_USER = 'sample-user@bugsee.dev';

let primaryClient: Bugsee | undefined;

/**
 * Launches the primary Bugsee client for the Task API process. Exercises every relevant
 * BugseeLaunchOptions field (docs/samples/PLAN.md §5.14-5.20 + the shared catalog S1).
 */
export function launchPrimary(): Bugsee {
  if (primaryClient !== undefined) return primaryClient;

  const endpoint = process.env.BUGSEE_ENDPOINT ?? 'https://apidev.bugsee.com';
  const appToken = process.env.BUGSEE_APP_TOKEN;
  if (appToken === undefined || appToken.length === 0) {
    throw new Error('BUGSEE_APP_TOKEN is not set — copy .env.example to .env and fill it in');
  }

  const client = launch(appToken, {
    endpoint,
    // F-1 WORKAROUND (see FINDINGS.md): the real package version is '0.0.0' (every workspace package
    // is unversioned pre-publish — see samples/FINDINGS.md F-X2), and staging REJECTS that as
    // "no longer supported". Any other version passes the version gate; the x-client-type rewrite in
    // bugsee-transport.ts handles the SECOND blocker that surfaces once this one is out of the way.
    sdkVersion: '1.0.0',
    appVersion: APP_VERSION,
    appBuild: APP_BUILD,

    // Manual telemetry / capture sources — all on so the whole catalog is exercised.
    captureLogs: true,
    captureNetwork: true,
    captureNetworkBodies: true,
    maxNetworkBodySize: 4096, // small on purpose — /scenarios/s7/large-body exceeds it
    captureNetworkBodyWithoutType: true,
    captureSystemTraces: true,
    captureSystemEvents: true,

    // Crash detection: kept survivable so the long-running verify server doesn't die mid-sweep.
    // exitOnUncaught:true is instead exercised in a disposable CHILD PROCESS — see
    // scripts/verify.ts (crashChildProcess) and scenarios.md S5.
    detectCrashes: true,
    exitOnUncaught: false,
    unhandledRejections: 'warn',

    // Hang / ANR detection (node-service is the primary sample for this; wired here too since it's a
    // real BugseeLaunchOptions field and free to exercise).
    detectHangs: true,
    hangFairMs: 500,
    hangMediumMs: 1500,
    hangSevereMs: 3000,

    // CPU profiling — attached to incident bundles.
    profiling: true,
    profilingSamplingIntervalMicros: 500,

    // Rolling capture buffer.
    maxRecordingTime: 60,
    maxDataSize: 20,
    capturedDataStore: 'disk',
    captureWriter: 'inline',
    recover: true,

    // Distributed tracing (S10 + the outbound-call scenarios).
    propagateTrace: true,
    tracePropagationTargets: [`127.0.0.1:${process.env.THIRD_PARTY_PORT ?? '5305'}`, /127\.0\.0\.1/],
    traceResponse: { serverTiming: true, traceresponse: true, exposeTraceresponse: true },

    // Performance/APM: on by default via the umbrella. A short flush interval so `pnpm verify` doesn't
    // have to wait out the 30s production default to see a transaction on the wire.
    performanceMonitoring: true,
    performanceSampleRate: 1,
    performanceFlushIntervalMs: 2000,

    // Incoming-server auto-instrumentation — ON here (the default/coexistence path); the
    // `instrumentIncomingRequests: false` "adapter alone" path is exercised by the secondary client
    // in bugsee-secondary.ts, mounted at /alt/*.
    instrumentIncomingRequests: true,

    shutdownTimeoutMs: 3000,
    onError: (error) => {
      // eslint-disable-next-line no-console
      console.error('[bugsee onError]', error);
    },

    // The tee transport: real delivery to staging, plus a local record for wire-level verification.
    transport: createTeeTransport() as never,
  });

  client.setUserIdentifier(SAMPLE_USER);
  primaryClient = client;
  return client;
}

export function getPrimaryClient(): Bugsee | undefined {
  return primaryClient;
}

export function requestContextStoreOf(client: Bugsee): RequestContextStore | undefined {
  return (
    client.getServiceProvider(RequestContextStoreToken).getImmediate({ optional: true }) ??
    undefined
  );
}
