// pnpm verify — boots the Metrics Ingest API, drives every /scenarios/* route (and the real API) over
// HTTP, drives the disposable crash-child and adapter-alone-child processes (behaviour that would kill
// or contaminate the long-lived server), flushes, and prints a LOCAL + WIRE pass/fail table.
//
// This script does NOT talk to the Bugsee staging MCP server (only the agent session has those tools).
// It writes data/verify-run.json with the run marker + every scenario outcome, which is what the agent
// cross-references against `list_issues`/`get_issue` afterwards to fill in the BACKEND verification
// depth recorded in scenarios.md.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = process.env.PORT ?? '5404';
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_MARKER = `run-${Date.now().toString(36)}`;

interface Result {
  id: string;
  method: string;
  path: string;
  status: number;
  expected: number | number[];
  ok: boolean;
  /** Wall-clock ms the route took, measured (not estimated). Recorded on BOTH paths — including an
   *  abort — so "this route needs a bigger budget" is a number in `data/verify-run.json`, not a guess.
   *  Budgets are still set from the work a route REQUESTS (see `hit`'s doc comment), never from these
   *  numbers, and for most rows this stays pure diagnostics.
   *
   *  THE RULE, deliberately stated WITHOUT a census of who currently obeys it. This comment has now
   *  gone stale twice — first claiming "nothing asserts on it", then claiming "TWO checks do, S1.flush
   *  and S4.dedupe, the latter measuring ~13-14s" — and both times it went stale in the very round
   *  that changed the checks it was describing (round 5 moved S1.flush's assertion onto the route's own
   *  `flushMs`; the dedupe route's own record has long since moved off 13-14s). A count and a timing
   *  cannot be kept true from here, so neither is recorded here any more.
   *
   *  What IS invariant: `ms` is this harness's clock for a WHOLE HTTP round trip, so it is only an
   *  UPPER bound on whatever the route did inside it. A check may assert on `ms` ONLY when no narrower
   *  measurement of the quantity it claims exists. The moment a route can measure the operation itself
   *  and return it (S1.flush's `flushMs` is the worked example), the check MUST read that field and not
   *  this one — otherwise delay landing anywhere else in the request satisfies the assertion. Every
   *  check that does assert on a duration carries its own justification, its own bound, and its own
   *  appended observation record at its own call site; that is the only place those numbers live. */
  ms: number;
  note?: string;
  body?: unknown;
}

const results: Result[] = [];

function expectOk(status: number, expected: number | number[]): boolean {
  return Array.isArray(expected) ? expected.includes(status) : status === expected;
}

/**
 * Default client-side budget for one scenario route. Generous: these routes talk to REAL staging, not
 * a mock. Any route that asks the SDK for TIMED work must be given a budget that EXCEEDS what it
 * requests — see samples/FINDINGS.md F-X19 for why a flat budget shorter than the requested work
 * reads a correctly-working flush as a failure. Two routes qualify and both pass their own budget
 * rather than this default: S1.flush (`FLUSH_TIMEOUT_MS + 5s`) and S4.dedupe (`DEDUPE_TIMEOUT_MS`,
 * one awaited report = at least two 30s-bounded transport calls, each retried up to 3x — see that
 * constant's own comment). Every other route only asks the app for work the SDK does off the response
 * path, and 10s is ample for those.
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
  const started = Date.now();
  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs), ...init });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const r: Result = {
      id,
      method,
      path,
      status: res.status,
      expected,
      ok: expectOk(res.status, expected),
      ms: Date.now() - started,
      body,
    };
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
      ms: Date.now() - started,
      note: err instanceof Error ? err.message : String(err),
    };
    results.push(r);
    return r;
  }
}

// Waits until the app is BOTH listening and Bugsee-launched. `/health` answers
// `{ok:true, isLaunched}` (src/server.ts:45-47) and that second field used to be ignored, so a run
// where `launch()` silently produced an unlaunched client would proceed anyway and fail later in a
// dozen confusing places instead of here, at the one point that can say why.
async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastBody: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        lastBody = await res.json();
        if ((lastBody as { isLaunched?: boolean } | undefined)?.isLaunched === true) return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `server did not become healthy AND Bugsee-launched in time (last /health body: ${JSON.stringify(lastBody)})`,
  );
}

function runChild(
  scriptRelPath: string,
  args: string[],
): Promise<{ code: number | null; stdout: string }> {
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

const auth = { headers: { authorization: 'Bearer metrics-api-dev-token' } };

async function main(): Promise<void> {
  console.log(`== pnpm verify (marker=${RUN_MARKER}) ==`);

  // scenarios.md's cross-cutting table claimed the file-backed store "survives a restart" and NOTHING
  // performed or asserted a restart — the claim rested on `src/store.ts`'s own header comment. It is
  // asserted here now, using the restart this sweep already performs: a series is written straight into
  // `data/db.json` BEFORE the server process exists, and the freshly started server (whose MetricsStore
  // hydrates from that file in its constructor) then has to serve it back through the real HTTP API.
  // Two points, not one, so the same check also proves the aggregation runs over data that came off
  // disk rather than out of memory. All of this lives in `scripts/verify.ts`, which is fingerprint-SAFE.
  const DB_PATH = join(ROOT, 'data', 'db.json');
  const RESTART_SERIES = `restart.${RUN_MARKER}`;
  const seedDb = (existsSync(DB_PATH)
    ? (JSON.parse(readFileSync(DB_PATH, 'utf8')) as { events?: unknown[] })
    : { events: [] }) as { events: unknown[] };
  seedDb.events = seedDb.events ?? [];
  seedDb.events.push(
    { id: `seed1-${RUN_MARKER}`, name: RESTART_SERIES, value: 7, tags: {}, createdAt: new Date().toISOString() },
    { id: `seed2-${RUN_MARKER}`, name: RESTART_SERIES, value: 11, tags: {}, createdAt: new Date().toISOString() },
  );
  // `data/` is a RUN ARTEFACT — gitignored, so a fresh clone does not have it. Before the restart seed
  // was added, the first writer of this path was `MetricsStore.save()` (src/store.ts:48), which creates
  // the directory itself; the seed moved the first write EARLIER than the server that used to create
  // it, so on a clean checkout `writeFileSync` threw ENOENT before `spawn` ever ran and `pnpm verify`
  // could not start at all. The seed therefore has to create the directory itself rather than inherit
  // it from a previous run. Verified by deleting `data/` and running the full sweep, not by reasoning.
  mkdirSync(dirname(DB_PATH), { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(seedDb, null, 2));

  console.log('starting server...');
  const server = spawn('pnpm', ['exec', 'tsx', 'src/server.ts'], { cwd: ROOT, stdio: 'inherit' });
  server.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`server exited early with code ${code}`);
  });

  let wireSnapshot: { bundleCount: number; transactions: unknown } = { bundleCount: 0, transactions: [] };

  try {
    await waitForHealth(20_000);
    console.log('server healthy.\n');

    // ---- Real API smoke (not a scenario id, but proves the app is real) ----
    await hit('api.no-auth', 'POST', '/api/v1/metrics', 401, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', value: 1 }),
    });
    await hit('api.bad-auth', 'POST', '/api/v1/metrics', 403, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', value: 1 }),
    });
    await hit('api.create-metric', 'POST', '/api/v1/metrics', 201, {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `latency.${RUN_MARKER}`, value: 42, tags: { region: 'eu' } }),
    });
    // A value above ALERT_THRESHOLD (90) makes the app call the third-party alert webhook for real —
    // exercises real network capture + outbound trace propagation as a side effect of genuine behaviour.
    const alerting = await hit('api.create-metric-alerting', 'POST', '/api/v1/metrics', 201, {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `latency.${RUN_MARKER}`, value: 99 }),
    });
    // The route answers `{event, alerted, traceparentSeen}` (src/plugins/metrics.ts:56-71) and both of
    // the interesting fields were going unread — only the hardcoded 201 was asserted — while
    // scenarios.md cited them ("alerted: true, traceparentSeen a valid W3C header — verified"). A 201
    // is returned whether or not the webhook call happened at all, so the outbound leg (real network
    // capture + real trace propagation as a side effect of genuine app behaviour, which is why this
    // row exists) had no coverage here.
    const alertingBody = alerting.body as
      | { alerted?: boolean; traceparentSeen?: string | null }
      | undefined;
    wireCheck(
      'api.create-metric-alerting: a value above ALERT_THRESHOLD really did dispatch the webhook (alerted: true)',
      alertingBody?.alerted === true,
    );
    wireCheck(
      `api.create-metric-alerting: the webhook saw a valid W3C traceparent (${alertingBody?.traceparentSeen})`,
      typeof alertingBody?.traceparentSeen === 'string' &&
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(alertingBody.traceparentSeen),
    );
    // A genuine Fastify SCHEMA validation failure (missing "value") — never thrown by our own code.
    // Fastify-specific: does this go through Bugsee's onError hook the same way a thrown error would?
    // See FINDINGS.md.
    await hit('api.validation-4xx', 'POST', '/api/v1/metrics', 400, {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `bad.${RUN_MARKER}` }),
    });
    // PAGINATION. scenarios.md's cross-cutting row is "**Pagination** + per-metric aggregation —
    // Local, verified", and round 6 closed only the aggregation half: this row asserted the hardcoded
    // 200 with no `page`/`pageSize` at all, so the envelope `{items,page,pageSize,total,totalPages}`
    // (src/plugins/metrics.ts:75-80, src/store.ts:69-79) was produced and read by nothing, and
    // `parsePagination`'s clamping (:37-41) was never exercised with a non-default value. Round 6
    // rejected exactly the "at Local depth a 200 suffices" reasoning for the aggregation half of this
    // same row, so it is rejected here too.
    //
    // The series is known EXACTLY — this run ingested 42 then 99 under `latency.<marker>`, in that
    // order, and nothing else writes that name — so every field of every page has one correct value.
    interface ListPage {
      items?: Array<{ name?: string; value?: number }>;
      page?: number;
      pageSize?: number;
      total?: number;
      totalPages?: number;
    }
    const apiList = await hit('api.list', 'GET', `/api/v1/metrics?name=latency.${RUN_MARKER}`, 200, auth);
    const listBody = apiList.body as ListPage | undefined;
    wireCheck(
      `api.list: the default page is the whole 2-point series, with the full envelope — got ${JSON.stringify(listBody)}`,
      listBody?.total === 2 &&
        listBody.page === 1 &&
        listBody.pageSize === 20 &&
        listBody.totalPages === 1 &&
        listBody.items?.length === 2 &&
        listBody.items[0]?.value === 42 &&
        listBody.items[1]?.value === 99,
    );
    // A NON-DEFAULT page: `pageSize=1` splits the same series in two, and page 2 must hold the SECOND
    // point (99). A `list()` regressed to ignore `page` — returning the first slice every time — reads
    // green on `total`/`totalPages` alone, so the item's own value is what discriminates.
    const apiListPage2 = await hit(
      'api.list-paged',
      'GET',
      `/api/v1/metrics?name=latency.${RUN_MARKER}&page=2&pageSize=1`,
      200,
      auth,
    );
    const page2Body = apiListPage2.body as ListPage | undefined;
    wireCheck(
      `api.list-paged: page 2 of pageSize 1 holds the SECOND point of the series and reports 2 pages — got ${JSON.stringify(page2Body)}`,
      page2Body?.page === 2 &&
        page2Body.pageSize === 1 &&
        page2Body.total === 2 &&
        page2Body.totalPages === 2 &&
        page2Body.items?.length === 1 &&
        page2Body.items[0]?.value === 99,
    );
    // `parsePagination`'s CLAMPING, both arms in one request (src/plugins/metrics.ts:37-41): an
    // over-large `pageSize` clamps to the 100 ceiling, and a `page=0` falls back to 1. Neither arm had
    // ever been exercised. `items` is not asserted here — the clamped page size (100) is larger than
    // this series, so the interesting answer is the echoed envelope, not its contents.
    const apiListClamped = await hit(
      'api.list-clamped',
      'GET',
      `/api/v1/metrics?name=latency.${RUN_MARKER}&page=0&pageSize=99999`,
      200,
      auth,
    );
    const clampedBody = apiListClamped.body as ListPage | undefined;
    wireCheck(
      `api.list-clamped: pageSize=99999 clamps to the 100 ceiling and page=0 falls back to 1 — got page=${clampedBody?.page}, pageSize=${clampedBody?.pageSize}`,
      clampedBody?.pageSize === 100 && clampedBody.page === 1 && clampedBody.total === 2,
    );
    // scenarios.md's cross-cutting table claimed "count/sum/avg/min/max correct for a known series" and
    // this row asserted the hardcoded 200 only — an aggregation regressing to `sum` for `avg`, or to a
    // count of the whole store, would have read green. The series IS known exactly: this run ingested
    // 42 and 99 under `latency.<marker>` above (nothing else writes that name), so every field has one
    // correct value and all five are asserted.
    const apiStats = await hit('api.stats', 'GET', `/api/v1/metrics/latency.${RUN_MARKER}/stats`, 200, auth);
    const statsBody = apiStats.body as
      | { count?: number; sum?: number; avg?: number; min?: number; max?: number }
      | undefined;
    wireCheck(
      `api.stats: count/sum/avg/min/max are all correct for this run's known 2-point series (42, 99) — got ${JSON.stringify(statsBody)}`,
      statsBody?.count === 2 &&
        statsBody.sum === 141 &&
        statsBody.avg === 70.5 &&
        statsBody.min === 42 &&
        statsBody.max === 99,
    );
    // The restart half of the file-backed-store claim (see the seed written before the server was
    // spawned): this series was on disk before the server process existed, so serving it correctly here
    // means the store hydrated it from `data/db.json` at boot.
    const restartStats = await hit(
      'api.stats-restart-survival',
      'GET',
      `/api/v1/metrics/${RESTART_SERIES}/stats`,
      200,
      auth,
    );
    const restartBody = restartStats.body as
      | { count?: number; sum?: number; min?: number; max?: number }
      | undefined;
    wireCheck(
      `store.restart-survival: a 2-point series written to data/db.json BEFORE this run's server process existed is served back by it (count/sum/min/max) — got ${JSON.stringify(restartBody)}`,
      restartBody?.count === 2 && restartBody.sum === 18 && restartBody.min === 7 && restartBody.max === 11,
    );
    // The write half, and the reason the restart check above is a restart rather than a fixture: what
    // THIS process's server ingested over HTTP must be on disk for the NEXT process to find. Read
    // straight off the file, not through the API, so an in-memory-only store fails it.
    const dbOnDisk = JSON.parse(readFileSync(DB_PATH, 'utf8')) as {
      events?: Array<{ name?: string; value?: number }>;
    };
    const ingestedOnDisk = (dbOnDisk.events ?? []).filter((e) => e.name === `latency.${RUN_MARKER}`);
    wireCheck(
      `store.write-through: both of this run's API-ingested events are in data/db.json on disk (${ingestedOnDisk.length} found)`,
      ingestedOnDisk.length === 2 &&
        ingestedOnDisk.some((e) => e.value === 42) &&
        ingestedOnDisk.some((e) => e.value === 99),
    );
    await hit('api.stats-not-found', 'GET', `/api/v1/metrics/does-not-exist.${RUN_MARKER}/stats`, 404, auth);
    await hit('api.admin-no-key', 'GET', '/api/v1/metrics/admin/health', 403, auth);
    await hit('api.admin-health', 'GET', '/api/v1/metrics/admin/health', 200, {
      headers: { ...auth.headers, 'x-admin-key': 'admin-dev-key' },
    });

    // ---- S1 Launch & lifecycle ----
    // The route answers `{isLaunched: client().isLaunched()}` and that boolean was going unread for
    // four rounds: only the hardcoded 200 was asserted, so `isLaunched()` regressing to `false` (or to
    // any non-boolean) would have left this row green while `scenarios.md` cited it as "isLaunched()
    // true - verified". Same class as the `flush()` boolean, `r1`/`r2`, `filterInvoked` and
    // `transactionNames` fixes: the evidence existed, nothing read it. `/health` returns the same
    // field and `waitForHealth()` now reads it too (see its own comment).
    const s1Status = await hit('S1.status', 'GET', '/scenarios/s1/status');
    wireCheck(
      'S1.status: the client reports isLaunched() === true',
      (s1Status.body as { isLaunched?: boolean } | undefined)?.isLaunched === true,
    );
    const s1Relaunch = await hit('S1.relaunch-noop', 'POST', '/scenarios/s1/relaunch-noop');
    wireCheck(
      'S1.relaunch-noop: a second launch() on the same carrier returns the SAME client instance',
      (s1Relaunch.body as { sameInstance?: boolean } | undefined)?.sameInstance === true,
    );

    // ---- S2 Identity & attributes ----
    // POSITIVE CONTROL for the attribute getters. `S2.clear-attributes` below is a NEGATIVE pair —
    // `afterClearOne === null` and `afterClearAll` empty — and a negative pair alone is satisfied by a
    // `getAttribute()` regressed to always return `undefined` and a `getAllAttributes()` regressed to
    // always return `{}`. Nothing in this gate used to assert either getter returning a VALUE, even
    // though this route already produced all four readings and the sweep threw the body away. This is
    // the same pairing discipline the S1.flush residual check states for itself further down ("the
    // negative check alone would pass vacuously"), applied one scenario over.
    //
    // NOT covered by the S2 wire checks on `manifest.attrs`: those read what the SDK put in the
    // uploaded bundle, a different path from what the getters answer in-process. Both regressions above
    // leave the bundle path untouched.
    const s2Identity = await hit('S2.identity-attributes', 'POST', '/scenarios/s2/identity-attributes');
    const s2IdBody = s2Identity.body as
      | {
          userIdentifier?: unknown;
          beforeSnapshot?: Record<string, unknown>;
          afterSnapshot?: Record<string, unknown>;
          getAttribute_num_attr?: unknown;
        }
      | undefined;
    const s2AttrsBefore = s2IdBody?.beforeSnapshot;
    const s2AttrsAfter = s2IdBody?.afterSnapshot;
    wireCheck(
      `S2.identity-attributes: getAllAttributes() returns every AttributeValue type with its exact value before the first event — ${JSON.stringify(s2AttrsBefore)}`,
      s2AttrsBefore !== undefined &&
        s2AttrsBefore.str_attr === `hello-${RUN_MARKER}` &&
        s2AttrsBefore.num_attr === 42 &&
        s2AttrsBefore.bool_attr === true &&
        JSON.stringify(s2AttrsBefore.arr_attr) === JSON.stringify(['a', 'b', 'c']) &&
        Object.keys(s2AttrsBefore).length === 4,
    );
    wireCheck(
      `S2.identity-attributes: getAllAttributes() tracks a LATER setAttribute() — after_attr appears in the second snapshot while the first four survive (${JSON.stringify(s2AttrsAfter?.after_attr)})`,
      s2AttrsAfter !== undefined &&
        s2AttrsAfter.after_attr === `set-after-event-${RUN_MARKER}` &&
        s2AttrsAfter.str_attr === `hello-${RUN_MARKER}` &&
        s2AttrsAfter.num_attr === 42 &&
        Object.keys(s2AttrsAfter).length === 5,
    );
    wireCheck(
      `S2.identity-attributes: getAttribute('num_attr') returns the VALUE that was set (${JSON.stringify(s2IdBody?.getAttribute_num_attr)}), not undefined — the positive half of S2.clear-attributes' negative pair`,
      s2IdBody?.getAttribute_num_attr === 42,
    );
    // SAMPLE_USER, set once at launch (src/bugsee.ts:13,97). Hard-coded rather than imported so this
    // harness never loads the SDK into its own process.
    wireCheck(
      `S2.identity-attributes: getUserIdentifier() returns the identity set at launch (${JSON.stringify(s2IdBody?.userIdentifier)})`,
      s2IdBody?.userIdentifier === 'sample-user@bugsee.dev',
    );
    const s2Clear = await hit('S2.clear-attributes', 'POST', '/scenarios/s2/clear-attributes');
    const s2ClearBody = s2Clear.body as
      | { afterClearOne?: unknown; afterClearAll?: Record<string, unknown> }
      | undefined;
    wireCheck(
      'S2.clear-attributes: clearAttribute() removed the single attribute (afterClearOne: null)',
      s2ClearBody?.afterClearOne === null,
    );
    wireCheck(
      'S2.clear-attributes: clearAllAttributes() leaves an empty attribute set',
      s2ClearBody?.afterClearAll !== undefined && Object.keys(s2ClearBody.afterClearAll).length === 0,
    );
    // PLAN §4 S2 asks for all three of setUserIdentifier/getUserIdentifier/clearUserIdentifier, and
    // `clearUserIdentifier` was neither exercised nor recorded N/A until this fix round (`browser-vanilla`
    // and `react-spa` cover it; `express-api` and `node-service` share the gap this closes here). The
    // route is at the BOTTOM of src/routes/scenarios.ts, below the last throw, so adding it shifted no
    // fingerprint — see its own comment. Asserted as a full transition, not just the cleared reading:
    // set -> read back -> clear -> read null -> restore. A getter stubbed to always return null would
    // pass the clear half and fail `afterSet`; a `clearUserIdentifier()` regressed to a no-op fails the
    // clear half. The `restored` field is the one that matters for the REST of the sweep — the identity
    // is process-global, so a route that cleared it without restoring would silently strip the user off
    // every later report.
    const s2User = await hit('S2.user-identifier', 'POST', '/scenarios/s2/user-identifier');
    const s2UserBody = s2User.body as
      | { initial?: unknown; afterSet?: unknown; afterClear?: unknown; restored?: unknown }
      | undefined;
    wireCheck(
      `S2.user-identifier: set -> get -> clearUserIdentifier() -> get null -> restore, all four readings correct (${JSON.stringify(s2UserBody)})`,
      s2UserBody?.initial === 'sample-user@bugsee.dev' &&
        s2UserBody.afterSet === 'temp-identity@bugsee.dev' &&
        s2UserBody.afterClear === null &&
        s2UserBody.restored === 'sample-user@bugsee.dev',
    );

    // ---- S3 Manual telemetry ----
    await hit('S3.telemetry', 'POST', '/scenarios/s3/telemetry');

    // ---- S4 Exceptions (storm runs LAST — spends the SDK's own rate-limit budget) ----
    await hit('S4.error-instance', 'POST', '/scenarios/s4/error-instance');
    await hit('S4.non-error', 'POST', '/scenarios/s4/non-error');
    await hit('S4.cause', 'POST', '/scenarios/s4/cause');
    await hit('S4.options', 'POST', '/scenarios/s4/options');
    // BUDGET. This route AWAITS two full `logException()` round trips to REAL staging, so — exactly
    // like S1.flush — it asks the SDK for TIMED work, and the F-X19 rule applies: the client-side
    // budget must EXCEED the work the route requests, or a correctly-working SDK reads as a failure.
    // It was nonetheless left on the flat 10s DEFAULT_HIT_TIMEOUT_MS for two rounds, on the reasoning
    // that one observation (the 2026-08-26 pre-fix baseline) was too thin to tune on and that raising
    // it would hide a genuine slowdown. Two things then falsified that:
    //   1. It reproduced. The 2026-08-26 VALIDATION run aborted here at 10s again, and again the
    //      independent wire check for the same scenario ("exactly ONE bundle") PASSED — the SDK
    //      deduplicated correctly and only this client-side budget was exceeded. Two occurrences on
    //      the same route make it the route's normal cost range, not an outlier. It is no longer a
    //      guess either: the re-run with the budget below MEASURED the route at 12850ms (recorded as
    //      `ms` in data/verify-run.json), i.e. genuinely ~1.3x over the flat 10s it was being given.
    //   2. The blast radius changed. When only an HTTP status was asserted this cost one status row;
    //      since the `r1`/`r2` evidence check below was added it fails a GATE check too — i.e. the
    //      flat budget now turns correct SDK behaviour red.
    // The budget is therefore derived from what the route REQUESTS, the same way S1.flush's is
    // (`FLUSH_TIMEOUT_MS + 5s`). The arithmetic that produced it was right; the JUSTIFICATION printed
    // here for two rounds ("two uploads, each bounded by the tee transport's own 30s") was wrong in
    // BOTH directions, and is restated:
    //   - It is ONE report on the wire, not two. The second `logException` of the same Error instance
    //     short-circuits in `checkOrSetAlreadyCaught` (packages/core/src/client.ts:636-638) and
    //     returns `{ok:false}` BEFORE `submitReport` (:674) — which is precisely what the `r1`/`r2`
    //     check below asserts and what both sweeps observed. So the route awaits one submission.
    //   - One report is nonetheless AT LEAST two 30s-bounded transport calls, not one: the issue
    //     create (`POST /v2/issues`, packages/core/src/bugsee-api.ts:81-85) and then the signed PUT
    //     of the bundle (packages/core/src/bundle-uploader.ts:21-36), each armed with the tee's
    //     `DEFAULT_TIMEOUT_MS` (src/bugsee-transport.ts) — and each retried up to 3x with backoff
    //     INSIDE the same promise the route awaits (packages/core/src/upload-pipeline.ts:35,96,155).
    // So `2 x 30s + 5s` is a floor on the serial worst case, not a ceiling: a full retry storm would
    // legitimately exceed it. It is kept because the aim is to not fail a HEALTHY run, and the
    // sensitivity that a budget this loose gives up is bought back by the explicit `ms` assertion
    // below instead of being silently lost.
    const DEDUPE_TIMEOUT_MS = 2 * 30_000 + 5_000;
    const s4Dedupe = await hit(
      'S4.dedupe',
      'POST',
      '/scenarios/s4/dedupe',
      200,
      undefined,
      DEDUPE_TIMEOUT_MS,
    );
    // The route AWAITS both `logException()` calls and returns their two `UploadResult`s. `r2.ok ===
    // false` is the SDK's OWN dedup decision (packages/core/src/client.ts's `checkOrSetAlreadyCaught`
    // returns `{ok:false}` for a re-capture of the same thrown object) — the most direct evidence of
    // deduplication this sample can obtain, and it was being produced and thrown away: `hit()` only
    // asserted HTTP 200, while scenarios.md's S4 dedupe row nonetheless CITED `{r1:{ok:true},
    // r2:{ok:false}}` as its evidence. The wire check below ("exactly ONE bundle") is the same claim
    // seen from the other end; both together distinguish "deduped" from "the second upload silently
    // failed". NB: this check inherits S4.dedupe's client-side budget exposure — if the local hit
    // aborts at DEDUPE_TIMEOUT_MS the body is undefined and this fails loudly rather than vacuously
    // passing, which is the intended direction (see the budget note above for why that budget is
    // derived from the route's requested work rather than left on the flat default).
    // SENSITIVITY, made explicit. The 65s abort budget above is a floor on the serial worst case, so
    // on its own it is nearly blind: a 4x regression would still land under 65s and pass in silence,
    // and `ms` is recorded but (by the `Result.ms` doc comment's own admission) asserted nowhere. So
    // an upper bound is asserted on `ms`, deliberately as a DIAGNOSIS and not as an abort: the request
    // is still allowed to run to the 65s budget and complete, so a slowdown is reported as "it worked,
    // but far slower than it should" rather than as an opaque abort with no body.
    //
    // THE CEILING IS A TRIPWIRE, AND IT MUST BE RE-FITTED AS OBSERVATIONS ACCUMULATE. It was first set
    // to 30000 ms on the ground that this was "roughly 2x observed, ample headroom", where "observed"
    // meant three runs spanning 12755-14255 ms. The very next independent run — the 2026-08-27 round-4
    // re-review — clocked 18433 ms, OUTSIDE that cited range, leaving only 1.63x of margin on a
    // provably-correct SDK. That is the F-X19 failure mode this exact route has already hit twice: a
    // client-side number fitted to a small sample turning a healthy run red. The number was wrong, not
    // the design.
    //
    // OBSERVATIONS (append to this list, never trim it — the ceiling is only as honest as the record;
    // each run's own value is also recorded as `ms` in `data/verify-run.json`):
    //   12755 ms · 12850 ms · 14255 ms  (2026-08-26, three runs)
    //   18433 ms                        (2026-08-27, round-4 re-review — escaped the 30000 ms fit)
    //   21119 ms · 9458 ms              (2026-08-27, the two validation runs OF the 45000 ms refit)
    //   8629 ms · 8967 ms · 9431 ms · 9522 ms
    //                                   (2026-08-27, the round-5 re-review's four consecutive sweeps)
    //   8268 ms · 8785 ms · 8776 ms · 9797 ms · 8671 ms
    //                                   (2026-08-27, the round-6 fix round's sweeps)
    //   9249 ms · 8518 ms · 8641 ms · 8904 ms · 9289 ms
    //                                   (2026-08-27, the round-5 FIX round's validation sweeps — the
    //                                   2nd through 6th of six. The FIRST of those six also passed
    //                                   161/161, but its `ms` is NOT recorded here: its stdout was
    //                                   tail-truncated before the value was read, and
    //                                   `data/verify-run.json` had already been overwritten by the
    //                                   next run. An observation that was not actually read is left
    //                                   out of the record rather than guessed at.)
    //   9168 ms · 9532 ms · 9122 ms    (2026-08-27, the round-7 fix round's sweeps — the first of the
    //                                   three run with `data/` deleted beforehand, which is why it is
    //                                   also the first observation taken against an empty store.)
    // Twenty-three observations, spread 8268-21119 ms: a 2.56x run-to-run swing on healthy staging,
    // with NO monotonic trend (the run right after the slowest was the fastest yet, and the seventeen
    // newest all sit at the fast end, 8268-9797 ms). That spread — not any single "2x observed" figure — is what
    // the ceiling has to clear, and it is exactly what the original 30000 ms fit got wrong by being
    // derived from three consecutive samples.
    // The 45000 ms fit still stands: 2.13x the worst observation (21119 ms), above the swing the
    // record actually shows, and still under the 65s abort budget so the check stays a diagnosis
    // rather than an abort.
    // Crossing 45s means the route now needs ~1.5 full transport bounds for what has never needed
    // one, i.e. a retry is happening where none used to. The 65s abort budget caps how far this can
    // be widened before it stops discriminating at all, so an observation above ~25 s is a reason to
    // investigate staging latency first, not to refit reflexively.
    //
    // The LABEL below deliberately does NOT enumerate the observations. That is what went stale: the
    // printed text said "observed range 12755-14255ms over three runs" while the very next run sat
    // outside it. The record lives here, in one place, where appending to it is the only edit needed.
    const DEDUPE_MS_CEILING = 45_000;
    wireCheck(
      `S4.dedupe: the awaited report round trip stayed under its tripwire ceiling (${s4Dedupe.ms}ms, ceiling ${DEDUPE_MS_CEILING}ms — the observation record lives in this check's comment, not in this label)`,
      s4Dedupe.ms < DEDUPE_MS_CEILING,
    );
    const dedupeBody = s4Dedupe.body as { r1?: { ok?: boolean }; r2?: { ok?: boolean } } | undefined;
    wireCheck(
      'S4.dedupe: the SDK itself reports the second logException of the SAME Error instance as not-reported (r1.ok true, r2.ok false)',
      dedupeBody?.r1?.ok === true && dedupeBody.r2?.ok === false,
    );

    // ---- S5 Crashes (in-request) ----
    await hit('S5.route-throw', 'GET', '/scenarios/s5/route-throw', 500);
    await hit('S5.hook-throw', 'GET', '/scenarios/s5/hook-throw', 500);
    await hit('S5.async-throw', 'GET', '/scenarios/s5/async-throw', 500);
    await hit('S5.async-plugin-throw', 'GET', '/scenarios/nested/s5/async-plugin-throw', 500);
    await hit('S5.timeout-throw', 'POST', '/scenarios/s5/timeout-throw', 202);
    await hit('S5.unhandled-rejection', 'POST', '/scenarios/s5/unhandled-rejection', 202);

    // ---- S6 Console capture ----
    await hit('S6.console', 'POST', '/scenarios/s6/console');

    // ---- S7 Network capture ----
    // These three asserted only the app's own hardcoded 200 for six rounds, while scenarios.md claimed
    // "body read correctly by the app" / "JSON body round-trips" / "text body round-trips" — the same
    // defect class their direct siblings (4xx/5xx/connection-failure/large-body/no-content-type) were
    // fixed for, left standing because the previous round's sweep stopped at the rows the reviewer had
    // named. `/ok` regressing to a 4xx with a JSON body, or the fetch never reaching the third party
    // at all, would have left all three green.
    //
    // What each route actually RETURNS bounds what can be asserted, and the doc rows were reworded to
    // match rather than the other way round: `/scenarios/s7/fetch-get` and `/s7/fetch-post-json` return
    // the third party's status AND its parsed JSON body (`thirdPartyBody`), so both halves are asserted
    // here; `/s7/fetch-post-text` returns the status only, so only the status is asserted. Deliberate
    // residual, recorded rather than papered over: `src/third-party.ts`'s `/ok` (:51-54) IGNORES the
    // request body — it answers `{ok:true, receivedAt}` to every method — so NOTHING the app can see
    // proves the POST body arrived, and "round-trips" was never a claim this sample could support.
    // Making it supportable would mean echoing the body from `/ok` AND widening the post-text route's
    // `reply.send` in `src/routes/scenarios.ts`, i.e. editing the fingerprint-sensitive file; the claim
    // was downgraded to what the evidence carries instead.
    const s7Get = await hit('S7.fetch-get', 'GET', '/scenarios/s7/fetch-get');
    const s7GetBody = s7Get.body as
      | { thirdPartyStatus?: number; thirdPartyBody?: { ok?: boolean } }
      | undefined;
    wireCheck(
      'S7.fetch-get: the third party really answered 200 and the app parsed its JSON body (ok:true)',
      s7GetBody?.thirdPartyStatus === 200 && s7GetBody.thirdPartyBody?.ok === true,
    );
    const s7PostJson = await hit('S7.fetch-post-json', 'POST', '/scenarios/s7/fetch-post-json');
    const s7PostJsonBody = s7PostJson.body as
      | { thirdPartyStatus?: number; thirdPartyBody?: { ok?: boolean } }
      | undefined;
    wireCheck(
      'S7.fetch-post-json: the POSTed JSON reached a third party that answered 200, and the app parsed its JSON reply (ok:true)',
      s7PostJsonBody?.thirdPartyStatus === 200 && s7PostJsonBody.thirdPartyBody?.ok === true,
    );
    const s7PostText = await hit('S7.fetch-post-text', 'POST', '/scenarios/s7/fetch-post-text');
    wireCheck(
      'S7.fetch-post-text: the POSTed text body reached a third party that answered 200 (the route returns no body to assert on — see the note above)',
      (s7PostText.body as { thirdPartyStatus?: number } | undefined)?.thirdPartyStatus === 200,
    );
    // Both routes return the THIRD PARTY's status and `ok` flag, and both were asserting only the
    // app's own hardcoded 200 — so `/boom` regressing to a 200, or being deleted and falling through
    // src/third-party.ts's catch-all 404 (:83), would leave the sweep green while scenarios.md
    // recorded "404/500 from the third party" as verified. Same fix their direct siblings
    // (connection-failure / large-body / no-content-type) already got. Honest residual on the 4xx
    // half only: src/third-party.ts's catch-all ALSO answers 404, so deleting `/not-found` is
    // indistinguishable from it working. The status is still worth asserting (a 4xx becoming a 2xx,
    // or the fetch not reaching the third party at all, is caught), and the 5xx half has no such
    // ambiguity — the catch-all's 404 is not 500.
    const s74xx = await hit('S7.4xx', 'GET', '/scenarios/s7/4xx');
    const s74xxBody = s74xx.body as { thirdPartyStatus?: number; ok?: boolean } | undefined;
    wireCheck(
      'S7.4xx: the third party really answered 404 and the app read it as not-ok',
      s74xxBody?.thirdPartyStatus === 404 && s74xxBody.ok === false,
    );
    const s75xx = await hit('S7.5xx', 'GET', '/scenarios/s7/5xx');
    const s75xxBody = s75xx.body as { thirdPartyStatus?: number; ok?: boolean } | undefined;
    wireCheck(
      'S7.5xx: the third party really answered 500 and the app read it as not-ok',
      s75xxBody?.thirdPartyStatus === 500 && s75xxBody.ok === false,
    );
    const s7ConnFailure = await hit('S7.connection-failure', 'GET', '/scenarios/s7/connection-failure');
    const connFailureBody = s7ConnFailure.body as { failed?: boolean; error?: string } | undefined;
    wireCheck(
      'S7.connection-failure: the app\'s own try/catch still works (failed:true, error message surfaced)',
      connFailureBody?.failed === true &&
        typeof connFailureBody.error === 'string' &&
        connFailureBody.error.length > 0,
    );
    const s7LargeBody = await hit('S7.large-body', 'GET', '/scenarios/s7/large-body');
    wireCheck(
      'S7.large-body: the FULL 20000-byte body still reached the app despite the 4096-byte capture limit',
      (s7LargeBody.body as { bodyLength?: number } | undefined)?.bodyLength === 20_000,
    );
    const s7NoContentType = await hit('S7.no-content-type', 'GET', '/scenarios/s7/no-content-type');
    const noContentTypeBody = s7NoContentType.body as
      | { contentType?: string | null; text?: string }
      | undefined;
    wireCheck(
      'S7.no-content-type: the app still read the response correctly with no content-type header',
      noContentTypeBody?.contentType === null && noContentTypeBody.text === 'no content type here',
    );

    // ---- S8 Filters & redaction ----
    await hit('S8.log-redaction', 'POST', '/scenarios/s8/log-redaction');
    await hit('S8.breadcrumb-drop', 'POST', '/scenarios/s8/breadcrumb-drop');
    await hit('S8.report-mutate', 'POST', '/scenarios/s8/report-mutate');
    await hit('S8.report-veto', 'POST', '/scenarios/s8/report-veto');
    const s8NetworkFilter = await hit('S8.network-filter', 'POST', '/scenarios/s8/network-filter');
    // The route reports whether `setNetworkEventFilter`'s callback was ever INVOKED (it flips a flag
    // inside the filter). Without this, every S8.network-filter wire check below is consistent with a
    // filter that was installed but never called — the header simply never having been sent — and
    // scenarios.md cited `filterInvoked: true` as evidence while nothing read it.
    wireCheck(
      'S8.network-filter: the installed setNetworkEventFilter callback was actually INVOKED (not merely registered)',
      (s8NetworkFilter.body as { filterInvoked?: boolean } | undefined)?.filterInvoked === true,
    );

    // ---- S9 Performance / APM ----
    const s9ManualSpan = await hit('S9.manual-span', 'POST', '/scenarios/s9/manual-span');
    const manualSpanBody = s9ManualSpan.body as
      | { transactionName?: string; traceId?: string }
      | undefined;
    wireCheck(
      'S9.manual-span: startTransaction/startChildSpan returned a real transaction name and W3C trace id',
      manualSpanBody?.transactionName === `scenario.manual.${RUN_MARKER}` &&
        typeof manualSpanBody.traceId === 'string' &&
        /^[0-9a-f]{32}$/i.test(manualSpanBody.traceId),
    );
    await hit('S9.route-name', 'POST', '/scenarios/s9/route-name');

    // ---- S10 Distributed tracing ----
    const s10Outbound = await hit('S10.outbound-trace', 'GET', '/scenarios/s10/outbound-trace');
    const outboundBody = s10Outbound.body as { traceparentReceivedByThirdParty?: string } | undefined;
    wireCheck(
      'S10.outbound-trace: the third party received a valid W3C traceparent header',
      typeof outboundBody?.traceparentReceivedByThirdParty === 'string' &&
        /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i.test(
          outboundBody.traceparentReceivedByThirdParty,
        ),
    );

    // ---- S12 Persistence info ----
    await hit('S12.info', 'GET', '/scenarios/s12/info');

    // ---- route naming (nested-plugin regression check + real admin route) ----
    // Both probes are PARAMETERIZED on purpose — see the wire checks below for why a static route
    // cannot discriminate here.
    await hit('route-naming.scenarios-nested', 'GET', '/scenarios/route-naming/deep/proj1/items/item1');
    await hit(
      'route-naming.admin-param',
      'GET',
      `/api/v1/metrics/admin/series/latency.${RUN_MARKER}/summary`,
      200,
      { headers: { ...auth.headers, 'x-admin-key': 'admin-dev-key' } },
    );

    // ---- first-owner-wins: hit ONCE, count http.server transactions for THIS route after the sweep ----
    await hit('S14.single-hit', 'GET', '/scenarios/s14/single-hit');

    // ---- custom setErrorHandler interaction: response is rewritten to 200, but does onError still fire? ----
    await hit('S14.custom-error-handler', 'GET', '/scenarios/s14/custom-handler/throw', 200);

    // ---- 4xx must NOT report / 5xx MUST ----
    await hit('status.4xx-not-reported', 'GET', '/scenarios/status/4xx', 400);
    await hit('status.5xx-reported', 'GET', '/scenarios/status/5xx-thrown', 500);

    // ---- concurrency: 50 overlapping requests, each with a distinct per-request attribute ----
    console.log('\nfiring 50 concurrent requests...');
    const concurrencyIndexes = Array.from({ length: 50 }, (_, i) => i);
    const concurrencyResults = await Promise.all(
      concurrencyIndexes.map((i) =>
        hit(`concurrency.${i}`, 'GET', `/scenarios/concurrency/hit?idx=${i}&delayMs=${(49 - i) % 40}`, 500),
      ),
    );
    const concurrencyOk = concurrencyResults.every((r) => r.ok);
    console.log(
      `concurrency sweep: ${concurrencyResults.filter((r) => r.ok).length}/50 returned 500 as expected`,
    );
    results.push({
      id: 'concurrency.summary',
      method: 'GET',
      path: '/scenarios/concurrency/hit (x50)',
      status: concurrencyOk ? 500 : -1,
      expected: 500,
      ok: concurrencyOk,
      // The 50 hits ran CONCURRENTLY and each recorded its own `ms`; the slowest is what the batch
      // actually cost in wall clock, so summing or averaging them would be a fiction.
      ms: Math.max(...concurrencyResults.map((r) => r.ms)),
    });

    // ---- S4 storm, last: it deliberately spends the rate-limit window ----
    const s4Storm = await hit('S4.storm', 'POST', '/scenarios/s4/storm');
    const stormBody = s4Storm.body as { responsivenessMs?: number; stillResponsive?: boolean } | undefined;
    wireCheck(
      `S4.storm: event loop stayed responsive after 200 logException calls (setImmediate delay ${stormBody?.responsivenessMs}ms)`,
      stormBody?.stillResponsive === true,
    );

    // ---- flush + let the async pipeline drain ----
    const FLUSH_TIMEOUT_MS = 15_000;
    // The tee's bundle count, sampled around the flush. This is instrumentation for ONE assertion (the
    // `true` branch guarded below), not a gate row of its own, so it is a plain fetch rather than a
    // `hit()`.
    const bundleCount = async (): Promise<number> =>
      ((await (await fetch(`${BASE}/scenarios/_debug/bundles`)).json()) as unknown[]).length;
    const bundlesBeforeFlush = await bundleCount();
    const s1Flush = await hit(
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
    const bundlesAfterFlush = await bundleCount();
    // The route returns `flush()`'s own boolean and it was going unread: only the hardcoded 200 was
    // asserted, so a regression that made `flush()` a no-op returning `false` immediately would have
    // left the gate green.
    //
    // What is asserted is deliberately NOT `flushed === true`. This flush is placed LAST on purpose —
    // after S4.storm's 200 `logException` calls and the 50-way concurrency batch — so it meets a real
    // ~100-bundle backlog, and `false` is the honest, reproducible outcome here: `drainPending`
    // (packages/core/src/client.ts:440-447) races the drain against `sleep(timeout)`. Moving the flush
    // to a low-load point would let it assert `true`, at the cost of no longer exercising the case
    // that matters (does the SDK honour its bound under load?), so it stays here.
    //
    // The invariant that holds either way — and that the no-op regression violates — is that
    // `flush(timeout)` must not answer `false` WITHOUT having actually waited: false ⇒ it spent the
    // timeout. The 500 ms of slack below covers the route's clock starting marginally after, and
    // stopping marginally before, the SDK's own internal timer.
    //
    // ==> THE OBSERVATION RECORD FOR THIS CHECK LIVES HERE, AND ONLY HERE. APPEND TO IT, NEVER TRIM IT
    // (same discipline as the S4.dedupe ceiling above; each run's round trip is also in
    // `data/verify-run.json` as `ms`, but the flush's OWN duration is only ever printed in the label
    // below, so it has to be copied here by hand or it is lost). Before round 6 this record had THREE
    // homes and they had already drifted: this comment said "two independent sweeps at ~15003 ms",
    // forty lines further down it said "both observed runs came in at 15002/15004", and
    // `scenarios.md` called the same outcome "three-times-reproduced". Two of those three retellings
    // described the SAME two runs and no third value was ever recorded anywhere. The duplicate figures
    // forty lines down are gone, and `scenarios.md`'s S1-flush row now points here instead of
    // restating them.
    //   15002 ms · 15004 ms   (2026-08-27, the round-5 fix round — the pair every earlier retelling
    //                          was describing. That round ran six sweeps and appended none of the
    //                          other four: a value that was not actually read is left out of the
    //                          record rather than guessed at.)
    //   15000 ms · 14999 ms · 14999 ms
    //                         (2026-08-27, the round-6 review's three sweeps. Two of the three land
    //                          BELOW the 15000 ms bound — that is the route's own clock being
    //                          marginally tighter than the SDK's internal timer, exactly what the
    //                          500 ms slack exists to absorb, NOT a flush that under-spent.)
    //   15000 ms · 15000 ms · 15001 ms · 15000 ms · 14999 ms
    //                         (2026-08-27, the round-6 fix round's sweeps.) How many sweeps a round ran
    //                          and what they SCORED is deliberately NOT recorded here: those numbers
    //                          live in scenarios.md's GATE-COUNT HOME, which states that they appear
    //                          exactly once in this sample, and a copy here would falsify that the next
    //                          time the gate size moves. This block's own history is the argument —
    //                          it already records two numbers that went stale in the round that changed
    //                          them. The DURATIONS are the record this home owns; the gate is not.
    //   15000 ms · 15000 ms · 15000 ms
    //                         (2026-08-27, the round-7 fix round's sweeps. The first of the three ran
    //                          against a DELETED `data/` — an empty store changes nothing about the
    //                          flush, as expected, and it is recorded so that is on the record rather
    //                          than assumed.)
    // Thirteen observations, spanning 14999-15004 ms: every one within 5 ms of the bound, either side. The
    // jitter this check has to tolerate is therefore single-digit milliseconds, so the 500 ms slack
    // sits ~2 orders of magnitude above it while a genuinely no-op `false` (0 ms — or anything under
    // 14.5 s) stays far outside. Widen the slack only if an observation ever approaches it, and append
    // that observation here when you do.
    //
    // RESIDUAL — NOW CLOSED, recorded because how it was closed matters. The `true` branch used to be
    // accepted unconditionally with nothing guarding it. An early note excused that by claiming "the
    // post-flush polling loop below independently proves the bundles do all arrive", which is false:
    // that loop asserts nothing, and the "50/50 bundles arrived" check reads the settled list after it
    // and passes with or without this flush. The replacement excuse — "closing it would need the route
    // to report the pending-bundle count (src/routes/scenarios.ts), which this round deliberately does
    // not touch" — did not hold either, and was the wrong shape of blocker: `scripts/verify.ts` is
    // fingerprint-SAFE (scenarios.md's own table says so), and the tee ALREADY publishes the count over
    // `/scenarios/_debug/bundles`. So the count is now sampled immediately after the flush returns and
    // again once the drain loop has settled, and the check further below asserts the implication
    // `flushed === true` ⇒ the settled count did not grow. A `flush()` that answers `true` without
    // draining leaves the ~100-bundle backlog for the drain loop to upload, which shows up as growth
    // and fails. The sampling ORDER is what makes that sound: the tee parses each bundle in a
    // `setImmediate` scheduled AFTER the response is handed back, and the `bundleCount()` fetch is a
    // whole further HTTP round trip, so every upload that completed before the flush returned is
    // already parsed and counted by then. The branch remains the one no sweep on record takes (every
    // full sweep answers `false`), so the guard is written to be correct rather than to be exercised.
    //
    // The DURATION this asserts on is `flushMs` — measured by the route around the `await
    // client().flush(...)` call itself (src/routes/scenarios.ts) — NOT `s1Flush.ms`, which is this
    // harness's wall clock for the entire HTTP round trip. Asserting on the round trip measured the
    // wrong quantity: it is only an UPPER bound on the flush, so a no-op `flush()` returning `false`
    // in 0 ms would still satisfy the invariant as long as >= 14.5 s of delay occurred ANYWHERE else
    // in that request — and this check deliberately runs at peak load, right after the S4 storm and
    // the 50-way concurrency batch, which is precisely when such delay is available. Since guarding a
    // no-op flush is the entire reason this check exists, it reads the flush's own duration.
    const flushBody = s1Flush.body as { flushed?: boolean; flushMs?: number } | undefined;
    wireCheck(
      `S1.flush: flush() returned ${flushBody?.flushed} after ${flushBody?.flushMs}ms of flush time (round trip ${s1Flush.ms}ms) — a false answer must mean it actually spent its ${FLUSH_TIMEOUT_MS}ms bound, never a no-op`,
      flushBody?.flushed === true ||
        (flushBody?.flushed === false &&
          flushBody.flushMs !== undefined &&
          flushBody.flushMs >= FLUSH_TIMEOUT_MS - 500),
    );
    // A WAIT, NOT A CHECK: this loop lets the SDK finish uploading the backlog so the wire-level
    // assertions below read a settled bundle list. It asserts nothing itself — an early version of the
    // flush comment above wrongly cited it as proof of arrival. What DOES use it is the flush's
    // now-closed residual: the settled count this loop waits for is compared against `bundlesAfterFlush`
    // below, which is where a `flush()` that answered `true` without draining would show up.
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
    interface NetworkEntryLike {
      type?: string;
      url?: string;
      custom?: { headers?: Record<string, unknown>; no_body_reason?: string | null };
    }
    interface BreadcrumbLike {
      category?: string;
      message?: string;
    }
    const bundlesRes = await fetch(`${BASE}/scenarios/_debug/bundles`);
    const bundles = (await bundlesRes.json()) as Array<{
      bundle?: {
        request?: Record<string, unknown>;
        attrs?: Record<string, unknown>;
        logMessages?: string[];
        breadcrumbs?: BreadcrumbLike[];
        network?: NetworkEntryLike[];
      };
    }>;
    const transactionsRes = await fetch(`${BASE}/scenarios/_debug/transactions`);
    const transactions = (await transactionsRes.json()) as Array<{
      transactions?: Array<{ name: string; op?: string }>;
    }>;
    wireSnapshot = { bundleCount: bundles.length, transactions };

    // ---- wire-only assertions on the tee'd bundles ----
    console.log('\n== wire-level checks (from the tee transport) ==');
    // Closes the S1.flush residual (see that check's comment above for the full reasoning and for why
    // the "it would need a route change" blocker recorded there did not hold). `bundles.length` is the
    // SETTLED count: the drain loop above only returns once the tee's count has been stable for three
    // 5 s ticks. The assertion is an implication, so it is vacuously true on the `false` branch every
    // sweep on record actually takes — it exists for the branch that would otherwise be unguarded.
    //
    // MEASURED CAVEAT on `bundlesAfterFlush`, recorded so nobody has to re-derive it. That sample is
    // taken over a whole HTTP round trip, so any upload that COMPLETES during the round trip is counted
    // into it — i.e. `bundlesAfterFlush` can be slightly HIGHER than the count at the instant `flush()`
    // returned. The inaccuracy therefore points TOWARD passing (a larger `bundlesAfterFlush` is closer
    // to the settled `bundles.length`), never toward a false failure. Magnitude: about ONE bundle,
    // against a signal of roughly sixty-five. Measured on a real sweep — `bundlesAfterFlush` landed at
    // 35-37 against a settled 101, so an undrained backlog shows up as a ~65-bundle gap and a one-bundle
    // sampling skew cannot mask it. Tighten this only if the gap ever shrinks to the same order as the
    // skew; a `flush()` that drains everything makes both counts equal and the skew disappears.
    wireCheck(
      `S1.flush: a true answer must mean the backlog was really drained — ${bundlesBeforeFlush} bundles before the flush, ${bundlesAfterFlush} immediately after, ${bundles.length} once the drain settled`,
      flushBody?.flushed !== true || bundles.length === bundlesAfterFlush,
    );
    wireCheck(
      'S4.dedupe: same Error instance logged twice produces exactly ONE bundle',
      bundles.filter((b) => String(b.bundle?.request?.summary ?? '').includes(`s4-dedupe-${RUN_MARKER}`))
        .length === 1,
    );

    // ---- S5: process-level crashes must carry the RIGHT report `type` — "crash" (detectCrashes /
    // uncaughtException) vs "error" (unhandledRejections:'warn') — not just a 202 the route hardcodes
    // regardless of whether anything was ever reported at all.
    const timeoutThrowBundle = bundles.find((b) =>
      String(b.bundle?.request?.summary ?? '').includes(`s5-timeout-throw-${RUN_MARKER}`),
    );
    wireCheck(
      'S5.timeout-throw: a bundle was uploaded with type "crash" (detectCrashes/uncaughtException path, not onError)',
      timeoutThrowBundle?.bundle?.request?.type === 'crash',
    );
    const unhandledRejectionBundle = bundles.find((b) =>
      String(b.bundle?.request?.summary ?? '').includes(`s5-unhandled-rejection-${RUN_MARKER}`),
    );
    wireCheck(
      'S5.unhandled-rejection: a bundle was uploaded with type "error" (unhandledRejections:\'warn\' path, not crash)',
      unhandledRejectionBundle?.bundle?.request?.type === 'error',
    );

    // ---- S8.log-redaction: a POSITIVE control alongside the negative check below. The negative check
    // alone (no SECRET_LOG_VALUE anywhere) passes vacuously if setLogEventFilter regressed to DROPPING
    // the entry entirely, or if this bundle simply never uploaded — neither of those is "redaction
    // working". Assert the redacted FORM actually reached logs.json.
    const s8LogRedactionBundle = bundles.find((b) =>
      String(b.bundle?.request?.summary ?? '').includes(`s8-log-redaction-${RUN_MARKER}`),
    );
    wireCheck(
      "S8.log-redaction: the REDACTED form (s8-contains-[redacted]-<marker>) DOES reach logs.json — positive control proving the filter transformed rather than dropped or never-uploaded the entry",
      (s8LogRedactionBundle?.bundle?.logMessages ?? []).some((m) =>
        m.includes(`s8-contains-[redacted]-${RUN_MARKER}`),
      ),
    );
    wireCheck(
      'S8.log-redaction: SECRET_LOG_VALUE never appears in an uploaded logs.json',
      !bundles.some((b) => b.bundle?.logMessages?.some((m) => m.includes('SECRET_LOG_VALUE'))),
    );
    wireCheck(
      'S8.report-veto: no bundle summary contains VETO_ME',
      !bundles.some((b) => String(b.bundle?.request?.summary ?? '').includes('VETO_ME')),
    );

    // ---- S3/S6: logs.json actually carries the manual telemetry (not just "a report arrived") ----
    const s3Bundle = bundles.find((b) =>
      String(b.bundle?.request?.summary ?? '').includes(`s3-${RUN_MARKER}`),
    );
    const s3Messages = s3Bundle?.bundle?.logMessages ?? [];
    wireCheck(
      'S3.telemetry: logs.json carries all 5 log() lines, one per LogLevel',
      ['debug', 'verbose', 'info', 'warning', 'error'].every((lvl) =>
        s3Messages.includes(`s3-${lvl}-${RUN_MARKER}`),
      ),
    );
    const s6Bundle = bundles.find((b) =>
      String(b.bundle?.request?.summary ?? '').includes(`s6-${RUN_MARKER}`),
    );
    const s6Messages = s6Bundle?.bundle?.logMessages ?? [];
    wireCheck(
      'S6.console: logs.json carries all 6 console.*() lines plus the circular-object line, no crash',
      ['s6-log', 's6-info', 's6-warn', 's6-error', 's6-debug', 's6-trace'].every((prefix) =>
        s6Messages.some((m) => m.includes(`${prefix}-${RUN_MARKER}`)),
      ) && s6Messages.some((m) => m.includes('s6-circular')),
    );

    // ---- S8.breadcrumb-drop: the filtered breadcrumb array itself, not just "a report arrived" ----
    // NOTE: breadcrumbs are a ROLLING trail (like network — not reset per report), so this bundle can
    // legitimately also carry earlier scenarios' own breadcrumbs (e.g. S3's `s3-breadcrumb-*`, or an
    // earlier run's own "kept" one) if they fall inside the same recording window. The real assertion
    // is therefore "THIS run's kept breadcrumb survived, and no secret-category breadcrumb EVER appears
    // in ANY bundle from this run" — not an exact count on one bundle (confirmed against a live run: an
    // exact-length assertion here is a false positive/negative depending on sweep timing, not a real
    // signal of the filter working).
    const breadcrumbBundle = bundles.find((b) =>
      String(b.bundle?.request?.summary ?? '').includes(`s8-breadcrumb-drop-${RUN_MARKER}`),
    );
    const crumbs = breadcrumbBundle?.bundle?.breadcrumbs ?? [];
    wireCheck(
      'S8.breadcrumb-drop: this run\'s "kept" breadcrumb survives, and no "secret"-category breadcrumb ever appears in any bundle',
      crumbs.some((c) => c.message === `kept-${RUN_MARKER}`) &&
        !bundles.some((b) => (b.bundle?.breadcrumbs ?? []).some((c) => c.category === 'secret')),
    );

    // ---- S7: network.json is actually present with real entries (not asserted anywhere before this) ----
    //
    // RUN SCOPING. `recover: true` + on-disk capture means a PRIOR run's undelivered report can be
    // recovered at launch and uploaded through THIS run's tee, landing in `bundles`. Every check that
    // selects a bundle by its summary/`http.url` is scoped by RUN_MARKER for that reason; these two
    // network checks were not, and a previous round's "every sibling is run-scoped" claim was wrong
    // about them. They cannot be scoped the same way: the entries they select are third-party URLs the
    // app builds itself, with no marker in them (`src/routes/scenarios.ts`'s `thirdPartyUrl('/large')`
    // takes no query), so `isThirdPartyPath` — which compares `new URL(raw).pathname` — could not see
    // one even if it were added there. The anchor used instead is the BUNDLE: a bundle is this run's
    // iff its own summary or `http.url` carries RUN_MARKER, and a recovered bundle carries the
    // PREVIOUS run's marker (its capture and its report both belong to that session — recovery never
    // merges an old rolling trail into a new report). Narrowing to those bundles' network trails is
    // therefore sound, and is what both checks below read.
    const isThisRun = (b: (typeof bundles)[number]): boolean =>
      String(b.bundle?.request?.summary ?? '').includes(RUN_MARKER) ||
      String(b.bundle?.attrs?.['http.url'] ?? '').includes(RUN_MARKER);
    const thisRunBundles = bundles.filter(isThisRun);
    const allNetworkEntries = thisRunBundles.flatMap((b) => b.bundle?.network ?? []);
    wireCheck(
      `S7: network.json is present in a bundle uploaded BY THIS RUN, with capture entries (${thisRunBundles.length}/${bundles.length} bundles are this run's)`,
      thisRunBundles.length > 0 && allNetworkEntries.length > 0,
    );
    // The fetch interceptor emits TWO 'complete' events per call: one with the raw response headers,
    // and a second (`override: true`) that layers in the body outcome (`custom.body` or
    // `no_body_reason`) once the body read finishes — confirmed against a live run. Search all entries
    // for the one that actually carries the reason, rather than assuming the first 'complete' match has
    // it (that assumption is what made this check fail against real data on the first run).
    //
    // Match on the exact third-party PATHNAME, not on a `.includes('/large')` substring: the app's own
    // route is `/scenarios/s7/large-body`, which CONTAINS '/large'. Incoming server requests happen not
    // to produce network entries today (packages/node/src/http-server-interceptor.ts captures context +
    // APM only, "NO headers/bodies"), so the substring is unambiguous by luck rather than by design —
    // the day incoming capture is added, a substring match would silently start selecting the wrong
    // entry and this check would keep reading green.
    const isThirdPartyPath = (raw: unknown, pathname: string): boolean => {
      if (typeof raw !== 'string') return false;
      try {
        return new URL(raw).pathname === pathname;
      } catch {
        return false;
      }
    };
    //
    // Selected out of `allNetworkEntries`, which is now scoped to THIS RUN's bundles (see the block
    // above) — the pathname alone would also match the `/large` call a recovered PRIOR-run bundle
    // carries in its own rolling trail, and this run makes exactly one `/large` call.
    const largeBodyEntry = allNetworkEntries.find(
      (e) => isThirdPartyPath(e.url, '/large') && e.custom?.no_body_reason != null,
    );
    wireCheck(
      'S7.large-body: the CAPTURED (not app-visible) copy was truncated — no_body_reason: size_too_large',
      largeBodyEntry?.custom?.no_body_reason === 'size_too_large',
    );

    // ---- S10: tracePropagationTargets, the EXCLUDE half ----
    // `propagateTrace` + `tracePropagationTargets` is a two-sided contract: listed targets GET a
    // `traceparent`, unlisted ones must NOT. Only the include half was ever checked (the third party
    // echoes the header back, asserted at S10.outbound-trace and on the filtered network entry above),
    // and the exclude half could not have been checked, because the list carried a catch-all
    // `/127\.0\.0\.1/` regex alongside the exact `127.0.0.1:<third-party-port>` string — and every
    // outbound call this sample makes goes to 127.0.0.1. The regex matched all of them, so "only
    // allow-listed targets receive the header" was a claim with no possible negative observation, while
    // scenarios.md read "Local — verified".
    //
    // The regex is gone (src/bugsee.ts:71 now lists exactly one target) and the app's existing call to
    // `http://127.0.0.1:1/unreachable` (S7.connection-failure) is now a genuine NON-listed target: same
    // client, same run, same interceptor, differing from the listed target ONLY in being absent from
    // the list. Its captured 'before' entry must carry no `traceparent`/`tracestate`, while the
    // `/echo-headers` entry asserted below (`'traceparent' in filteredEntry.custom.headers`) shows the
    // include half still works — the pair is what makes either half meaningful.
    //
    // The existence assertion is deliberate and comes first: without it, "no entry carries traceparent"
    // would pass vacuously in exactly the case where the connection-failure call stopped being captured
    // at all. Entries are taken from THIS RUN's bundles only — a bundle recovered from a previous sweep
    // carries a trail captured under the OLD config, where the regex did add the header.
    const unlistedTargetEntries = allNetworkEntries.filter((e) => {
      if (typeof e.url !== 'string') return false;
      try {
        return new URL(e.url).host === '127.0.0.1:1';
      } catch {
        return false;
      }
    });
    const unlistedWithHeaders = unlistedTargetEntries.filter((e) => e.custom?.headers !== undefined);
    wireCheck(
      `S10.tracePropagationTargets (exclude, non-vacuity): the NON-listed target 127.0.0.1:1 was captured with its request headers (${unlistedWithHeaders.length} entr(y|ies))`,
      unlistedWithHeaders.length > 0,
    );
    wireCheck(
      'S10.tracePropagationTargets (exclude): NO traceparent/tracestate was injected into the NON-listed target 127.0.0.1:1',
      unlistedWithHeaders.length > 0 &&
        unlistedWithHeaders.every(
          (e) =>
            !('traceparent' in (e.custom?.headers ?? {})) &&
            !('tracestate' in (e.custom?.headers ?? {})),
        ),
    );

    // ---- S8.network-filter: compare the FILTERED call against an unfiltered control call ----
    const networkFilterBundle = bundles.find((b) =>
      String(b.bundle?.request?.summary ?? '').includes(`s8-network-filter-${RUN_MARKER}`),
    );
    // Select each of the two same-URL calls by the `x-call-id` the route stamps on it, NOT by its
    // position in the array. Both calls target `/echo-headers`, and the property the "filtered" check
    // asserts (no x-secret-header, traceparent present) is equally true of the CONTROL entry — so a
    // positional `[filtered, control] = entries` reads green no matter which entry it actually lands
    // on. Network capture is a ROLLING trail (this bundle also carries earlier scenarios' entries —
    // confirmed against live data), so ordering is not something this sample controls.
    const echoEntries = (networkFilterBundle?.bundle?.network ?? []).filter(
      (e) => isThirdPartyPath(e.url, '/echo-headers') && e.type === 'before',
    );
    const byCallId = (id: string): NetworkEntryLike | undefined =>
      echoEntries.find((e) => e.custom?.headers?.['x-call-id'] === id);
    const filteredEntry = byCallId(`filtered-${RUN_MARKER}`);
    const controlEntry = byCallId(`control-${RUN_MARKER}`);
    wireCheck(
      'S8.network-filter: both the filtered call and the unfiltered control call were captured, each identifiable by its own x-call-id',
      filteredEntry !== undefined && controlEntry !== undefined,
    );
    // ASSERT KEY ABSENCE, NOT VALUE ABSENCE — and that distinction is what makes these two checks
    // falsifiable at all. Form (f) ("a negative assertion the SDK already guarantees by default") was
    // cleared here AT SOURCE, not by probing: `packages/protocol/src/sanitize.ts:40-49` REPLACES a
    // sensitive header's value with `<redacted>` and NEVER deletes the key, and `x-secret-header` is
    // not in the exact-match `SENSITIVE_HEADERS` set anyway. So the app-side filter is strictly
    // required for the key to be gone, and the SDK cannot satisfy `!('x-secret-header' in headers)`
    // by default. Had this been written as a VALUE-absence assertion ("the value is not
    // 'super-secret'"), the SDK's own default redaction would have satisfied it for free and the
    // check would have been unfalsifiable — a peer sample's assertion was exactly that.
    wireCheck(
      'S8.network-filter: WITH the filter installed, x-secret-header is stripped (x-call-id/traceparent survive, so this IS the filtered call and the filter was surgical)',
      filteredEntry?.custom?.headers !== undefined &&
        !('x-secret-header' in filteredEntry.custom.headers) &&
        'traceparent' in filteredEntry.custom.headers,
    );
    wireCheck(
      'S8.network-filter: WITHOUT the filter, content-type passes through unmodified (proves the strip above was scoped, not global)',
      controlEntry?.custom?.headers?.['content-type'] === 'application/json',
    );
    // Global negative: the secret must not survive ANYWHERE in ANY uploaded bundle's network trail —
    // the same positive-plus-negative pairing S8.log-redaction uses. The per-entry check above cannot
    // see a leak into some other entry (a redirect hop, the 'complete' stage, another bundle's copy of
    // the rolling trail).
    wireCheck(
      'S8.network-filter: x-secret-header never appears in ANY captured network entry of ANY uploaded bundle',
      !bundles.some((b) =>
        (b.bundle?.network ?? []).some(
          (e) => e.custom?.headers !== undefined && 'x-secret-header' in e.custom.headers,
        ),
      ),
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
    // The other half of the claim (scenarios.md): `after_attr` must be ABSENT from the BEFORE bundle,
    // not just present on the after one. Without this half, a regression that snapshotted attributes at
    // UPLOAD time instead of at SUBMIT time (exactly what commit f17baa8 fixed) would stamp `after_attr`
    // on BOTH bundles and the "present after" check below would stay green either way.
    wireCheck(
      'S2: attribute set AFTER the first event is ABSENT from the earlier (before) bundle',
      s2Before !== undefined && s2Before.bundle?.attrs?.after_attr === undefined,
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
    wireCheck(
      'concurrency isolation: every bundle has a DISTINCT context_id',
      contextIds.size === concurrencyBundles.length,
    );

    // ---- route naming: the nested-plugin pattern must be the FULL merged Fastify pattern ----
    const allTxns = transactions.flatMap((t) => t.transactions ?? []);
    const nestedScenarioTxn = allTxns.find((t) =>
      t.name.includes('/scenarios/route-naming/deep/:id/items/:itemId'),
    );
    wireCheck(
      'route naming: nested scenarios plugin recorded the FULL pattern (with both prefixes)',
      nestedScenarioTxn !== undefined,
    );
    // GENERAL RULE, learned here and in a peer sample (angular-spa): **a route-naming check on a
    // STATIC route cannot discriminate.** This check used to assert
    // `t.name.includes('/api/v1/metrics/admin/health')` — a route with NO path parameters. When
    // `routeOf` returns undefined the SDK falls back to `${method} ${urlPath(info.url)}`
    // (packages/node/src/server-instrument.ts:148-154), and `urlPath` strips only the query, so the
    // fallback for that route is `GET /api/v1/metrics/admin/health` — BYTE-IDENTICAL to the pattern
    // form. The check would have read green even if `routeOf` returned undefined for every request in
    // the sweep. This run's own third-party mock (plain `node:http`, i.e. the pure fallback path)
    // demonstrates the shape: it produced `GET /not-found`, `GET /boom`, `GET /large`, `POST /alert`.
    // So the assertion moved to a route that DOES carry parameters, and asserts EQUALITY (not
    // `includes`) against the merged two-level pattern — exactly the form round 3 gave the
    // adapter-alone check. A concrete-URL fallback would read
    // `GET /api/v1/metrics/admin/series/latency.<marker>/summary` and fail this.
    const ADMIN_PATTERN = 'GET /api/v1/metrics/admin/series/:name/summary';
    const adminTxn = allTxns.find((t) => t.name === ADMIN_PATTERN);
    wireCheck(
      `route naming: the two-level-nested admin plugin recorded the FULL pattern (exact match on "${ADMIN_PATTERN}", got ${JSON.stringify(allTxns.filter((t) => t.name.includes('/api/v1/metrics/admin')).map((t) => t.name))})`,
      adminTxn !== undefined,
    );
    // ...and the ONE-level-nested case, so README's "at both depths tested" claim has a falsifiable
    // check behind it at each depth. Same discipline: `/api/v1/metrics/:name/stats` is parameterized, and
    // `api.stats` already hits it with a concrete name, so the fallback form differs from the pattern.
    const STATS_PATTERN = 'GET /api/v1/metrics/:name/stats';
    wireCheck(
      `route naming: the one-level-nested metrics plugin recorded the FULL pattern (exact match on "${STATS_PATTERN}")`,
      allTxns.some((t) => t.name === STATS_PATTERN),
    );

    // ---- first-owner-wins: exactly ONE http.server transaction for the single-hit probe ----
    const singleHitTxns = allTxns.filter(
      (t) => t.op === 'http.server' && t.name.includes('/scenarios/s14/single-hit'),
    );
    wireCheck(
      `first-owner-wins: exactly ONE http.server transaction for a route hit once (found ${singleHitTxns.length})`,
      singleHitTxns.length === 1,
    );

    // ---- F-3: custom setErrorHandler rewrote the response to 200 — does onError still report it? ----
    // Identifier note: this check, its label and its comment named "F-2" for three rounds, but
    // `FINDINGS.md` has NO F-2 heading — that finding was folded into F-3 as its illustration
    // (FINDINGS.md:123, "was filed separately as F-2"), so the printed gate label pointed readers at a
    // section that does not exist. `scenarios.md:244` already said this correctly; this did not.
    // A REAL, recorded check (not a printed observation): this is the class of check the 2026-08-23
    // review found sitting outside the pass/fail gate entirely. It asserts today's actual (buggy)
    // behaviour, so it will FLIP TO FAIL the day @bugsee/fastify gains a `shouldReport` seam that lets
    // an app opt this case out — that flip is the point, see FINDINGS.md F-3.
    const customHandlerBundle = bundles.find((b) =>
      String(b.bundle?.request?.summary ?? '').includes(`s14-custom-handler-throw-${RUN_MARKER}`),
    );
    wireCheck(
      'F-3 (formerly filed as F-2): onError reported the error EVEN THOUGH a custom setErrorHandler rewrote the response to 200',
      customHandlerBundle !== undefined,
    );

    // ---- F-1: does a genuine Fastify SCHEMA VALIDATION 4xx (never thrown by app code) get reported? ----
    // Same discipline as F-3 above: asserts today's actual behaviour, so it fails the day
    // @bugsee/fastify's onError hook starts filtering by status (defaultShouldReport) — see FINDINGS.md.
    // Scoped to THIS run via `http.url` (which carries the `?marker=` every `hit()` appends —
    // server-instrument.ts:259 stamps `sanitizeUrl(info.url)`, query included, and a live run confirms
    // the marker survives). The summary alone is Fastify's own validation message and carries no
    // marker. That matters because this sample runs with `recover: true` + `capturedDataStore: 'disk'`
    // and NO `dataDir` — `.env` sets none, so @bugsee/node's default root applies:
    // `os.tmpdir()/bugsee/<appTokenHash>` (packages/node/src/data-location.ts:7,
    // packages/node/src/launch.ts:433-437), e.g. `/var/folders/.../T/bugsee/<hash>/` on macOS, which
    // survives every run of this sample. (The repo-local `data/` dir is NOT it — an earlier version of
    // this comment named it; it holds only the app's own `db.json` and this script's
    // `verify-run.json`, and `/scenarios/s12/info` correctly reports
    // `dataDir: "(default os.tmpdir()/bugsee)"`.) A PREVIOUS run's undelivered report is recovered
    // from that root at launch and uploaded through THIS run's tee, landing in `bundles`. Not observed
    // in a clean run (a drained run leaves nothing behind), so this closes a latent false-PASS — the
    // check could otherwise go green on a stale bundle while this run reported nothing at all.
    //
    // Scoping status of the sibling checks, ENUMERATED rather than claimed (a previous round claimed
    // "every sibling is run-scoped" and a re-review found two that were not). Stated precisely, in
    // two parts, because an earlier version of THIS comment over-generalized the second half:
    //   (a) Of the checks that select from `bundles` — the stale-bundle hazard's actual surface,
    //       since `bundles` is the only thing a recovered previous-run report can land in — every
    //       check that POSITIVELY selects a bundle is run-scoped: by a summary marker, by `http.url`,
    //       or, for the two S7 network checks, by narrowing to this run's bundles first. The
    //       remainder of the bundle-selecting checks are global NEGATIVES ("no bundle anywhere
    //       contains X"), which a recovered stale bundle can only make stricter, never falsely green.
    //   (b) Three positive selectors are NEITHER run-scoped nor negatives — the two route-naming
    //       transaction checks and the first-owner-wins check above. They are not exceptions to (a),
    //       they are outside it: they select from `transactions`, not `bundles`, and transactions
    //       come from the in-process tee record (src/bugsee-transport.ts:67,291), which is a fresh
    //       in-memory array in a process this script itself just spawned. It starts empty every run,
    //       so there is no stale value for them to match and no marker needed.
    const validationBundle = bundles.find(
      (b) =>
        String(b.bundle?.request?.summary ?? '').includes("must have required property 'value'") &&
        String(b.bundle?.attrs?.['http.url'] ?? '').includes(RUN_MARKER),
    );
    wireCheck(
      'F-1: a schema-validation 400 (never thrown by app code) WAS reported to Bugsee, exactly like a 5xx',
      validationBundle !== undefined,
    );

    // ---- 4xx must NOT report / 5xx MUST — assert the REPORTING, not just the HTTP status the route
    // hardcodes (a check on the status alone cannot fail even if every error started getting reported,
    // or none did) ----
    // Marker-scoped for the same reason as the F-1 check above: `http.route` alone would also match a
    // bundle recovered from a PREVIOUS run. These two fail (rather than falsely pass) in that case, so
    // the exposure is a spurious FAIL rather than a missed regression — still worth closing.
    const routeBundlesThisRun = (route: string): typeof bundles =>
      bundles.filter(
        (b) =>
          b.bundle?.attrs?.['http.route'] === route &&
          String(b.bundle?.attrs?.['http.url'] ?? '').includes(RUN_MARKER),
      );
    const status4xxBundles = routeBundlesThisRun('/scenarios/status/4xx');
    wireCheck(
      'status.4xx-not-reported: ZERO bundles reported for the plain (never-thrown) 400 route',
      status4xxBundles.length === 0,
    );
    const status5xxBundles = routeBundlesThisRun('/scenarios/status/5xx-thrown');
    wireCheck(
      'status.5xx-reported: exactly ONE bundle reported for the thrown-500 route, with the right http.route',
      status5xxBundles.length === 1,
    );
  } finally {
    console.log('\nstopping server...');
    server.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (!server.killed) server.kill('SIGKILL');
  }

  // ---- adapter-alone child (instrumentIncomingRequests:false, setupFastify only) ----
  console.log('\n== adapter-alone child process (instrumentIncomingRequests: false) ==');
  const ADAPTER_ALONE_PORT = '5407';
  const adapterAlone = await runChild('scripts/adapter-alone-child.ts', [ADAPTER_ALONE_PORT]);
  let adapterAloneParsed: {
    httpServerTransactionCount?: number;
    routePattern?: string;
    transactionNames?: string[];
    contextIdCount?: number;
  } = {};
  try {
    const lastLine = adapterAlone.stdout.trim().split('\n').pop() ?? '{}';
    adapterAloneParsed = JSON.parse(lastLine) as typeof adapterAloneParsed;
  } catch {
    // leave empty — the check below fails honestly
  }
  wireCheck(
    'adapter alone: exactly ONE http.server transaction with the node:http patch OFF',
    adapterAloneParsed.httpServerTransactionCount === 1,
  );
  // THE route-naming assertion for the adapter-alone path: the name BUGSEE recorded on its
  // `http.server` transaction. `packages/node/src/server-instrument.ts:153` builds it as
  // `${method} ${route || urlPath(url)}` and :471 re-stamps it at finish, so the concrete-URL
  // fallback (`GET /nested/items/abc/sub/def`) is the exact shape a route-naming regression
  // produces — an equality check against the pattern form fails on it, and on a missing name.
  //
  // This REPLACES what was asserted here for three rounds: `routePattern`, which the child reads off
  // `req.routeOptions.url` — FASTIFY's own property. `@bugsee/fastify` only ever READS it
  // (`dist/index.js:10`, `var routeOf = (req) => req.routeOptions?.url;`) and never writes it, so
  // that value is invariant under every Bugsee route-naming regression: it stays the merged pattern
  // whether the SDK names the transaction correctly, names it by concrete URL, or does not name it
  // at all. Meanwhile the SDK's real answer was being printed by the child and dropped on the floor
  // here — while scenarios.md cited it as this row's Wire evidence. Same class as the `r1`/`r2` and
  // `filterInvoked` checks fixed the previous round: the evidence existed, nothing read it.
  wireCheck(
    `adapter alone: BUGSEE named the http.server transaction with the FULL Fastify pattern (got ${JSON.stringify(adapterAloneParsed.transactionNames)})`,
    adapterAloneParsed.transactionNames?.length === 1 &&
      adapterAloneParsed.transactionNames[0] === 'GET /nested/items/:id/sub/:subId',
  );
  // Kept as a PRECONDITION, not as SDK evidence (see above): it asserts that Fastify itself resolved
  // the nested-prefix pattern and exposed it on `routeOptions.url` — the input `routeOf` reads. If
  // both this and the check above fail, the sample's own route registration broke; if only the check
  // above fails, the SDK stopped using an input that was there.
  wireCheck(
    "adapter alone (precondition, Fastify's own value): routeOptions.url carried the merged nested pattern",
    adapterAloneParsed.routePattern === '/nested/items/:id/sub/:subId',
  );
  wireCheck(
    'adapter alone: exactly ONE context (PLAN §5.14-20 first-owner-wins, no double-instrumentation)',
    adapterAloneParsed.contextIdCount === 1,
  );

  // ---- performanceSampleRate: 0 must suppress EVERY transaction on the wire (S9) ----
  console.log('\n== sample-rate child process (performanceSampleRate: 0) ==');
  const SAMPLE_RATE_PORT = '5408';
  const sampleRateChild = await runChild('scripts/sample-rate-child.ts', [SAMPLE_RATE_PORT, RUN_MARKER]);
  let sampleRateParsed: { bundleArrived?: boolean; httpServerTransactionCount?: number } = {};
  try {
    const lastLine = sampleRateChild.stdout.trim().split('\n').pop() ?? '{}';
    sampleRateParsed = JSON.parse(lastLine) as typeof sampleRateParsed;
  } catch {
    // leave empty — the checks below fail honestly
  }
  wireCheck(
    'performanceSampleRate:0 control: the client/transport pipeline is genuinely alive (a report arrived)',
    sampleRateParsed.bundleArrived === true,
  );
  wireCheck(
    'performanceSampleRate:0: ZERO http.server transactions reached the wire despite 5 real requests',
    sampleRateParsed.httpServerTransactionCount === 0,
  );

  // ---- crash-child processes (exitOnUncaught / unhandledRejections — need a real process exit) ----
  console.log('\n== crash-child processes (exitOnUncaught / unhandledRejections) ==');
  // `runChild` returns BOTH the exit code and the child's merged stdout/stderr, and until this round
  // only the code was read. That made the `uncaught-exit` check the weakest in the gate: a child that
  // died BEFORE `launch()` ever ran — a bad token, a missing .env, an import error — also exits
  // non-zero and read green. `crash-child.ts:27` prints `crash-child ready mode=<mode> marker=<m>`
  // AFTER `launch()` returns, so requiring that line proves the SDK was launched and the exit code
  // describes the crash path under test rather than a boot failure. The marker scopes it to this run.
  const childBooted = (stdout: string, mode: string): boolean =>
    stdout.includes(`crash-child ready mode=${mode} marker=${RUN_MARKER}`);
  const uncaughtExit = await runChild('scripts/crash-child.ts', ['uncaught-exit', RUN_MARKER]);
  wireCheck(
    'S5 exitOnUncaught:true — the child launched Bugsee first (ready line printed), THEN exited non-zero on the uncaught exception',
    childBooted(uncaughtExit.stdout, 'uncaught-exit') &&
      uncaughtExit.code !== 0 &&
      uncaughtExit.code !== null,
  );
  const uncaughtNoExit = await runChild('scripts/crash-child.ts', ['uncaught-no-exit', RUN_MARKER]);
  wireCheck(
    'S5 exitOnUncaught:false — the child launched, survived the exception (printed its still-alive line), then self-exited at code 7',
    childBooted(uncaughtNoExit.stdout, 'uncaught-no-exit') &&
      uncaughtNoExit.stdout.includes('still alive after uncaught exception') &&
      uncaughtNoExit.code === 7,
  );
  const rejectionWarn = await runChild('scripts/crash-child.ts', ['rejection-warn', RUN_MARKER]);
  wireCheck(
    "S5 unhandledRejections:'warn' — the child launched, survived the rejection (printed its still-alive line), then exited on its OWN timer (42)",
    childBooted(rejectionWarn.stdout, 'rejection-warn') &&
      rejectionWarn.stdout.includes('still alive after warn-mode rejection') &&
      rejectionWarn.code === 42,
  );

  // ---- print the table ----
  console.log('\n== pnpm verify — results ==');
  const width = Math.max(...results.map((r) => r.id.length)) + 2;
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL';
    console.log(
      `${status.padEnd(5)} ${r.id.padEnd(width)} ${r.method.padEnd(5)} ${r.path.padEnd(50)} ${r.status}${r.method === '-' ? '' : ` ${r.ms}ms`}${r.note !== undefined ? `  (${r.note})` : ''}`,
    );
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} local checks passed.`);
  if (failed.length > 0) {
    console.log('FAILED:', failed.map((f) => f.id).join(', '));
  }

  // No credential-shaped data may land in the committed artifact — see samples/express-api's own note
  // (its `_debug/transactions` records carry the SDK's own `requestHeaders`, including a real, if
  // short-lived, session `authorization` bearer token). Headers are dropped entirely.
  const withoutHeaders = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutHeaders);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'requestHeaders' && key !== 'responseHeaders')
        .map(([key, v]) => [key, withoutHeaders(v)]),
    );
  };

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
  // ms: 0 — a wire check is a pure assertion over data already collected, it issues no request.
  results.push({ id: `wire:${label}`, method: '-', path: '-', status: ok ? 1 : 0, expected: 1, ok, ms: 0 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
