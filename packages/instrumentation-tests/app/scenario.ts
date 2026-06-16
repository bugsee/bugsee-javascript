// The instrumentation battery the app runs under each real runtime. One scenario module, three runtime
// entries (entry-node/bun/deno) inject their own runtime's launch(). Everything here is plain portable
// JS the SDK's public surface drives — no fakes, no injected seams: a real process, real timers, a real
// outgoing fetch, real console output, the real V8 CPU profiler, and the real worker-thread hang
// watchdog. The only "mock" is the upload destination (the collector), exactly as a customer's backend
// would be the destination in production.
import type { Bugsee, BugseeLaunchOptions } from '@bugsee/node';

export type LaunchFn = (token: string, options?: BugseeLaunchOptions) => Bugsee;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Busy-block the main thread for ~ms so the event-loop watchdog observes a real hang. Named distinctively
 * (`e2eHangSpin`) and given real arithmetic self-work so the V8 CPU profiler samples THIS frame during the
 * stall — the e2e then asserts the AppHang bundle's profile contains it (the native-free "where is the main
 * thread stuck" stack). `acc` is kept observably live so the spin work is not optimized away.
 */
function e2eHangSpin(ms: number): void {
  const end = Date.now() + ms;
  let acc = 0;
  while (Date.now() < end) {
    acc += Math.sqrt(acc + 1);
  }
  if (acc < 0) {
    throw new Error('unreachable'); // keeps `acc` live (never thrown — acc is always >= 0)
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
  // The CPU profiler keeps sampling through the stall, so `e2eHangSpin` lands in the profile attached to it.
  e2eHangSpin(400);
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

/**
 * Incoming-server battery: launch with the default-on `instrumentIncomingRequests`, stand up a REAL
 * `node:http` server (works on node/bun/deno via their node:http compat — the slice-4 spikes proved the
 * emit patch fires on all three), hit it once with a real request, and report FROM the handler. The proof:
 * the node:http emit patch opens a per-request context for the in-flight request, so (a) the handler's log
 * line and (b) the handler-raised error report both carry the SAME request `context_id`. (The `http.server`
 * APM transaction needs the performance extension, which the umbrella wires and this bare-@bugsee/node
 * harness does not — that path is covered by the unit + per-adapter integration suites.) Exits 0.
 */
async function runServerScenario(launch: LaunchFn, collectorUrl: string): Promise<void> {
  const client = launch('e2e-app-token', {
    endpoint: collectorUrl,
    appVersion: '1.2.3',
    detectHangs: false,
    profiling: false,
    recover: false,
    onError: noteOnError,
    // instrumentIncomingRequests defaults to TRUE — the server below is auto-instrumented, no flag passed.
  });

  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    // Emitted INSIDE the handler → it runs in the request's run-scoped context, so this line is stamped
    // with the request's context_id (the end-to-end proof the emit patch opened the context).
    client.log(`handling ${req.method} ${req.url}`);
    // A report raised from the handler → an error bundle that merges the active context (same context_id).
    void client.logException(new Error('e2e server handler failure'));
    res.statusCode = 200;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  // A real incoming request the default-on emit patch brackets with a per-request context.
  const res = await fetch(`http://127.0.0.1:${port}/orders/42`);
  await res.text();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await client.flush(20_000);
  await client.stop(20_000);
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
  if (opts.scenario === 'server') {
    await runServerScenario(launch, opts.collectorUrl);
    return;
  }
  await runMainScenario(launch, opts.collectorUrl);
}
