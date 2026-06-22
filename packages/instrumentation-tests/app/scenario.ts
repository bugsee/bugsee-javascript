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

/**
 * Multi-instance recovery battery (two phases over a SHARED dataDir, one process each):
 *   seed    — a DOOMED instance persists an incident to the shared dataDir, then dies (process.exit) WITHOUT
 *             delivering it — its endpoint is unreachable, so the durable bundle stays in its own subtree's
 *             pending/ queue and its pid is now gone.
 *   recover — a FRESH instance launches on the SAME dataDir; its coordinator finds the dead sibling subtree
 *             (dead pid), recovers its persisted bundle, and delivers it to the real collector.
 * Proves cross-PROCESS recovery end-to-end with the real liveness gate, on each runtime.
 */
async function runMultiInstanceScenario(launch: LaunchFn, collectorUrl: string): Promise<void> {
  const dataDir = process.env.BUGSEE_E2E_DATADIR ?? '';
  if (process.env.BUGSEE_E2E_PHASE === 'seed') {
    const client = launch('e2e-app-token', {
      endpoint: 'http://127.0.0.1:1', // unreachable → the upload fails, the bundle stays persisted
      dataDir,
      detectHangs: false,
      profiling: false,
      recover: true,
      onError: noteOnError,
    });
    await client.logException(new Error('e2e multi-instance incident'));
    await client.flush(2000); // assembly+persist complete; the upload fails (unreachable) — bundle kept
    process.exit(1); // die — this instance's pid is now gone (a dead sibling for the recoverer)
    return;
  }
  const client = launch('e2e-app-token', {
    endpoint: collectorUrl,
    dataDir,
    detectHangs: false,
    profiling: false,
    recover: true,
    onError: noteOnError,
  });
  await sleep(3000); // let the fire-and-forget sibling-recovery scan + enqueue the recovered bundle (generous
  // so slow CI doesn't race the flush; recovery of one small bundle is normally well under this)
  await client.flush(10_000); // deliver it
  await client.stop(3000);
}

/**
 * Disk-capture recovery battery (server write-path P1: "a crash loses nothing"). Unlike multi-instance
 * (which recovers an already-ASSEMBLED+persisted bundle), this proves the MARKER path: an incident that
 * died BEFORE its bundle was assembled is rebuilt next launch from the durable on-disk CAPTURE chunks.
 *   seed    — launch with the DEFAULT on-disk capture, log a distinctive breadcrumb, fire an incident (its
 *             marker is written synchronously), then `process.exit` IMMEDIATELY — no graceful flush, so only
 *             the marker + the capture chunks survive (the 'exit' hook persists the buffered chunk). No
 *             bundle is assembled, and the endpoint is unreachable, so nothing delivers live.
 *   recover — a FRESH instance on the SAME dataDir rebuilds the dead sibling's incident bundle from its
 *             marker + capture chunks and delivers it; the bundle's logs.json carries the seed's breadcrumb,
 *             proving the pre-crash capture survived on disk and was recovered.
 */
async function runDiskRecoveryScenario(launch: LaunchFn, collectorUrl: string): Promise<void> {
  const dataDir = process.env.BUGSEE_E2E_DATADIR ?? '';
  if (process.env.BUGSEE_E2E_PHASE === 'seed') {
    const client = launch('e2e-app-token', {
      endpoint: 'http://127.0.0.1:1', // unreachable → nothing is delivered live
      dataDir, // shared on-disk root; capturedDataStore defaults to 'disk'
      detectHangs: false,
      profiling: false,
      recover: true, // arms the marker store + recovery
      exitOnUncaught: false,
      onError: noteOnError,
    });
    console.log('e2e disk-recovery breadcrumb 7f3a'); // must survive on disk → reappear in the recovered bundle
    await sleep(150); // let the console→log capture append the breadcrumb to the disk chunk
    // Fire an incident: the marker is written SYNCHRONOUSLY here. Then die at once WITHOUT assembling the
    // bundle — only the marker + the on-disk chunks remain (the marker-recovery path must rebuild from them).
    void client.logException(new Error('e2e disk-recovery incident'));
    process.exit(0);
    return;
  }
  const client = launch('e2e-app-token', {
    endpoint: collectorUrl,
    dataDir,
    detectHangs: false,
    profiling: false,
    recover: true,
    onError: noteOnError,
  });
  await sleep(3000); // let the fire-and-forget recovery scan rebuild + enqueue the recovered bundle
  await client.flush(10_000); // deliver it
  await client.stop(3000);
}

/**
 * Off-thread capture-writer battery (server write-path Phase 2 — the INSURANCE path). Boot with
 * `captureWriter: 'worker'` so the rolling capture is drained to disk by a REAL worker_threads worker over
 * the shared zero-copy SAB ring — exercising, on each runtime, the worker_threads spawn + the `Atomics`
 * flush-and-ack handshake + the SharedArrayBuffer ring + the worker-owns-the-fds design. A burst of logs
 * drives the ring under real throughput (the worker drains concurrently while the main thread keeps
 * producing); the error report then drains the capture window, which reads the OFF-THREAD-written chunks
 * back off disk — so the delivered bundle's logs.json + network.json are the end-to-end proof that the
 * off-thread path produces correct bundles on the runtime. (If a runtime lacked worker_threads the writer
 * would degrade to the on-thread drainer and still be correct — but node/bun/deno all have it.) Exits 0.
 */
async function runWorkerWriterScenario(launch: LaunchFn, collectorUrl: string): Promise<void> {
  const dataDir = process.env.BUGSEE_E2E_DATADIR ?? '';
  const client = launch('e2e-app-token', {
    endpoint: collectorUrl,
    appVersion: '1.2.3',
    dataDir, // on-disk capture (capturedDataStore defaults to 'disk') → a ChunkStorage writer is used…
    captureWriter: (process.env.BUGSEE_E2E_WRITER as 'inline' | 'worker') || 'worker', // off-thread by default
    detectHangs: false,
    profiling: false,
    recover: false,
    onError: noteOnError,
  });

  // A distinctive breadcrumb that MUST survive the off-thread path, then a burst that exercises the ring
  // under real throughput (the producer keeps committing while the worker drains on its own thread).
  console.log('e2e worker-writer breadcrumb 9b2e');
  for (let i = 0; i < 100; i++) {
    console.log(`e2e worker-writer burst ${i}`);
  }

  // A real outgoing request → network.json, captured + written through the same off-thread path.
  const res = await fetch(`${collectorUrl}/echo?probe=worker`);
  await res.text();

  // An error report → drains the capture window: the bundle is rebuilt from the OFF-THREAD-written chunks
  // (the ring writer's read() flush-and-acks the worker first, so the snapshot sees everything on disk).
  await client.logException(new Error('e2e worker-writer failure'));

  await client.flush(20_000);
  await client.stop(20_000);
}

// A known upstream (frontend-like) trace context the test injects as the INBOUND request — so the assertions
// can check that the backend continued THIS exact trace and re-propagated it onward.
const INBOUND_TRACE = '0af7651916cd43dd8448eb211c80319c'; // 16-byte W3C trace id
const INBOUND_SPAN = 'b7ad6b7169203331'; // 8-byte upstream span id

/**
 * Cross-project distributed-tracing round-trip (cross-project-tracing.md X1–X5). One auto-instrumented
 * node:http backend, hit with an inbound `traceparent`+`tracestate` (the originator/frontend side). The
 * backend (a) CONTINUES that trace as a child, (b) makes an allowlisted OUTGOING call from the handler that
 * the propagation decorator stamps with the continued `traceparent` + `bugsee=` tracestate, and (c) reports
 * from the handler — whose request.json carries `trace_id` = the inbound trace (T8). The e2e then asserts the
 * SAME trace id flows: inbound → report → outbound. Exits 0.
 */
async function runPropagationScenario(launch: LaunchFn, collectorUrl: string): Promise<void> {
  const client = launch('e2e-app-token', {
    endpoint: collectorUrl,
    appVersion: '1.2.3',
    detectHangs: false,
    profiling: false,
    recover: false,
    propagateTrace: true,
    tracePropagationTargets: [collectorUrl], // allow injecting onto the collector's /echo (our "downstream")
    onError: noteOnError,
  });
  // Distributed tracing needs the performance extension (it mints the trace/span ids + the http.server txn).
  // The bare @bugsee/node harness omits it (the umbrella normally wires it), so wire it here for the e2e.
  const { createPerformanceExtension } = await import('@bugsee/performance');
  createPerformanceExtension().setup(
    client as unknown as Parameters<ReturnType<typeof createPerformanceExtension>['setup']>[0],
  );

  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    void (async () => {
      // Runs inside the request's continued-trace context. This outgoing call is decorated: the propagation
      // injects `traceparent` (continuing the inbound trace) + `bugsee=` onto it → the collector records them.
      const echo = await fetch(`${collectorUrl}/echo?probe=propagation`);
      await echo.text();
      // A report from the handler → request.json carries trace_id = the inbound trace (T8 + continuation).
      await client.logException(new Error('e2e propagation handler failure'));
      res.statusCode = 200;
      res.end('ok');
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  // The INBOUND request carries a known upstream W3C trace context (the originator/frontend).
  const res = await fetch(`http://127.0.0.1:${port}/orders/42`, {
    headers: {
      traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01`,
      tracestate: 'bugsee=r1:sfe-session',
    },
  });
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
  if (opts.scenario === 'multi-instance') {
    await runMultiInstanceScenario(launch, opts.collectorUrl);
    return;
  }
  if (opts.scenario === 'disk-recovery') {
    await runDiskRecoveryScenario(launch, opts.collectorUrl);
    return;
  }
  if (opts.scenario === 'worker') {
    await runWorkerWriterScenario(launch, opts.collectorUrl);
    return;
  }
  if (opts.scenario === 'propagation') {
    await runPropagationScenario(launch, opts.collectorUrl);
    return;
  }
  await runMainScenario(launch, opts.collectorUrl);
}
