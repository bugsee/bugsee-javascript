// The instrumentation battery the app runs under each real runtime. One scenario module, three runtime
// entries (entry-node/bun/deno) inject their own runtime's launch(). Everything here is plain portable
// JS the SDK's public surface drives — no fakes, no injected seams: a real process, real timers, a real
// outgoing fetch, real console output, the real V8 CPU profiler, and the real worker-thread hang
// watchdog. The only "mock" is the upload destination (the collector), exactly as a customer's backend
// would be the destination in production.
import type { Bugsee, BugseeLaunchOptions } from '@bugsee/node';

export type LaunchFn = (token: string, options?: BugseeLaunchOptions) => Bugsee;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Busy-block the main thread for ~ms so the event-loop watchdog observes a real hang. */
function blockEventLoop(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* deliberate spin to stall the loop */
  }
}

const noteOnError = (e: unknown): void => {
  // Surface SDK internal errors in the e2e process output (console is the standalone app's only sink).
  console.error('[bugsee onError]', e);
};

/**
 * Non-fatal battery: console logs, a captured outgoing request, a thrown-and-logged exception (an error
 * report bundle), a rolling CPU profile, and a deliberate event-loop hang (an AppHang report). Exits 0.
 */
async function runMainScenario(launch: LaunchFn, collectorUrl: string): Promise<void> {
  const client = launch('e2e-app-token', {
    endpoint: collectorUrl,
    appVersion: '1.2.3',
    appBuild: '42',
    profiling: true,
    profilingSamplingIntervalMicros: 1000,
    detectHangs: true,
    hangFairMs: 100,
    hangMediumMs: 5000,
    hangSevereMs: 10_000,
    recover: false, // in-memory store; no durable queue needed for the live path
    onError: noteOnError,
  });

  // Console → logs.json (the app deliberately logs so the console interceptor captures it).
  console.log('e2e log line: hello from the instrumented app');
  console.error('e2e error log line: something noteworthy');

  // A real outgoing request the network interceptor captures (not internal-tagged → recorded).
  const res = await fetch(`${collectorUrl}/echo?probe=instrumentation`);
  await res.text();

  // A logged exception → an error report bundle (drains the capture window: logs + network).
  await client.logException(new Error('e2e instrumented failure'));

  // A deliberate main-thread hang past the fair threshold → the worker watchdog fires an AppHang report.
  blockEventLoop(400);
  // Let the watchdog's queued message process on the (now-unblocked) loop and the report assemble.
  await sleep(700);

  // Generous flush/stop budgets: the AppHang report's assembly snapshots the real CPU profiler and the
  // upload pipeline's first retry backoff is ~5s — under CPU-contended CI a tighter budget could time out
  // before the (already-submitted) hang bundle is delivered. The budgets are ceilings, not waits, so the
  // happy path is unaffected.
  await client.flush(20_000);
  await client.stop(20_000);
}

/**
 * Crash battery: arm the SDK, then throw asynchronously so it surfaces as a real `uncaughtException`.
 * The SDK's crash handler flushes the crash report then `process.exit(1)` — so this run exits non-zero
 * by design, and the collector must have captured the crash bundle before exit.
 */
async function runCrashScenario(launch: LaunchFn, collectorUrl: string): Promise<void> {
  launch('e2e-app-token', {
    endpoint: collectorUrl,
    appVersion: '1.2.3',
    detectHangs: false,
    profiling: false,
    recover: false,
    exitOnUncaught: true,
    shutdownTimeoutMs: 5000,
    onError: noteOnError,
  });

  console.log('e2e crash scenario armed'); // marks the run in the e2e output
  // Async throw → uncaughtException (a synchronous top-level throw would be a module-eval error instead).
  setTimeout(() => {
    throw new Error('e2e uncaught crash');
  }, 20);

  // Stay alive until the crash fires, the SDK flushes the crash bundle, and it calls process.exit(1).
  await sleep(10_000);
}

/** Dispatch by the BUGSEE_E2E_SCENARIO the runner sets when spawning. */
export async function runScenario(
  launch: LaunchFn,
  opts: { collectorUrl: string; scenario: string },
): Promise<void> {
  if (opts.scenario === 'crash') {
    await runCrashScenario(launch, opts.collectorUrl);
    return;
  }
  await runMainScenario(launch, opts.collectorUrl);
}
