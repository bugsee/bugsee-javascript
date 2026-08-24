// pnpm verify — boots the Task API, drives every /scenarios/* route over HTTP, drives the two
// disposable crash-child processes (exitOnUncaught / unhandledRejections modes, which can't run inside
// the long-lived server), flushes, and prints a LOCAL + WIRE pass/fail table.
//
// This script does NOT talk to the Bugsee staging MCP server (only the agent session has those tools).
// It writes data/verify-run.json with the run marker + every scenario outcome, which is what the agent
// cross-references against `list_issues`/`get_issue` afterwards to fill in the BACKEND verification
// depth recorded in scenarios.md.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = process.env.PORT ?? '5304';
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_MARKER = `run-${Date.now().toString(36)}`;

interface Result {
  id: string;
  method: string;
  path: string;
  status: number;
  expected: number | number[];
  ok: boolean;
  note?: string;
  body?: unknown;
}

const results: Result[] = [];

function expectOk(status: number, expected: number | number[]): boolean {
  return Array.isArray(expected) ? expected.includes(status) : status === expected;
}

/**
 * Default client-side budget for one scenario route. Deliberately generous: these routes talk to REAL
 * staging, not a mock.
 *
 * A route that asks the SDK to do timed work must be given MORE than the time it asks for — see the
 * `timeoutMs` override at the S1.flush call site. This used to be a flat 10s for every route while
 * S1.flush requested a 15s flush, so the client aborted five seconds before the server could
 * legitimately answer, and the resulting failure was indistinguishable from a real flush defect.
 */
const DEFAULT_HIT_TIMEOUT_MS = 10_000;

async function hit(
  id: string,
  method: string,
  path: string,
  expected: number | number[] = 200,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_HIT_TIMEOUT_MS,
): Promise<Result> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}marker=${RUN_MARKER}`;
  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs), ...init });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const r: Result = { id, method, path, status: res.status, expected, ok: expectOk(res.status, expected), body };
    results.push(r);
    return r;
  } catch (err) {
    const r: Result = {
      id,
      method,
      path,
      status: -1,
      expected,
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    };
    results.push(r);
    return r;
  }
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('server did not become healthy in time');
}

function runChild(scriptRelPath: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'tsx', scriptRelPath, ...args], { cwd: ROOT });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

async function main(): Promise<void> {
  console.log(`== pnpm verify (marker=${RUN_MARKER}) ==`);

  console.log('starting server...');
  const server = spawn('pnpm', ['exec', 'tsx', 'src/server.ts'], { cwd: ROOT, stdio: 'inherit' });
  server.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`server exited early with code ${code}`);
  });

  // Captured mid-run, written to the artifact at the very end so the artifact can carry the wire
  // checks and the crash-child checks as well — both of which run after this snapshot is taken.
  let wireSnapshot: { bundleCount: number; transactions: unknown } = {
    bundleCount: 0,
    transactions: [],
  };

  try {
    await waitForHealth(20_000);
    console.log('server healthy.\n');

    // ---- Real API smoke (not a scenario id, but proves the app is real) ----
    const auth = { headers: { authorization: 'Bearer task-api-dev-token' } };
    await hit('api.no-auth', 'GET', '/projects', 401);
    await hit('api.bad-auth', 'GET', '/projects', 403, {
      headers: { authorization: 'Bearer wrong' },
    });
    const createProject = await hit('api.create-project', 'POST', '/projects', 201, {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Verify project' }),
    });
    const projectId = (createProject.body as { id?: string } | undefined)?.id;
    await hit('api.validation-4xx', 'POST', '/projects', 400, {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (projectId !== undefined) {
      await hit('api.create-task', 'POST', `/projects/${projectId}/tasks`, 201, {
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Verify task' }),
      });
      await hit('api.get-project', 'GET', `/projects/${projectId}`, 200, auth);
      await hit('api.pagination', 'GET', `/projects?page=1&pageSize=1`, 200, auth);
      await hit('api.not-found', 'GET', `/projects/does-not-exist`, 404, auth);
    }

    // ---- S1 Launch & lifecycle ----
    await hit('S1.status', 'GET', '/scenarios/s1/status');
    await hit('S1.relaunch-noop', 'POST', '/scenarios/s1/relaunch-noop');

    // ---- S2 Identity & attributes ----
    await hit('S2.identity-attributes', 'POST', '/scenarios/s2/identity-attributes');
    await hit('S2.clear-attributes', 'POST', '/scenarios/s2/clear-attributes');

    // ---- S3 Manual telemetry ----
    await hit('S3.telemetry', 'POST', '/scenarios/s3/telemetry');

    // ---- S4 Exceptions ----
    await hit('S4.error-instance', 'POST', '/scenarios/s4/error-instance');
    await hit('S4.non-error', 'POST', '/scenarios/s4/non-error');
    await hit('S4.cause', 'POST', '/scenarios/s4/cause');
    await hit('S4.options', 'POST', '/scenarios/s4/options');
    await hit('S4.dedupe', 'POST', '/scenarios/s4/dedupe');
    // S4.storm runs LAST — see below. It fires 200 exceptions at once and the SDK's capture rate
    // limiter admits 100 per 60s, by design, so a storm in the MIDDLE of the sweep spends the whole
    // window's budget and starves every scenario that follows it. That is the SDK protecting itself
    // correctly; it was this harness measuring inside a window it had already spent.

    // ---- S5 Crashes (in-request) ----
    await hit('S5.route-throw', 'GET', '/scenarios/s5/route-throw', 500);
    await hit('S5.middleware-throw', 'GET', '/scenarios/s5/middleware-throw', 500);
    await hit('S5.async-throw', 'GET', '/scenarios/s5/async-throw', 500);
    await hit('S5.timeout-throw', 'POST', '/scenarios/s5/timeout-throw', 202);
    await hit('S5.unhandled-rejection', 'POST', '/scenarios/s5/unhandled-rejection', 202);

    // ---- S6 Console capture ----
    await hit('S6.console', 'POST', '/scenarios/s6/console');

    // ---- S7 Network capture ----
    await hit('S7.fetch-get', 'GET', '/scenarios/s7/fetch-get');
    await hit('S7.fetch-post-json', 'POST', '/scenarios/s7/fetch-post-json');
    await hit('S7.fetch-post-text', 'POST', '/scenarios/s7/fetch-post-text');
    await hit('S7.4xx', 'GET', '/scenarios/s7/4xx');
    await hit('S7.5xx', 'GET', '/scenarios/s7/5xx');
    await hit('S7.connection-failure', 'GET', '/scenarios/s7/connection-failure');
    await hit('S7.large-body', 'GET', '/scenarios/s7/large-body');
    await hit('S7.no-content-type', 'GET', '/scenarios/s7/no-content-type');

    // ---- S8 Filters & redaction ----
    await hit('S8.log-redaction', 'POST', '/scenarios/s8/log-redaction');
    await hit('S8.breadcrumb-drop', 'POST', '/scenarios/s8/breadcrumb-drop');
    await hit('S8.report-mutate', 'POST', '/scenarios/s8/report-mutate');
    await hit('S8.report-veto', 'POST', '/scenarios/s8/report-veto');
    await hit('S8.network-filter', 'POST', '/scenarios/s8/network-filter');

    // ---- S9 Performance / APM ----
    await hit('S9.manual-span', 'POST', '/scenarios/s9/manual-span');
    await hit('S9.route-name', 'POST', '/scenarios/s9/route-name');

    // ---- S10 Distributed tracing ----
    await hit('S10.outbound-trace', 'GET', '/scenarios/s10/outbound-trace');

    // ---- S12 Persistence info (manual repro documented in scenarios.md) ----
    await hit('S12.info', 'GET', '/scenarios/s12/info');

    // ---- route naming (nested router regression check) ----
    await hit('route-naming.flat', 'GET', '/scenarios/route-naming/proj1/tasks/task1');
    if (projectId !== undefined) {
      await hit('route-naming.nested-list', 'GET', `/projects/${projectId}/tasks`, 200, auth);
    }

    // ---- 4xx must NOT report / 5xx MUST ----
    await hit('status.4xx-not-reported', 'GET', '/scenarios/status/4xx', 400);
    await hit('status.5xx-reported', 'GET', '/scenarios/status/5xx-thrown', 500);

    // ---- adapter-alone (instrumentIncomingRequests:false) + manual middleware halves ----
    await hit('alt.status', 'GET', '/scenarios/alt-status');
    await hit('alt.route-status', 'GET', '/scenarios/alt/status');
    await hit('alt.route-naming', 'GET', '/scenarios/alt/projects/p1/tasks/t1');
    await hit('alt.throw', 'GET', '/scenarios/alt/throw', 500);
    await hit('alt.throw-async', 'GET', '/scenarios/alt/throw-async', 500);

    // ---- concurrency: 50 overlapping requests, each with a distinct per-request attribute ----
    console.log('\nfiring 50 concurrent requests...');
    const concurrencyIndexes = Array.from({ length: 50 }, (_, i) => i);
    const concurrencyResults = await Promise.all(
      concurrencyIndexes.map((i) =>
        hit(
          `concurrency.${i}`,
          'GET',
          `/scenarios/concurrency/hit?idx=${i}&delayMs=${(49 - i) % 40}`,
          500,
        ),
      ),
    );
    const concurrencyOk = concurrencyResults.every((r) => r.ok);
    console.log(`concurrency sweep: ${concurrencyResults.filter((r) => r.ok).length}/50 returned 500 as expected`);
    results.push({
      id: 'concurrency.summary',
      method: 'GET',
      path: '/scenarios/concurrency/hit (x50)',
      status: concurrencyOk ? 500 : -1,
      expected: 500,
      ok: concurrencyOk,
    });

    // ---- S4 storm, last: it deliberately spends the rate-limit window (see above) ----
    await hit('S4.storm', 'POST', '/scenarios/s4/storm');

    // ---- flush + let the async pipeline drain ----
    // The S4 storm alone enqueues 200 real uploads; the durable pipeline caps concurrency at 4
    // in-flight operations (packages/core/src/upload-pipeline.ts bufferSize), so draining the whole
    // sweep's backlog against the REAL staging endpoint takes real wall-clock time. Poll the local
    // bundle-count instead of a fixed sleep: wait until it stops growing (drained) or a hard cap.
    // The client budget must EXCEED the flush the route is being asked to perform, with headroom for
    // the request itself — otherwise a flush that is working correctly still reads as a failure.
    const FLUSH_TIMEOUT_MS = 15_000;
    await hit(
      'S1.flush',
      'POST',
      '/scenarios/s1/flush',
      200,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeoutMs: FLUSH_TIMEOUT_MS }),
      },
      FLUSH_TIMEOUT_MS + 5_000,
    );
    console.log('\ndraining the upload backlog against the real staging endpoint...');
    let lastCount = -1;
    let stableTicks = 0;
    const drainDeadline = Date.now() + 150_000;
    while (Date.now() < drainDeadline && stableTicks < 3) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const r = await fetch(`${BASE}/scenarios/_debug/bundles`);
      const list = (await r.json()) as unknown[];
      console.log(`  bundles so far: ${list.length}`);
      stableTicks = list.length === lastCount ? stableTicks + 1 : 0;
      lastCount = list.length;
    }

    // ---- wire-level debug snapshot ----
    const bundlesRes = await fetch(`${BASE}/scenarios/_debug/bundles`);
    const bundles = (await bundlesRes.json()) as Array<{
      bundle?: { request?: Record<string, unknown>; attrs?: Record<string, unknown> };
    }>;
    const transactionsRes = await fetch(`${BASE}/scenarios/_debug/transactions`);
    const transactions = await transactionsRes.json();
    // Held for the artifact, which is written at the END of the run — see the note at that write.
    wireSnapshot = { bundleCount: bundles.length, transactions };

    // ---- wire-only assertions on the tee'd bundles ----
    console.log('\n== wire-level checks (from the tee transport) ==');
    wireCheck(
      'S4.dedupe: same Error instance logged twice produces exactly ONE bundle',
      bundles.filter((b) => String(b.bundle?.request?.summary ?? '').includes(`s4-dedupe-${RUN_MARKER}`)).length === 1,
    );
    wireCheck(
      'S8.log-redaction: SECRET_LOG_VALUE never appears in an uploaded logs.json',
      !bundles.some((b) =>
        (b as { bundle?: { logMessages?: string[] } }).bundle?.logMessages?.some((m) =>
          m.includes('SECRET_LOG_VALUE'),
        ),
      ),
    );
    wireCheck(
      'S8.report-veto: no bundle summary contains VETO_ME',
      !bundles.some((b) => String(b.bundle?.request?.summary ?? '').includes('VETO_ME')),
    );
    const mutated = bundles.find((b) =>
      String(b.bundle?.request?.summary ?? '').includes(`s8-report-mutate-${RUN_MARKER}`),
    );
    wireCheck(
      'S8.report-mutate: the report handler label was added',
      Array.isArray(mutated?.bundle?.request?.labels) &&
        (mutated?.bundle?.request?.labels as string[]).includes('mutated-by-report-handler'),
    );
    const s2Before = bundles.find((b) =>
      String(b.bundle?.request?.summary ?? '').includes(`s2-before-${RUN_MARKER}`),
    );
    wireCheck(
      'S2: attributes set before the event are present in manifest.attrs',
      s2Before?.bundle?.attrs?.str_attr === `hello-${RUN_MARKER}` && s2Before?.bundle?.attrs?.num_attr === 42,
    );
    const s2After = bundles.find((b) =>
      String(b.bundle?.request?.summary ?? '').includes(`s2-after-${RUN_MARKER}`),
    );
    wireCheck(
      'S2: attribute set AFTER the first event is present on a later event',
      s2After?.bundle?.attrs?.after_attr === `set-after-event-${RUN_MARKER}`,
    );

    const concurrencyBundles = bundles.filter((b) =>
      String(b.bundle?.request?.summary ?? '').includes(`concurrency-${RUN_MARKER}-`),
    );
    const concurrencyIsolated = concurrencyBundles.every((b) => {
      const summary = String(b.bundle?.request?.summary ?? '');
      const idx = summary.split('-').pop();
      return b.bundle?.attrs?.['scenario.req_index'] === idx;
    });
    wireCheck(
      `concurrency isolation: ${concurrencyBundles.length}/50 bundles arrived, each with its OWN req_index`,
      concurrencyBundles.length === 50 && concurrencyIsolated,
    );
    const contextIds = new Set(concurrencyBundles.map((b) => b.bundle?.request?.context_id));
    wireCheck('concurrency isolation: every bundle has a DISTINCT context_id', contextIds.size === concurrencyBundles.length);

    const routeNamingTxn = (transactions as Array<{ transactions?: Array<{ name: string }> }>)
      .flatMap((t) => t.transactions ?? [])
      .find((t) => t.name.includes(':taskId') || t.name === 'POST /' || t.name === 'GET /:taskId');
    console.log(
      routeNamingTxn !== undefined
        ? `[observed] a nested-router transaction name on the wire: "${routeNamingTxn.name}" — see FINDINGS.md`
        : '[note] no nested-router transaction observed this run',
    );
  } finally {
    console.log('\nstopping server...');
    server.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (!server.killed) server.kill('SIGKILL');
  }

  // ---- crash-child processes (exitOnUncaught / unhandledRejections — need a real process exit) ----
  console.log('\n== crash-child processes (exitOnUncaught / unhandledRejections) ==');
  const uncaughtExit = await runChild('scripts/crash-child.ts', ['uncaught-exit', RUN_MARKER]);
  wireCheck(
    'S5 exitOnUncaught:true — process exits non-zero after an uncaught exception',
    uncaughtExit.code !== 0 && uncaughtExit.code !== null,
  );
  const uncaughtNoExit = await runChild('scripts/crash-child.ts', ['uncaught-no-exit', RUN_MARKER]);
  wireCheck(
    'S5 exitOnUncaught:false — process reports the exception then stays alive (self-exits at code 7)',
    uncaughtNoExit.code === 7,
  );
  const rejectionWarn = await runChild('scripts/crash-child.ts', ['rejection-warn', RUN_MARKER]);
  wireCheck(
    "S5 unhandledRejections:'warn' — process survives the rejection and exits on its OWN timer (42)",
    rejectionWarn.code === 42,
  );

  // ---- print the table ----
  console.log('\n== pnpm verify — results ==');
  const width = Math.max(...results.map((r) => r.id.length)) + 2;
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL';
    console.log(
      `${status.padEnd(5)} ${r.id.padEnd(width)} ${r.method.padEnd(5)} ${r.path.padEnd(45)} ${r.status}${r.note !== undefined ? `  (${r.note})` : ''}`,
    );
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} local checks passed.`);
  if (failed.length > 0) {
    console.log('FAILED:', failed.map((f) => f.id).join(', '));
  }

  // This artifact is COMMITTED as the evidence trail for a run, so nothing credential-shaped may go
  // into it. The `_debug/transactions` records carry the SDK's own `requestHeaders`, and those include
  // `authorization: Bearer <session access token>` — a real, if short-lived, credential that was being
  // committed on every run. Headers are dropped entirely rather than pattern-redacted: nothing in the
  // wire checks reads them, so there is no reason to keep any of them.
  const withoutHeaders = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutHeaders);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'requestHeaders' && key !== 'responseHeaders')
        .map(([key, v]) => [key, withoutHeaders(v)]),
    );
  };

  // Written HERE, last, and not at the point the wire snapshot is taken. `wireCheck` appends to the
  // same `results` array the local checks use, and both the wire checks and the crash-child checks run
  // after that snapshot — so writing the artifact there recorded the local checks only. The agent
  // cross-references this file against `list_issues`/`get_issue` to fill in the BACKEND depth in
  // scenarios.md, which means a check missing from it is a check that silently never gets verified.
  writeFileSync(
    join(ROOT, 'data', 'verify-run.json'),
    JSON.stringify(
      {
        runMarker: RUN_MARKER,
        at: new Date().toISOString(),
        results,
        bundleCount: wireSnapshot.bundleCount,
        transactions: withoutHeaders(wireSnapshot.transactions),
      },
      null,
      2,
    ),
  );
  console.log(`\nrun marker: ${RUN_MARKER} (see data/verify-run.json)`);
}

function wireCheck(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  results.push({ id: `wire:${label}`, method: '-', path: '-', status: ok ? 1 : 0, expected: 1, ok });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
