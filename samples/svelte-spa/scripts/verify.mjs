// The scripted scenario sweep (docs/samples/PLAN.md §3/§6). Drives the REAL app + REAL SDK headlessly
// via Playwright: exercises the Habit tracker app itself, then every control in the Scenario panel, and
// prints a pass/fail table for what could be checked from the browser (LOCAL: no throw / WIRE: the right
// request left the process). Backend (MCP) verification is a SEPARATE step the build agent runs by hand
// against the printed evidence — see scenarios.md. Structurally mirrors samples/react-spa/scripts/verify.mjs
// (the wave-1 reference) including its evidence-based waits (see the comments on waitForBundles/waitForQuiet
// below — samples/FINDINGS.md F-X19 found a fixed-window wait fails in BOTH directions).
import { chromium } from 'playwright';

const BASE = 'http://localhost:5304';
const results = [];

function record(id, description, ok, detail = '') {
  results.push({ id, description, ok, detail });
}

async function click(page, testid, { wait = 300 } = {}) {
  await page.click(`[data-testid="${testid}"]`, { timeout: 5000 });
  await page.waitForTimeout(wait);
}

async function main() {
  // `browser`/`pageErrors` are declared OUTSIDE the try so the finally block can always close the
  // browser, and the report can always print, even if a scenario throws partway through — a run that
  // aborts early must still tell you what it got through, and must always exit the process. (Found the
  // hard way: an earlier version of this script left the browser subprocess connection open on an
  // uncaught throw, which kept the node process alive indefinitely with the report never printed — no
  // exit, no evidence, just a silent hang. Not a bug in the app or the SDK, purely this script's own
  // control flow — see scenarios.md's note on the <svelte:boundary> reset requirement that originally
  // triggered it.)
  let browser;
  const pageErrors = [];
  try {
  browser = await chromium.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true });

  page.on('pageerror', (err) => pageErrors.push(err.message));
  const bugseeCalls = [];
  page.on('response', async (res) => {
    if (!res.url().includes('bugsee.com') && !res.url().includes('amazonaws.com')) return;
    let ok = false;
    try {
      if (res.url().includes('amazonaws.com')) {
        ok = res.status() >= 200 && res.status() < 300;
      } else {
        const json = await res.json();
        ok = json?.ok !== false;
      }
    } catch {
      ok = res.status() >= 200 && res.status() < 300;
    }
    bugseeCalls.push({ url: res.url(), status: res.status(), ok, t: Date.now() });
  });

  // Wire-level tap for the continuous performance upload (PLAN §6.6) — instead of stopping at "not
  // visible via MCP" for render spans / route naming, listen for the actual POST /v2/performance/
  // transactions batches (@bugsee/performance sends `{ transactions: TransactionWire[] }`) the whole run.
  const perfTransactions = [];
  page.on('request', (req) => {
    if (!req.url().includes('/v2/performance/transactions')) return;
    try {
      const body = req.postDataJSON();
      if (Array.isArray(body?.transactions)) perfTransactions.push(...body.transactions);
    } catch {
      // ignore an unparsable body — nothing to record
    }
  });

  let checkpoint = 0;
  const sinceCheckpoint = () => {
    const slice = bugseeCalls.slice(checkpoint);
    checkpoint = bugseeCalls.length;
    return slice;
  };
  /** A bugsee call that created (or attempted) an issue AND SUCCEEDED — the evidence a report actually
   *  arrived, not merely that a request left the process (a collector-side 401/500 no longer passes). */
  const isIssueCall = (c) => c.url.includes('issues') && c.ok;

  // (There used to be a `waitForCalls(match)` here — "wait for an issue call in the window after my
  // click". It is gone: a window cannot tell THIS control's report from a slow PREVIOUS one, and several
  // checks built on it turned out to be satisfiable by an earlier control's traffic. Report-level checks
  // now match the uploaded bundle's own content — see `waitForBundles`/`bySummary` below.)

  /**
   * Wait until bugsee traffic SETTLES — the right wait for an upper-bound assertion (see file banner).
   *
   * Returns `{ calls, reason, waitedMs }`, not a bare slice. The `reason` is load-bearing: a wait that
   * exits by TIMEOUT has NOT observed quiet, it has merely run out of budget with traffic still in
   * flight, and any caller whose claim depends on "nothing is in flight any more" is then asserting
   * something it did not measure. That was not hypothetical — see the storm-settle note near the S4
   * check for the five-run measurement that exposed it. Callers that make an upper-bound or
   * drain-completed claim MUST check `reason === 'quiet'`; `waitedMs` is reported so the run says how
   * long the settle actually took instead of leaving it invisible.
   */
  const waitForQuiet = async ({ quietMs = 1500, timeout = 25_000, poll = 100 } = {}) => {
    const started = Date.now();
    const deadline = started + timeout;
    let lastSeen = bugseeCalls.length;
    let lastChange = Date.now();
    for (;;) {
      if (bugseeCalls.length !== lastSeen) {
        lastSeen = bugseeCalls.length;
        lastChange = Date.now();
      }
      const quiet = Date.now() - lastChange >= quietMs;
      if (quiet || Date.now() >= deadline) {
        const calls = bugseeCalls.slice(checkpoint);
        checkpoint = bugseeCalls.length;
        return { calls, reason: quiet ? 'quiet' : 'timeout', waitedMs: Date.now() - started };
      }
      await page.waitForTimeout(poll);
    }
  };

  /** Every bundle src/bugsee-transport.ts's tee has parsed so far, read out of the page. */
  const readBundles = () =>
    page.evaluate(() => window.__bugseeTee?.getCapturedBundles() ?? []);

  /**
   * Bundle-level (WIRE) evidence, via src/bugsee-transport.ts's tee — it forwards every SDK call to
   * real staging verbatim while recording a parsed copy of each uploaded bundle in the page (a real
   * unzip of the ZIP PUT to S3, not a text scan). Polls until at least `min` bundles matching `matchFn`
   * show up, or `timeout` elapses (absence is itself a valid, asserted-on result — e.g. proving a
   * vetoed report never produces a bundle at all). Needed because the S8 in-app filter-log checks only
   * prove the filter CALLBACK ran, not that the SDK actually applied its return value to what got
   * uploaded — PLAN §6.6.
   *
   * `min` is what makes an UPPER-bound assertion honest. Returning as soon as the expected count is
   * reached means "exactly N" can only ever observe N — a regression to N+1 stays invisible unless the
   * extra one happens to land inside the same poll tick. Callers asserting `=== N` therefore pass
   * `min: N + 1`, which keeps polling for the full window and can actually see the extra one.
   *
   * `delivered` is what makes an EXISTENCE assertion honest, and it is the general form of what
   * `bundle-upload-status-wire` (bottom of this file) used to do for four hand-named bundles.
   * `getCapturedBundles()` admits a record the moment its body PARSED, whatever S3 answered — so every
   * `... reaches the wire` row above was really asserting `the SDK BUILT and SENT this bundle`, not that
   * it LANDED. An expired presigned URL (403) or an S3 5xx would leave ~30 of them green with nothing
   * reaching the backend. Defaulting to `delivered: true` means each of those rows now requires a 2xx
   * PUT, at the source, instead of a separate check covering a hand-picked four.
   *
   * `delivered: 'any'` is the deliberate exception, for the three callers whose claim is about how many
   * bundles the SDK BUILT rather than how many arrived — a veto absence, the dedupe upper bound, the S12
   * recovery bound. Filtering those by status would let a bundle that was wrongly built but failed to
   * upload satisfy an assertion that it was never built at all, which inverts what they test. Their
   * landing is asserted separately, by `bundle-upload-status-wire`.
   */
  const isDelivered = (b) => typeof b.status === 'number' && b.status >= 200 && b.status < 300;
  const waitForBundles = async (matchFn, { timeout = 20_000, min = 1, poll = 200, delivered = true } = {}) => {
    const deadline = Date.now() + timeout;
    const admits = delivered === 'any' ? matchFn : (b) => matchFn(b) && isDelivered(b);
    for (;;) {
      const matched = (await readBundles()).filter(admits);
      if (matched.length >= min || Date.now() >= deadline) return matched;
      await page.waitForTimeout(poll);
    }
  };
  const waitForBundle = async (matchFn, options = {}) =>
    (await waitForBundles(matchFn, options))[0];

  /**
   * The discriminator every report-level check uses: match the UPLOADED bundle by the exact
   * `request.json.summary` the SDK wrote (which is the reported error's own message).
   *
   * This replaced a family of checks that asserted "an `/v2/issues` call succeeded inside the window
   * after I clicked" — a form that cannot distinguish THIS control's report from a slow PREVIOUS one.
   * It was not theoretical: the `arm-boundary` click fires its own report via `<svelte:boundary
   * onerror>`, and that report's `/v2/issues` response was measured landing 1991ms after the click,
   * while the next check's window opened ~800ms after it. Both `svelte-report-error` and
   * `svelte-error-boundary-global` were satisfiable by that earlier report, so a no-op
   * `reportSvelteError` would still have passed. Matching the bundle's own content is immune: it
   * names the specific incident, in any order, however late it arrives.
   */
  const bySummary = (summary) => (b) => b.bundle?.request?.summary === summary;

  // Audit of the remaining window-scoped checks (every check in this file was re-read for the defect
  // above). Three still measure bugsee traffic inside a time window. TWO of them are pure ABSENCE
  // assertions, where the failure mode is inverted — unrelated traffic drifting into the window can only
  // make them FAIL, never pass a no-op — and each has a positive control, so "nothing arrived" can't
  // mean "nothing works":
  //   * `s8-report-veto`     — 0 issue calls after the veto click (drained with waitForQuiet first);
  //                            positive control = `s8-report-mutate-wire`, the same handler admitting.
  //   * `s9-sample-rate-0`   — `scenario.manual` absent from the perf tap; positive control =
  //                            `s9-sample-rate-1`, the identical call at rate 1.
  // The THIRD is not an absence assertion and an earlier version of this block wrongly filed it as one:
  //   * `s4-storm`           — a two-sided BOUND (`> 0 && < 200`) on admitted calls. Its UPPER half is
  //                            an absence claim with the inverted failure mode above; its LOWER half
  //                            (`stormCalls.length > 0`) is a PRESENCE claim over a window matched only
  //                            by `isIssueCall`, i.e. it is the one presence assertion in this file that
  //                            is NOT content-matched, and unrelated issue traffic drifting into the
  //                            window could in principle satisfy it. It is kept in that form on purpose:
  //                            the storm's 200 reports are indistinguishable from each other by design
  //                            and the claim being made IS about the count, which is what a window
  //                            measures. It is also the last control in the sweep to FIRE reports, which
  //                            bounds but does not eliminate the drift: `arm-global`'s report fires about
  //                            a second earlier and can still be in flight when the storm window opens,
  //                            so the honest statement is "at most a handful of stragglers from the
  //                            immediately preceding controls", not "the only traffic that can drift in is
  //                            the storm's own" (which an earlier version of this comment claimed, and the
  //                            code does not support). Harmless at the measured ~97 against a `> 0 &&
  //                            < 200` bound — a straggler cannot move 97 across either edge — and
  //                            `s4-storm-settle` separately asserts the window closed on genuine quiet
  //                            rather than on its deadline.
  // Every OTHER presence assertion is content-matched (`bySummary`) or reads a specific named span/entry.

  let errorCheckpoint = 0;
  const newPageErrors = () => {
    const count = pageErrors.length - errorCheckpoint;
    errorCheckpoint = pageErrors.length;
    return count;
  };

  // ---------------------------------------------------------------------------------------- App smoke
  await page.goto(`${BASE}/#/habits`, { waitUntil: 'networkidle' });
  const habitCount = await page.locator('.habit-tile').count();
  record('app-habits-list', 'Habits index lists seeded habits', habitCount >= 3, `${habitCount} habits`);

  const runTag = Date.now().toString(36);
  const habitName = `Verify habit ${runTag}`;
  await page.fill('[data-testid="new-habit-name"]', habitName);
  await page.click('[data-testid="add-habit"]');
  await page.waitForTimeout(500);
  const created = await page.locator('.habit-tile', { hasText: habitName }).count();
  record('app-create-habit', 'Create habit (form + API)', created === 1);

  const newTile = page.locator('.habit-tile', { hasText: habitName });
  const toggleBtn = newTile.locator('button');
  await toggleBtn.click();
  await page.waitForTimeout(500);
  const toggleText = await toggleBtn.textContent();
  record('app-toggle-checkin', 'Toggle today\'s check-in (optimistic + API)', toggleText?.includes('Done today') ?? false, toggleText ?? '');

  await page.click(`.habit-tile >> text=${habitName}`);
  await page.waitForSelector('[data-testid="habit-heatmap"]', { timeout: 5000 });
  const heatCells = await page.locator('[data-testid="habit-heatmap"] .cell').count();
  record('app-habit-detail', 'Habit detail route (/#/habits/:id) renders the heat map', heatCells === 84, `${heatCells} cells`);

  // NOTE: this router is HASH-based, so a `page.goto` to a hash-only-different URL is a SAME-DOCUMENT
  // navigation — Playwright's `waitUntil: 'networkidle'` resolves on that immediately (there is no
  // document load to wait for), well before the page's own client-side `onMount` fetch resolves. An
  // earlier version of this script relied on networkidle here and got a false FAIL (0 cells/rows) purely
  // from the race, not from an app bug — `waitForSelector` on the actual expected content is the fix.
  await page.goto(`${BASE}/#/calendar`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="calendar-heatmap"] .cell', { timeout: 5000 });
  const calendarCells = await page.locator('[data-testid="calendar-heatmap"] .cell').count();
  record('app-calendar', 'Calendar page renders a heat map', calendarCells === 84, `${calendarCells} cells`);

  await page.goto(`${BASE}/#/stats`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="stats-table"] tbody tr', { timeout: 5000 });
  const statsRows = await page.locator('[data-testid="stats-table"] tbody tr').count();
  record('app-stats', 'Stats page lists a row per habit', statsRows >= 3, `${statsRows} rows`);

  // ---------------------------------------------------------------------------------- Settings (S2)
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
  await page.fill('[data-testid="user-id-input"]', 'verify-script-user@bugsee.dev');
  await click(page, 'set-user-id');
  const setUserIdText = await page.locator('[data-testid="current-user-id"]').textContent();
  record('s2-set-user-id', 'setUserIdentifier — getUserIdentifier() reflects it', Boolean(setUserIdText?.includes('verify-script-user@bugsee.dev')), setUserIdText ?? '');

  await page.selectOption('[data-testid="attr-type"]', 'string');
  await page.fill('[data-testid="attr-key"]', 'theme');
  await page.fill('[data-testid="attr-value"]', 'dark');
  await click(page, 'set-attribute');
  await page.selectOption('[data-testid="attr-type"]', 'number');
  await page.fill('[data-testid="attr-key"]', 'seats');
  await page.fill('[data-testid="attr-value"]', '5');
  await click(page, 'set-attribute');
  await page.selectOption('[data-testid="attr-type"]', 'boolean');
  await page.fill('[data-testid="attr-key"]', 'beta');
  await page.fill('[data-testid="attr-value"]', 'true');
  await click(page, 'set-attribute');
  await page.selectOption('[data-testid="attr-type"]', 'string[]');
  await page.fill('[data-testid="attr-key"]', 'tags');
  await page.fill('[data-testid="attr-value"]', 'alpha, beta, gamma');
  await click(page, 'set-attribute');
  const attrsDump = await page.locator('[data-testid="attrs-dump"]').textContent();
  record('s2-attributes', 'setAttribute — string/number/boolean/string[]', Boolean(attrsDump?.includes('gamma')), attrsDump ?? '');

  // `getAttribute` (singular) — declared in the catalog but never called before this fix.
  await click(page, 'get-attribute');
  const singleAttrText = await page.locator('[data-testid="single-attr-dump"]').textContent();
  record('s2-get-attribute', "getAttribute('tags') returns the value just set", Boolean(singleAttrText?.includes('gamma')), singleAttrText ?? '');

  // `clearAttribute` — the attr-key input still holds 'tags' from the loop above.
  await click(page, 'clear-attribute');
  const afterClearOne = await page.locator('[data-testid="attrs-dump"]').textContent();
  record(
    's2-clear-attribute',
    "clearAttribute('tags') removes just that key (others survive)",
    Boolean(afterClearOne && !afterClearOne.includes('tags') && afterClearOne.includes('theme')),
    afterClearOne ?? '',
  );

  await click(page, 'clear-all-attributes');
  const afterClearAll = await page.locator('[data-testid="attrs-dump"]').textContent();
  record('s2-clear-all-attributes', 'clearAllAttributes empties the attribute set', Boolean(afterClearAll?.includes('{}')), afterClearAll ?? '');

  await click(page, 'clear-user-id');
  const afterClearUserId = await page.locator('[data-testid="current-user-id"]').textContent();
  record('s2-clear-user-id', 'clearUserIdentifier — getUserIdentifier() reflects null', Boolean(afterClearUserId?.includes('null')), afterClearUserId ?? '');
  // Restore the identifier so every scenario after this still reports one (the input still holds it).
  await click(page, 'set-user-id');

  await click(page, 'toggle-drawer');
  await page.fill('[data-testid="s11-masked-field"]', 'this should be masked in the replay');
  await page.fill('[data-testid="s11-unmask-field"]', 'this carries the .bugsee-unmask opt-out mark');
  const drawerVisible = await page.locator('[data-testid="settings-drawer"]').count();
  record('settings-drawer', 'Settings drawer opens and holds the S11 masking-target fields', drawerVisible === 1);

  // ---------------------------------------------------------------------------------- Scenario panel
  await page.goto(`${BASE}/#/scenarios`, { waitUntil: 'networkidle' });

  // S1: relaunch demos FIRST (each rebuilds the client) — minimal, then full (restores the working
  // client for everything below).
  sinceCheckpoint();
  newPageErrors();
  await click(page, 's1-relaunch-minimal', { wait: 0 });
  const minimalCalls = (await waitForQuiet()).calls;
  const isLaunchedAfterMinimal = await page.locator('[data-testid="is-launched"]').textContent();
  record(
    's1-relaunch-minimal',
    'relaunch with no capture/behaviour options set — every SDK default in force (NOT a literal launch(token, {}): relaunch() always injects endpoint/appId/appVersion/appBuild/onError, doLaunch adds carrier)',
    newPageErrors() === 0 && isLaunchedAfterMinimal?.trim() === 'true',
    `calls: ${JSON.stringify(minimalCalls.map((c) => c.status))}; isLaunched=${isLaunchedAfterMinimal}`,
  );

  newPageErrors();
  await click(page, 's1-relaunch-full', { wait: 800 });
  const isLaunchedAfterFull = await page.locator('[data-testid="is-launched"]').textContent();
  record(
    's1-relaunch-full',
    'launch(FULL_LAUNCH_OPTIONS)',
    newPageErrors() === 0 && isLaunchedAfterFull?.trim() === 'true',
    isLaunchedAfterFull ?? '',
  );

  const isLaunchedText = await page.locator('[data-testid="is-launched"]').textContent();
  record('s1-is-launched', 'isLaunched() reflects the launched client', isLaunchedText?.trim() === 'true', isLaunchedText ?? '');

  await click(page, 's1-duplicate-launch');
  const duplicateStatus = await page.locator('[data-testid="s1-duplicate-launch-status"]').textContent();
  record(
    's1-duplicate-launch',
    'second launch() on the same carrier is ignored',
    Boolean(duplicateStatus?.includes('same instance returned: true')),
    duplicateStatus ?? '',
  );

  // S3 manual telemetry — no direct wire signal exists for these (they're captured into the local ring,
  // not individually reported), so the real, obtainable assertion is: no throw. S5 below independently
  // proves this same page-error mechanism DOES detect a real failure (a positive control for this
  // negative one).
  newPageErrors();
  for (const level of ['error', 'warning', 'info', 'debug', 'verbose']) {
    await click(page, `s3-log-${level}`, { wait: 100 });
  }
  record('s3-log', 'log() at every LogLevel', newPageErrors() === 0);

  newPageErrors();
  await click(page, 's3-event-params');
  await click(page, 's3-event-no-params');
  record('s3-event', 'event() with/without params', newPageErrors() === 0);

  newPageErrors();
  await click(page, 's3-trace');
  record('s3-trace', 'trace(name, value)', newPageErrors() === 0);

  newPageErrors();
  await click(page, 's3-breadcrumb');
  record('s3-breadcrumb', 'addBreadcrumb() — every field', newPageErrors() === 0);

  // S4 exceptions. Each control is matched to ITS OWN uploaded bundle by `request.json.summary`, not to
  // "some issue call arrived in my window" — see the note on `bySummary` above for why a window is not
  // enough. A bundle PUT also implies the `/v2/issues` call that minted its presigned URL succeeded, so
  // this is strictly stronger evidence than the call-count form it replaced, not just better scoped.
  // NB: a non-Error throwable's summary is whatever the SDK stringified it to — `[object Object]` for
  // the object case and `null` for the null case (dumped with DEBUG_BUNDLES, not guessed).
  sinceCheckpoint();
  await click(page, 's4-error', { wait: 0 });
  record('s4-error', 'logException(new Error) — its own bundle reaches the wire', (await waitForBundle(bySummary('S4: logException(new Error(...))'))) !== undefined);
  await click(page, 's4-string', { wait: 0 });
  record('s4-string', 'logException(string) — its own bundle reaches the wire', (await waitForBundle(bySummary('S4: a plain string throwable'))) !== undefined);
  await click(page, 's4-object', { wait: 0 });
  record('s4-object', 'logException(object) — its own bundle reaches the wire', (await waitForBundle(bySummary('[object Object]'))) !== undefined);
  await click(page, 's4-null', { wait: 0 });
  record('s4-null', 'logException(null) — its own bundle reaches the wire', (await waitForBundle(bySummary('null'))) !== undefined);
  await click(page, 's4-cause', { wait: 0 });
  record('s4-cause', 'logException with chained cause — its own bundle reaches the wire', (await waitForBundle(bySummary('S4: wrapped error'))) !== undefined);
  await click(page, 's4-options', { wait: 0 });
  const optionsBundle = await waitForBundle(bySummary('S4: logException with LogExceptionOptions'));
  record('s4-options', 'logException with LogExceptionOptions — its own bundle reaches the wire', optionsBundle !== undefined);
  // `request.json` is parsed in full by the tee but only `.summary`/`.labels` were ever read out of it.
  // The OPTIONS this control passes are right there: `labels` is the discriminating one (nothing else in
  // the run carries these two), `source.mechanism` is `mechanism`, and `severity: 3` is `'high'`
  // (protocol Severity.High). The severity half is stated for completeness and is NOT independent
  // evidence — 3 is also what an un-optioned report carries, measured on the capture-probe bundle in the
  // same run — so the check would still fail on a `labels`/`mechanism` regression and would not on a
  // severity one. Making severity discriminating needs a second control at a non-default severity, which
  // is not worth its own report.
  const optionsRequest = optionsBundle?.bundle?.request;
  record(
    's4-options-wire',
    'LogExceptionOptions reach the UPLOADED bundle\'s request.json — labels + source.mechanism (severity 3 = "high" is also the default, so it is reported, not relied on)',
    Array.isArray(optionsRequest?.labels) &&
      optionsRequest.labels.includes('scenario-panel') &&
      optionsRequest.labels.includes('s4-options') &&
      optionsRequest?.source?.mechanism === 'programmatic' &&
      optionsRequest?.severity === 3,
    JSON.stringify({ labels: optionsRequest?.labels, source: optionsRequest?.source, severity: optionsRequest?.severity }),
  );
  await click(page, 's4-dedupe', { wait: 0 });
  // `min: 2` deliberately: this is an upper bound, so keep polling the whole window instead of
  // returning the moment the expected single bundle shows up (see `waitForBundles`).
  // `delivered: 'any'`: the claim is about how many bundles the SDK BUILT for one deduped incident, so a
  // second bundle that was built but failed to upload must still count against it (see `waitForBundles`).
  const dedupeBundles = await waitForBundles(bySummary('S4: same instance twice — should dedupe'), { min: 2, timeout: 12_000, delivered: 'any' });
  record('s4-dedupe', 'same instance twice — should dedupe (exactly 1 uploaded bundle, not 0 and not 2)', dedupeBundles.length === 1, `${dedupeBundles.length} uploaded bundle(s)`);
  // s4-storm runs LAST (deliberately) — see the note by the storm block at the bottom of this script.

  // S5 crashes
  sinceCheckpoint();
  newPageErrors();
  await click(page, 's5-uncaught', { wait: 0 });
  // The SDK half is asserted DIRECTLY. This check previously read
  // `newPageErrors() > 0 || uncaughtCalls.some(isIssueCall)`, and `s5Uncaught` throws inside a
  // `setTimeout`, so Playwright's own `pageerror` event ALWAYS fires: the left disjunct was
  // tautologically true, short-circuited, and the SDK was never required to do anything at all. The
  // page-error count is kept as reported DETAIL (it is a genuine positive control for the S3/S6
  // no-throw checks elsewhere), never as an alternative to the evidence.
  const uncaughtBundle = await waitForBundle(bySummary('S5: uncaught exception outside any try/catch'));
  const uncaughtPageErrors = newPageErrors();
  record('s5-uncaught', 'uncaught exception -> window.onerror -> its own bundle reaches the wire', uncaughtBundle !== undefined, `${uncaughtPageErrors} uncaught page error(s) also seen by the browser`);
  await click(page, 's5-rejection', { wait: 0 });
  record('s5-rejection', 'unhandled promise rejection — its own bundle reaches the wire', (await waitForBundle(bySummary('S5: unhandled promise rejection'))) !== undefined);

  // S6 console
  newPageErrors();
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    await click(page, `s6-${m}`, { wait: 100 });
  }
  await click(page, 's6-circular');
  record('s6-console', 'console.* incl. multi-arg + circular object (no throw from the interceptor)', newPageErrors() === 0);

  // S7 network — one real assertion per control (reading the exact body the app read off `s7-status`),
  // not one decorative assertion covering all eleven.
  await click(page, 's7-get');
  let s7Text = await page.locator('[data-testid="s7-status"]').textContent();
  record('s7-get', 'fetch GET — app reads the real response body', Boolean(s7Text?.includes('GET ->') && s7Text.includes('"ok":true')), s7Text ?? '');

  await click(page, 's7-post-json');
  s7Text = await page.locator('[data-testid="s7-status"]').textContent();
  record('s7-post-json', 'fetch POST JSON — body round-trips through the local API', Boolean(s7Text?.includes('"hello":"world"') && s7Text.includes('"n":42')), s7Text ?? '');

  await click(page, 's7-post-text');
  s7Text = await page.locator('[data-testid="s7-status"]').textContent();
  record('s7-post-text', 'fetch POST text', Boolean(s7Text?.includes('POST text -> echo: plain text body')), s7Text ?? '');

  await click(page, 's7-4xx');
  s7Text = await page.locator('[data-testid="s7-status"]').textContent();
  record('s7-4xx', 'fetch 4xx', Boolean(s7Text?.includes('4xx -> status 404')), s7Text ?? '');

  await click(page, 's7-5xx');
  s7Text = await page.locator('[data-testid="s7-status"]').textContent();
  record('s7-5xx', 'fetch 5xx', Boolean(s7Text?.includes('5xx -> status 500')), s7Text ?? '');

  await click(page, 's7-connfail', { wait: 700 });
  s7Text = await page.locator('[data-testid="s7-status"]').textContent();
  record('s7-connfail', 'connection failure — app catches it (not "unexpectedly succeeded")', Boolean(s7Text?.includes('connfail -> caught:')), s7Text ?? '');

  await click(page, 's7-large-body');
  s7Text = await page.locator('[data-testid="s7-status"]').textContent();
  record('s7-large-body', 'body over maxNetworkBodySize — app still reads the FULL 64KB body', Boolean(s7Text?.includes('app read 65536 bytes')), s7Text ?? '');

  await click(page, 's7-no-content-type');
  s7Text = await page.locator('[data-testid="s7-status"]').textContent();
  record('s7-no-content-type', 'response with no Content-Type', Boolean(s7Text?.includes('no content-type on this response')), s7Text ?? '');

  await click(page, 's7-xhr');
  s7Text = await page.locator('[data-testid="s7-status"]').textContent();
  record('s7-xhr', 'XHR (different code path from fetch)', Boolean(s7Text?.includes('XHR ->') && s7Text.includes('"ok":true')), s7Text ?? '');

  // A genuine ROUND TRIP, not just "a message arrived": the server greets every connection with its own
  // `{"type":"welcome",...}` before the app has sent anything (server/api-server.mjs's
  // `wss.on('connection')`), so the previous assertion — `includes('WS message ->')` — was satisfied by
  // merely opening the socket. The app now reports only the message carrying the per-click nonce it
  // sent, so `WS echo ->` plus that nonce means the payload really went out and came back.
  await click(page, 's7-ws', { wait: 500 });
  s7Text = await page.locator('[data-testid="s7-status"]').textContent();
  record(
    's7-ws',
    'WebSocket ROUND-TRIP — the app\'s own nonce comes back from the server (not the connection greeting)',
    Boolean(s7Text?.includes('WS echo ->') && s7Text.includes('"scenario":"s7-ws"') && /"nonce":"s7ws-\d+-/.test(s7Text)),
    s7Text ?? '',
  );

  await click(page, 's7-sse', { wait: 1500 });
  s7Text = await page.locator('[data-testid="s7-status"]').textContent();
  record('s7-sse', 'SSE — 5 real server-sent events read', Boolean(s7Text?.includes('SSE event #5 ->')), s7Text ?? '');

  // `navigator.sendBeacon` — a NEW interceptor in @bugsee/capture that no sample had ever exercised, so
  // it reached this sweep with zero empirical validation. It is inert unless the app actually calls
  // `navigator.sendBeacon`, which nothing in this app did until the control above it was added.
  //
  // The LOCAL half asserts a real ROUND TRIP, not the browser's queue-acceptance boolean: `sendBeacon()`
  // returns true for "the user agent took it", never "the server got it", so the panel reads the payload
  // back off the server (`/api/scenario/beacon-log`) and reports both. That matters for the falsification
  // below — restoring the native `sendBeacon` leaves this LOCAL row green (the beacon still reaches the
  // server) while the WIRE row goes red, which is what isolates the INTERCEPTOR from the transport.
  const S7_BEACON_PAYLOAD = 'S7-BEACON-PAYLOAD-MARKER';
  await click(page, 's7-beacon', { wait: 300 });
  s7Text = await page.locator('[data-testid="s7-status"]').textContent();
  record(
    's7-beacon',
    'navigator.sendBeacon — the user agent queues it AND the payload actually reaches the server (read back over a separate GET, not inferred from sendBeacon\'s return value)',
    Boolean(s7Text?.includes('queued=true') && s7Text.includes('tag=s7-beacon') && s7Text.includes(`body=${S7_BEACON_PAYLOAD}`)),
    s7Text ?? '',
  );

  // ---- Wire-depth evidence for S3 `log()` / S6 `console.*` / S7 XHR + WebSocket (PLAN §6.6).
  // None of those has a wire signal of its own — nothing leaves the process when they happen; they sit
  // in the local capture ring until the next REPORT's bundle carries them. The checks above are
  // therefore LOCAL by construction (`newPageErrors() === 0`, or the DOM status the app itself wrote),
  // and scenarios.md used to mark several of them W anyway, which nothing supported. Fire one report
  // whose bundle is the ring as it stands right now, unzip it, and assert the actual entries.
  await click(page, 'capture-wire-probe', { wait: 0 });
  const CAPTURE_PROBE_SUMMARY = 'WIRE: capture probe (log/console/xhr/ws ring contents)';
  const probeBundle = await waitForBundle(bySummary(CAPTURE_PROBE_SUMMARY));
  const probeLogs = probeBundle?.bundle?.logMessages ?? [];
  const probeNetwork = probeBundle?.bundle?.network ?? [];
  const probeRequest = probeBundle?.bundle?.request ?? {};
  const probeFiles = probeBundle?.bundle?.files ?? [];

  // ---- Fields the tee ALREADY parses that no check was reading (the round-4 sweep).
  //
  // `src/bugsee-transport.ts` parses five things out of every uploaded bundle — `files`, `request`,
  // `logMessages`, `breadcrumbs`, `network` — and three of them were only partly read: `files` by
  // nothing at all, `request` by `.summary` and `.labels` alone, `breadcrumbs` by the S8 redaction check
  // alone. Everything asserted below was already sitting unzipped in the SAME probe bundle the checks
  // above read; none of it costs an extra report or an extra request.

  // S1 at wire depth. `launch(FULL_LAUNCH_OPTIONS)` was asserted only by `isLaunched()` being true — the
  // options themselves are echoed back in `environment.sdk.options` under their canonical
  // `com:bugsee:option:*` identifiers (the dotted names sent colon-separated, since the server treats
  // dots as nesting). The three NUMERIC ones are what make this check bite: they carry this sample's
  // deliberately non-default values (2048 / 120 / 10), so an option silently not reaching the SDK — or
  // reaching it under the wrong identifier — fails here rather than passing as "launched: true".
  const wireOptions = probeRequest?.environment?.sdk?.options ?? {};
  record(
    's1-launch-options-wire',
    'FULL_LAUNCH_OPTIONS actually reach the wire — the UPLOADED bundle\'s environment.sdk.options carries the canonical com:bugsee:option:* identifiers with THIS sample\'s non-default values (body-size-limit 2048, duration 120, data-size 10) and its capture flags',
    wireOptions['com:bugsee:option:capture:network:body-size-limit'] === 2048 &&
      wireOptions['com:bugsee:option:config:duration'] === 120 &&
      wireOptions['com:bugsee:option:config:data-size'] === 10 &&
      wireOptions['com:bugsee:option:capture:logs'] === true &&
      wireOptions['com:bugsee:option:capture:network'] === true &&
      wireOptions['com:bugsee:option:capture:network:bodies'] === true &&
      wireOptions['com:bugsee:option:capture:network:body-without-type'] === true &&
      wireOptions['com:bugsee:option:capture:system-traces'] === true &&
      wireOptions['com:bugsee:option:capture:system-events'] === true &&
      wireOptions['com:bugsee:option:capture:interactions'] === true &&
      wireOptions['com:bugsee:option:capture:view-hierarchy'] === true &&
      wireOptions['com:bugsee:option:detect:crash'] === true,
    JSON.stringify(wireOptions),
  );
  record(
    's1-app-identity-wire',
    'appId/appVersion/appBuild/sdkVersion from the launch options reach the UPLOADED bundle\'s environment (this is what an issue is filed against, and nothing asserted it)',
    probeRequest?.environment?.app?.package_id === 'com.bugsee.sample.svelte-spa' &&
      probeRequest?.environment?.app?.version === '1.0.0' &&
      probeRequest?.environment?.app?.build === '1' &&
      probeRequest?.environment?.sdk?.version === '0.1.0' &&
      probeRequest?.environment?.sdk?.type === 'javascript',
    JSON.stringify({ app: probeRequest?.environment?.app, sdk: { version: probeRequest?.environment?.sdk?.version, type: probeRequest?.environment?.sdk?.type } }),
  );
  // S2 at wire depth: `s2-set-user-id` asserted only that the SDK's own GETTER echoed the value back,
  // which a client that stored it and never sent it would pass. It travels as `request.json.email`.
  //
  // The expected value is the SAMPLE's identifier, not the one the S2 block set: the S1 relaunch controls
  // run between them, and `relaunch()` (src/bugsee.ts) re-applies `setUserIdentifier(SAMPLE_USER_ID)` on
  // the fresh client — a relaunched client has no state of its own. So this asserts the identifier the
  // LAST `setUserIdentifier` call put in place, which is exactly the claim.
  record(
    's2-user-id-wire',
    'setUserIdentifier reaches the wire — the UPLOADED bundle\'s request.json carries it as `email` (the getter alone would pass for a client that stored it and never sent it)',
    probeRequest?.email === 'sample-user@bugsee.dev',
    JSON.stringify({ email: probeRequest?.email ?? null }),
  );
  // S3 at wire depth: the breadcrumbs file was read by exactly one check (S8's redaction), so the
  // every-field crumb this run adds was never actually verified to survive the trip. Asserted field by
  // field — a crumb that arrived with only its message would otherwise read as a pass.
  const everyFieldCrumb = probeBundle?.bundle?.breadcrumbs?.find((c) => c.message === 'S3: addBreadcrumb every field');
  record(
    's3-breadcrumb-wire',
    'addBreadcrumb() -> EVERY field (type/category/message/level/data) survives into the UPLOADED bundle\'s breadcrumbs file, not just the message',
    everyFieldCrumb?.type === 'user' &&
      everyFieldCrumb?.category === 'scenario-panel' &&
      everyFieldCrumb?.level === 'info' &&
      everyFieldCrumb?.data?.control === 's3-breadcrumb' &&
      typeof everyFieldCrumb?.timestamp === 'number',
    JSON.stringify(everyFieldCrumb ?? null),
  );
  // The bundle's own FILE MANIFEST — parsed by the tee since it was written and referenced by nothing.
  // It is the cheapest possible check that each capture stream FULL_LAUNCH_OPTIONS switches on actually
  // produced a file: `captureSystemTraces` -> traces.system.json, `captureSystemEvents` ->
  // events.system.json, `captureInteractions` -> events.user.json, `captureViewHierarchy` ->
  // viewtree.json, `replay` -> replay.bin, `trace()` -> traces.user.json, plus the logs/network/
  // breadcrumbs files the content checks above read. A stream going dark drops its file.
  //
  // `performance.json` is DELIBERATELY NOT in this list, and the omission is measured, not assumed: it
  // was present in the probe bundle on one run here and absent on the next, because performance data has
  // its OWN continuous `/v2/performance/transactions` upload (the `perfTransactions` tap above) and
  // whether any transaction happens to be un-flushed at bundle time is a race, not a signal. Asserting
  // it would have made this check flap for a reason that says nothing about capture.
  const EXPECTED_FILES = [
    'request.json', 'manifest.json', 'apptoken', 'logs.json', 'network.json', 'breadcrumbs',
    'traces.system.json', 'events.system.json', 'events.user.json', 'traces.user.json',
    'viewtree.json', 'replay.bin', 'crash.json',
  ];
  //
  // `replay.bin` stays in the list but its MEANING narrowed when recording became the default: it is now
  // evidence that the recorder is alive, NOT that `FULL_LAUNCH_OPTIONS.replay` was read (an SDK ignoring
  // that key entirely produces the same file). The option path is asserted separately, and only where it
  // is still observable — see the `s11-replay-off` / `s11-replay-default-on` pair.
  const missingFiles = EXPECTED_FILES.filter((f) => !probeFiles.includes(f));
  record(
    'bundle-files-wire',
    'the UPLOADED bundle carries a file for EVERY capture stream that is running (system traces/events, interactions, view hierarchy, replay, logs, network, breadcrumbs) — a stream going dark drops its file',
    missingFiles.length === 0,
    `missing: ${JSON.stringify(missingFiles)}; present: ${JSON.stringify(probeFiles)}`,
  );
  // Maintenance affordance (same shape as DEBUG_BUNDLES / DEBUG_S12): dump the probe bundle's real
  // network.json entries. The wire assertions below match on exact shapes (`mechanism`/`type`/`status`/
  // `custom.no_body_reason`) written by packages/capture's interceptors — this is how you find out what
  // those actually are for a given control instead of guessing at them.
  if (process.env.DEBUG_NETWORK) {
    console.log('\n--- DEBUG probe bundle network entries ---');
    for (const n of probeNetwork) {
      console.log(
        JSON.stringify({
          mechanism: n.mechanism,
          type: n.type,
          method: n.method,
          url: n.url,
          status: n.status,
          direction: n.direction,
          event: n.event,
          override: n.override,
          no_body_reason: n.custom?.no_body_reason,
          body: typeof n.custom?.body === 'string' ? n.custom.body.slice(0, 120) : n.custom?.body,
        }),
      );
    }
  }
  record(
    's3-log-wire',
    'log() at every LogLevel -> all 5 messages reach the wire in the UPLOADED bundle\'s logs.json',
    ['error', 'warning', 'info', 'debug', 'verbose'].every((level) => probeLogs.includes(`S3: log() at level ${level}`)),
    `${probeLogs.length} log message(s) in the probe bundle`,
  );
  // `console.trace` is deliberately absent from the expected set — the SDK does not capture it at all
  // (packages/capture/src/console-interceptor.ts:24-30 `DEFAULT_LEVELS` maps log/info/debug/warn/error
  // and nothing else). Recorded as FINDINGS.md F-3; asserting 6 here would just fail on a known gap,
  // and asserting "some console line arrived" would hide it.
  record(
    's6-console-wire',
    'console.log/info/warn/error/debug -> each reaches the wire in the UPLOADED bundle\'s logs.json, with its object argument stringified (console.trace is NOT captured — FINDINGS.md F-3)',
    ['log', 'info', 'warn', 'error', 'debug'].every((m) => probeLogs.includes(`S6: console.${m} {"control":"s6-${m}"}`)) &&
      !probeLogs.some((m) => m.startsWith('S6: console.trace')),
    `trace captured: ${probeLogs.some((m) => m.startsWith('S6: console.trace'))}`,
  );
  // The circular-object control had NO wire assertion at all — `s6-circular` asserted only "no page
  // error", i.e. that the interceptor did not throw. That leaves the one console case where a regression
  // is actually plausible (a serializer that falls back to `[object Object]`, truncates, or drops the
  // entry entirely) unasserted, while the evidence sits unzipped and free in the same probe bundle.
  // The exact string is asserted, not a substring of it: `[Circular]` is the marker the SDK's own
  // serializer writes for the self-reference, and matching the whole message also pins the sibling key.
  const circularLog = probeLogs.find((m) => m.startsWith('S6: circular object'));
  record(
    's6-circular-wire',
    'console.log with a SELF-REFERENTIAL object -> the UPLOADED bundle\'s logs.json carries it serialized with the [Circular] marker (not "[object Object]", not truncated, not dropped)',
    circularLog === 'S6: circular object {"name":"circular","self":"[Circular]"}',
    circularLog ?? '(no S6: circular object message in the probe bundle)',
  );
  const xhrEntry = probeNetwork.find((n) => n.mechanism === 'xhr' && n.url?.includes('/api/scenario/get') && n.type === 'complete');
  record(
    's7-xhr-wire',
    'XHR -> the UPLOADED bundle\'s network.json carries the call under mechanism "xhr" with its real status + body',
    xhrEntry?.status === 200 && typeof xhrEntry?.custom?.body === 'string' && xhrEntry.custom.body.includes('"ok":true'),
    JSON.stringify({ mechanism: xhrEntry?.mechanism, status: xhrEntry?.status, body: xhrEntry?.custom?.body }),
  );
  const wsEntries = probeNetwork.filter((n) => n.mechanism === 'ws' && n.url?.includes('/api/ws'));
  record(
    's7-ws-wire',
    'WebSocket -> the UPLOADED bundle\'s network.json carries the socket under mechanism "ws" with BOTH directions (an outbound send and an inbound message)',
    wsEntries.some((n) => n.type === 'open') &&
      wsEntries.some((n) => n.type === 'message' && n.direction === 'out') &&
      wsEntries.some((n) => n.type === 'message' && n.direction === 'in'),
    `${wsEntries.length} ws entries: ${JSON.stringify(wsEntries.map((n) => `${n.type}/${n.direction ?? '-'}`))}`,
  );
  // SSE, mirroring the WebSocket check above. scenarios.md marks the SSE row L (the app's own "event #5"
  // status line) and nothing over-claimed — but the probe bundle DOES carry `mechanism: "sse"` entries,
  // so a total loss of EventSource capture was invisible at this depth. It no longer is.
  //
  // The asserted stages are `before` / `open` / `close`, deliberately NOT `message`: the app's SSE
  // control subscribes to a NAMED channel (`source.addEventListener('activity', ...)`, ScenarioPage
  // .svelte), and packages/capture/src/sse-interceptor.ts hooks only the default `'message'` event type
  // — its own header says so in as many words ("Named events beyond the default 'message' channel are a
  // follow-up"). So zero `message` entries is the interceptor's DOCUMENTED current scope, not a
  // regression, and asserting one here would fail on a known deferral. `close` is included because it is
  // the one stage the interceptor synthesises itself (close() is a method, not an event, so it is
  // wrapped per instance) and the app really does call `source.close()` after its 5th event.
  const sseEntries = probeNetwork.filter((n) => n.mechanism === 'sse' && n.url?.includes('/api/scenario/sse'));
  record(
    's7-sse-wire',
    'SSE -> the UPLOADED bundle\'s network.json carries the EventSource connection under mechanism "sse" with its "before", "open" and "close" stages (named-channel `message` entries are out of the interceptor\'s current scope — see sse-interceptor.ts)',
    sseEntries.some((n) => n.type === 'before') &&
      sseEntries.some((n) => n.type === 'open') &&
      sseEntries.some((n) => n.type === 'close'),
    `${sseEntries.length} sse entries: ${JSON.stringify(sseEntries.map((n) => n.type))}`,
  );
  // sendBeacon, mirroring the two checks above — the first empirical validation this interceptor has had
  // in a sample. Its emitted shape (read from packages/capture's send-beacon interceptor, not guessed):
  // `mechanism: 'sendBeacon'`, a `before` -> `complete` pair sharing one id, `method: 'POST'` on BOTH
  // (a beacon is always a POST), the request body on the `before` entry, and NO `status` on either — a
  // beacon has no response, so a status field appearing here would itself be the bug.
  //
  // The body needle is THIS control's own payload literal, not a shape test: matching only on
  // `mechanism === 'sendBeacon'` would be satisfied by an interceptor that recorded the right envelope
  // around the wrong (or empty) content. The `beacon-log` GET the panel makes to read the payload back is
  // a `fetch` and shows up separately in the ring — hence the url filter, so the two cannot be confused.
  const beaconEntries = probeNetwork.filter(
    (n) => n.mechanism === 'sendBeacon' && n.url?.includes('/api/scenario/beacon?tag=s7-beacon'),
  );
  const beaconBefore = beaconEntries.find((n) => n.type === 'before');
  const beaconComplete = beaconEntries.find((n) => n.type === 'complete');
  record(
    's7-beacon-wire',
    'navigator.sendBeacon -> the UPLOADED bundle\'s network.json carries the call under mechanism "sendBeacon" as a before/complete PAIR sharing one id, method POST on both, this control\'s exact payload as the request body, and NO status on either (a beacon has no response)',
    beaconEntries.length >= 2 &&
      beaconBefore?.method === 'POST' &&
      beaconComplete?.method === 'POST' &&
      beaconBefore?.id !== undefined &&
      beaconBefore.id === beaconComplete?.id &&
      beaconBefore?.custom?.body === S7_BEACON_PAYLOAD &&
      beaconBefore?.status === undefined &&
      beaconComplete?.status === undefined,
    JSON.stringify({
      entries: beaconEntries.map((n) => `${n.type}/${n.method}/${n.status ?? 'no-status'}`),
      sameId: beaconBefore?.id !== undefined && beaconBefore.id === beaconComplete?.id,
      body: beaconBefore?.custom?.body,
    }),
  );

  // ---- Wire-depth evidence for the S7 `fetch` controls, from the SAME probe bundle. Each `s7-*` check
  // above reads the status line the APP wrote from its own response: real evidence that the call happened
  // and that the interceptor did not alter what the app saw, but evidence about the APP, not about
  // capture — a filter/interceptor that recorded nothing at all would leave every one of them green.
  // scenarios.md marked them W anyway. The probe bundle carries the ring's fetch entries, so assert them.
  //
  // Shapes come from packages/capture/src/fetch-interceptor.ts: a `before` entry (request headers/body),
  // a `complete` entry carrying `status`, and — once the bounded read of the CLONED response resolves —
  // a second `complete` with `override: true` carrying the response body or the `no_body_reason` that
  // explains its absence.
  const fetchEntries = probeNetwork.filter((n) => n.mechanism === 'fetch');
  /** The status-bearing `complete` entry for a url (the override amendment carries no status). */
  const fetchStatus = (urlPart) =>
    fetchEntries.find((n) => n.type === 'complete' && n.status !== undefined && n.url?.includes(urlPart));
  /**
   * An entry OF A GIVEN STAGE for a url whose captured body is a string containing `text`.
   *
   * The stage is a REQUIRED argument, not an optional filter, and that is the whole point. This helper
   * used to match ANY fetch entry for the url — which made the two request-body checks below satisfiable
   * by the RESPONSE entry instead, because the local API echoes the request straight back
   * (`server/api-server.mjs`'s `/api/scenario/echo` and `/api/scenario/echo-text`), so the same
   * substrings appear in both directions. Measured on a real probe bundle, all four of these exist:
   *   {"type":"before",   url:"/api/scenario/echo",      body:'{"hello":"world","n":42}'}
   *   {"type":"complete", url:"/api/scenario/echo",      override:true, body:'{"received":{"hello":"world","n":42}}'}
   *   {"type":"before",   url:"/api/scenario/echo-text", body:'plain text body'}
   *   {"type":"complete", url:"/api/scenario/echo-text", override:true, body:'echo: plain text body'}
   * i.e. lines 2 and 4 alone satisfied the untyped form, so a regression that dropped REQUEST-body
   * capture entirely (`packages/capture/src/fetch-interceptor.ts`'s `readRequestBody`, or the `before`
   * emit that carries it) would have left both checks green while their descriptions became false.
   * Naming the stage makes each check assert the direction it claims: `before` = what the app SENT,
   * `complete` = what the app RECEIVED.
   */
  const fetchBody = (urlPart, type, text) =>
    fetchEntries.find(
      (n) =>
        n.type === type &&
        n.url?.includes(urlPart) &&
        typeof n.custom?.body === 'string' &&
        n.custom.body.includes(text),
    );
  const getStatus = fetchStatus('/api/scenario/get');
  const getBody = fetchBody('/api/scenario/get', 'complete', '"ok":true');
  record(
    's7-get-wire',
    'fetch GET -> the UPLOADED bundle\'s network.json carries it under mechanism "fetch" with status 200 and the real response body',
    getStatus?.status === 200 && getBody !== undefined,
    JSON.stringify({ status: getStatus?.status, body: getBody?.custom?.body?.slice(0, 60) }),
  );
  // Matched by the payload's own content, not by url alone: S8's redaction control POSTs to this SAME
  // `/api/scenario/echo` endpoint later in the run (the mistake that produced a false FAIL once already,
  // see the s8-network-filter-wire note below).
  const postJsonEntry = fetchBody('/api/scenario/echo', 'before', '"hello":"world"');
  record(
    's7-post-json-wire',
    'fetch POST JSON -> the UPLOADED bundle carries the REQUEST body the app sent, on the "before" entry (NOT the echoed response, which carries the same substrings)',
    postJsonEntry !== undefined && postJsonEntry.custom.body.includes('"n":42'),
    JSON.stringify(postJsonEntry?.custom?.body ?? null),
  );
  const postTextEntry = fetchBody('/api/scenario/echo-text', 'before', 'plain text body');
  record(
    's7-post-text-wire',
    'fetch POST text -> the UPLOADED bundle carries the plain-text REQUEST body, on the "before" entry (NOT the echoed response)',
    postTextEntry !== undefined,
    JSON.stringify(postTextEntry?.custom?.body ?? null),
  );
  const status4xx = fetchStatus('/api/scenario/4xx');
  const status5xx = fetchStatus('/api/scenario/5xx');
  record(
    's7-4xx-5xx-wire',
    'fetch 4xx / 5xx -> the UPLOADED bundle carries each call with its REAL status (404 / 500), not a normalised one',
    status4xx?.status === 404 && status5xx?.status === 500,
    JSON.stringify({ '4xx': status4xx?.status, '5xx': status5xx?.status }),
  );
  const connFailEntry = fetchEntries.find((n) => n.type === 'error' && n.url?.includes('127.0.0.1:1'));
  record(
    's7-connfail-wire',
    'connection failure -> the UPLOADED bundle carries an "error"-stage entry for the failed call (the app caught the throw; capture still recorded it)',
    connFailEntry !== undefined && typeof (connFailEntry.customError ?? connFailEntry.custom?.error) === 'string',
    JSON.stringify(connFailEntry?.customError ?? connFailEntry?.custom?.error ?? null),
  );
  // The row this backs claims "captured copy truncated; app still reads the FULL body". Only the second
  // half was ever asserted (the app's own 65536-byte read). This asserts the first: the bounded read
  // REFUSES an over-cap body and says why, rather than buffering 64KB into the ring.
  //
  // Measured, not assumed: raising `maxNetworkBodySize` to 200000 in FULL_LAUNCH_OPTIONS fails THIS
  // check and nothing else — `s7-large-body` (the app-side read) stays green, which is exactly why the
  // row could not be W on its strength alone.
  const largeBodyEntry = fetchEntries.find(
    (n) => n.url?.includes('/api/scenario/large-body') && n.custom?.no_body_reason != null,
  );
  record(
    's7-large-body-wire',
    'body over maxNetworkBodySize (2048) -> the UPLOADED bundle carries no_body_reason "size_too_large" and NO body, while the app read all 65536 bytes',
    largeBodyEntry?.custom?.no_body_reason === 'size_too_large' && largeBodyEntry?.custom?.body == null,
    JSON.stringify({
      no_body_reason: largeBodyEntry?.custom?.no_body_reason,
      body: largeBodyEntry?.custom?.body ?? null,
    }),
  );
  // Same, measured: flipping `captureNetworkBodyWithoutType` to false fails THIS check and nothing else
  // (the gate drops the body as `no_content_type` and the entry loses it entirely), while the app-side
  // `s7-no-content-type` check stays green.
  const noTypeEntry = fetchBody('/api/scenario/no-content-type', 'complete', 'no content-type on this response');
  record(
    's7-no-content-type-wire',
    'response with no Content-Type -> captureNetworkBodyWithoutType: true KEEPS the body in the UPLOADED bundle (the gate would otherwise drop it as no_content_type)',
    noTypeEntry !== undefined && noTypeEntry.custom.no_body_reason == null,
    JSON.stringify({ body: noTypeEntry?.custom?.body, no_body_reason: noTypeEntry?.custom?.no_body_reason }),
  );

  // S8 filters
  await click(page, 's8-install');
  sinceCheckpoint();
  await click(page, 's8-network', { wait: 500 });
  await click(page, 's8-veto-network', { wait: 500 });
  await click(page, 's8-log', { wait: 300 });
  await click(page, 's8-breadcrumb', { wait: 300 });
  await click(page, 's8-report-mutate', { wait: 900 });
  const filterCalls = (await waitForQuiet()).calls.filter(isIssueCall);
  const filterLogText = await page.locator('[data-testid="filter-log"]').textContent();
  record(
    's8-filters',
    'network (header+body redact) / network (veto) / log / breadcrumb / report before-mutate — every limb actually fired (in-app filter-callback log)',
    Boolean(
      filterLogText &&
        filterLogText.includes('droppedSecretHeader=true') &&
        filterLogText.includes('redactedSsn=true') &&
        // `network: VETOED`, not a bare `VETOED`: the report-handler limb logs `report: VETOED` too, so
        // a bare substring would be satisfiable by the wrong limb if the two ever ran in the other order
        // (today the report veto is clicked later, which is the only reason a bare match still means the
        // network limb — an accident, not an assertion).
        filterLogText.includes('network: VETOED') &&
        filterLogText.includes('log: redacted') &&
        filterLogText.includes('breadcrumb: redacted') &&
        filterLogText.includes('report: mutated'),
    ),
    `${filterCalls.length} issue calls; log: ${filterLogText}`,
  );

  // ---- Bundle-level (WIRE) assertions — PLAN §6.6. The in-app filter-log check above only proves the
  // Scenario panel's OWN filter callback ran and logged what it saw; it says nothing about whether the
  // SDK actually applied the filter's RETURN VALUE to what got uploaded (a mutation that discarded every
  // filter's return value would leave the check above green). These inspect the tee's parsed copy of the
  // REAL uploaded bundle — a genuine unzip of the ZIP PUT to S3 (src/bugsee-transport.ts), not a text
  // scan of the small bugsee.com metadata calls (which never carry the bundle at all — that upload goes
  // to a separate S3 domain).
  const mutateBundle = await waitForBundle(
    (b) => b.bundle?.request?.summary === 'S8: report handler should mutate this',
  );
  const mutateLabels = mutateBundle?.bundle?.request?.labels;
  record(
    's8-report-mutate-wire',
    'report handler before-mutate -> the UPLOADED bundle request.json carries the label it added',
    Array.isArray(mutateLabels) && mutateLabels.includes('redacted-before'),
    JSON.stringify(mutateLabels ?? null),
  );
  // Match on the S8 payload's own distinctive content, not just the URL — `s7-post-json` (S7) ALSO POSTs
  // to this same `/api/scenario/echo` endpoint earlier in the run, and the ring can carry both entries;
  // matching by URL alone picked up the WRONG (S7) entry in one run, a false FAIL since that entry
  // legitimately has no secret header/ssn to redact. `note` is untouched by the redaction filter (only
  // `ssn` is regex-replaced), so it survives as a stable discriminator.
  //
  // `type === 'before'` is REQUIRED here for exactly the reason `fetchBody` above takes the stage as a
  // required argument (round 3) — this check was the one place that fix did not sweep into. Measured on a
  // real mutate bundle, `/api/scenario/echo` produces BOTH of these and the url+body predicate alone
  // matched both:
  //   [before]   headers:["Content-Type","traceparent","tracestate"]  body:'{"ssn":"[REDACTED]","note":"S8: …"}'
  //   [complete] override:true, headers:[RESPONSE headers]            body:'{"received":{"ssn":"[REDACTED]","note":"S8: …"}}'
  // The header half is what makes that fatal: `!('x-secret' in headers)` on the `complete` entry reads the
  // RESPONSE headers (access-control-allow-origin, content-type, date, …), which never carried `x-secret`
  // at all — so "the UPLOADED bundle has the x-secret header dropped" would be satisfied by an entry that
  // never had it to drop, and by an empty header map, i.e. a total loss of REQUEST-header capture would
  // leave this green. It passed for the right reason only because the `before` entry happens to be first.
  const networkEntry = mutateBundle?.bundle?.network?.find(
    (n) =>
      n.type === 'before' &&
      n.url?.includes('/api/scenario/echo') &&
      n.custom?.body?.includes('S8: network redact scenario'),
  );
  const networkHeaders = networkEntry?.custom?.headers ?? {};
  const networkBody = networkEntry?.custom?.body;
  // `Content-Type` is asserted PRESENT alongside `x-secret` being absent. "x-secret is not in this map" is
  // trivially true of an EMPTY map, so on its own it cannot tell "the filter dropped the header" from
  // "request headers were not captured at all" — the sibling header the app sent on the same request is
  // the positive control that makes the absence mean something.
  record(
    's8-network-filter-wire',
    'network filter -> the UPLOADED bundle\'s REQUEST ("before") entry has the x-secret header dropped (while its sibling Content-Type survives) and the SSN redacted',
    networkEntry !== undefined &&
      !('x-secret' in networkHeaders) &&
      'Content-Type' in networkHeaders &&
      typeof networkBody === 'string' &&
      networkBody.includes('[REDACTED]') &&
      !networkBody.includes('123-45-6789'),
    JSON.stringify({ type: networkEntry?.type, headers: networkHeaders, body: networkBody }),
  );
  const vetoedNetworkEntry = mutateBundle?.bundle?.network?.find((n) => n.url?.includes('veto-me'));
  record(
    's8-veto-network-wire',
    'network veto -> the vetoed request never appears in the UPLOADED bundle at all',
    vetoedNetworkEntry === undefined,
  );
  const redactedLog = mutateBundle?.bundle?.logMessages?.find((m) => m.includes('SECRET_TOKEN'));
  record(
    's8-log-filter-wire',
    'log filter -> the UPLOADED bundle carries the redacted message, not the raw token',
    redactedLog !== undefined && redactedLog.includes('[REDACTED]') && !redactedLog.includes('abc123'),
    redactedLog ?? '(not found)',
  );
  const redactedCrumb = mutateBundle?.bundle?.breadcrumbs?.find((c) => c.message === 'has a secret');
  record(
    's8-breadcrumb-filter-wire',
    'breadcrumb filter -> the UPLOADED bundle has data.secret redacted, not the raw value',
    redactedCrumb?.data?.secret === '[REDACTED]',
    JSON.stringify(redactedCrumb ?? null),
  );

  // Report veto, checked separately (own before/after delta + its own bundle-absence check).
  await waitForQuiet(); // drain the mutate call's own traffic first
  sinceCheckpoint();
  await click(page, 's8-report-veto', { wait: 1500 });
  const vetoWindowCalls = (await waitForQuiet()).calls.filter(isIssueCall);
  const vetoFilterLogText = await page.locator('[data-testid="filter-log"]').textContent();
  record(
    's8-report-veto',
    'report handler before-veto -> the callback fired AND no new issue call was made',
    vetoWindowCalls.length === 0 && Boolean(vetoFilterLogText?.includes('report: VETOED')),
    `${vetoWindowCalls.length} issue call(s) in the veto window; log: ${vetoFilterLogText}`,
  );
  // `delivered: 'any'`: this is an ABSENCE claim about what the SDK BUILT. A vetoed report that was
  // nonetheless assembled and PUT — and merely rejected by S3 — is still the defect this row exists to
  // catch, so it must not be filtered out by upload status (see `waitForBundles`).
  const vetoedBundle = await waitForBundle(
    (b) => b.bundle?.request?.summary === 'S8: report handler should VETO this',
    { timeout: 1500, delivered: 'any' },
  );
  record(
    's8-report-veto-wire',
    'report handler veto -> the vetoed report never appears as an UPLOADED bundle either',
    vetoedBundle === undefined,
  );

  await click(page, 's8-uninstall');

  // S9 performance
  newPageErrors();
  await click(page, 's9-manual-transaction', { wait: 400 });
  record('s9-manual-transaction', 'manual transaction + every SpanStatus child span (no throw)', newPageErrors() === 0);
  newPageErrors();
  await click(page, 's9-set-route-name');
  record('s9-set-route-name', 'setRouteName direct call (no throw)', newPageErrors() === 0);

  // `performanceSampleRate` 0 vs 1 — a two-relaunch check (was N/A "out of scope", no reason given).
  await click(page, 's9-relaunch-rate-0', { wait: 500 });
  const beforeRateZero = perfTransactions.length;
  await click(page, 's9-manual-transaction', { wait: 400 });
  await page.waitForTimeout(4000); // > performanceFlushIntervalMs (3000ms, FULL_LAUNCH_OPTIONS)
  const sampledZeroNames = perfTransactions.slice(beforeRateZero).map((t) => t.name);
  record(
    's9-sample-rate-0',
    'performanceSampleRate: 0 — the manual transaction is head-sampled OUT, never reaches the wire',
    !sampledZeroNames.includes('scenario.manual'),
    `${sampledZeroNames.length} transactions reached the wire in this window`,
  );

  await click(page, 's9-relaunch-rate-1', { wait: 500 });
  const beforeRateOne = perfTransactions.length;
  await click(page, 's9-manual-transaction', { wait: 400 });
  await page.waitForTimeout(4000);
  const sampledOneNames = perfTransactions.slice(beforeRateOne).map((t) => t.name);
  record(
    's9-sample-rate-1',
    "performanceSampleRate: 1 — the SAME manual transaction now reaches the wire (positive control for s9-sample-rate-0)",
    sampledOneNames.includes('scenario.manual'),
    `${sampledOneNames.length} transactions reached the wire in this window`,
  );

  // S10 — outbound trace propagation (no two-hop counterpart needed; only the trace_id JOIN would need
  // one). Verified locally via the purpose-built /api/scenario/echo-headers endpoint.
  await click(page, 's10-propagation');
  const s10StatusText = await page.locator('[data-testid="s10-status"]').textContent();
  record(
    's10-propagation',
    'propagateTrace — outbound traceparent/tracestate reaches the server (echoed back)',
    Boolean(s10StatusText && /traceparent/.test(s10StatusText) && s10StatusText.includes('bugsee=')),
    s10StatusText ?? '',
  );

  // The EXCLUDE half. Until this check existed, `tracePropagationTargets: ['/api/']` matched EVERY fetch
  // the app makes, so the include check above would have passed identically if the allow-list were
  // ignored altogether — the option was never actually put to a test that could fail. (The one
  // non-matching URL the sample had, `http://127.0.0.1:1/definitely-closed`, never connects, so no
  // header is observable there at all.) `/trace-exclude-probe` connects, is cross-origin, and has no
  // `/api/` in its path.
  //
  // `echoed` is the positive control that makes the two absences mean something: it is the server's own
  // `host` header coming back, so "no traceparent" cannot be satisfied by a request that failed, was
  // blocked by CORS, or never left — those all report `echoed: false` and fail this check.
  await click(page, 's10-propagation-excluded', { wait: 400 });
  const s10ExcludeText = await page.locator('[data-testid="s10-exclude-status"]').textContent();
  let s10Exclude;
  try {
    s10Exclude = JSON.parse(s10ExcludeText ?? '{}');
  } catch {
    s10Exclude = {};
  }
  record(
    's10-propagation-excluded',
    'tracePropagationTargets EXCLUDE half — a cross-origin URL that does NOT match the allow-list receives NO traceparent/tracestate (while the same request demonstrably completed and echoed its headers back)',
    s10Exclude.echoed === true && s10Exclude.traceparent === null && s10Exclude.tracestate === null,
    s10ExcludeText ?? '',
  );

  // S11 session replay
  newPageErrors();
  // NOTE the wording: `replay: true` no longer TURNS ON anything — recording is the default now, and this
  // row only says the explicit form is still accepted and selects the fail-closed masking defaults. What
  // proves the option is read at all is the `s11-replay-off` / `s11-replay-default-on` pair below.
  await click(page, 's11-replay-defaults', { wait: 800 });
  record('s11-replay-defaults', 'relaunch with an explicit (now redundant) replay: true — accepted, fail-closed masking defaults', newPageErrors() === 0);

  await click(page, 's11-replay-masking', { wait: 800 });
  record('s11-replay-masking', 'relaunch with explicit masking options', newPageErrors() === 0);

  // Relaunch under the SELECTOR-driven config (`maskTextSelector`/`blockSelector`/`ignoreSelector` —
  // three PLAN §4 S11 options that nothing in this sample exercised, and that were not recorded N/A
  // either). This is the session the drawer below is recorded under, and the one the wire checks read.
  await click(page, 's11-replay-selectors', { wait: 800 });
  record('s11-replay-selectors', 'relaunch with maskTextSelector/blockSelector/ignoreSelector', newPageErrors() === 0);

  // The masking TARGETS live on the Settings page's drawer, not here — visit it now, WHILE this replay
  // session is active, so the fields are actually on screen during a live recording instead of only ever
  // appearing during the pre-replay Settings visit earlier in this script.
  //
  // These literals are NEEDLES searched for inside the decoded rrweb stream below; they must stay in sync
  // with src/routes/SettingsPage.svelte's drawer markup.
  // Their LENGTHS are load-bearing too, and deliberately all different: rrweb masks an input value by
  // replacing it with a run of `*` of the same length, so `"text":"<n stars>"` is a per-field fingerprint
  // that says "this field's input event was recorded, masked" — which is what separates "masked" from
  // "not recorded at all" below. 20 / 24 / 23 characters respectively.
  const S11_MASKED_VALUE = 'S11-MASKED-PIN-VALUE';
  const S11_UNMASK_MARKED_VALUE = 'S11-UNMASKED-INPUT-VALUE';
  const S11_IGNORED_VALUE = 'S11-IGNORED-INPUT-VALUE';
  const maskedRun = (value) => `"text":"${'*'.repeat(value.length)}"`;
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
  await click(page, 'toggle-drawer');
  await page.fill('[data-testid="s11-masked-field"]', S11_MASKED_VALUE);
  await page.fill('[data-testid="s11-unmask-field"]', S11_UNMASK_MARKED_VALUE);
  await page.fill('[data-testid="s11-ignore-field"]', S11_IGNORED_VALUE);
  const drawerVisibleDuringReplay = await page.locator('[data-testid="settings-drawer"]').count();
  record(
    's11-masking-targets-on-screen',
    'masking-target fields are displayed during an ACTIVE replay session (not just before launch)',
    drawerVisibleDuringReplay === 1 && newPageErrors() === 0,
  );
  await page.waitForTimeout(500); // give the active replay ring a moment to record this screen
  await page.goto(`${BASE}/#/scenarios`, { waitUntil: 'networkidle' });

  // ---- S11 at WIRE depth (PLAN §4 S11: masking "verified by inspecting the replay for the secret").
  //
  // Every S11 check above — and every S11 check that existed before this round — asserts `no new page
  // error` plus `isLaunched`/drawer-visible. Replay recording could be entirely DEAD and all of them stay
  // green. scenarios.md justified that with "not visible via get_issue", which is true of the BACKEND
  // level and NOT of the wire level this sample's own tee already reaches: the tee unzips every uploaded
  // bundle, `replay.bin` is right there in `files`, and it gunzips to the real rrweb event stream.
  //
  // So: fire one report while the drawer recording is still in the ring, then decode that bundle's
  // replay and assert what the recording contains.
  await click(page, 's11-replay-wire-probe', { wait: 0 });
  const REPLAY_PROBE_SUMMARY = 'WIRE: replay probe (masked drawer recording)';
  const replayProbeBundle = await waitForBundle(bySummary(REPLAY_PROBE_SUMMARY));
  const S11_NEEDLES = [
    S11_MASKED_VALUE,
    S11_UNMASK_MARKED_VALUE,
    S11_IGNORED_VALUE,
    'S11-MASK-SELECTOR-TARGET-TEXT',
    'S11-BLOCK-SELECTOR-TARGET-TEXT',
    'S11-PLAIN-TEXT-CONTROL',
    '"source":5',
    maskedRun(S11_MASKED_VALUE),
    maskedRun(S11_UNMASK_MARKED_VALUE),
    maskedRun(S11_IGNORED_VALUE),
  ];
  const replay = replayProbeBundle
    ? await page.evaluate(
        ([seq, needles]) => window.__bugseeTee?.inspectReplay(seq, needles) ?? null,
        [replayProbeBundle.seq, S11_NEEDLES],
      )
    : null;
  if (process.env.DEBUG_REPLAY) {
    console.log('\n--- DEBUG replay probe bundle ---');
    console.log(JSON.stringify({ files: replayProbeBundle?.bundle?.files, replay }, null, 2));
  }
  record(
    's11-replay-wire',
    'session replay actually RECORDS — the UPLOADED bundle carries replay.bin, and it gunzips to a real rrweb event stream containing a Meta (type 4) and a FullSnapshot (type 2) event (a recording without a FullSnapshot cannot be replayed at all)',
    replayProbeBundle?.bundle?.files?.includes('replay.bin') === true &&
      (replayProbeBundle?.bundle?.replayBytes ?? 0) > 0 &&
      replay?.present === true &&
      replay.events > 0 &&
      replay.eventTypes.includes(4) &&
      replay.eventTypes.includes(2),
    JSON.stringify({
      replayBytes: replayProbeBundle?.bundle?.replayBytes,
      gzBytes: replay?.gzBytes,
      chars: replay?.chars,
      events: replay?.events,
      eventTypes: replay?.eventTypes,
      error: replay?.error,
    }),
  );
  const hits = replay?.hits ?? {};
  // What makes this check able to FAIL, rather than a set of absences that a dead recorder satisfies:
  //
  //  PRESENT (the recorder was live, on THAT screen, capturing both text and input events at the moment
  //           the secrets were not captured):
  //    S11-PLAIN-TEXT-CONTROL   — an un-marked text node in the same drawer. It is only recordable
  //                               because this session runs `maskAllText: false`; with the fail-closed
  //                               default ON, every text absence below would be true for free and the
  //                               two text selectors would be untestable.
  //    "source":5               — rrweb IncrementalSource.Input: input events were being recorded.
  //    the `.bugsee-unmask` field's input event, IN EITHER FORM — a 24-star run (what F-4 measures
  //                               today) OR its raw value (what the fork would produce once F-4 is
  //                               fixed). See the F-4 note below for why the disjunction, not a pin.
  //
  //  ABSENT (the privacy claim, each attributable to one specific mechanism):
  //    the two SECRET values     — neither the password nor the ignoreSelector field's text reached the
  //                               recording. (The `.bugsee-unmask` field is deliberately NOT in this
  //                               list — it is opted OUT of masking, so its value appearing is the
  //                               documented intent, not a leak.)
  //    MASK-SELECTOR target text — `maskTextSelector: '.s11-mask-target'`.
  //    BLOCK-SELECTOR target text— `blockSelector: '.s11-block-target'` (subtree not recorded).
  //    maskedRun(MASKED)  (20)   — the password field's events were not recorded AT ALL, not merely
  //                                masked: the sensitive floor puts it in `ignoreSelector`.
  //    maskedRun(IGNORED) (23)   — same, via the caller's own `ignoreSelector: '.s11-ignore-target'`.
  //  Those last two are the discriminating pair: they are absent while the 24-length run from the field
  //  RIGHT NEXT TO THEM is present, so "not recorded" cannot be explained by the observer being dead.
  //  Each needle is the full quoted JSON value (`"text":"***"`), not a bare star run — a 23-star run is a
  //  substring of a 24-star one, so an unquoted needle would report the ignored field as present.
  //
  // HONEST LIMIT, stated because the check's name invites the stronger reading: this is a positive
  // control for the RECORDING, not for the MASKING. It does not prove the PIN would have appeared with
  // masking off — that needs a panel control that relaunches with the floor lifted, and for a password
  // field the sensitive floor is specifically designed so that no option can lift it. The masked-field
  // half is therefore a one-sided claim by construction; the `maskTextSelector` / `blockSelector` /
  // `ignoreSelector` halves are not (their targets are ordinary elements, and `maskAllText: false` means
  // an identical un-marked sibling IS recorded).
  //
  // FINDINGS.md F-4, and why this check does NOT pin it. `.bugsee-unmask` is honoured only on the
  // FULL-SNAPSHOT path — rrweb's live input observer is never handed `unmaskInputSelector` and masks
  // purely off `maskInputOptions` — so a value TYPED during recording is masked regardless of the mark,
  // and `S11-UNMASKED-INPUT-VALUE` does not appear in the decoded stream today.
  //
  // An earlier version of this check asserted that absence, plus the 24-star run, as facts. That pinned
  // the DEFECT: the day the fork honours the mark on the incremental path, a check literally titled
  // "replay masking VERIFIED IN THE RECORDING" would go red and read as "masking broke" — the opposite of
  // what happened. `angular-spa`, which reproduced F-4 independently and decisively (one `source:5` event,
  // `{"source":5,"text":"*****************"}` for a 17-character value, while the full-snapshot path read
  // the same field back verbatim in the same sweep), deliberately declined to add such a check for exactly
  // that reason. This one now takes the same position by DISJUNCTION rather than by omission: the field's
  // input event must be present in ONE of the two forms, which keeps it as the positive control that makes
  // the two absences below attributable, while committing to neither outcome of F-4. F-4 stays a written
  // finding; it is not a fixture.
  record(
    's11-replay-masking-wire',
    'replay masking VERIFIED IN THE RECORDING — the decoded rrweb stream contains neither SECRET field value, the maskTextSelector target\'s text nor the blockSelector target\'s text, and carries NO input event at all for the password / ignoreSelector fields, while an un-marked text node, live input events, and the neighbouring .bugsee-unmask field\'s input event (masked OR raw — F-4 is not pinned here) ARE present',
    hits[S11_MASKED_VALUE] === false &&
      hits[S11_IGNORED_VALUE] === false &&
      hits['S11-MASK-SELECTOR-TARGET-TEXT'] === false &&
      hits['S11-BLOCK-SELECTOR-TARGET-TEXT'] === false &&
      hits[maskedRun(S11_MASKED_VALUE)] === false &&
      hits[maskedRun(S11_IGNORED_VALUE)] === false &&
      hits['S11-PLAIN-TEXT-CONTROL'] === true &&
      hits['"source":5'] === true &&
      (hits[maskedRun(S11_UNMASK_MARKED_VALUE)] === true || hits[S11_UNMASK_MARKED_VALUE] === true),
    JSON.stringify(hits),
  );

  await click(page, 's11-replay-canvas-fixed', { wait: 800 });
  record('s11-replay-canvas-fixed', "relaunch with replay.canvas: { fps: 2 }", newPageErrors() === 0);
  await click(page, 's11-replay-canvas-all', { wait: 800 });
  record('s11-replay-canvas-all', "relaunch with replay.canvas: { fps: 'all' }", newPageErrors() === 0);

  // ---- The replay OPTION PATH — the pair of checks that survives recording being ON BY DEFAULT.
  //
  // `packages/browser/src/launch.ts` now reads `options.replay !== false && domDocument !== undefined`:
  // recording happens unless you opt OUT. That silently hollowed out `s11-replay-wire` above as evidence
  // about the OPTION — `replay.bin` being present in an uploaded bundle no longer says the SDK read the
  // `replay` key at all, because an SDK that ignored the key entirely would produce exactly the same
  // bundle. (`s11-replay-wire` is still a real check; what it now attests is that the RECORDER works,
  // not that the option was consulted. Its masking sibling is unaffected — mask options have no default
  // that could make them vacuous.)
  //
  // `replay: false` is the only replay configuration whose effect is observable at all now, so it is the
  // only thing that can prove the option path exists. Both halves are asserted, and the pair is what
  // makes each half worth having:
  //   * default-on — relaunch with NO `replay` key at all; its bundle must still carry `replay.bin`.
  //                  Pins the product decision itself, and goes red if the default ever flips back.
  //                  Deliberately not `replay: true`, which is green under EITHER default.
  //   * opt-out    — relaunch with `replay: false`; its bundle must carry no `replay.bin` at all.
  // An SDK that ignored `replay` entirely passes exactly one of the two, never both — whichever way it
  // is broken. Each control fires its own distinctly-summarised report after a settle (the recorder is
  // lazy-loaded, see the panel), so these read real bundles, not the ambient one.
  newPageErrors();
  await click(page, 's11-replay-default-on', { wait: 2500 });
  const replayDefaultBundle = await waitForBundle(bySummary('WIRE: replay default probe (no replay option at all)'));
  record(
    's11-replay-default-on',
    'session replay is ON BY DEFAULT — a launch with NO `replay` option at all still uploads a bundle carrying a non-empty replay.bin (this is what pins the default; an explicit `replay: true` would pass under either default and prove nothing)',
    replayDefaultBundle?.bundle?.files?.includes('replay.bin') === true &&
      (replayDefaultBundle?.bundle?.replayBytes ?? 0) > 0 &&
      newPageErrors() === 0,
    JSON.stringify({
      uploaded: replayDefaultBundle !== undefined,
      replayBytes: replayDefaultBundle?.bundle?.replayBytes,
    }),
  );

  newPageErrors();
  await click(page, 's11-replay-off', { wait: 2500 });
  const replayOffBundle = await waitForBundle(bySummary('WIRE: replay opt-out probe (replay: false)'));
  record(
    's11-replay-off',
    '`replay: false` OPTS OUT — the bundle uploaded from that session carries NO replay.bin at all, while the default-on probe\'s bundle (same app, same page, one relaunch apart) carries one. This is the only replay configuration whose effect is still observable, so it is the only evidence that the option is read',
    replayOffBundle !== undefined &&
      replayOffBundle.bundle?.files?.includes('replay.bin') === false &&
      replayOffBundle.bundle?.replayBytes === undefined &&
      newPageErrors() === 0,
    JSON.stringify({
      uploaded: replayOffBundle !== undefined,
      files: replayOffBundle?.bundle?.files,
    }),
  );

  newPageErrors();
  await click(page, 's11-replay-restore', { wait: 800 });
  const isLaunchedAfterS11 = await page.locator('[data-testid="is-launched"]').textContent();
  record(
    's11-replay-restore',
    'relaunch back to FULL_LAUNCH_OPTIONS baseline',
    newPageErrors() === 0 && isLaunchedAfterS11?.trim() === 'true',
    isLaunchedAfterS11 ?? '',
  );

  // Svelte-specific (§5.4)
  await click(page, 'arm-boundary', { wait: 500 });
  const guardedFallback = await page.locator('[data-testid="guarded-widget-fallback"]').count();
  // This click ALSO fires a report (the boundary's `onerror` → `reportSvelteErrorDirect`), which used to
  // be an unowned side effect that drifted into the next two checks' windows. Assert it here, by its own
  // summary, so the local path is evidence rather than noise.
  const localBoundaryBundle = await waitForBundle(
    bySummary('S-svelte: ThrowingWidget local-boundary render throw (caught by <svelte:boundary>)'),
  );
  record(
    'svelte-error-boundary-local',
    'nested <svelte:boundary> catches a render throw AND its onerror report reaches the wire',
    guardedFallback === 1 && localBoundaryBundle !== undefined,
    `fallback shown=${guardedFallback === 1}, local-throw bundle uploaded=${localBoundaryBundle !== undefined}`,
  );
  await click(page, 'disarm-boundary');

  // Matched to ITS OWN uploaded bundle, not to an issue call in the window after the click. The
  // `arm-boundary` click just above fires a report of its own (`<svelte:boundary onerror>` →
  // `reportSvelteErrorDirect`) whose `/v2/issues` response was MEASURED landing 1991ms after the click,
  // while this check's window opened ~800ms after it — so the previous window form was satisfiable by
  // that earlier report and `reportSvelteError` could have been a no-op and still passed. Worse, the
  // window form then moved the checkpoint, pushing this call's real evidence into the NEXT svelte check's
  // window, which had the same defect. Both are now content-matched.
  sinceCheckpoint();
  await click(page, 'svelte-report-error', { wait: 0 });
  const reportErrorBundle = await waitForBundle(bySummary('Svelte: reportSvelteError called directly'));
  record(
    'svelte-report-error',
    'reportSvelteError direct call -> ITS OWN report reaches the wire as an uploaded bundle',
    reportErrorBundle !== undefined,
  );

  newPageErrors();
  await click(page, 'svelte-render-span', { wait: 400 });
  const renderSpanStatus = await page.locator('[data-testid="svelte-render-span-status"]').textContent();
  record(
    'svelte-render-span',
    'startSvelteRenderSpan(...)() direct call — stop() ran with the transaction THIS control started still active (recordRenderSpan is a documented no-op without one)',
    // Not a decorative literal: the panel used to set "recorded a ui.render mount span"
    // unconditionally, so this assertion read the sample's own prose — probed in isolation it produced
    // ZERO /v2/performance/transactions POSTs in 12s while still reading green. The panel now reports
    // what it OBSERVED, and `svelte-render-span-wire` below asserts the span itself, by name, on the wire.
    //
    // IDENTITY, not mere presence. The panel's first repair reported `getActiveSpan() !== undefined`,
    // which is too weak to be worth asserting: clicking this very button starts an INTERACTION
    // transaction, so something is always active. Measured — deleting the panel's own
    // `startTransaction` call left this check green while the named span reached
    // /v2/performance/transactions zero times, i.e. the mutation that breaks the feature survived here
    // and was caught only by the wire check below. The panel now reports whether the span landed on THE
    // transaction it started (`getActiveSpan() === txn`), which that same mutation makes false.
    newPageErrors() === 0 &&
      Boolean(renderSpanStatus?.includes('recorded onto the transaction this control started: true')),
    renderSpanStatus ?? '',
  );

  await click(page, 'svelte-route-id-from-navigation');
  // Read the RETURNED value's own status line, and match it EXACTLY. The descriptive line
  // (`svelte-route-id-status`) echoes the ARGUMENT — `{to:{route:{id:'/habits/[id]'}}}` — so a
  // `includes('/habits/[id]')` against it passes for `undefined`, `null` and `''` alike: the expected
  // value is a literal inside the input being echoed. Demonstrated, then fixed on both sides.
  const routeIdResult = (await page.locator('[data-testid="svelte-route-id-result"]').textContent())?.trim();
  record('svelte-route-id-from-navigation', "routeIdFromNavigation RETURNS exactly '/habits/[id]'", routeIdResult === '/habits/[id]', `returned ${JSON.stringify(routeIdResult)}`);

  const annotateText = await page.locator('[data-testid="component-annotate-count"]').textContent();
  const annotateMatch = annotateText?.match(/(\d+)/);
  const annotateCount = annotateMatch ? Number(annotateMatch[1]) : 0;
  record('svelte-component-annotate', 'svelte-plugin-component-annotate stamps data-bugsee-component in the DOM (reactive, measured on THIS page)', annotateCount > 0, `${annotateCount} elements`);

  // Global (app-level) boundary — no nested boundary competing, unlike react-spa's F-5 (react-router's
  // per-route boundary intercepts first there). Expect App.svelte's own boundary to catch this.
  // ThrowingWidget throws a message parameterized by `scenario` ('local' vs 'global') so an individual
  // EVENT is self-describing, but this does NOT split the two paths into separate ISSUES — checked via
  // MCP: they still fingerprint to the same one, because Bugsee's error grouping keys off the thrown
  // Error's own stack trace (always the same $effect line in ThrowingWidget.svelte, regardless of which
  // boundary catches it), not the message text. See scenarios.md's Svelte-specific section.
  sinceCheckpoint();
  await click(page, 'arm-global', { wait: 900 });
  const globalFallback = await page.locator('[data-testid="error-fallback"]').count();
  // Content-matched for the same reason as `svelte-report-error` above: the `issue calls in my window`
  // half of this check was satisfiable by the local boundary's report (or by `reportSvelteError`'s, once
  // the window form had shifted it forward), leaving only the `globalFallback === 1` half doing real
  // work. `ThrowingWidget` parameterizes its message by `scenario`, so the global path's report has a
  // summary no other report in the sweep produces.
  const globalBundle = await waitForBundle(
    bySummary('S-svelte: ThrowingWidget global-boundary render throw (caught by <svelte:boundary>)'),
  );
  record(
    'svelte-error-boundary-global',
    'app-level <svelte:boundary> (App.svelte) catches an UNGUARDED throw via handleErrorWithBugsee, and THAT throw\'s own report reaches the wire',
    globalFallback === 1 && globalBundle !== undefined,
    `bugsee's fallback shown=${globalFallback === 1}, global-throw bundle uploaded=${globalBundle !== undefined}`,
  );
  // MUST click the boundary's own `reset()` — a Svelte 5 `<svelte:boundary>` that has caught an error
  // stops reactively re-rendering its children entirely (including the outer {#if route.id === ...}
  // outlet swap) until `reset()` runs; simply navigating to another route and back does NOT un-stick it
  // (found the hard way: the first version of this script hung forever on the next click, because the
  // fallback stayed on screen through two more `page.goto` calls). See scenarios.md for detail.
  await click(page, 'error-fallback-reset', { wait: 500 });
  const stillFallback = await page.locator('[data-testid="error-fallback"]').count();
  record('svelte-boundary-reset', "<svelte:boundary>'s reset() un-sticks it (navigation alone does not)", stillFallback === 0);

  // Debug affordance (same shape as DEBUG_S12 below): dump every bundle summary the tee has recorded so
  // far. Used when writing/maintaining the bundle-summary-scoped checks above — those match on the exact
  // `request.json.summary` string the SDK actually writes, and this is how you find out what that is
  // without guessing. Runs before the storm, which floods the tee with 100+ identical `S4: storm N`
  // entries.
  if (process.env.DEBUG_BUNDLES) {
    const dumped = await page.evaluate(() => window.__bugseeTee?.getCapturedBundles() ?? []);
    console.log('\n--- DEBUG captured bundle summaries ---');
    for (const b of dumped) console.log(JSON.stringify(b.bundle?.request?.summary ?? null));
  }

  // S4 storm — deliberately last (before the final flush/S12 probe): 200 logException calls in ~1s
  // must rate-limit rather than drop the app, and stay responsive.
  //
  // BUDGET, DERIVED FROM THE WORK REQUESTED — not a round constant. This block used to settle the storm
  // with two stacked fixed waits (3s-quiet within 60s, then 4s-quiet within 45s) whose comment declared
  // the straggler hazard closed. It was not: five consecutive sweeps on a freshly started server scored
  // 84/86, 86/86, 84/86, 86/86, 86/86 — `s1-flush` and `s12-persist-recover` failing TOGETHER in exactly
  // the runs where the storm admitted the FEWEST uploads (37 and 39 admitted -> fail; 68/72/72 -> pass).
  // Fewer admitted is SLOWER to drain, not faster: a smaller admitted count here means staging was
  // accepting more slowly, so the same backlog took longer, ran the 45s wait out on its DEADLINE, and
  // left `flush(5000)` and the S12 recovery competing with traffic that was still flowing. The failure
  // was in this script's budget, not in the SDK.
  //
  // So the budget is computed from what the storm ASKS the SDK to do, the way samples/fastify-api's
  // S4.dedupe budget is derived from its route's requested work rather than left on a flat default:
  //   * `STORM_ATTEMPTS`      — the literal loop count in ScenarioPage.svelte's `s4Storm`.
  //   * `STORM_ADMIT_CEILING` — the most the capture rate limiter can let through (~100 reports / 60s,
  //                             samples/FINDINGS.md F-X19). The admitted count is what actually has to
  //                             DRAIN, and it can never exceed this.
  //   * `PER_REPORT_BUDGET_MS`— per-admitted-report drain cost. Each admitted report is two serial
  //                             round trips to real staging (POST /v2/issues, then the signed S3 PUT),
  //                             pipelined across reports. MEASURED on this sample across ELEVEN runs
  //                             against real staging: 827, 828, 865, 831, 845, 836, 839, 845, 798,
  //                             837, 787 ms/report (worst 865). Set to 1750, ~2x that worst — headroom for
  //                             staging jitter, and the sensitivity that a budget this loose gives up
  //                             is bought back by the explicit per-report assertion below (which is
  //                             checked against the SAME constant) rather than silently lost.
  // The two waits also collapse into ONE (quiet at STORM_SETTLE_QUIET_MS): the second wait's only job
  // was to re-arm a longer lull, which a single longer `quietMs` does directly and without a second
  // deadline to run out of. That also FIXED the admitted count this check reports. The old first wait
  // exited on a 3s lull, and a 3s lull is a FALSE quiet here — the drain has gaps that long in it — so
  // `stormCalls` only ever saw the calls that had landed before the first gap. That is where the
  // previously documented "not stable run to run" spread came from (61/68/75, and the round-3
  // re-review's 37/39/68/72/72): it was this script's window closing early, not the SDK's throughput
  // moving. With one 4s-quiet wait the same build measures 97 admitted on every one of eleven runs —
  // right up against STORM_ADMIT_CEILING, which is what F-X19's ~100/60s rate limiter predicts.
  const STORM_ATTEMPTS = 200;
  const STORM_ADMIT_CEILING = 100;
  const PER_REPORT_BUDGET_MS = 1750;
  const STORM_SETTLE_QUIET_MS = 4000;
  const STORM_SETTLE_TIMEOUT_MS = STORM_SETTLE_QUIET_MS + STORM_ADMIT_CEILING * PER_REPORT_BUDGET_MS;
  sinceCheckpoint();
  await click(page, 's4-storm', { wait: 0 });
  const stormQuiet = await waitForQuiet({ quietMs: STORM_SETTLE_QUIET_MS, timeout: STORM_SETTLE_TIMEOUT_MS });
  const stormCalls = stormQuiet.calls.filter(isIssueCall);
  record(
    's4-storm',
    `${STORM_ATTEMPTS} exceptions in ~1s — some get through (not silently dropped entirely) but rate-limited well under ${STORM_ATTEMPTS}; app stays responsive`,
    stormCalls.length > 0 && stormCalls.length < STORM_ATTEMPTS,
    `${stormCalls.length} issue calls (of ${STORM_ATTEMPTS} attempted); quiet-wait exited by ${stormQuiet.reason} after ${stormQuiet.waitedMs}ms`,
  );

  // SENSITIVITY, made explicit — the same trade samples/fastify-api makes for its derived abort budget.
  // A budget generous enough never to fail a HEALTHY run is, on its own, nearly blind: the storm could
  // get several times slower and still land inside STORM_SETTLE_TIMEOUT_MS. So the measured cost is
  // asserted separately, against the per-report figure the budget was derived from (observed 787-865
  // ms/report over eleven runs; ceiling 1750). The quiet tail is subtracted first — it is the PRICE of
  // detecting quiet, not drain work. Deliberately a DIAGNOSIS, not an abort: the settle is still allowed
  // to run to the full budget and complete, so a slow run reports "it drained, but far slower than it
  // should" rather than aborting with the rest of the sweep unmeasured.
  const stormDrainMs = Math.max(0, stormQuiet.waitedMs - STORM_SETTLE_QUIET_MS);
  const perReportMs = stormCalls.length > 0 ? stormDrainMs / stormCalls.length : Number.POSITIVE_INFINITY;
  record(
    's4-storm-settle',
    `the storm reaches genuine quiet inside a budget DERIVED from its own requested work (${STORM_SETTLE_QUIET_MS}ms quiet + ${STORM_ADMIT_CEILING} admittable reports x ${PER_REPORT_BUDGET_MS}ms), and stays within that per-report cost`,
    stormQuiet.reason === 'quiet' && perReportMs < PER_REPORT_BUDGET_MS,
    `exit=${stormQuiet.reason}; drain=${stormDrainMs}ms for ${stormCalls.length} admitted = ${perReportMs === Number.POSITIVE_INFINITY ? 'n/a' : `${perReportMs.toFixed(0)}ms`}/report (budget ${PER_REPORT_BUDGET_MS}ms, of ${STORM_SETTLE_TIMEOUT_MS}ms total)`,
  );

  // Final flush + S12 persistence probe: logException then hard-reload before it can settle.
  // wait: 6000, not 1500 — flush(5000) itself can take up to 5s to resolve and re-render the status
  // line; reading it after only 1500ms reliably captured a stale/previous value, not this call's result.
  //
  // The PRECONDITION is asserted, not assumed. `flush(5000)` returning `drained=false` while uploads are
  // genuinely still in flight is CORRECT behaviour, not a defect — so if the storm never reached quiet
  // this check must report itself INCONCLUSIVE rather than print the SDK's honest answer as a failure of
  // the SDK. (That is precisely the misreading the five-run measurement above produced twice.)
  await click(page, 's1-flush', { wait: 6000 });
  const flushStatus = await page.locator('[data-testid="s1-flush-status"]').textContent();
  record(
    's1-flush',
    'flush(5000) drains pending uploads (asserted only where the storm has genuinely gone quiet first — otherwise INCONCLUSIVE, since flush -> false is correct while traffic is still in flight)',
    stormQuiet.reason === 'quiet' && Boolean(flushStatus?.includes('drained=true')),
    `${flushStatus ?? ''} [precondition: storm quiet-wait exited by ${stormQuiet.reason} after ${stormQuiet.waitedMs}ms]`,
  );

  // Wire-level proof for performance instrumentation (PLAN §6.6) instead of stopping at "not visible via
  // MCP": @bugsee/performance POSTs batches to /v2/performance/transactions on a 3s interval
  // (FULL_LAUNCH_OPTIONS.performanceFlushIntervalMs); `perfTransactions` has been tapping that the whole
  // run (see the listener installed near the top of this script).
  const allRenderSpans = perfTransactions.flatMap((t) => t.spans ?? []).filter((s) => s.operation === 'ui.render');
  const MANUAL_RENDER_SPAN_NAME = 'ManualScenarioSpan';
  // Split, because the previous single check filtered on `operation === 'ui.render'` alone and was
  // credited in scenarios.md with proving BOTH the preprocessor's auto-injected `onMount` calls and the
  // direct manual call — while the auto-injected spans alone satisfied it. The manual span carries its
  // own name (`startSvelteRenderSpan('ManualScenarioSpan')` → `description`), which is trivially
  // assertable, so assert it.
  const autoRenderSpans = allRenderSpans.filter((s) => s.description !== MANUAL_RENDER_SPAN_NAME);
  record(
    'wire-render-spans',
    'the preprocessor\'s auto-injected onMount(startSvelteRenderSpan(\'<Name>\')) produces ui.render spans that reach /v2/performance/transactions',
    autoRenderSpans.length > 0,
    `${autoRenderSpans.length} auto-injected ui.render spans across ${perfTransactions.length} transactions`,
  );
  const manualRenderSpans = allRenderSpans.filter((s) => s.description === MANUAL_RENDER_SPAN_NAME);
  record(
    'svelte-render-span-wire',
    `the DIRECT startSvelteRenderSpan('${MANUAL_RENDER_SPAN_NAME}') call reaches /v2/performance/transactions as a ui.render span under that exact name`,
    manualRenderSpans.length > 0,
    `${manualRenderSpans.length} span(s) named ${MANUAL_RENDER_SPAN_NAME}; phases=${JSON.stringify(manualRenderSpans.map((s) => s.attributes?.['ui.render_phase']))}`,
  );
  const routeNamedTxn = perfTransactions.find(
    (t) => t?.attributes?.['bugsee.name_source'] === 'route' && typeof t.name === 'string' && t.name.includes('/habits/[id]'),
  );
  record(
    'wire-route-naming',
    "setRouteName / instrumentSvelteKitNavigation reach the wire with bugsee.name_source: 'route' and the parameterized route name",
    Boolean(routeNamedTxn),
    routeNamedTxn ? `name=${routeNamedTxn.name}` : `${perfTransactions.length} transactions seen, none matched`,
  );

  sinceCheckpoint();
  await page.click('[data-testid="s12-crash-and-reload"]');
  // 8s, not 3s: a 3s wait here originally made this control look like it produced NOTHING — the
  // recovery-then-upload cycle genuinely takes several seconds (assemble -> enqueue -> two separate
  // recovery paths each re-upload, see FINDINGS.md), and closing the browser before it finishes silently
  // discards the evidence rather than failing loudly. See FINDINGS.md for what a long-enough wait reveals.
  await page.waitForTimeout(8000);
  if (process.env.DEBUG_S12) {
    const s12CallsRaw = bugseeCalls.slice(checkpoint);
    console.log('\n--- DEBUG s12 raw calls since checkpoint ---');
    for (const c of s12CallsRaw) console.log(c.status, c.ok, c.url, c.t);
  }
  // Scoped to the ACTUAL S12 incident's UPLOADED BUNDLE CONTENT (via the tee, src/bugsee-transport.ts),
  // not a raw /v2/issues call count in a time window — a raw count is vulnerable to unrelated traffic
  // landing in the same window (measured: leftover S4-storm uploads bled into a naive count here in one
  // run, inflating the known 2-call F-1 duplicate to 21, before the storm-settle fix above). `window.
  // __bugseeTee` is fresh page state (wiped by the reload), so any matching bundle it now records can
  // only be from the recovery re-upload(s) triggered by the NEW launch, never the original (interrupted)
  // attempt.
  // `min: 3`, not 2 — this is an UPPER bound, so the poll must keep looking for the full window instead
  // of returning the instant the expected 2 appear. Breaking at `>= 2` made the `=== 2` assertion below
  // unable to observe a regression to 3 or 4 at all (a third bundle arriving even 200ms later was never
  // read), while the comment claimed exactly that guard. Polling to the deadline is what makes the
  // stated bound real; the timeout is the cost of an upper-bound assertion.
  // `delivered: 'any'`: the F-1 bound counts how many bundles the RECOVERY produced for one incident.
  // A duplicate leg whose PUT failed is still a duplicate leg, so status must not filter it out here
  // (see `waitForBundles`); their landing is asserted by `bundle-upload-status-wire` instead.
  const s12Bundles = await waitForBundles(
    bySummary('S12: persist+recover across a hard reload'),
    { min: 3, timeout: 12_000, delivered: 'any' },
  );
  // The bound is CONDITIONAL on the channel being clear, because that is the honest limit of what this
  // check can observe. Two regimes:
  //
  //   * Storm reached quiet (`stormQuiet.reason === 'quiet'`) — the recovery had the wire to itself for
  //     the whole poll window, so BOTH legs of the F-1 duplicate are observable and the bound is EXACT
  //     (2). `>= 1` here would silently keep passing if a regression made this WORSE (3, 4, ...).
  //   * Storm did NOT reach quiet — the recovery re-upload competed with a still-draining storm backlog
  //     for the same rate-limit and transport budget, and a leg landing after the 12s poll window is
  //     indistinguishable from a leg that never happened. `=== 2` there would be asserting something
  //     this script did not measure, so the claim degrades to what it CAN still see: recovery happened
  //     at all, and it was not worse than the documented duplicate.
  //
  // F-1's SUBSTANCE is unaffected — the duplicate is DETERMINISTIC, not probabilistic: it reproduces on
  // every isolated click (see FINDINGS.md F-1's single-click probe, which has no storm in front of it),
  // and samples/solid-spa measured the same seam at SSOLID-80 = 10 -> 12 -> 14 over three consecutive
  // sweeps (exactly +2 each, against a +1 dedupe control). What is conditional is only this sweep's
  // ability to WITNESS both legs at the tail of a 200-exception storm. If/when F-1 is fixed upstream the
  // clear-channel bound must drop to `=== 1` (and FINDINGS.md F-1 move to Resolved) together.
  //
  // The contended bound is NOT a way of always passing. Measured by deliberately shrinking the settle
  // budget above to ~its old size: the contended run delivered ZERO observable bundles and this check
  // went red on the `>= 1` half. "1-2" still requires recovery to actually be seen; it only stops the
  // sweep from claiming it counted BOTH legs when it had no clear window to count them in.
  const s12ChannelClear = stormQuiet.reason === 'quiet';
  const s12Ok = s12ChannelClear
    ? s12Bundles.length === 2
    : s12Bundles.length >= 1 && s12Bundles.length <= 2;
  record(
    's12-persist-recover',
    'logException then immediate hard-reload — recovers on next launch as the KNOWN duplicate pair (FINDINGS.md F-1, not yet fixed upstream): EXACTLY 2 uploaded bundles when the storm settled first, 1-2 when it did not (a leg arriving after the poll window is unobservable, not absent)',
    s12Ok,
    `${s12Bundles.length} uploaded bundle(s) carrying the S12 report on recovery; channel ${s12ChannelClear ? 'CLEAR (bound: exactly 2)' : 'CONTENDED, storm never quiet (bound: 1-2)'}`,
  );

  // The page-load transaction finishes only on visibilitychange -> hidden (packages/performance/src/
  // page-load.ts:149-154), which a headless sweep never naturally triggers (the tab is never actually
  // backgrounded) — not a defect, just an artifact of how this transaction is designed to finalize
  // (after LCP/CLS/INP settle). Simulate it, LAST (after every other check, since forcing the document
  // hidden could plausibly change timer/throttling behavior for anything that runs afterward), to prove
  // the feature genuinely reaches the wire instead of leaving it undemonstrated.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // The finished transaction still has to wait for the NEXT continuous-upload batch
  // (performanceFlushIntervalMs: 3000 in FULL_LAUNCH_OPTIONS) — poll past that interval rather than a
  // fixed short sleep (an 800ms wait here originally made this look like it never reaches the wire at
  // all; it does, just not within 800ms).
  {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !perfTransactions.some((t) => t.operation === 'pageload')) {
      await page.waitForTimeout(200);
    }
  }
  const pageloadTxn = perfTransactions.find((t) => t.operation === 'pageload');
  record(
    'wire-page-load-transaction',
    "the automatic page-load transaction (finishes on visibilitychange -> hidden) reaches /v2/performance/transactions once the page is hidden",
    Boolean(pageloadTxn),
    pageloadTxn ? `name=${pageloadTxn.name}` : `${perfTransactions.length} transactions seen this run, none matched op=pageload`,
  );

  // ---- Upload STATUS: the residual, now that the general case moved into `waitForBundles`.
  //
  // `src/bugsee-transport.ts` records the HTTP `status` of every bundle-upload PUT, and for a long time
  // nothing read it — `getCapturedBundles()` admits a record as soon as its body PARSED, regardless of
  // what S3 answered. So every "the UPLOADED bundle carries X" row rested on the body the SDK handed the
  // transport: evidence the SDK BUILT the bundle right, not that it landed. An expired presigned URL
  // (403) or an S3 5xx would leave ~30 of them green with nothing reaching the backend.
  //
  // The FIRST fix for that was this check, scoped to four hand-named bundles. That was too narrow: it
  // repaired the four rows that happened to be listed and left every other `... reaches the wire` row
  // asserting what was SENT rather than what S3 ACCEPTED. The fix now lives at the source instead —
  // `waitForBundles` admits only 2xx-delivered bundles by default (see its doc comment), which repairs
  // every existence row at once, including the ones added after this block was written.
  //
  // What remains here is the RESIDUAL: the three callers that deliberately opt out of that filter with
  // `delivered: 'any'`, because their claim is about how many bundles the SDK BUILT (a veto absence, the
  // dedupe upper bound, the S12 recovery bound) and filtering by status would let a wrongly-built bundle
  // pass by failing to upload. Those bundles' landing is unasserted unless it is asserted here.
  // (`optionsBundle`/`probeBundle`/`mutateBundle`/`replayProbeBundle` are covered by the helper now, so
  // they are gone from this list — keeping them would be asserting the same thing twice.)
  //
  // Still deliberately NOT ranging over every record in the tee: the S4 storm pushes ~100 uploads through
  // a rate-limited path at once, and making this assertion cover those would couple it to storm behaviour
  // it is not about.
  const uploadStatuses = [
    ['s4-dedupe', ...dedupeBundles],
    ['s12-recover', ...s12Bundles],
  ].flatMap(([name, ...bundles]) => bundles.map((b, i) => ({ name: `${name}#${i + 1}`, status: b?.status })));
  const badUploads = uploadStatuses.filter(
    (u) => !(typeof u.status === 'number' && u.status >= 200 && u.status < 300),
  );
  record(
    'bundle-upload-status-wire',
    'the bundles read with `delivered: \'any\'` (dedupe, S12 recovery) — the only ones the helper\'s 2xx filter does not already cover — actually LANDED: each S3 PUT answered 2xx. Without this, a bundle counted toward one of those bounds could have failed to upload entirely and nothing would say so',
    uploadStatuses.length > 0 && badUploads.length === 0,
    JSON.stringify(uploadStatuses),
  );

  } catch (err) {
    console.error('\nSweep aborted by an unexpected throw (partial results below):', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }

  // ---------------------------------------------------------------------------------------- Report
  // Always prints, even on an aborted run — see the note above main()'s try block.
  if (results.length > 0) {
    const width = Math.max(...results.map((r) => r.id.length)) + 2;
    console.log('\n=== svelte-spa scenario sweep ===\n');
    for (const r of results) {
      const status = r.ok ? 'PASS' : 'FAIL';
      console.log(`${status}  ${r.id.padEnd(width)} ${r.description}${r.detail ? ` — ${r.detail}` : ''}`);
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed (LOCAL/WIRE level only — see scenarios.md for backend/MCP verification)`);
    if (failed.length > 0) process.exitCode = 1;
  }
  if (pageErrors.length > 0) {
    console.log(`\nUncaught page errors observed (expected for S5): ${pageErrors.length}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // ALWAYS terminate — a lingering Playwright/browser handle must never keep the process alive past
    // the report. See the note above main()'s try block for how this was found.
    process.exit(process.exitCode ?? 0);
  });
