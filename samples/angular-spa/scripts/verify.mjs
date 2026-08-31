// The scripted scenario sweep (docs/samples/PLAN.md §3/§6). Drives the REAL app + REAL SDK headlessly
// via Playwright: exercises the Expense-report app itself, then every control in the Scenario panel,
// and prints a pass/fail table for what could be checked from the browser (LOCAL: no throw / WIRE: the
// right request left the process). Backend (MCP) verification is a SEPARATE step the build agent runs
// by hand against the printed evidence — see scenarios.md.
//
// Mirrors samples/react-spa/scripts/verify.mjs's structure (same waitForCalls/waitForQuiet helpers) so
// the two samples' sweeps read the same way. Requires `pnpm dev` running in another terminal first.
import { chromium } from 'playwright';

const BASE = 'http://localhost:5306';
const results = [];

function record(id, description, ok, detail = '') {
  results.push({ id, description, ok, detail });
}

async function click(page, testid, { wait = 350 } = {}) {
  await page.click(`[data-testid="${testid}"]`, { timeout: 5000 });
  await page.waitForTimeout(wait);
}

async function statusTextOk(page, testid) {
  const text = await page.locator(`[data-testid="${testid}"]`).locator('xpath=following-sibling::p').first().textContent();
  return text ?? '';
}

/** Like statusTextOk, but also reads the `.ok`/`.err` class the template binds from the control's real
 *  return value — for controls whose component method actually computes success/failure (flush(),
 *  stop(), performanceSampleRate:0, the S10 echo-headers probe), so verify.mjs stops hardcoding `true`
 *  for checks that have a real signal available.
 *
 *  `manual transaction` used to be on that list and is NOT: `manualTransaction()` prints its status text
 *  and takes `setStatus`'s default `ok = true` unconditionally, computing neither half (see the note at
 *  the `s9-manual-transaction` check). Being ON this list is a claim about the CONTROL, not about the
 *  helper — verify each addition against the component method before adding it. */
async function statusOk(page, testid) {
  const p = page.locator(`[data-testid="${testid}"]`).locator('xpath=following-sibling::p').first();
  const text = (await p.textContent().catch(() => null)) ?? '';
  const ok = await p.evaluate((el) => el.classList.contains('ok')).catch(() => false);
  return { text, ok };
}

async function isLaunched(page) {
  const text = await page.locator('[data-testid="is-launched"]').textContent();
  return text?.trim() === 'true';
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true });

  const pageErrors = [];
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
    // `method` (round 7) is what lets `wire-upload-status` single out the presigned bundle PUTs from the
    // rest of the SDK's traffic. Unlike the in-page tee, this list survives every navigation in the run,
    // so it is the only run-wide view of whether uploads were actually STORED.
    bugseeCalls.push({ url: res.url(), method: res.request().method(), status: res.status(), ok, t: Date.now() });
  });

  // WIRE evidence for @bugsee/performance: the extension uploads finished transactions as
  // `POST <endpoint>/v2/performance/transactions` with a `{ transactions: TransactionWire[] }` body
  // (`packages/performance/src/performance-send.ts:23`), each transaction carrying its own `status` and
  // its full `spans: SpanWire[]` array. Intercepting the REQUEST body here is the only way to assert on
  // what a performance control actually produced — the app's own status line is written by the control
  // itself and can say anything. Same technique as samples/solid-spa/scripts/verify.mjs:79-99.
  const perfTransactionCalls = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().includes('/v2/performance/transactions')) return;
    try {
      const body = JSON.parse(req.postData() ?? '{}');
      perfTransactionCalls.push({ transactions: body.transactions ?? [], t: Date.now() });
    } catch {
      // malformed/unreadable body — nothing to record
    }
  });
  /** Wait until a transaction matching `match` reaches the wire, restricted to POSTs at/after `sinceTs`
   *  (so a check proves THIS click's upload, not a same-named one from earlier in the sweep). Returns
   *  whatever matched — possibly empty; the caller decides what "found nothing" means. */
  const waitForPerfTransactions = async (match, { timeout = 15_000, poll = 100, sinceTs = 0 } = {}) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = perfTransactionCalls
        .filter((c) => c.t >= sinceTs)
        .flatMap((c) => c.transactions)
        .filter(match);
      if (found.length > 0 || Date.now() >= deadline) return found;
      await page.waitForTimeout(poll);
    }
  };

  let checkpoint = 0;
  const isIssueCall = (c) => c.url.includes('issues');

  /** Wait until MIN matching calls have appeared (or timeout), advancing the checkpoint either way. */
  const waitForCalls = async (match, { timeout = 20_000, min = 1, poll = 100 } = {}) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const slice = bugseeCalls.slice(checkpoint);
      if (slice.filter(match).length >= min || Date.now() >= deadline) {
        checkpoint = bugseeCalls.length;
        return slice;
      }
      await page.waitForTimeout(poll);
    }
  };

  /**
   * Wait until bugsee traffic SETTLES (no new call for quietMs) — the right wait for an upper-bound
   * check. Returns `{ calls, reason, waitedMs }`: `reason` is `'quiet'` when the quiet window was
   * genuinely reached, `'timeout'` when the budget ran out with traffic STILL flowing.
   *
   * That distinction is load-bearing, not cosmetic: an earlier revision returned only the call slice,
   * so a caller could not tell "traffic really stopped" from "we gave up while uploads were still in
   * flight". This sample's own FINDINGS.md F-6 was built on exactly that ambiguity — it read a
   * `flush(5000) -> false` immediately after a `waitForQuiet` that had in fact exited by TIMEOUT (with
   * ~20s of genuine upload work still queued) as evidence of an SDK defect, when `false` was the
   * correct answer. Callers that make an upper-bound claim MUST check `reason === 'quiet'`.
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
  const sinceCheckpoint = () => {
    checkpoint = bugseeCalls.length;
  };

  /**
   * Bundle-level (WIRE) evidence, via src/app/bugsee-transport.ts's tee — it forwards every SDK call
   * to real staging verbatim while recording a parsed copy of each uploaded bundle in the page. Polls
   * until a bundle matching `matchFn` shows up, or `timeout` elapses (absence is itself a valid,
   * asserted-on result — e.g. proving a vetoed report never produces a bundle at all). Needed because
   * several LOCAL-only checks below only prove the app's OWN filter/status callback ran, not that the
   * SDK actually applied its return value to what got uploaded — PLAN §6.6, item 2/3 of this fix pass.
   */
  /**
   * Did the presigned PUT that carried this bundle actually STORE it?
   *
   * Round 7 hole (found by a peer sample, present here too): the tee parses `record.bundle` from the
   * REQUEST body — the bytes handed to the transport — so the parsed bundle exists whether the upload
   * was accepted or refused, and `CapturedCall.status` was recorded by the tee and read by ZERO checks.
   * Every "the UPLOADED bundle carries X" check in this file was therefore really asserting "the body
   * handed to the transport carried X": a 403 on the S3 PUT would have left ~30 wire checks green with
   * nothing whatsoever reaching the backend. Applied inside `waitForBundle`, so a refused upload can no
   * longer satisfy a wire check; `wire-upload-status` at the end of the run reports the whole picture,
   * which is what covers the checks that assert a bundle is ABSENT (the S8 veto pair), where a gate on
   * its own would be silent.
   */
  const uploadStored = (b) => typeof b.status === 'number' && b.status >= 200 && b.status < 300;

  const waitForBundle = async (matchFn, { timeout = 8000, poll = 150 } = {}) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const bundles = await page.evaluate(() => window.__bugseeTee?.getCapturedBundles() ?? []);
      const found = bundles.find((b) => uploadStored(b) && matchFn(b));
      if (found !== undefined || Date.now() >= deadline) return found;
      await page.waitForTimeout(poll);
    }
  };

  /** Every bundle-upload the tee recorded whose PUT was NOT 2xx — read fresh from the page, since the
   *  tee's ring is the only place a refused upload is visible at all. */
  const refusedUploads = async () =>
    (await page.evaluate(() => window.__bugseeTee?.getCapturedBundles() ?? []))
      .filter((b) => !uploadStored(b))
      .map((b) => ({ status: b.status, summary: b.bundle?.request?.summary ?? '(no summary)' }));

  let errorCheckpoint = 0;
  const newPageErrors = () => {
    const count = pageErrors.length - errorCheckpoint;
    errorCheckpoint = pageErrors.length;
    return count;
  };

  // ---------------------------------------------------------------------------------------- App smoke
  await page.goto(`${BASE}/expenses`, { waitUntil: 'networkidle' });
  const expenseCount = await page.locator('[data-testid^="expense-row-"]').count();
  record('app-expenses-list', 'Expenses list shows seeded expenses', expenseCount >= 5, `${expenseCount} rows`);

  // New expense — reactive form + validation + file attachment.
  await page.click('[data-testid="new-expense-link"]');
  await page.waitForSelector('[data-testid="expense-title"]', { timeout: 5000 });
  await page.click('[data-testid="submit-expense"]'); // trigger validation with an empty/invalid form
  await page.waitForTimeout(200);
  const titleError = await page.locator('[data-testid="error-title"]').count();
  record('app-form-validation', 'Reactive form shows a validation error on an empty required field', titleError === 1);

  const runTag = Date.now().toString(36);
  await page.fill('[data-testid="expense-title"]', `Verify expense ${runTag}`);
  await page.fill('[data-testid="expense-amount"]', '123.45');
  await page.selectOption('[data-testid="expense-category"]', 'Software');
  await page.setInputFiles('[data-testid="expense-attachment"]', {
    name: 'receipt.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('a fake receipt for the verify sweep'),
  });
  await page.waitForTimeout(200);
  const attachmentShown = await page.locator('[data-testid="attachment-name"]').count();
  record('app-file-attachment', 'File input reads a receipt into the form (FileReader -> base64)', attachmentShown === 1);
  await page.click('[data-testid="submit-expense"]');
  await page.waitForSelector('[data-testid="expense-detail"]', { timeout: 5000 });
  const detailTitle = await page.locator('[data-testid="expense-detail"] h2').textContent();
  record('app-create-expense', 'Create expense navigates to its detail page', detailTitle?.includes(runTag) ?? false);
  const attachmentDownload = await page.locator('[data-testid="attachment-download"]').count();
  record('app-attachment-download', 'Expense detail shows a download link for the attachment', attachmentDownload === 1);

  // HttpClient (XHR) network capture — wire-level, PLAN §6.6 item 3 of this fix pass. The app's real
  // CRUD above (`core/expense.service.ts`, `provideHttpClient()` with no `withFetch()`) just issued
  // several `/api/expenses` requests through Angular's default XHR backend. Force a report right now
  // (via `window.__bugsee`) so its network.json necessarily includes them, then inspect the tee'd copy
  // of the UPLOADED bundle directly — closing the gap the earlier build only had `SANGULAR-7` (an
  // EXCEPTION report, not a network entry) for. See scenarios.md's corrected S7 HttpClient row.
  await page.evaluate(() => {
    void window.__bugsee?.logException(new Error('S7: wire-level marker for the HttpClient network entry'));
  });
  const httpClientBundle = await waitForBundle(
    (b) => b.bundle?.request?.summary === 'S7: wire-level marker for the HttpClient network entry',
  );
  const httpClientEntry = httpClientBundle?.bundle?.network?.find((n) => n.url?.includes('/api/expenses'));
  record(
    'app-httpclient-network-wire',
    'HttpClient (XHR) CRUD traffic actually appears as a network entry in the UPLOADED bundle',
    httpClientEntry !== undefined,
    `bundle found=${httpClientBundle !== undefined}; matching /api/expenses entry found=${httpClientEntry !== undefined}`,
  );

  // Approvals: guard redirect when NOT a manager, then toggle manager mode and approve one.
  await page.goto(`${BASE}/approvals`, { waitUntil: 'networkidle' });
  const deniedBanner = await page.locator('[data-testid="denied-banner"]').count();
  const redirectedToExpenses = page.url().includes('/expenses');
  record('app-guard-redirect', 'managerGuard redirects a non-manager /approvals visit to /expenses', deniedBanner === 1 && redirectedToExpenses, page.url());

  await page.check('[data-testid="manager-toggle"]');
  await page.goto(`${BASE}/approvals`, { waitUntil: 'networkidle' });
  const approvalsTable = await page.locator('[data-testid="approvals-table"]').count();
  record('app-manager-access', 'Manager mode grants access to the lazy-loaded /approvals feature', approvalsTable === 1);
  // Real check, not a hardcoded true: when there IS a pending expense, the approve button must actually
  // remove it from the pending list — only the "nothing pending" branch is legitimately unfalsifiable.
  const pendingBeforeApprove = await page.locator('[data-testid^="approve-"]').count();
  const hasApprovable = pendingBeforeApprove > 0;
  if (hasApprovable) {
    await page.locator('[data-testid^="approve-"]').first().click();
    await page.waitForTimeout(400);
  }
  const pendingAfterApprove = await page.locator('[data-testid^="approve-"]').count();
  record(
    'app-approve-expense',
    'Approve button removes the expense from the pending list',
    hasApprovable ? pendingAfterApprove === pendingBeforeApprove - 1 : true,
    hasApprovable ? `pending ${pendingBeforeApprove} -> ${pendingAfterApprove}` : 'nothing pending to approve',
  );

  // ---------------------------------------------------------------------------------------- Settings (S2)
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await page.fill('[data-testid="user-id-input"]', 'verify-script-user@bugsee.dev');
  await click(page, 'set-user-id');
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
  await click(page, 'clear-attribute'); // clears "tags" (the last attrKey set above)
  const attrsAfterClear = await page.locator('[data-testid="attrs-dump"]').textContent();
  record('s2-clear-attribute', 'clearAttribute("tags")', Boolean(attrsAfterClear && !attrsAfterClear.includes('gamma')), attrsAfterClear ?? '');
  await click(page, 'clear-all-attributes');
  const attrsAfterClearAll = await page.locator('[data-testid="attrs-dump"]').textContent();
  record('s2-clear-all-attributes', 'clearAllAttributes()', attrsAfterClearAll?.trim() === '{}', attrsAfterClearAll ?? '');
  await click(page, 'clear-user-id');
  const clearedStatus = await page.locator('.status-line').first().textContent();
  record('s2-clear-user-id', 'clearUserIdentifier()', Boolean(clearedStatus?.includes('null')), clearedStatus ?? '');

  // ---------------------------------------------------------------------------------- Scenario panel
  await page.goto(`${BASE}/scenarios`, { waitUntil: 'networkidle' });

  // S1: relaunch demos first (each rebuilds the client) — minimal, then a direct stop() probe, then full.
  //
  // `calls.every(c => c.ok)` was the whole wire half of these two checks, and it is VACUOUS: a relaunch
  // issues no Bugsee HTTP traffic of its own (nothing is uploaded until a report exists), so the slice is
  // reliably `[]` and `[].every(...)` is `true` — both checks collapsed to `isLaunched`. Replaced with a
  // real positive signal available from the page: the relaunch must have produced a DIFFERENT client
  // instance than the one that was live before it (that is what `relaunch()` claims to do, and a no-op
  // relaunch — the sample's own F-0 bug class — would leave the same object in place). The
  // "no bugsee call failed" conjunct is kept but stated honestly in the detail, including the count, so a
  // zero-call slice can no longer read as a passed assertion.
  sinceCheckpoint();
  const clientBeforeMinimal = await page.evaluate(() => {
    window.__verifyPrevClient = window.__bugsee;
    return window.__bugsee !== undefined;
  });
  await click(page, 's1-relaunch-minimal', { wait: 0 });
  const minimalQuiet = await waitForQuiet();
  const minimalLaunched = await isLaunched(page);
  const minimalIsNewClient = await page.evaluate(
    () => window.__bugsee !== undefined && window.__bugsee !== window.__verifyPrevClient,
  );
  const minimalFailed = minimalQuiet.calls.filter((c) => !c.ok);
  record(
    's1-relaunch-minimal',
    'launch({}) — every OTHER option at its default (endpoint/appId/etc still pinned to staging; see FINDINGS.md)',
    clientBeforeMinimal && minimalLaunched && minimalIsNewClient && minimalFailed.length === 0,
    `hadClientBefore=${clientBeforeMinimal}; isLaunched=${minimalLaunched}; newClientInstance=${minimalIsNewClient}; ` +
      `bugseeCalls=${minimalQuiet.calls.length} (failed=${minimalFailed.length}; a relaunch normally issues none), ` +
      `quiet-wait exited by ${minimalQuiet.reason} after ${minimalQuiet.waitedMs}ms`,
  );

  await click(page, 's1-stop', { wait: 0 });
  const stopStatus = await statusOk(page, 's1-stop');
  record('s1-stop', 'stop(2000) — direct call returns a real boolean (discarded everywhere else)', stopStatus.ok, stopStatus.text);

  sinceCheckpoint();
  await page.evaluate(() => {
    window.__verifyPrevClient = window.__bugsee;
  });
  await click(page, 's1-relaunch-full', { wait: 800 });
  const fullQuiet = await waitForQuiet();
  const fullLaunched = await isLaunched(page);
  const fullIsNewClient = await page.evaluate(
    () => window.__bugsee !== undefined && window.__bugsee !== window.__verifyPrevClient,
  );
  const fullFailed = fullQuiet.calls.filter((c) => !c.ok);
  record(
    's1-relaunch-full',
    'launch(FULL_LAUNCH_OPTIONS)',
    fullLaunched && fullIsNewClient && fullFailed.length === 0,
    `isLaunched=${fullLaunched}; newClientInstance=${fullIsNewClient}; ` +
      `bugseeCalls=${fullQuiet.calls.length} (failed=${fullFailed.length}), ` +
      `quiet-wait exited by ${fullQuiet.reason} after ${fullQuiet.waitedMs}ms`,
  );

  const isLaunchedText = await page.locator('[data-testid="is-launched"]').textContent();
  record('s1-is-launched', 'isLaunched() reflects the launched client', isLaunchedText?.trim() === 'true', isLaunchedText ?? '');

  await click(page, 's1-duplicate-launch');
  const dupStatus = await statusTextOk(page, 's1-duplicate-launch');
  record('s1-duplicate-launch', 'second launch() on the same carrier is ignored', dupStatus.includes('true'), dupStatus);

  // S3 manual telemetry — ALL FOUR checks are now WIRE checks (round-5 fix). Each used to read
  // `<x>Launched && newPageErrors() === 0`; the `newPageErrors()` half is dead app-wide (documented at
  // the Angular-error-seam block below), so every one of them reduced to a fact `s1-is-launched`
  // already asserts — nothing about `log()`/`event()`/`trace()`/`addBreadcrumb()` themselves. Each of
  // those four APIs writes a capture entry that the bundle assembler serializes into its own file
  // (`packages/core/src/client.ts:569-624`; `logs.json` / `events.user.json` / `traces.user.json` /
  // `breadcrumbs`, `packages/protocol/src/constants.ts`), so all four are directly visible in the
  // tee'd copy of the uploaded bundle. Same fix shape round 4 applied to `s6-console`.
  //
  // The four control groups are clicked first and ONE marker report then drains the capture ring they
  // all wrote into — four separate reports would cost four extra staging issues per sweep for no extra
  // evidence.
  newPageErrors();
  for (const level of ['error', 'warning', 'info', 'debug', 'verbose']) {
    await click(page, `s3-log-${level}`, { wait: 150 });
  }
  await click(page, 's3-event-params');
  await click(page, 's3-event-no-params');
  await click(page, 's3-trace');
  await click(page, 's3-breadcrumb');
  const s3Launched = await isLaunched(page);
  const s3NoThrow = newPageErrors() === 0;
  await page.evaluate(() => {
    void window.__bugsee?.logException(new Error('S3: wire-level marker for log/event/trace/breadcrumb'));
  });
  const s3WireBundle = await waitForBundle(
    (b) => b.bundle?.request?.summary === 'S3: wire-level marker for log/event/trace/breadcrumb',
  );

  // log() at every level: the message must be in logs.json AND carry the right NUMERIC wire level
  // (`packages/protocol/src/levels.ts:23-29` — error=1 … verbose=5; the manual API maps the string
  // level itself at `client.ts:596-600`). Asserting the level is what makes this more than "a log
  // arrived": a mapping that collapsed every level to one value would still ship five messages.
  const WIRE_LEVEL = { error: 1, warning: 2, info: 3, debug: 4, verbose: 5 };
  const s3Logs = s3WireBundle?.bundle?.logs ?? [];
  const s3LogHits = Object.entries(WIRE_LEVEL).map(([name, wire]) => {
    const hit = s3Logs.find((l) => l.message === `sample log at level=${name}`);
    return { name, found: hit !== undefined, level: hit?.level, expected: wire };
  });
  record(
    's3-log',
    'log() at every LogLevel -> logs.json in the UPLOADED bundle carries all five, each at its own numeric wire level',
    s3LogHits.every((h) => h.found && h.level === h.expected) && s3Launched && s3NoThrow,
    `isLaunched=${s3Launched}; ${JSON.stringify(s3LogHits)}`,
  );

  const s3Events = s3WireBundle?.bundle?.userEvents ?? [];
  const s3WithParams = s3Events.find((e) => e.name === 'expense_created');
  const s3NoParams = s3Events.find((e) => e.name === 'scenario_panel_opened');
  record(
    's3-event',
    'event() with/without params -> events.user.json in the UPLOADED bundle carries both, with params preserved',
    s3WithParams !== undefined &&
      s3WithParams.params?.category === 'Software' &&
      s3WithParams.params?.source === 'scenario-panel' &&
      s3NoParams !== undefined &&
      s3NoParams.params === undefined &&
      s3Launched,
    `isLaunched=${s3Launched}; events.user.json=${JSON.stringify(s3Events.map((e) => ({ name: e.name, params: e.params })))}`,
  );

  const s3Traces = s3WireBundle?.bundle?.userTraces ?? [];
  const s3Trace = s3Traces.find((t) => t.name === 'render.expenses_list');
  record(
    's3-trace',
    'trace(name, value) -> traces.user.json in the UPLOADED bundle carries the name AND the value verbatim',
    s3Trace !== undefined && s3Trace.value?.ms === 12.4 && s3Trace.value?.rows === 5 && s3Launched,
    `isLaunched=${s3Launched}; traces.user.json=${JSON.stringify(s3Traces)}`,
  );

  const s3Crumb = s3WireBundle?.bundle?.breadcrumbs?.find(
    (b) => b.message === 'user clicked "Add breadcrumb" in the scenario panel',
  );
  record(
    's3-breadcrumb',
    'addBreadcrumb() — every field survives to the UPLOADED bundle (type/category/level/data)',
    s3Crumb !== undefined &&
      s3Crumb.type === 'navigation' &&
      s3Crumb.category === 'ui.click' &&
      s3Crumb.level === 'info' &&
      s3Crumb.data?.control === 's3-breadcrumb' &&
      s3Crumb.data?.screen === 'scenarios' &&
      s3Launched,
    `isLaunched=${s3Launched}; breadcrumb=${JSON.stringify(s3Crumb ?? null)}`,
  );

  // S4 exceptions
  sinceCheckpoint();
  await click(page, 's4-error', { wait: 0 });
  record('s4-error', 'logException(new Error)', (await waitForCalls(isIssueCall)).some((c) => isIssueCall(c) && c.ok));
  await click(page, 's4-string', { wait: 0 });
  record('s4-string', 'logException(string)', (await waitForCalls(isIssueCall)).some(isIssueCall));
  await click(page, 's4-object', { wait: 0 });
  record('s4-object', 'logException(object)', (await waitForCalls(isIssueCall)).some(isIssueCall));
  await click(page, 's4-null', { wait: 0 });
  record('s4-null', 'logException(null)', (await waitForCalls(isIssueCall)).some(isIssueCall));
  await click(page, 's4-cause', { wait: 0 });
  record('s4-cause', 'logException with chained cause', (await waitForCalls(isIssueCall)).some(isIssueCall));
  await click(page, 's4-options', { wait: 0 });
  record('s4-options', 'logException with LogExceptionOptions', (await waitForCalls(isIssueCall)).some(isIssueCall));
  // WIRE half, added in round 6. `s4-options` above only asserts "an issue call happened", which is the
  // same thing `s4-error` asserts — it says nothing about the OPTIONS. The backend evidence was no
  // better while the fixture passed the SDK's own defaults (`mechanism: 'programmatic'` is
  // `client.ts:661`'s default and `severity: 'high'` is `defaultSeverity('error')`), so the `s4-options`
  // issue rendered byte-identical to the `s4-error` one and only `# Labels` discriminated. The fixture
  // now passes NON-DEFAULT values (`scenario-panel.component.ts`'s `logWithOptions`) and this reads them
  // straight off the uploaded `request.json` — the file the tee has parsed all along
  // (`bugsee-transport.ts:100-103`) and which carries `severity` and `source.mechanism`
  // (`packages/protocol/src/wire.ts:108-118`) that no check had ever looked at.
  const s4OptionsBundle = await waitForBundle(
    (b) => b.bundle?.request?.summary === 'S4: with LogExceptionOptions',
    { timeout: 15_000 },
  );
  const s4OptionsReq = s4OptionsBundle?.bundle?.request;
  // Wire severity is numeric (`packages/protocol/src/levels.ts:15-21`): blocker=5, and the DEFAULT this
  // control would otherwise get is high=3. Asserting `=== 5` therefore fails if the option is ignored.
  const s4OptionsOk =
    s4OptionsReq !== undefined &&
    s4OptionsReq.severity === 5 &&
    s4OptionsReq.source?.mechanism === 'manual-dialog' &&
    Array.isArray(s4OptionsReq.labels) &&
    s4OptionsReq.labels.includes('scenario-panel') &&
    s4OptionsReq.labels.includes('s4-options');
  record(
    's4-options-wire',
    'LogExceptionOptions actually reach the wire — the UPLOADED request.json carries the NON-DEFAULT severity (blocker=5, not the default high=3), mechanism (manual-dialog, not the default programmatic) and both labels',
    s4OptionsOk,
    `bundle found=${s4OptionsBundle !== undefined}; severity=${s4OptionsReq?.severity} (default would be 3); ` +
      `source=${JSON.stringify(s4OptionsReq?.source ?? null)}; labels=${JSON.stringify(s4OptionsReq?.labels ?? null)}`,
  );
  await click(page, 's4-dedupe', { wait: 0 });
  const dedupeQuiet = await waitForQuiet();
  const dedupeCalls = dedupeQuiet.calls.filter(isIssueCall);
  // Was `<= 1`, which passes on ZERO issue calls too — the real expectation is EXACTLY one.
  record('s4-dedupe', 'same instance twice — should dedupe (1 issue, not 2)', dedupeCalls.length === 1, `${dedupeCalls.length} issue calls`);
  // s4-storm runs LAST (see the note by the react-spa sweep it mirrors): 200 logException calls trips
  // the rate limiter, whose window would otherwise swallow unrelated scenarios that follow it.

  // S5 crashes
  sinceCheckpoint();
  newPageErrors();
  await click(page, 's5-uncaught', { wait: 0 });
  const uncaughtCalls = await waitForCalls(isIssueCall);
  // The `newPageErrors() > 0` disjunct is DEAD in this app and is left in place deliberately, not
  // overlooked: `BugseeErrorHandler` (`src/app/app.config.ts:20`) absorbs the throw before it can reach
  // Playwright's `pageerror`, so this reduces to "the SDK actually issued an issue upload" — the
  // STRONGER of the two halves. Removing the disjunct would change nothing about what passes; keeping it
  // documents that a non-Angular-wired build of this same page would still be covered.
  record('s5-uncaught', 'uncaught exception -> window.onerror', newPageErrors() > 0 || uncaughtCalls.some(isIssueCall));
  await click(page, 's5-rejection', { wait: 0 });
  record('s5-rejection', 'unhandled promise rejection', (await waitForCalls(isIssueCall)).some(isIssueCall));

  // S6 console
  //
  // `newPageErrors() === 0` alone was UNFALSIFIABLE here and is no longer the pass condition. This app
  // installs an app-wide `BugseeErrorHandler` (`src/app/app.config.ts`), which absorbs every throw that
  // reaches Angular — so `pageErrors` stays empty for the ENTIRE sweep and an absence-of-pageerrors
  // assertion is green no matter what the console interceptor does.
  //
  // Half 1 (LOCAL, per method) reads the control's own status line after EVERY click. `consoleCall()` /
  // `consoleCircular()` (`src/app/scenarios/scenario-panel.component.ts:212-224`) call `setStatus`
  // AFTER the `console.*` call, so a console interceptor that THROWS aborts the handler and leaves the
  // line stuck on the PREVIOUS control's text — a real, per-method signal that the interceptor let the
  // call complete. (`s6-circular` is the testid read for all seven: the six method buttons live in a
  // different `.control-row` than the `<p>`, so only `s6-circular` is its preceding sibling.)
  //
  // Half 2 (WIRE) is the half that catches SILENT misbehaviour, which half 1 cannot: an interceptor
  // that returns normally but captures NOTHING leaves every status line correct. It reuses the exact
  // path `s8-log-filter-wire` already trusts — the tee parses the uploaded `logs.json` into
  // `bundle.logMessages` (`src/app/bugsee-transport.ts:72-76`) — by forcing a report right after the S6
  // clicks and asserting each console message is really IN the bundle that left the process.
  //
  // That half is demonstrably discriminating, and NOT by an injected mutation: this very run shows
  // `console.trace` MISSING from the same `logs.json` that carries the other five, because
  // `DEFAULT_LEVELS` (`packages/capture/src/console-interceptor.ts:24-30`) has no `trace` key and no
  // platform overrides it. See FINDINGS.md F-7. So `trace` is deliberately NOT part of the pass
  // condition (asserting its absence would fail the day the SDK is fixed); its wire status is reported
  // in the detail on every run, and half 1 still covers the fact that the CALL itself completes.
  newPageErrors();
  const s6Completed = [];
  const s6Missed = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    await click(page, `s6-${m}`, { wait: 120 });
    const seen = (await statusTextOk(page, 's6-circular')).trim();
    (seen === `console.${m}(...)` ? s6Completed : s6Missed).push(m);
  }
  await click(page, 's6-circular');
  const s6CircularText = (await statusTextOk(page, 's6-circular')).trim();
  const s6CircularOk = s6CircularText === 'console.log(circular object)';
  await page.evaluate(() => {
    void window.__bugsee?.logException(new Error('S6: wire-level marker for console capture'));
  });
  const s6Bundle = await waitForBundle(
    (b) => b.bundle?.request?.summary === 'S6: wire-level marker for console capture',
  );
  const s6Logs = s6Bundle?.bundle?.logMessages ?? [];
  const s6Wire = Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'debug', 'trace'].map((m) => [
      m,
      s6Logs.some((l) => l.includes(`S6: console.${m} from the scenario panel`)),
    ]),
  );
  // The five levels `DEFAULT_LEVELS` actually maps. `trace` is excluded from the pass condition on
  // purpose — see the F-7 note above.
  const s6CapturedLevels = ['log', 'info', 'warn', 'error', 'debug'];
  // Round-6 tightening. This conjunct used to be `l.includes('S6: circular object')` — the plain STRING
  // argument, which the interceptor passes through untouched (`stringifyArg`,
  // `packages/capture/src/console-interceptor.ts:33-35`). It therefore said nothing about the SERIALIZER,
  // which is the only thing the circular fixture exists to exercise: replacing `jsonSafeStringify` with
  // `String(arg)` at `console-interceptor.ts:41` yields `S6: circular object [object Object]` and the old
  // form still passed. The discriminating evidence was already in the same `logMessages` — the safe
  // stringifier replaces a back-reference with the literal `"[Circular]"`
  // (`packages/util/src/json-safe-stringify.ts:44-45`), and the fixture's back-reference is `obj.self`
  // (`scenario-panel.component.ts:229-233`). Asserting the SERIALIZED shape catches a silently-degraded
  // formatter as well as a throwing one (the throwing case was already covered: the interceptor swallows
  // the throw and emits nothing, `console-interceptor.ts:94-110`).
  const s6CircularWire = s6Logs.some(
    (l) => l.includes('S6: circular object') && l.includes('"self":"[Circular]"'),
  );
  record(
    's6-console',
    'console.* incl. multi-arg + circular object — each call completes (LOCAL) AND its message is in the UPLOADED bundle (WIRE)',
    s6Missed.length === 0 &&
      s6CircularOk &&
      s6Bundle !== undefined &&
      s6CapturedLevels.every((m) => s6Wire[m]) &&
      s6CircularWire &&
      newPageErrors() === 0,
    `handlers that ran to completion: ${s6Completed.join(',') || '(none)'}; did NOT complete: ${s6Missed.join(',') || '(none)'}; ` +
      `circular status line="${s6CircularText}"; uploaded bundle found=${s6Bundle !== undefined}; ` +
      `in logs.json: ${JSON.stringify(s6Wire)} (circular=${s6CircularWire}, as serialized: ` +
      `${JSON.stringify(s6Logs.find((l) => l.includes('S6: circular object')) ?? null)}) — ` +
      `trace:false is the KNOWN SDK defect FINDINGS.md F-7, not asserted on`,
  );

  // S7 network — per-control content assertions (reading the shared `s7-status` line after each click)
  // instead of a bare `true`; still LOCAL/WIRE only, not a wire-level inspection of the CAPTURED copy
  // (documented gap — see FINDINGS.md / scenarios.md item on wire-level verification).
  newPageErrors();
  await click(page, 's7-get');
  const s7Get = await page.locator('[data-testid="s7-status"]').textContent();
  await click(page, 's7-post-json');
  const s7PostJson = await page.locator('[data-testid="s7-status"]').textContent();
  await click(page, 's7-post-text');
  const s7PostText = await page.locator('[data-testid="s7-status"]').textContent();
  await click(page, 's7-4xx');
  const s7Get4xx = await page.locator('[data-testid="s7-status"]').textContent();
  await click(page, 's7-5xx');
  const s7Get5xx = await page.locator('[data-testid="s7-status"]').textContent();
  await click(page, 's7-connfail', { wait: 700 });
  const s7ConnFail = await page.locator('[data-testid="s7-status"]').textContent();
  await click(page, 's7-large-body');
  const s7LargeBody = await page.locator('[data-testid="s7-status"]').textContent();
  await click(page, 's7-no-content-type');
  const s7NoContentType = await page.locator('[data-testid="s7-status"]').textContent();
  await click(page, 's7-xhr');
  const s7Xhr = await page.locator('[data-testid="s7-status"]').textContent();
  await click(page, 's7-sse', { wait: 1500 });
  const s7Sse = await page.locator('[data-testid="s7-status"]').textContent();
  // sendBeacon (round 7): a capture source the substrate gained after round 6, reached by no other
  // control here — the beacon path is neither fetch nor XHR. The control prints the tag it put in the
  // beacon's url and body, and the wire half below requires THAT tag, so this pair cannot be satisfied
  // by some other request.
  await click(page, 's7-send-beacon', { wait: 400 });
  const s7Beacon = (await page.locator('[data-testid="s7-status"]').textContent()) ?? '';
  const s7BeaconTag = /beacon-[a-z0-9]+/.exec(s7Beacon)?.[0];
  const s7Checks = {
    get: s7Get?.includes('"ok":true') ?? false,
    postJson: (s7PostJson?.includes('"hello":"world"') && s7PostJson?.includes('"n":42')) ?? false,
    postText: s7PostText?.includes('plain text body') ?? false,
    get4xx: s7Get4xx?.includes('404') ?? false,
    get5xx: s7Get5xx?.includes('500') ?? false,
    connfail: (s7ConnFail?.includes('connection failure ->') && !s7ConnFail?.includes('unexpectedly succeeded')) ?? false,
    largeBody: s7LargeBody?.includes('65536 bytes') ?? false,
    noContentType: s7NoContentType?.includes('no content-type on this response') ?? false,
    // Was `includes('200')`, which searched the WHOLE status line `XHR -> ${status} ${responseText}` —
    // and the body is `{"ok":true,"now":<13-digit epoch ms>}`, so a non-2xx status whose timestamp
    // happened to contain "200" read as a pass (~1% of runs). Anchored to the status POSITION instead,
    // and the body's own success field is asserted separately.
    xhr: /^XHR -> 200 \{/.test((s7Xhr ?? '').trim()) && (s7Xhr?.includes('"ok":true') ?? false),
    sse: s7Sse?.includes('SSE event #5') ?? false,
    // LOCAL half only: `sendBeacon` returned true, i.e. the user agent QUEUED the payload. Whether the
    // SDK captured it is `s7-sendbeacon-wire` below.
    sendBeacon: s7Beacon.includes('sendBeacon queued') && s7BeaconTag !== undefined,
  };
  const s7AllOk = Object.values(s7Checks).every(Boolean) && newPageErrors() === 0;
  record(
    's7-network',
    'fetch/XHR/SSE/sendBeacon GET/POST/4xx/5xx/connfail/large-body/no-content-type — each control\'s own response content checked',
    s7AllOk,
    JSON.stringify(s7Checks),
  );

  // S7 wire-level: maxNetworkBodySize (2048, see src/app/bugsee.ts) — PLAN §6.6, item 3 of this fix
  // pass. The check above only proves the APP read the full 64KB body (interceptors don't alter app
  // behavior); it says nothing about what the SDK actually captured. The real behavior (confirmed by
  // reading packages/capture/src/network-body.ts's `boundedText`) is NOT truncation — a body over the
  // byte cap is DROPPED ENTIRELY, tagged `custom.no_body_reason: 'size_too_large'`, with no `custom.body`
  // at all. Force a report right now (via window.__bugsee, exposed by main.ts) so its network.json
  // necessarily includes the large-body request just issued, then inspect the tee'd copy of the
  // UPLOADED bundle for that exact shape.
  await page.evaluate(() => {
    void window.__bugsee?.logException(new Error('S7: wire-level marker for the large-body network entry'));
  });
  const s7WireBundle = await waitForBundle(
    (b) => b.bundle?.request?.summary === 'S7: wire-level marker for the large-body network entry',
  );
  // A GET emits (at least) two NetworkEvent stages sharing one url: 'before' (request — headers only,
  // no body-shape info for a bodiless GET) and 'complete' (response — carries `custom.body` or
  // `custom.no_body_reason`). The first url match can be the headers-only 'before' stage, so pick the
  // entry that actually carries body-shape info instead of the first url match.
  const s7NetworkEntry = s7WireBundle?.bundle?.network?.find(
    (n) => n.url?.includes('large-body') && (n.custom?.no_body_reason !== undefined || n.custom?.body !== undefined),
  );
  record(
    's7-large-body-wire',
    "maxNetworkBodySize: 2048 -> the UPLOADED bundle's copy is DROPPED (no_body_reason: 'size_too_large'), not the full 64KB the app itself read",
    s7NetworkEntry !== undefined &&
      s7NetworkEntry.custom?.no_body_reason === 'size_too_large' &&
      s7NetworkEntry.custom?.body === undefined,
    `network entry found=${s7NetworkEntry !== undefined}; custom=${JSON.stringify(s7NetworkEntry?.custom ?? null)} (app read 65536+ bytes)`,
  );

  // S7 wire-level: captureNetworkBodyWithoutType (round-5 fix). `s7-network`'s `noContentType` conjunct
  // reads only the APP's own status line — it proves the app read the body, which is true whether the
  // option is on or off (interceptors don't alter app behaviour), exactly the gap `s7-large-body-wire`
  // closed for the sibling row. The option's effect is visible directly on the uploaded entry:
  // `gateNetworkBody` (`packages/protocol/src/sanitize.ts:485-487`) nulls the body and sets
  // `custom.no_body_reason: 'no_content_type'` when the option is OFF, and leaves `custom.body` intact
  // when it is ON (`packages/capture/src/network-provider.ts:141-143` wires it from the launch option).
  // Same bundle as above: the no-content-type request was issued in the same batch, so the marker
  // report's network.json carries both entries — no second report needed.
  const s7NoTypeEntry = s7WireBundle?.bundle?.network?.find(
    (n) => n.url?.includes('no-content-type') && (n.custom?.no_body_reason !== undefined || n.custom?.body !== undefined),
  );
  record(
    's7-no-content-type-wire',
    "captureNetworkBodyWithoutType: true -> the UPLOADED bundle KEEPS the body of a response with no Content-Type (no 'no_content_type' reason)",
    s7NoTypeEntry !== undefined &&
      typeof s7NoTypeEntry.custom?.body === 'string' &&
      s7NoTypeEntry.custom.body.includes('no content-type on this response') &&
      s7NoTypeEntry.custom?.no_body_reason == null,
    `network entry found=${s7NoTypeEntry !== undefined}; custom=${JSON.stringify(s7NoTypeEntry?.custom ?? null)}`,
  );

  // S7 wire-level: the sendBeacon interceptor (round 7 — new in the substrate). The LOCAL half above
  // only proves the browser accepted the payload for queueing, which is true whether or not the SDK
  // instruments the call at all — `navigator.sendBeacon` returning true says nothing about capture.
  // The uploaded entry is what distinguishes an instrumented beacon from an invisible one: a beacon
  // reaches network.json with `mechanism: 'sendBeacon'` and `method: 'POST'` (the API is POST-only),
  // paired 'before'/'complete' stages like every other source, and the payload as `custom.body`.
  // Bound to the tag the control printed, so it cannot be satisfied by any other request in the bundle.
  const s7BeaconEntry =
    s7BeaconTag === undefined
      ? undefined
      : s7WireBundle?.bundle?.network?.find(
          (n) => n.mechanism === 'sendBeacon' && (n.url?.includes(s7BeaconTag) ?? false) && n.custom?.body !== undefined,
        );
  record(
    's7-sendbeacon-wire',
    'navigator.sendBeacon is captured — the UPLOADED bundle carries a network entry with mechanism "sendBeacon", method POST and this click\'s payload',
    s7BeaconEntry !== undefined &&
      s7BeaconEntry.method === 'POST' &&
      typeof s7BeaconEntry.custom?.body === 'string' &&
      s7BeaconEntry.custom.body.includes(s7BeaconTag ?? '\0'),
    `tag=${s7BeaconTag ?? '(none — the control never reported one)'}; entry=${JSON.stringify(
      s7BeaconEntry === undefined
        ? null
        : { mechanism: s7BeaconEntry.mechanism, method: s7BeaconEntry.method, type: s7BeaconEntry.type, url: s7BeaconEntry.url, body: s7BeaconEntry.custom?.body },
    )}`,
  );

  // S8 filters — reads the `filter-log` list the filter callbacks themselves append to, so this checks
  // that every installed filter actually FIRED with the expected redaction/veto content, not just that
  // clicking the controls didn't throw. Still LOCAL only (network-entry content itself isn't visible via
  // `get_issue` — documented gap).
  await click(page, 's8-install');
  sinceCheckpoint();
  newPageErrors();
  // Read the filter-log RIGHT AFTER each control, not once at the very end: the log is a bounded
  // 10-item ring (`scenario-panel.component.ts`'s `filterLog.update((prev) => [entry, ...prev.slice(0,
  // 9)])`), and the veto-network request's own retries/multi-stage events can push 6+ entries in a row
  // — a single end-of-sequence read was observed to evict `s8-network`'s entry entirely before it was
  // ever inspected (a real bug in this check, caught while fixing hardcoded/weak checks in this pass).
  await click(page, 's8-network', { wait: 500 });
  const filterLogAfterNetwork = await page.locator('[data-testid="filter-log"] li').allTextContents();
  await click(page, 's8-veto-network', { wait: 500 });
  const filterLogAfterVeto = await page.locator('[data-testid="filter-log"] li').allTextContents();
  await click(page, 's8-log', { wait: 300 });
  const filterLogAfterLog = await page.locator('[data-testid="filter-log"] li').allTextContents();
  await click(page, 's8-breadcrumb', { wait: 300 });
  const filterLogAfterBreadcrumb = await page.locator('[data-testid="filter-log"] li').allTextContents();
  await click(page, 's8-report-mutate', { wait: 900 });
  const filterLogAfterMutate = await page.locator('[data-testid="filter-log"] li').allTextContents();
  await click(page, 's8-report-veto', { wait: 400 }); // was 0 — the veto's report-handler callback runs
  // asynchronously, so reading filter-log immediately raced it and intermittently missed the entry
  const filterLogAfterVetoReport = await page.locator('[data-testid="filter-log"] li').allTextContents();
  const filterCalls = (await waitForQuiet()).calls.filter(isIssueCall);
  const s8Checks = {
    networkRedaction: filterLogAfterNetwork.some((l) => l.includes('droppedSecretHeader=true') && l.includes('redactedSsn=true')),
    networkVeto: filterLogAfterVeto.some((l) => l.includes('VETOED') && l.includes('veto-me')),
    logRedaction: filterLogAfterLog.some((l) => l.startsWith('log: redacted')),
    breadcrumbRedaction: filterLogAfterBreadcrumb.some((l) => l.includes('breadcrumb: redacted data.secret')),
    reportMutate: filterLogAfterMutate.some((l) => l.startsWith('report: mutated')),
    reportVeto: filterLogAfterVetoReport.some((l) => l.startsWith('report: VETOED')),
  };
  const s8Ok = Object.values(s8Checks).every(Boolean) && newPageErrors() === 0;
  record(
    's8-filters',
    'network/log/breadcrumb/report before-mutate/before-veto — each filter callback actually fired with the expected redaction',
    s8Ok,
    `${filterCalls.length} issue calls while filters installed; checks=${JSON.stringify(s8Checks)}`,
  );

  // ---- Bundle-level (wire) assertions — PLAN §6.6, item 2/3 of this fix pass. The checks above only
  // prove the Scenario panel's OWN filter callback ran and logged what it saw; they say nothing about
  // whether the SDK actually applied the filter's RETURN VALUE to what got uploaded. A mutation that
  // discarded every filter's return value would leave `s8Checks` above green. These checks inspect the
  // tee'd copy of the REAL uploaded bundle instead (src/app/bugsee-transport.ts).
  const mutateBundle = await waitForBundle(
    (b) => b.bundle?.request?.summary === 'S8: report handler should mutate this',
  );
  const mutateLabels = mutateBundle?.bundle?.request?.labels;
  record(
    's8-report-mutate-wire',
    'report handler mutate -> the UPLOADED bundle request.json carries the added label',
    Array.isArray(mutateLabels) && mutateLabels.includes('MUTATE_ME') && mutateLabels.includes('redacted-before'),
    JSON.stringify(mutateLabels ?? null),
  );
  // MATCH AMBIGUITY (fixed): this used to select `n.url?.includes('/scenario/echo')`, which is NOT unique
  // — S7's `s7-post-json` control POSTs to the SAME `/api/scenario/echo` path earlier in the sweep, and
  // its entry is still in the capture ring when this bundle is assembled. `find()` returned S7's entry
  // (body `{"hello":"world","n":42}`), so the check asserted "no x-secret-token, no SSN" about a request
  // that never carried either — it could not fail. Select on what S8's request actually CARRIES instead:
  //   * `type === 'before'` — the REQUEST stage (the only stage that carries the request headers the
  //     filter is supposed to have stripped; the `complete` stage carries the echoed RESPONSE),
  //   * `method === 'POST'`,
  //   * a body containing S8's own unredacted marker field (`ordinary field, not redacted`), which the
  //     filter deliberately leaves untouched — S7's echo payload has no such field.
  const s8NetworkEntry = mutateBundle?.bundle?.network?.find(
    (n) =>
      n.url?.includes('/scenario/echo') &&
      !n.url?.includes('veto') &&
      n.type === 'before' &&
      n.method === 'POST' &&
      typeof n.custom?.body === 'string' &&
      n.custom.body.includes('ordinary field, not redacted'),
  );
  const s8NetworkHeaders = s8NetworkEntry?.custom?.headers;
  const s8NetworkBody = s8NetworkEntry?.custom?.body;
  record(
    's8-network-filter-wire',
    'network filter -> the UPLOADED bundle has the secret header dropped and the SSN redacted',
    // `s8NetworkHeaders === undefined ||` was a vacuous escape hatch — an entry with NO headers at all
    // (i.e. no request-header capture happening) satisfied the "secret header dropped" claim. The request
    // stage always carries headers (the app sets Content-Type + x-secret-token), so require them present.
    s8NetworkEntry !== undefined &&
      s8NetworkHeaders !== undefined &&
      Object.keys(s8NetworkHeaders).length > 0 &&
      !Object.keys(s8NetworkHeaders).some((k) => k.toLowerCase() === 'x-secret-token') &&
      typeof s8NetworkBody === 'string' &&
      s8NetworkBody.includes('[REDACTED]') &&
      !s8NetworkBody.includes('123-45-6789'),
    `entry found=${s8NetworkEntry !== undefined}; url=${s8NetworkEntry?.url ?? 'n/a'}; stage=${s8NetworkEntry?.type ?? 'n/a'}; ` +
      `headers=${JSON.stringify(s8NetworkHeaders ?? null)}; body=${JSON.stringify(s8NetworkBody ?? null)}`,
  );
  // Absence checks need a PRECONDITION, or they pass on an empty/missing bundle for the wrong reason.
  // `s8NetworkEntry` above is that precondition here: it proves this bundle really does carry S8's
  // network entries, so the vetoed one being missing means the veto worked — not that nothing was captured.
  const s8VetoedNetworkEntry = mutateBundle?.bundle?.network?.find((n) => n.url?.includes('veto-me'));
  record(
    's8-veto-network-wire',
    'network veto -> the vetoed request never appears in the UPLOADED bundle at all',
    s8NetworkEntry !== undefined && s8VetoedNetworkEntry === undefined,
    `S8 network entries present in this bundle=${s8NetworkEntry !== undefined} (precondition); vetoed entry found=${s8VetoedNetworkEntry !== undefined}`,
  );
  const s8RedactedLog = mutateBundle?.bundle?.logMessages?.find((m) => m.includes('SECRET_TOKEN'));
  record(
    's8-log-filter-wire',
    'log filter -> the UPLOADED bundle carries the redacted message, not the raw token',
    s8RedactedLog !== undefined && s8RedactedLog.includes('[REDACTED]') && !s8RedactedLog.includes('abc123'),
    s8RedactedLog ?? 'no matching log message in the uploaded bundle',
  );
  const s8RedactedCrumb = mutateBundle?.bundle?.breadcrumbs?.find((c) => c.message === 'crumb with secret data');
  record(
    's8-breadcrumb-filter-wire',
    'breadcrumb filter -> the UPLOADED bundle has data.secret redacted, not the raw value',
    s8RedactedCrumb?.data?.secret === '[REDACTED]',
    JSON.stringify(s8RedactedCrumb?.data ?? null),
  );
  const s8VetoedReportBundle = await waitForBundle(
    (b) => b.bundle?.request?.summary === 'S8: report handler should VETO this — must never arrive',
    { timeout: 2000 },
  );
  // Same precondition discipline as `s8-veto-network-wire`: absence only means "the veto worked" if the
  // sibling, NON-vetoed report from the same control pair did arrive. `mutateBundle` is that witness.
  record(
    's8-report-veto-wire',
    'report handler veto -> the vetoed report never appears as an UPLOADED bundle either',
    mutateBundle !== undefined && s8VetoedReportBundle === undefined,
    `non-vetoed sibling bundle present=${mutateBundle !== undefined} (precondition); vetoed bundle found=${s8VetoedReportBundle !== undefined}`,
  );

  await click(page, 's8-uninstall');

  // S9 performance
  sinceCheckpoint();
  // `s9Status.ok && text.includes('6 child spans')` was NOT a computed result, despite this file's own
  // header claiming `statusOk` is used only where the control really computes one. Both halves come from
  // `manualTransaction()`'s unconditional tail (`scenario-panel.component.ts:405` builds the literal
  // status array, `:412` prints `statuses.length` and `setStatus`'s default `ok = true` at `:74` sets the
  // class) — so the string is printed, and the class is `.ok`, no matter what `startChildSpan`/`finish`
  // actually did: nothing between the `startTransaction` call and `setStatus` can change either half
  // short of throwing. Replaced with the wire evidence the peer sample (solid-spa) already uses: the
  // transaction must actually reach `POST /v2/performance/transactions`, finished `OK`, carrying exactly
  // six child spans — one per SpanStatus. The status line is kept as a secondary conjunct only.
  const s9TxSinceTs = Date.now();
  await click(page, 's9-manual-transaction', { wait: 400 });
  const s9Status = await statusOk(page, 's9-manual-transaction');
  const s9WireTx = await waitForPerfTransactions((t) => t.name === 'scenario.manual_transaction', {
    sinceTs: s9TxSinceTs,
  });
  const s9ExpectedStatuses = ['OK', 'ERROR', 'TIMEOUT', 'CANCELLED', 'DEADLINE_EXCEEDED', 'UNKNOWN'];
  const s9SpanStatuses = (s9WireTx[0]?.spans ?? []).map((s) => s.status);
  record(
    's9-manual-transaction',
    'manual transaction + every SpanStatus child span — WIRE: the UPLOADED transaction finished OK and carries all 6 child spans',
    s9WireTx.length > 0 &&
      s9WireTx[0].status === 'OK' &&
      s9SpanStatuses.length === s9ExpectedStatuses.length &&
      s9ExpectedStatuses.every((s) => s9SpanStatuses.includes(s)) &&
      s9Status.ok &&
      s9Status.text.includes('6 child spans'),
    `uploaded tx found=${s9WireTx.length > 0}; tx status=${s9WireTx[0]?.status}; ` +
      `child span statuses=[${s9SpanStatuses.join(',')}]; status line="${s9Status.text}"`,
  );

  // setRouteName direct call: prove it actually renames the ACTIVE transaction (not just "didn't throw").
  // window.__bugsee is a live getClient() accessor (see main.ts) — start a transaction through it first so
  // the call has something to rename regardless of whether the automatic navigation transaction has
  // already idle-finished by this point in the sweep.
  await page.evaluate(() => {
    const perf = window.__bugsee?.ext('performance');
    window.__verifyRouteProbe = perf?.startTransaction({ name: 'verify.route_naming_probe', operation: 'custom' });
  });
  await click(page, 's9-set-route-name');
  const s9RouteName = await page.evaluate(() => {
    const name = window.__bugsee?.ext('performance').getActiveSpan()?.getName?.();
    window.__verifyRouteProbe?.finish('OK');
    return name;
  });
  record(
    's9-set-route-name',
    'setRouteName("/manual/:demo") renames the ACTIVE transaction',
    s9RouteName === '/manual/:demo',
    `getActiveSpan().getName() -> ${s9RouteName}`,
  );

  // performanceSampleRate: 0 — previously skipped as "would need a 2nd relaunch pair"; the component
  // method does that relaunch pair itself (rate 0, check, restore rate 1) so this is a single control.
  await click(page, 's9-rate-zero', { wait: 1800 });
  const s9RateZeroStatus = await statusOk(page, 's9-rate-zero');
  record(
    's9-rate-zero',
    'performanceSampleRate: 0 -> startTransaction().isSampled() === false',
    s9RateZeroStatus.ok,
    s9RateZeroStatus.text,
  );

  // S10 distributed tracing (outbound leg) — previously wholly N/A even though the local API's
  // echo-headers route + propagateTrace/tracePropagationTargets were both already in place, just never
  // wired to a control.
  //
  // Round-5 fix: the control now fires THREE probes and the `ok` class is the AND of all three. The
  // single same-origin probe it used to fire could not exercise `tracePropagationTargets` at all —
  // `createTraceparentDecorator` returns `true` for a same-origin url BEFORE consulting the allowlist
  // (`packages/capture/src/traceparent.ts:136-142`), so that check passed identically with the option
  // deleted. The two cross-origin probes (`:5336`, the API server's own origin, vs the app's `:5306`)
  // cover both halves the PLAN names: INCLUDE (matches `/api/` -> decorated) and EXCLUDE (no `/api/`
  // in the url -> NOT decorated). Falsifiable in both directions: dropping `tracePropagationTargets`
  // fails the include half, widening it to match everything fails the exclude half.
  await click(page, 's10-echo-headers', { wait: 900 });
  const s10Status = await statusOk(page, 's10-echo-headers');
  record(
    's10-echo-headers',
    'propagateTrace + tracePropagationTargets: same-origin AND cross-origin-allowlisted requests carry a W3C traceparent; a cross-origin NON-matching request does not',
    s10Status.ok,
    s10Status.text,
  );

  // Angular error seam
  sinceCheckpoint();
  await click(page, 's-create-handler', { wait: 0 });
  record('angular-create-handler', 'createAngularErrorHandler(...).handleError(err) — reports + delegates', (await waitForCalls(isIssueCall)).some(isIssueCall));
  sinceCheckpoint();
  await click(page, 's-report-direct', { wait: 0 });
  record('angular-report-direct', 'reportAngularError(error, options) called directly', (await waitForCalls(isIssueCall)).some(isIssueCall));
  sinceCheckpoint();
  await click(page, 's-unwrap', { wait: 0 });
  record('angular-original-error-unwrap', 'BugseeErrorHandler unwraps { ngOriginalError } before reporting', (await waitForCalls(isIssueCall)).some(isIssueCall));

  // Angular: error in a component / service / RxJS pipeline / HttpClient call — each an UNCAUGHT
  // error routed through the registered BugseeErrorHandler. Was `pageErrors.length > 0` (a CUMULATIVE
  // counter never reset since s5-uncaught, so all four of these could never fail regardless of what
  // happened); now reset via newPageErrors() immediately before each control so it reflects only that
  // control's own outcome.
  //
  // As with `s5-uncaught` above, the `newPageErrors() > 0` disjunct is DEAD in this app — routing these
  // errors through `BugseeErrorHandler` is the whole POINT of these four controls, and that handler
  // absorbs the throw, so `pageErrors` never grows here. Each check therefore reduces to its
  // `waitForCalls(isIssueCall)` half: "the SDK issued an issue upload for it". That is the stronger
  // reading, and it is why these are left as they are rather than rewritten like `s6-console`.
  sinceCheckpoint();
  newPageErrors();
  await click(page, 'arm-widget', { wait: 600 });
  record('angular-error-in-component', 'ThrowingWidgetComponent throws in ngOnInit -> ErrorHandler', newPageErrors() > 0 || (await waitForCalls(isIssueCall, { timeout: 3000 })).some(isIssueCall));
  await click(page, 'reset-widget');

  sinceCheckpoint();
  newPageErrors();
  await click(page, 'throw-service', { wait: 0 });
  record('angular-error-in-service', 'ThrowingService.throwSynchronously() -> ErrorHandler', newPageErrors() > 0 || (await waitForCalls(isIssueCall, { timeout: 3000 })).some(isIssueCall));

  sinceCheckpoint();
  newPageErrors();
  await click(page, 'throw-rxjs', { wait: 0 });
  record('angular-error-in-rxjs', 'error inside an RxJS map operator, no error callback', (await waitForCalls(isIssueCall, { timeout: 5000 })).some(isIssueCall) || newPageErrors() > 0);

  sinceCheckpoint();
  newPageErrors();
  await click(page, 'throw-httpclient', { wait: 0 });
  record('angular-error-in-httpclient', 'HttpClient 5xx call with no error callback', (await waitForCalls(isIssueCall, { timeout: 5000 })).some(isIssueCall) || newPageErrors() > 0);

  // Angular router-naming primitives (synthetic snapshot/router — not the live app's real navigation)
  await click(page, 's-route-pattern');
  const patternStatus = await statusTextOk(page, 's-route-pattern');
  record('angular-route-pattern', 'routePatternFromSnapshot({approvals -> :id}) -> "/approvals/:id"', patternStatus.includes('/approvals/:id'), patternStatus);

  // setRouteNameFromRouter(fakeRouter): prove it actually renames the ACTIVE transaction to
  // "/expenses/new" (previously only checked that the click didn't throw) — start a transaction through
  // window.__bugsee first so there is something for the call to rename, then read the name back after.
  await page.evaluate(() => {
    const perf = window.__bugsee?.ext('performance');
    window.__verifyRouteProbe2 = perf?.startTransaction({ name: 'verify.route_from_router_probe', operation: 'custom' });
  });
  await click(page, 's-route-router');
  const routerNameAfter = await page.evaluate(() => {
    const name = window.__bugsee?.ext('performance').getActiveSpan()?.getName?.();
    window.__verifyRouteProbe2?.finish('OK');
    return name;
  });
  record(
    'angular-set-route-from-router',
    'setRouteNameFromRouter(fakeRouter) -> renames the ACTIVE transaction to "/expenses/new"',
    routerNameAfter === '/expenses/new',
    `getActiveSpan().getName() -> ${routerNameAfter}`,
  );

  // Real navigation-driven route naming (setRouteNameFromRouter, wired in main.ts on every NavigationEnd).
  //
  // This used to be `page.goto(...)` followed by `page.url().includes('/expenses')` — a hard reload plus an
  // assertion that Playwright navigated where it was told. It tested Playwright, not the wiring under test,
  // and passed identically with main.ts's NavigationEnd subscription deleted. Replaced with the same
  // technique the `s9-set-route-name` / `angular-set-route-from-router` checks above already use: open a
  // transaction through `window.__bugsee`, perform a REAL in-app router navigation (clicking a link,
  // not a reload — a reload would discard the JS realm and the transaction with it), then read the ACTIVE
  // transaction's name back. main.ts's `NavigationEnd -> setRouteNameFromRouter(router)` must have renamed
  // it to the matched route PATTERN. Polled because the navigation transaction idle-finishes on its own.
  //
  // The TARGET route is what makes this discriminating, and picking a static one made the replacement
  // still-unfalsifiable: navigating to `/expenses` and expecting the name `/expenses` passes even with
  // the ENTIRE route-naming seam neutralised, because the browser tier already names every navigation
  // transaction after `location.pathname` in phase 1 (`packages/browser/src/navigation-source.ts:109-119`
  // / `:144-148` -> `packages/performance/src/navigations.ts:58`), and for a static route the raw
  // pathname IS the pattern. So navigate to the PARAMETERISED route instead (`app.routes.ts:13-16`,
  // `expenses/:id`) by clicking a real expense row: with the seam working the active transaction is named
  // `/expenses/:id`; with it neutralised the phase-1 name survives as the raw `/expenses/<uuid>`, and the
  // two are trivially distinguishable. The concrete URL is reported in the detail as the contrast.
  //
  // Falsified by breaking the REAL path, per the lesson in the S11 block below: replacing
  // `main.ts:26`'s `setRouteNameFromRouter(router)` with a no-op IN THE SOURCE made this check read
  // `/expenses/<uuid>` and FAIL; restoring the line byte-for-byte made it read `/expenses/:id` again.
  await page.click('a[href="/expenses"]');
  await page.waitForSelector('[data-testid^="expense-row-"]', { timeout: 5000 });
  await page.evaluate(() => {
    const perf = window.__bugsee?.ext('performance');
    window.__verifyNavProbe = perf?.startTransaction({ name: 'verify.real_navigation_probe', operation: 'custom' });
  });
  await page.locator('[data-testid^="expense-row-"]').first().click();
  let navRouteName;
  const navDeadline = Date.now() + 4000;
  for (;;) {
    const seen = await page.evaluate(() => window.__bugsee?.ext('performance').getActiveSpan()?.getName?.());
    if (seen !== undefined) navRouteName = seen;
    if (navRouteName === '/expenses/:id' || Date.now() >= navDeadline) break;
    await page.waitForTimeout(50);
  }
  await page.evaluate(() => window.__verifyNavProbe?.finish('OK'));
  const navUrlPath = new URL(page.url()).pathname;
  record(
    'angular-router-navigation',
    'real in-app navigation to a PARAMETERISED route (/expenses/:id) renames the ACTIVE transaction to the matched route PATTERN, not the concrete URL',
    navRouteName === '/expenses/:id' && /^\/expenses\/.+/.test(navUrlPath) && navUrlPath !== '/expenses/:id',
    `getActiveSpan().getName() -> ${navRouteName}; concrete url path=${navUrlPath} (the two must differ — that is what makes this falsifiable)`,
  );

  // S11 session replay
  //
  // These four used to have `newPageErrors() === 0` as their SOLE condition, justified by a claim that a
  // rejection from one of these async handlers surfaces as an unhandled rejection and so reaches
  // Playwright's `pageerror`. That claim was WRONG, and the evidence for it was an artifact of HOW it was
  // gathered: the round-3 review replaced the handler through `page.evaluate`, which installs a natively
  // async function in Playwright's realm — one zone.js never patched — so its rejection escaped Angular
  // and produced a pageerror. Breaking the REAL code path instead (making `client.stop()` throw, which
  // `relaunch()` awaits at `src/app/bugsee.ts:158-160`) produces ZERO pageerrors: the rejection travels
  // the zone-patched promise back into Angular, where `BugseeErrorHandler` (`src/app/app.config.ts:20`)
  // absorbs it and only logs an `ERROR ...` console line. `pageErrors.length === 0` for the WHOLE sweep,
  // every run — so these four could not fail. (That real-path break was run by the round-4 review; its
  // artifacts are the two `PROBE-R4-D3: stop() throws inside the real relaunch()` reports, staging issues
  // `SANGULAR-126`/`127`, whose stacks run through the app's own `relaunch` — see scenarios.md's probe
  // table.)
  //
  // GENERAL LESSON: a falsifiability claim established by injecting a replacement through
  // `page.evaluate` may be testing the injection realm rather than the code under test. Break the real
  // path. This file held exactly two such claims — this one and `s6-console`'s (which patched the global
  // `console`); both were re-grounded in round 4, `s6-console`'s on a live behavioural asymmetry the SDK
  // itself produces rather than on any mutation.
  //
  // Replacement, modelled on `s11-replay-file-wire` below (the group's only genuine proof): each control
  // must produce a client that is (a) a DIFFERENT instance than the one live before the click — the
  // relaunch actually happened, which for the 2nd/3rd/4th control is load-bearing since the PREVIOUS
  // client already had replay on — and (b) actually recording, proven by a report forced right after the
  // relaunch arriving as an uploaded bundle that contains `replay.bin`.
  //
  // ROUND 7 — WHAT (b) IS NOW WORTH, stated plainly so it is not over-read. Session replay became ON BY
  // DEFAULT in the browser tier (`packages/browser/src/launch.ts:433`: `options.replay !== false &&
  // domDocument !== undefined`). `replay.bin` therefore appears in EVERY bundle this app uploads,
  // including ones from clients launched with no `replay` key at all — the app's own baseline. So for
  // these four controls (b) no longer discriminates "the replay OPTION I passed was honoured" from "the
  // option was ignored entirely and the default recorded anyway"; all four options mean "replay on", and
  // "replay on" is what happens regardless. It is retained because it is still a real regression
  // detector — it fails the day recording stops — but the thing it used to prove is now proved by the
  // NEGATIVE control instead: `s11-replay-optout` below is the only check in this group that can tell
  // the option path is read at all, because `replay: false` is the only value whose effect on the
  // uploaded bundle is observable. `s11-replay-default-on` is its positive twin.
  await page.goto(`${BASE}/scenarios`, { waitUntil: 'networkidle' });
  newPageErrors(); // reset the checkpoint

  // Fill the two S11 fields BEFORE any replay relaunch, not after (round 6). This ordering is
  // load-bearing for `s11-replay-masking-wire` below, and getting it wrong is what made the earlier
  // rounds' observation ("both fields come back masked") look like an SDK defect:
  //
  //   * rrweb consults `unmaskInputSelector` when it SERIALIZES an element into the FULL SNAPSHOT — the
  //     value is emitted raw iff `element.matches(unmaskInputSelector)` (fork `record.js`, the
  //     `["input","textarea","select"]` branch of the element serializer).
  //   * The INCREMENTAL input observer does not take `unmaskInputSelector` at all (fork `record.js`, the
  //     input-observer factory destructures only blockClass/blockSelector/ignoreClass/ignoreSelector/
  //     maskInputOptions/maskInputFn/sampling/userTriggeredOnInput), so a value TYPED while the recorder
  //     is already running is masked whatever the markup says.
  //
  // Typing first and relaunching after therefore puts both values in the full snapshot, where the opt-out
  // is actually honoured. See FINDINGS.md F-8 — CONFIRMED in round 7, and confirmed only because the
  // replay default flip made the experiment possible at all: with a recorder live from the primary
  // launch, typing into just the `.bugsee-unmask` field yields exactly one `source:5` event and it comes
  // back masked (17 asterisks for a 17-character value), while the full-snapshot path in this very sweep
  // reads the same field back verbatim. It lives in the rrweb fork, it fails CLOSED, and NOTHING here
  // asserts it: a check pinning the masked outcome would fail the day the fork honours the mark.
  const s11MaskedValue = `S11SECRET${runTag}MASKED`;
  const s11ShownValue = `S11VISIBLE${runTag}SHOWN`;
  await page.fill('[data-testid="s11-masked-field"]', s11MaskedValue);
  await page.fill('[data-testid="s11-shown-field"]', s11ShownValue);

  /** Click an S11 relaunch control, then force a report through the NEW client and return both the
   *  new-instance signal and the uploaded bundle's file list. `marker` must be unique per call. */
  const relaunchAndCaptureFiles = async (testid, marker) => {
    await page.evaluate(() => {
      window.__verifyPrevClient = window.__bugsee;
    });
    await click(page, testid, { wait: 800 });
    const isNewClient = await page.evaluate(
      () => window.__bugsee !== undefined && window.__bugsee !== window.__verifyPrevClient,
    );
    await page.evaluate((m) => {
      void window.__bugsee?.logException(new Error(m));
    }, marker);
    const bundle = await waitForBundle((b) => b.bundle?.request?.summary === marker, { timeout: 15_000 });
    return { isNewClient, files: bundle?.bundle?.files };
  };
  const replayCases = [
    ['s11-replay-defaults', 'relaunch with replay: true (fail-closed defaults)'],
    ['s11-replay-masking', 'relaunch with explicit masking options'],
    ['s11-replay-canvas-fixed', 'relaunch with replay.canvas: { fps: 2 }'],
    ['s11-replay-canvas-all', "relaunch with replay.canvas: { fps: 'all' }"],
  ];
  for (const [testid, label] of replayCases) {
    const { isNewClient, files } = await relaunchAndCaptureFiles(
      testid,
      `S11: wire marker for ${testid}`,
    );
    record(
      testid,
      `${label} — WIRE: the relaunched client is a new instance and is recording (its UPLOADED bundle carries replay.bin — which the DEFAULT also produces, so this does not prove the option was honoured; see s11-replay-optout)`,
      isNewClient && (files?.includes('replay.bin') ?? false),
      `newClientInstance=${isNewClient}; uploaded bundle files=${JSON.stringify(files ?? null)}`,
    );
  }
  // S11 wire-level: confirm replay actually produces a FILE in the uploaded bundle while it is active —
  // PLAN §6.6. File presence only; the CONTENT pair is `s11-replay-masking-wire`, immediately below.
  await page.evaluate(() => {
    void window.__bugsee?.logException(new Error('S11: wire-level marker for replay file presence'));
  });
  const s11Bundle = await waitForBundle(
    (b) => b.bundle?.request?.summary === 'S11: wire-level marker for replay file presence',
  );
  record(
    's11-replay-file-wire',
    // The label used to say `replay: true`, which is not the configuration in force at this point: the
    // last relaunch above is `s11-replay-canvas-all`, so the active client was launched with
    // `replay: { canvas: { fps: 'all' } }`. Named for what is actually running.
    "replay: { canvas: { fps: 'all' } } (the last s11 relaunch) -> the UPLOADED bundle contains a replay.bin file (file presence only; the CONTENT pair is s11-replay-masking-wire)",
    s11Bundle?.bundle?.files.includes('replay.bin') ?? false,
    `files=${JSON.stringify(s11Bundle?.bundle?.files ?? null)}`,
  );

  // ------------------------------------------------------------------ S11 masking CONTENT (round 6)
  //
  // The gap this closes was justified for five rounds as "no rrweb decoder exists in this sample's
  // tooling". That was false. `replay.bin` is `gzipSync(strToU8(JSON.stringify(payloads)))`
  // (`packages/replay/src/encoder.ts:14-16`), `@bugsee/util` exports `gunzipSync`/`strFromU8`, and this
  // sample already depends on and imports from it. `bugsee-transport.ts`'s `getReplayText()` inflates the
  // stream of the bundle whose report summary is given; nothing else in the tee changed.
  //
  // This is PLAN §4 S11's positive control, the one thing the whole wave was missing for replay: it
  // asserts BOTH directions off the SAME uploaded stream —
  //   * the default-masked field's typed value is ABSENT from the entire stream, and
  //   * the `.bugsee-unmask` opted-out field's typed value IS present.
  // Each half alone is worthless: "absent" also holds when the recorder captured nothing at all, and
  // "present" also holds when masking is off entirely. Both are read off the full snapshot's own nodes by
  // `id` (`id`/`class` are in the replay's structural-attribute allowlist, `masking.ts:123-186`, so they
  // survive attribute masking and can be used to select), plus a whole-stream substring scan so a leak
  // through ANY event — full snapshot, mutation or incremental input — fails the check.
  const s11ReplayText = await page.evaluate(
    (s) => window.__bugseeTee?.getReplayText(s) ?? null,
    'S11: wire-level marker for replay file presence',
  );
  let s11Events = null;
  try {
    s11Events = s11ReplayText === null ? null : JSON.parse(s11ReplayText);
  } catch {
    s11Events = null;
  }
  /** Depth-first walk of an rrweb serialized-node tree, yielding every node. */
  const walkRrwebNodes = (node, out = []) => {
    if (node === null || typeof node !== 'object') return out;
    out.push(node);
    for (const child of node.childNodes ?? []) walkRrwebNodes(child, out);
    return out;
  };
  const s11FullSnapshot = Array.isArray(s11Events) ? s11Events.find((e) => e?.type === 2) : undefined;
  const s11Nodes = s11FullSnapshot === undefined ? [] : walkRrwebNodes(s11FullSnapshot.data?.node);
  const nodeById = (id) => s11Nodes.find((n) => n.attributes?.id === id);
  const maskedNode = nodeById('s11-masked');
  const shownNode = nodeById('s11-shown');
  // The stream is the WHOLE decoded text, so this catches a leak in any event type, not just the snapshot.
  const secretLeaked = s11ReplayText !== null && s11ReplayText.includes(s11MaskedValue);
  const shownPresent = s11ReplayText !== null && s11ReplayText.includes(s11ShownValue);
  const s11MaskingOk =
    // `getReplayText()` looks the stream up by report summary in the tee's own ring, which — by design —
    // also holds bundles whose PUT was refused (see bugsee-transport.ts's note on `status`). Conjoining
    // the bundle `waitForBundle` already gated on keeps this check from reading a stream that never
    // reached storage.
    s11Bundle !== undefined &&
    Array.isArray(s11Events) &&
    s11Events.length > 0 &&
    s11FullSnapshot !== undefined && // precondition: "absent" is only meaningful if the DOM was captured
    maskedNode !== undefined &&
    shownNode !== undefined &&
    !secretLeaked &&
    maskedNode.attributes?.value !== s11MaskedValue &&
    shownPresent &&
    shownNode.attributes?.value === s11ShownValue;
  record(
    's11-replay-masking-wire',
    'replay masking CONTENT — the UPLOADED replay.bin decodes to rrweb events in which the default-masked input\'s typed value is ABSENT and the .bugsee-unmask opted-out input\'s typed value is PRESENT',
    s11MaskingOk,
    `decoded=${s11ReplayText !== null}; events=${Array.isArray(s11Events) ? s11Events.length : 'n/a'}; ` +
      `types=${Array.isArray(s11Events) ? JSON.stringify([...new Set(s11Events.map((e) => e?.type))]) : 'n/a'}; ` +
      `fullSnapshot=${s11FullSnapshot !== undefined}; ` +
      `#s11-masked value=${JSON.stringify(maskedNode?.attributes?.value ?? null)} (secret leaked anywhere in stream=${secretLeaked}); ` +
      `#s11-shown value=${JSON.stringify(shownNode?.attributes?.value ?? null)} (expected ${JSON.stringify(s11ShownValue)}, present anywhere in stream=${shownPresent})`,
  );

  // ---------------------------------------------------------------- S11 opt-out / default (round 7)
  //
  // This pair replaces the single `s11-replay-restore` check, which the default flip BROKE — correctly,
  // in the sense that it started failing rather than lying. It clicked `s11-replay-off`, which relaunched
  // with plain FULL_LAUNCH_OPTIONS (no `replay` key), and asserted the uploaded bundle carried NO
  // `replay.bin`. Under opt-in replay that was a sound negative control; under the default it asserts the
  // opposite of the SDK's documented behaviour — "no replay key" now means "record". The control itself
  // was mis-named too: its button said "Restore (replay off)" while turning nothing off.
  //
  // Split into the two checks that are each meaningful now, and deliberately ordered opt-out FIRST so the
  // baseline restore is the last thing that runs and the remainder of the sweep (S4 storm, S1 flush, S12)
  // sees the app's real configuration:
  //
  //   s11-replay-optout     — `replay: false` -> NO replay.bin. The group's only proof that the option is
  //                           read at all: it is the one value whose effect is observable in the bundle.
  //   s11-replay-default-on — FULL_LAUNCH_OPTIONS, no `replay` key -> replay.bin PRESENT. The positive
  //                           twin, and the check that pins the default itself.
  //
  // Neither half is worth anything alone: "absent" is also what a client that uploaded nothing produces
  // (hence the bundle-arrived precondition), and "present" is also what an SDK that ignores `replay:
  // false` entirely produces. Together they are two-directional.
  const optOut = await relaunchAndCaptureFiles('s11-replay-off', 'S11: wire marker for the replay:false opt-out');
  const optOutLaunched = await isLaunched(page);
  record(
    's11-replay-optout',
    'relaunch with replay: false — WIRE: new client instance, and its UPLOADED bundle carries NO replay.bin (the explicit opt-out is honoured)',
    optOutLaunched &&
      optOut.isNewClient &&
      optOut.files !== undefined &&
      !optOut.files.includes('replay.bin'),
    `isLaunched=${optOutLaunched}; newClientInstance=${optOut.isNewClient}; uploaded bundle files=${JSON.stringify(optOut.files ?? null)} (precondition: a bundle arrived at all=${optOut.files !== undefined})`,
  );

  const baseline = await relaunchAndCaptureFiles('s11-replay-baseline', 'S11: wire marker for the restored baseline');
  const baselineLaunched = await isLaunched(page);
  record(
    's11-replay-default-on',
    'relaunch back to the FULL_LAUNCH_OPTIONS baseline, which passes NO replay key — WIRE: new client instance, and its UPLOADED bundle carries replay.bin anyway, because replay is ON BY DEFAULT',
    baselineLaunched &&
      baseline.isNewClient &&
      baseline.files !== undefined &&
      baseline.files.includes('replay.bin') &&
      newPageErrors() === 0,
    `isLaunched=${baselineLaunched}; newClientInstance=${baseline.isNewClient}; uploaded bundle files=${JSON.stringify(baseline.files ?? null)} (precondition: a bundle arrived at all=${baseline.files !== undefined})`,
  );

  // S4 storm — deliberately last: 200 logException calls in ~1s must rate-limit, app stays responsive.
  await page.goto(`${BASE}/scenarios`, { waitUntil: 'networkidle' });
  sinceCheckpoint();
  await click(page, 's4-storm', { wait: 0 });
  // The 60s budget here used to run out with the storm's uploads STILL in flight (measured: the wait
  // exited by TIMEOUT, ~20s of genuine upload work left). That silently invalidated the NEXT check —
  // `s1-flush` claimed to be flushing "after traffic went quiet" when it was in fact flushing mid-storm.
  // Budget raised so quiet is actually reachable, and the exit reason is now recorded and asserted on.
  const stormQuiet = await waitForQuiet({ quietMs: 3000, timeout: 180_000 });
  const stormCalls = stormQuiet.calls.filter(isIssueCall);
  // Was `< 200`, which passes on ZERO issue calls too (i.e. the rate limiter swallowing everything would
  // still "pass"). The real expectation is SOME calls got through, rate-limited to fewer than 200.
  record(
    's4-storm',
    '200 exceptions in ~1s — rate-limited (not zero, not all 200), app stays responsive',
    stormCalls.length > 0 && stormCalls.length < 200,
    `${stormCalls.length} issue calls (of 200 attempted); quiet-wait exited by ${stormQuiet.reason} after ${stormQuiet.waitedMs}ms`,
  );

  // Final flush + S12 persistence probe: logException then hard-reload before it can settle.
  //
  // This check's MEANING depends entirely on the wait above having actually reached quiet: `flush(5000)`
  // returning `false` while uploads are still genuinely in flight is CORRECT behaviour, not a defect
  // (that misreading is what FINDINGS.md F-6 originally recorded — see its retraction). So the precondition
  // is now asserted, not assumed: if the storm never went quiet, this check FAILS as inconclusive rather
  // than reporting flush's answer as if the precondition held.
  await click(page, 's1-flush', { wait: 1500 });
  const flushStatus = await statusOk(page, 's1-flush');
  record(
    's1-flush',
    'flush(5000) drains pending uploads (after the storm has genuinely gone quiet)',
    stormQuiet.reason === 'quiet' && flushStatus.ok,
    `${flushStatus.text} [precondition: storm quiet-wait exited by ${stormQuiet.reason} after ${stormQuiet.waitedMs}ms]`,
  );

  // ------------------------------------------------------------- upload status, run-wide (round 7)
  //
  // The other half of the `uploadStored()` fix. Every "the UPLOADED bundle carries X" check in this file
  // reads a bundle the tee parsed from the REQUEST body, so until round 7 they all held equally well for
  // a bundle that was REFUSED at the presigned PUT — a peer sample found the same hole and measured the
  // blast radius: an S3 403 would leave ~30 wire checks green with nothing in the backend at all.
  // `uploadStored()` now gates every bundle a check reads, but that gate is silent for the checks that
  // assert a bundle is ABSENT (the S8 veto pair), and the in-page tee's ring is wiped by each of this
  // sweep's navigations. So the run-wide claim is made HERE, from Playwright's own response log, which
  // survives navigation: every presigned PUT the SDK made in this entire run was stored.
  //
  // `> 0` is load-bearing: "no upload was refused" is trivially true when nothing was uploaded, and it
  // would also be true if the upload host ever stopped matching this predicate — which must fail loudly
  // rather than quietly turning the check vacuous.
  const uploadPuts = bugseeCalls.filter((c) => c.method === 'PUT' && c.url.includes('amazonaws.com'));
  const refusedPuts = uploadPuts.filter((c) => !(c.status >= 200 && c.status < 300));
  const teeRefused = await refusedUploads();
  record(
    'wire-upload-status',
    'every presigned bundle PUT in this run was STORED (2xx) — without this, every "the UPLOADED bundle carries X" check above would hold just as well for a bundle the backend refused',
    uploadPuts.length > 0 && refusedPuts.length === 0 && teeRefused.length === 0,
    `bundle PUTs observed=${uploadPuts.length}; refused=${refusedPuts.length}` +
      `${refusedPuts.length > 0 ? ` ${JSON.stringify(refusedPuts.slice(0, 5).map((c) => ({ status: c.status, url: c.url.slice(0, 60) })))}` : ''}` +
      `; tee-side non-2xx since the last navigation=${teeRefused.length}` +
      `${teeRefused.length > 0 ? ` ${JSON.stringify(teeRefused.slice(0, 5))}` : ''}`,
  );

  sinceCheckpoint();
  // A real local signal instead of an unconditional true: did the page actually reload. The eventual
  // recovery/upload OUTCOME is not verifiable at this depth after a heavy sweep prelude — see
  // FINDINGS.md F-4 — so this control's pass/fail is deliberately scoped to "the reload happened", not
  // to "the issue arrived" (that half is confirmed, or not, by the MCP poll documented in scenarios.md).
  let reloaded = false;
  page.once('load', () => {
    reloaded = true;
  });
  await page.click('[data-testid="s12-crash-and-reload"]');
  await page.waitForTimeout(3000); // page reloads mid-flight
  record(
    's12-persist-recover',
    'logException then immediate hard-reload — recover on next launch',
    reloaded,
    reloaded
      ? 'page reload observed locally; recovery/upload outcome requires the MCP poll after this script (see FINDINGS.md F-4 — it can lose the race while the prelude\'s IndexedDB write backlog is still draining)'
      : 'no page reload observed locally — the reload itself did not happen',
  );

  await browser.close();

  // ---------------------------------------------------------------------------------------- Report
  const width = Math.max(...results.map((r) => r.id.length)) + 2;
  console.log('\n=== angular-spa scenario sweep ===\n');
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL';
    console.log(`${status}  ${r.id.padEnd(width)} ${r.description}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed (LOCAL/WIRE level only — see scenarios.md for backend/MCP verification)`);
  if (pageErrors.length > 0) {
    console.log(`\nUncaught page errors observed (expected for S5/component-service-rxjs-http throws): ${pageErrors.length}`);
  }
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
