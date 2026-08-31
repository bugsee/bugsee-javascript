// Bugsee wiring for the Metrics Ingest API. Single-install re-export: everything (launch, manual-API
// types) is imported from @bugsee/fastify itself — see packages/fastify/src/index.ts — so this file
// never imports @bugsee/bugsee directly. The one exception is @bugsee/node, added as a direct
// dependency purely to reach RequestContextStoreToken for the per-request-attribute concurrency
// scenario (S2 + the framework-adapter concurrency contract) — @bugsee/fastify does not re-export that
// token.
import { type RequestContextStore, RequestContextStoreToken } from '@bugsee/node';
import { type Bugsee, launch } from '@bugsee/fastify';
import { createTeeTransport } from './bugsee-transport';

export const APP_VERSION = '1.0.0';
export const APP_BUILD = process.env.APP_BUILD ?? '1';
export const SAMPLE_USER = 'sample-user@bugsee.dev';

let primaryClient: Bugsee | undefined;

/**
 * Launches the primary Bugsee client for the Metrics Ingest API process. Exercises every relevant
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
    // scripts/crash-child.ts (spawned from scripts/verify.ts) and scenarios.md S5.
    detectCrashes: true,
    exitOnUncaught: false,
    unhandledRejections: 'warn',

    // Hang / ANR detection — a real BugseeLaunchOptions field, free to exercise here too
    // (node-service is the deep-dive sample for this per PLAN §5.13).
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
    tracePropagationTargets: [`127.0.0.1:${process.env.THIRD_PARTY_PORT ?? '5405'}`], // narrow on purpose: see verify.ts's exclude control
    traceResponse: { serverTiming: true, traceresponse: true, exposeTraceresponse: true },

    // Performance/APM: on by default via the umbrella. A short flush interval so `pnpm verify` doesn't
    // have to wait out the 30s production default to see a transaction on the wire.
    performanceMonitoring: true,
    performanceSampleRate: 1,
    performanceFlushIntervalMs: 2000,

    // Incoming-server auto-instrumentation — ON here (the default/coexistence path, first-owner-wins
    // vs setupFastify's own hooks — see FINDINGS.md / scenarios.md S14). The
    // `instrumentIncomingRequests: false` "adapter alone" path CANNOT be exercised by a second client in
    // THIS process — the node:http patch is process-wide (see scripts/adapter-alone-child.ts's own
    // comment) — so it runs in a separate disposable child process instead.
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
