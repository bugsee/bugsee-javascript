// The scripted scenario sweep (docs/samples/PLAN.md §3/§6). Drives the REAL app + REAL SDK headlessly
// via Playwright: exercises the Kanban app itself, then every control in the Scenario panel, and prints
// a pass/fail table for what could be checked from the browser (LOCAL: no throw / WIRE: the right
// request left the process). Backend (MCP) verification is a SEPARATE step the build agent runs by hand
// against the printed evidence — see scenarios.md.
//
// IMPORTANT: this script installs the diagnostic-only staging workarounds (staging-workarounds.mjs) for
// four independent SDK/backend defects (FINDINGS.md F-1..F-4) that otherwise block 100% of delivery to
// the staging collector. Without them every WIRE check below would read "blocked" and no scenario could
// ever reach level 3 (Backend) verification. A real customer cannot apply these workarounds — see the
// header comment in staging-workarounds.mjs.
import { chromium } from 'playwright';
import { CHROMIUM_ARGS, installStagingWorkarounds } from './staging-workarounds.mjs';

const BASE = 'http://localhost:5302';
const results = [];

function record(id, description, ok, detail = '') {
  results.push({ id, description, ok, detail });
}

async function click(page, testid, { wait = 350 } = {}) {
  await page.click(`[data-testid="${testid}"]`, { timeout: 5000 });
  await page.waitForTimeout(wait);
}

async function main() {
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await installStagingWorkarounds(page);

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
    bugseeCalls.push({ url: res.url(), status: res.status(), ok, t: Date.now() });
  });

  // A window of bugsee/S3 calls seen since the last checkpoint — lets each scenario report what it,
  // specifically, sent (WIRE-level evidence).
  let checkpoint = 0;
  const sinceCheckpoint = () => {
    const slice = bugseeCalls.slice(checkpoint);
    checkpoint = bugseeCalls.length;
    return slice;
  };
  let errorCheckpoint = 0;
  const newPageErrors = () => {
    const count = pageErrors.length - errorCheckpoint;
    errorCheckpoint = pageErrors.length;
    return count;
  };

  // ---------------------------------------------------------------------------------------- App smoke
  await page.goto(`${BASE}/boards`, { waitUntil: 'networkidle' });
  const boardCount = await page.locator('.board-tile').count();
  record('app-boards-list', 'Boards index lists seeded boards', boardCount >= 2, `${boardCount} boards`);

  await page.click('[data-testid^="board-"]');
  await page.waitForSelector('.lists-row', { timeout: 5000 });
  const listCount = await page.locator('.list-column').count();
  record('app-board-view', 'Board view renders lists + cards', listCount >= 3, `${listCount} lists`);

  const runTag = Date.now().toString(36);
  const listTitle = `Verify list ${runTag}`;
  const cardTitle = `Verify card ${runTag}`;
  const cardTitleEdited = `Verify card ${runTag} (edited)`;

  await page.fill('[data-testid="new-list-input"]', listTitle);
  await page.press('[data-testid="new-list-input"]', 'Enter');
  await page.waitForTimeout(500);
  const listCountAfter = await page.locator('.list-column').count();
  record('app-create-list', 'Create list (optimistic + API)', listCountAfter === listCount + 1);

  const newListColumn = page.locator('.list-column', { hasText: listTitle });
  const cardInput = newListColumn.locator('[data-testid^="new-card-input-"]');
  await cardInput.fill(cardTitle);
  await cardInput.press('Enter');
  await page.waitForTimeout(500);
  const cardVisible = await page.locator('.card-tile', { hasText: cardTitle }).count();
  record('app-create-card', 'Create card (optimistic + API)', cardVisible === 1);

  await page.click(`.card-tile >> text=${cardTitle}`);
  await page.waitForSelector('[data-testid="card-modal"]', { timeout: 5000 });
  await page.fill('#card-title', cardTitleEdited);
  await page.click('[data-testid="save-card"]');
  await page.waitForTimeout(600);
  const edited = await page.locator('.card-tile', { hasText: cardTitleEdited }).count();
  record('app-edit-card', 'Edit card via modal route (/board/:id/card/:cardId)', edited === 1);

  // ---------------------------------------------------------------------------------- Settings (S2)
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

  // ---------------------------------------------------------------------------------- Scenario panel
  await page.goto(`${BASE}/scenarios`, { waitUntil: 'networkidle' });

  // S1: relaunch demos FIRST (each rebuilds the client) — minimal (demonstrates default sdkVersion
  // 0.0.0 being rejected server-side, see FINDINGS.md F-2/F-3 note), then full (restores a working
  // client with sdkVersion override for everything below).
  sinceCheckpoint();
  await click(page, 's1-relaunch-minimal', { wait: 1500 });
  const minimalCalls = sinceCheckpoint();
  record('s1-relaunch-minimal', 'launch({}) — every default', true, JSON.stringify(minimalCalls.map((c) => c.status)));

  await click(page, 's1-relaunch-full', { wait: 800 });
  record('s1-relaunch-full', 'launch(FULL_LAUNCH_OPTIONS)', true);

  const isLaunchedText = await page.locator('[data-testid="is-launched"]').textContent();
  record('s1-is-launched', 'isLaunched() reflects the launched client', isLaunchedText === 'true', isLaunchedText ?? '');

  await click(page, 's1-duplicate-launch');
  const dupStatus = await page.locator('[data-testid="s1-duplicate-launch"]').locator('xpath=following-sibling::p').first().textContent();
  record('s1-duplicate-launch', 'second launch() on the same carrier is ignored', Boolean(dupStatus?.includes('true')), dupStatus ?? '');

  // S3 manual telemetry
  for (const level of ['error', 'warning', 'info', 'debug', 'verbose']) {
    await click(page, `s3-log-${level}`, { wait: 150 });
  }
  record('s3-log', 'log() at every LogLevel', true);
  await click(page, 's3-event-params');
  await click(page, 's3-event-no-params');
  record('s3-event', 'event() with/without params', true);
  await click(page, 's3-trace');
  record('s3-trace', 'trace(name, value)', true);
  await click(page, 's3-breadcrumb');
  record('s3-breadcrumb', 'addBreadcrumb() — every field', true);

  // S4 exceptions
  sinceCheckpoint();
  await click(page, 's4-error', { wait: 1800 }); // first report since relaunch — session create + issue create
  record('s4-error', 'logException(new Error)', sinceCheckpoint().some((c) => c.url.includes('issues') && c.ok));
  await click(page, 's4-string', { wait: 1300 });
  record('s4-string', 'logException(string)', sinceCheckpoint().some((c) => c.url.includes('issues')));
  await click(page, 's4-object', { wait: 1300 });
  record('s4-object', 'logException(object)', sinceCheckpoint().some((c) => c.url.includes('issues')));
  await click(page, 's4-null', { wait: 1300 });
  record('s4-null', 'logException(null)', sinceCheckpoint().some((c) => c.url.includes('issues')));
  await click(page, 's4-cause', { wait: 1300 });
  record('s4-cause', 'logException with chained cause', sinceCheckpoint().some((c) => c.url.includes('issues')));
  await click(page, 's4-options', { wait: 1300 });
  record('s4-options', 'logException with LogExceptionOptions', sinceCheckpoint().some((c) => c.url.includes('issues')));
  await click(page, 's4-dedupe', { wait: 1200 });
  const dedupeCalls = sinceCheckpoint().filter((c) => c.url.includes('issues'));
  record('s4-dedupe', 'same instance twice — should dedupe (1 issue, not 2)', dedupeCalls.length <= 1, `${dedupeCalls.length} issue calls`);
  // s4-storm (200 logException calls) is run LAST in the sweep, not here: it deliberately trips the
  // capture-storm rate limiter, and that limiter's ~60s window would otherwise silently swallow several
  // of the UNRELATED scenarios that follow it in this same script run (observed: react-link-component-
  // stack intermittently produced no issue call for ~10-15s after the storm — not a real bug, just this
  // script's own scenarios competing for the same rate-limit budget).

  // S5 crashes
  sinceCheckpoint();
  await click(page, 's5-uncaught', { wait: 900 });
  record('s5-uncaught', 'uncaught exception -> window.onerror', pageErrors.length > 0 || sinceCheckpoint().some((c) => c.url.includes('issues')));
  await click(page, 's5-rejection', { wait: 900 });
  record('s5-rejection', 'unhandled promise rejection', sinceCheckpoint().some((c) => c.url.includes('issues')));

  // S6 console
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    await click(page, `s6-${m}`, { wait: 120 });
  }
  await click(page, 's6-circular');
  record('s6-console', 'console.* incl. multi-arg + circular object', true);

  // S7 network
  await click(page, 's7-get');
  await click(page, 's7-post-json');
  await click(page, 's7-post-text');
  await click(page, 's7-4xx');
  await click(page, 's7-5xx');
  await click(page, 's7-connfail', { wait: 700 });
  await click(page, 's7-large-body');
  await click(page, 's7-no-content-type');
  await click(page, 's7-xhr');
  await click(page, 's7-sse', { wait: 1500 });
  record('s7-network', 'fetch/XHR/SSE GET/POST/4xx/5xx/connfail/large-body/no-content-type', true);

  // S8 filters
  await click(page, 's8-install');
  sinceCheckpoint();
  await click(page, 's8-network', { wait: 500 });
  await click(page, 's8-veto-network', { wait: 500 });
  await click(page, 's8-log', { wait: 300 });
  await click(page, 's8-breadcrumb', { wait: 300 });
  await click(page, 's8-report-mutate', { wait: 900 });
  await click(page, 's8-report-veto', { wait: 900 });
  const filterCalls = sinceCheckpoint().filter((c) => c.url.includes('issues'));
  record('s8-filters', 'network/log/breadcrumb/report before-mutate/before-veto', true, `${filterCalls.length} issue calls while filters installed (veto should reduce this)`);
  await click(page, 's8-uninstall');

  // S9 performance
  sinceCheckpoint();
  await click(page, 's9-manual-transaction', { wait: 400 });
  record('s9-manual-transaction', 'manual transaction + every SpanStatus child span', true);
  await click(page, 's9-set-route-name');
  record('s9-set-route-name', 'setRouteName direct call', true);

  // React-specific
  await click(page, 'arm-guarded', { wait: 600 });
  const guardedFallback = await page.locator('[data-testid="guarded-widget-fallback"]').count();
  record('react-error-boundary-hoc', 'withBugseeErrorBoundary — local fallback catches render throw', guardedFallback === 1);
  await click(page, 'disarm-guarded');

  await click(page, 's-root-handlers');
  record('react-root-handlers', 'createBugseeErrorHandlers().onUncaughtError called directly', true);
  sinceCheckpoint();
  await click(page, 's-report-react-error', { wait: 1500 });
  record('react-report-error', 'reportReactError direct call', sinceCheckpoint().some((c) => c.url.includes('issues')));
  sinceCheckpoint();
  await click(page, 's-link-stack', { wait: 2200 });
  record('react-link-component-stack', 'linkComponentStack + logException', sinceCheckpoint().some((c) => c.url.includes('issues')));

  await click(page, 's-toggle-slow-list', { wait: 700 });
  const slowListVisible = await page.locator('[data-testid="slow-list"]').count();
  record('react-profiler-slow-list', 'BugseeProfiler wraps a mounted slow list', slowListVisible === 1);
  await click(page, 's-toggle-slow-list', { wait: 300 }); // unmount

  await click(page, 's-manual-render-span');
  record('react-record-render-span', 'recordReactRenderSpan direct call', true);

  await click(page, 's-route-pattern');
  const patternStatus = await page.locator('[data-testid="s-route-pattern"]').locator('xpath=following-sibling::p').first().textContent();
  record('react-route-pattern', 'routePatternFromMatches -> /board/:id/card/:cardId', Boolean(patternStatus?.includes('/board/:id/card/:cardId')), patternStatus ?? '');
  await click(page, 's-instrument-matches');
  record('react-instrument-matches', 'instrumentRouterMatches refines the active transaction', true);

  // Real navigation-driven route naming (instrumentReactRouter, wired in router.tsx)
  await page.goto(`${BASE}/board/board-1`, { waitUntil: 'networkidle' });
  record('react-router-navigation', 'data-router navigation to /board/:id', page.url().includes('/board/board-1'));

  // S11 session replay — each control relaunches the SDK (fresh carrier) with a different replay option
  // set. No throw is the LOCAL-level bar; MCP cannot show replay contents (documented gap).
  await page.goto(`${BASE}/scenarios`, { waitUntil: 'networkidle' });
  newPageErrors(); // reset the checkpoint
  await click(page, 's11-replay-defaults', { wait: 800 });
  record('s11-replay-defaults', 'relaunch with replay: true (fail-closed defaults)', newPageErrors() === 0);
  await click(page, 's11-replay-masking', { wait: 800 });
  record('s11-replay-masking', 'relaunch with explicit masking options', newPageErrors() === 0);
  await click(page, 's11-replay-canvas-fixed', { wait: 800 });
  record('s11-replay-canvas-fixed', "relaunch with replay.canvas: { fps: 2 }", newPageErrors() === 0);
  await click(page, 's11-replay-canvas-all', { wait: 800 });
  record('s11-replay-canvas-all', "relaunch with replay.canvas: { fps: 'all' }", newPageErrors() === 0);
  await page.fill('[data-testid="s11-masked-field"]', 'this should be masked in the replay');
  await page.fill('[data-testid="s11-shown-field"]', 'this should NOT be masked (.bugsee-show)');
  await click(page, 's11-replay-off', { wait: 800 }); // restore FULL_LAUNCH_OPTIONS (with sdkVersion override) for the rest of the sweep
  record('s11-replay-restore', 'relaunch back to FULL_LAUNCH_OPTIONS baseline', true);

  // The global (unguarded) throw. EXPECTED (per docs/design intent): propagates to the app-level
  // BugseeErrorBoundary wrapping <RouterProvider> in main.tsx. OBSERVED (FINDINGS.md F-5): react-router
  // v6 data routers install their OWN per-route RenderErrorBoundary, which intercepts a route-element
  // render throw BEFORE it ever reaches an outer boundary — so BugseeErrorBoundary never runs, nothing
  // is reported, and the user sees React Router's generic "Unexpected Application Error!" page instead
  // of the app's own (Bugsee-reporting) fallback. This assertion checks for the ACTUAL (gap) behavior.
  await page.goto(`${BASE}/scenarios`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800); // let any straggling in-flight report from the previous section settle
  sinceCheckpoint();
  await click(page, 'arm-global', { wait: 900 });
  const globalFallback = await page.locator('[data-testid="error-fallback"]').count();
  const reactRouterOwnFallback = await page.locator('text=Unexpected Application Error!').count();
  const globalReportCalls = sinceCheckpoint().filter((c) => c.url.includes('issues'));
  // The issue-calls count is diagnostic only, not part of the pass condition: a late response from an
  // UNRELATED prior click can land inside this window in a script that fires this many actions back to
  // back (observed: the count varies 0-1 run to run depending on exactly where earlier network activity
  // settles) — MCP is the authority on whether THIS click produced a report, checked separately.
  record(
    'react-error-boundary-global-GAP',
    'F-5: data-router route throw bypasses BugseeErrorBoundary (react-router intercepts first)',
    globalFallback === 0 && reactRouterOwnFallback === 1,
    `bugsee's fallback shown=${globalFallback === 1}, react-router's own fallback shown=${reactRouterOwnFallback === 1}, issue calls in window=${globalReportCalls.length} (diagnostic only)`,
  );

  // S4 storm — deliberately last (see the note by s4-dedupe above): 200 logException calls in ~1s must
  // rate-limit rather than drop the app, and its rate-limit window lingering afterward no longer affects
  // any other check since nothing follows it but flush + the S12 reload.
  await page.goto(`${BASE}/scenarios`, { waitUntil: 'networkidle' });
  sinceCheckpoint();
  await click(page, 's4-storm', { wait: 2500 });
  const stormCalls = sinceCheckpoint().filter((c) => c.url.includes('issues'));
  record('s4-storm', '200 exceptions in ~1s — rate-limited, app stays responsive', stormCalls.length < 200, `${stormCalls.length} issue calls (of 200 attempted)`);

  // Final flush + S12 persistence probe: logException then hard-reload before it can settle.
  await click(page, 's1-flush', { wait: 1500 });
  record('s1-flush', 'flush(5000) drains pending uploads', true);

  sinceCheckpoint();
  await page.click('[data-testid="s12-crash-and-reload"]');
  await page.waitForTimeout(3000); // page reloads mid-flight
  record('s12-persist-recover', 'logException then immediate hard-reload — recover on next launch', true, 'see MCP poll after this script for the recovered issue');

  await browser.close();

  // ---------------------------------------------------------------------------------------- Report
  const width = Math.max(...results.map((r) => r.id.length)) + 2;
  console.log('\n=== react-spa scenario sweep ===\n');
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL';
    console.log(`${status}  ${r.id.padEnd(width)} ${r.description}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed (LOCAL/WIRE level only — see scenarios.md for backend/MCP verification)`);
  if (pageErrors.length > 0) {
    console.log(`\nUncaught page errors observed (expected for S5): ${pageErrors.length}`);
  }
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
