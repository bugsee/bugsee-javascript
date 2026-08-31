// The scripted scenario sweep (docs/samples/PLAN.md §3/§6). Drives the REAL app + REAL SDK headlessly
// via Playwright: exercises the Bug tracker app itself, then every control in the Scenario panel, and
// prints a pass/fail table for what could be checked from the browser (LOCAL: no throw / WIRE: the
// right request left the process). Backend (MCP) verification is a SEPARATE step the build agent runs
// by hand against the printed evidence — see scenarios.md.
//
// Runs a STOCK Chromium against the real staging collector, no workarounds of any kind (the wire-
// contract + CORS defects that once blocked every browser sample are fixed — see samples/FINDINGS.md
// F-X6/F-X10).
//
// Almost every check below asserts on OBSERVED evidence (a DOM status line, a page error count, an
// actual network call) — never a bare `true`. Where the BACKEND cannot confirm something at all
// (S3's log()/event()/trace()/addBreadcrumb(): the SDK demonstrably puts them in the uploaded bundle —
// logs.json/breadcrumbs/network.json are all present and populated — but no `# Logs` section is ever
// rendered for them, see samples/FINDINGS.md F-X4, whose open next step this sample closed), the
// real-but-modest assertion available here is "the call didn't throw"
// (newPageErrors() === 0), which DOES fail if the call breaks — see samples/FINDINGS.md's F-X21 lesson
// (a `record(..., true)` sat directly on top of a real defect in react-spa and could never have caught
// it). ONE check (`s1-flush-post-storm`) is a deliberate exception and says so in its own description:
// it accepts either boolean outcome because post-storm drain timing is nondeterministic by design.
//
// Several checks go past LOCAL to true WIRE level (PLAN §6.6): `waitForPerfTransactions` /
// `settlePerfTransactions` intercept the actual POST /v2/performance/transactions request bodies (not
// just the app's own status line) for the manual-transaction check, both route-naming checks (S9 direct
// call + the LIVE `solid-route-name-wire` defect confirmation) and the `performanceSampleRate: 0` check;
// `apiRequestCalls` intercepts the real outgoing request to the local API server for S7;
// `uploadedBundles` captures the bundle-upload (S3 PUT) bytes PAIRED WITH THE STATUS S3 RETURNED, so
// every "the uploaded bundle contains X" row reads an ACCEPTED upload (round-5 R5-1) — its zip central
// directory for the S11 replay.bin presence/absence pair, and DECOMPRESSED (`zipEntry`, plus
// `gunzipSync` for `replay.bin`) for the two S8 bundle checks and the two S11 masking checks; and two
// (`s8-report-veto-backend`, `s8-report-mutate-backend`) go all the way to BACKEND depth by calling the
// staging MCP endpoint directly.
//
// Seven lessons this sweep learned the hard way and now encodes — the first four from rounds 1-3, the
// last three from round 4:
// (1) never assert on a string the app prints UNCONDITIONALLY — derive the status from the thing being
//     claimed, or assert on the wire (s1-relaunch-after-stop, s9-manual-transaction);
// (2) never pre-filter the evidence to the subset a passing run would produce and then assert a property
//     of that subset — assert over EVERYTHING the action produced (solid-route-name-wire);
// (3) a number that is COMPUTED and PRINTED is not asserted. s8-filters computed the issue-call count
//     that scenarios.md cited as the report-veto's whole wire evidence, put it in the detail string, and
//     never read it in the boolean — so a broken veto would have uploaded the vetoed report and the
//     sweep would still have printed a full pass. If a doc cites a number as evidence, the check has to
//     assert on it. (Same shape: a substring test loose enough that two different log lines each satisfy
//     it alone — split it.)
// (4) a NEGATIVE assertion needs a positive control for the MECHANISM under test, not just for the
//     plumbing. solid-route-name-wire asserted "no navigation transaction is route-named" with a control
//     proving only that navigation transactions arrived — all still true with the integration deleted.
//     It now also requires the misattribution probe to produce a route-named transaction, so removing
//     the wiring turns the check red instead of leaving it vacuously green.
// Round 4 added three more, each swept across EVERY check rather than only where it was found:
// (5) a check that claims "X never happened" must ask the system that would HOLD X. The S8 report-veto
//     row claimed "no issue created" while only ever counting browser requests — and a contradicting
//     issue (SSOLID-82) sat on staging for three review rounds. `s8-report-veto-backend` now queries
//     staging itself, with the mutate report from the same block as the positive control;
// (6) a `waitFor…` helper without `sinceTs` reads the EARLIEST match in the whole run, not this click's.
//     Every waitForPerfTransactions call now pins it, not just the ones whose name looks ambiguous today
//     (`/issues/:id` is emitted by the live router wiring as well as by the control that asserts on it);
// (7) evidence written by the SAMPLE'S OWN callback into the SAMPLE'S OWN DOM is LOCAL evidence, however
//     specific it reads. Every S8 network row rested on it; PLAN §6.6's prescribed fallback (read the
//     SDK's own upload) is now used by `s8-network-bundle-wire` and `s8-sanitizer-disabled-bundle-wire`.
// Round 5 (re-verification against a CHANGED SDK: session replay is now ON BY DEFAULT) added four more,
// each swept across every check rather than only where it was found:
// (8) a green check whose SUBJECT moved is not a passing check. `s11-replay-bundle-wire` asserted
//     "relaunch with explicit masking -> the bundle has replay.bin"; once replay.bin rides EVERY bundle
//     it stayed green while measuring nothing about the control it named. When a default flips, re-read
//     what each row's evidence now DISCRIMINATES, not whether it still passes.
// (9) "the uploaded bundle contains X" is a claim about what the collector ACCEPTED. Every bundle row
//     teed the REQUEST body, so a wholesale S3 rejection left them all green — proven here by fulfilling
//     every bundle PUT with 500. The tee is now response-side and 2xx-filtered (R5-1).
// (10) a masking check with ONE probe string cannot tell replay's snapshot path from its incremental
//     path, because a relaunch does not reload the page: whatever sits in the field at relaunch is
//     re-recorded by the full snapshot. This block's first version read the snapshot's copy and reported
//     the OPPOSITE of the truth about `.bugsee-unmask`. Distinct `…-snap` / `…-typed` probes (R5-3).
// (11) a check must WAIT for its own evidence, not inherit the slack of an unrelated wait. The S8 bundle
//     read leaned on a `waitForQuiet()` that settles on /v2/issues traffic and can go quiet before the
//     S3 PUT is even attempted — observed failing with `0 ACCEPTED bundle(s) … statuses: []` (R5-2).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'http://localhost:5307';
const results = [];

// ---- Local secrets (.env, gitignored) --------------------------------------------------------------
// Same file the app's own token comes from (vite.config.ts loads it with loadEnv). Read here so the
// BACKEND leg of this sweep (below) can run without a credential ever appearing in the source.
const HERE = dirname(fileURLToPath(import.meta.url));
function loadDotEnv() {
  try {
    const text = readFileSync(join(HERE, '..', '.env'), 'utf8');
    const out = {};
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}
const dotenv = loadDotEnv();
const MCP_URL = process.env.BUGSEE_MCP_URL || dotenv.BUGSEE_MCP_URL || '';
const APP_KEY = process.env.BUGSEE_APP_KEY || dotenv.BUGSEE_APP_KEY || 'SSOLID';

/** One JSON-RPC call against the Bugsee staging MCP endpoint (streamable HTTP: the response is an SSE
 *  frame carrying a single `data:` line). This is what turns the S8 report-veto row from a W-depth
 *  "no request left the process" claim into a real B-depth "the backend does not have it" claim —
 *  round-4 finding R4-1: the sample never queried staging for the vetoed message, which is why a
 *  contradicting issue (SSOLID-82) sat undetected on the backend for three review rounds. */
async function mcp(name, args) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (!line) throw new Error(`MCP ${name}: no data frame (status ${res.status})`);
  const payload = JSON.parse(line.slice(6));
  if (payload.error) throw new Error(`MCP ${name}: ${JSON.stringify(payload.error)}`);
  return payload.result?.content?.[0]?.text ?? '';
}

// ---- Minimal zip reader ----------------------------------------------------------------------------
/** Extract one named entry from an uploaded Bugsee bundle (a zip), DECOMPRESSED. PLAN §6.6's prescribed
 *  fallback for a capture stream with no MCP surface is "intercept the SDK's own upload and assert the
 *  bundle", which needs the entry's actual CONTENT — a filename match alone (`zipNames`, which reads the
 *  central directory) answers only presence/absence. Used by `s8-network-bundle-wire` and
 *  `s8-sanitizer-disabled-bundle-wire` for `network.json`, by `s7-send-beacon-bundle-wire` for the
 *  sendBeacon entries, and by the two S11 masking checks for `replay.bin` — which is then `gunzipSync`ed,
 *  since `replay.bin` is gzipped JSON (`packages/replay/src/encoder.ts`), not a zip member's own DEFLATE. */
function zipEntry(buf, wanted) {
  // End-of-central-directory, scanned backwards (comment field is variable-length but tiny here).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('latin1');
    if (name === wanted) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      return method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
/** Every entry NAME in a bundle — printed in a check's detail so a missing entry is diagnosable. */
function zipNames(buf) {
  const names = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return names;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('latin1'));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return names;
}

function record(id, description, ok, detail = '') {
  results.push({ id, description, ok, detail });
}

async function click(page, testid, { wait = 350 } = {}) {
  await page.click(`[data-testid="${testid}"]`, { timeout: 5000 });
  await page.waitForTimeout(wait);
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
    bugseeCalls.push({ url: res.url(), status: res.status(), ok, t: Date.now() });
  });

  // ---- Wire-level capture (PLAN §6.6): the actual request BODIES, not the app's own read-back ------
  /** Every POST /v2/performance/transactions body, decoded — the wire-level evidence for S9 + the
   *  solid-route-name-wire check (FINDINGS.md finding A). */
  const perfTransactionCalls = [];
  /** Every request to the local `/api/scenario/*` fixture API — proves the REAL request left the
   *  process with the right method/body, not just that the app read back a good response (S7). */
  const apiRequestCalls = [];
  /** Every S3 bundle-upload PUT, paired with the status the collector ACTUALLY returned.
   *
   *  Teed on RESPONSE, not on request — round-5 finding R5-1, cross-checked from a peer sample that
   *  proved it by fulfilling every non-localhost PUT with 500 and watching all of its bundle rows stay
   *  green. Every check phrased "the UPLOADED bundle contains X" is a claim about what the collector
   *  accepted; reading the request body alone only proves what the SDK SENT, so a wholesale S3 outage
   *  would leave those rows passing. `acceptedBundlesSince()` below is the only accessor the checks use,
   *  and it filters to 2xx. */
  const uploadedBundles = [];
  page.on('request', (req) => {
    const url = req.url();
    if (req.method() === 'POST' && url.includes('/v2/performance/transactions')) {
      try {
        const body = JSON.parse(req.postData() ?? '{}');
        perfTransactionCalls.push({ transactions: body.transactions ?? [], t: Date.now() });
      } catch {
        // malformed body — nothing to record
      }
    }
    if (url.includes('/api/scenario/')) {
      // `resourceType` distinguishes a `navigator.sendBeacon` call (Chromium reports it as `ping`) from
      // an ordinary fetch/XHR to the same path — the only wire-side discriminator available, since CDP
      // does not expose a beacon's payload at all (`postData()` is null for string AND Blob beacons).
      apiRequestCalls.push({
        url,
        method: req.method(),
        body: req.postData() ?? null,
        resourceType: req.resourceType(),
        t: Date.now(),
      });
    }
  });
  page.on('response', (res) => {
    const req = res.request();
    if (req.method() !== 'PUT' || !res.url().includes('amazonaws.com')) return;
    const buf = req.postDataBuffer();
    if (!buf) return;
    uploadedBundles.push({
      buf,
      status: res.status(),
      ok: res.status() >= 200 && res.status() < 300,
      t: Date.now(),
    });
  });
  /** The bytes of every bundle the collector ACCEPTED (2xx) since `fromIndex`. */
  const acceptedBundlesSince = (fromIndex) =>
    uploadedBundles.slice(fromIndex).filter((b) => b.ok).map((b) => b.buf);
  /** Every bundle-upload outcome since `fromIndex`, accepted or not — for the detail string, so a run
   *  that fails because S3 rejected the upload says so instead of just reporting "0 bundles". */
  const bundleStatusesSince = (fromIndex) => uploadedBundles.slice(fromIndex).map((b) => b.status);
  /** Wait until at least one ACCEPTED bundle upload has landed since `fromIndex` and the upload traffic
   *  has gone quiet, so a check reads the whole set the action produced rather than the first arrival. */
  const waitForAcceptedBundles = async (fromIndex, { timeout = 20_000, quietMs = 1500, poll = 150 } = {}) => {
    const deadline = Date.now() + timeout;
    let lastSeen = uploadedBundles.length;
    let lastChange = Date.now();
    for (;;) {
      if (uploadedBundles.length !== lastSeen) {
        lastSeen = uploadedBundles.length;
        lastChange = Date.now();
      }
      const settled = Date.now() - lastChange >= quietMs;
      if ((settled && acceptedBundlesSince(fromIndex).length > 0) || Date.now() >= deadline) {
        return acceptedBundlesSince(fromIndex);
      }
      await page.waitForTimeout(poll);
    }
  };
  /** Wait until a matching performance transaction reaches the wire (or the timeout elapses). Returns
   *  whatever matched (possibly empty) — the caller decides what "found nothing" means. `sinceTs`
   *  restricts to calls that arrived at/after that Date.now() — needed for a positive control that must
   *  prove THIS click's delivery, not just "this name arrived at some earlier point in the sweep". */
  const waitForPerfTransactions = async (match, { timeout = 6000, poll = 100, sinceTs = 0 } = {}) => {
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
  /** Wait until performance-transaction traffic SETTLES (no new POST for `quietMs`), then return EVERY
   *  transaction uploaded at/after `sinceTs`. `waitForPerfTransactions` returns on the FIRST matching POST,
   *  which is the wrong shape for a "nothing in this whole navigation is named X" claim: one `<A>` click
   *  emits two `currententrychange` navigations (a 0ms phantom, immediately superseded, and the live one),
   *  and stopping at the first POST can see only the phantom. Settling sees both. */
  const settlePerfTransactions = async ({ sinceTs = 0, quietMs = 2500, timeout = 15_000 } = {}) => {
    const deadline = Date.now() + timeout;
    let lastSeen = perfTransactionCalls.length;
    let lastChange = Date.now();
    for (;;) {
      if (perfTransactionCalls.length !== lastSeen) {
        lastSeen = perfTransactionCalls.length;
        lastChange = Date.now();
      }
      if (Date.now() - lastChange >= quietMs || Date.now() >= deadline) {
        return perfTransactionCalls.filter((c) => c.t >= sinceTs).flatMap((c) => c.transactions);
      }
      await page.waitForTimeout(100);
    }
  };

  let checkpoint = 0;
  const sinceCheckpoint = () => {
    const slice = bugseeCalls.slice(checkpoint);
    checkpoint = bugseeCalls.length;
    return slice;
  };
  /** A bugsee/S3 call that created (or attempted) an issue — the evidence a report left the process. */
  const isIssueCall = (c) => c.url.includes('issues');

  /** Wait until the evidence ARRIVES, instead of for a fixed number of milliseconds — see
   *  samples/FINDINGS.md F-X19 (a fixed window fails in both directions). */
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

  /** Wait until bugsee traffic SETTLES — no new call for `quietMs` — then return everything seen. The
   *  right wait for an upper-bound check ("at most one issue"). */
  const waitForQuiet = async ({ quietMs = 1500, timeout = 25_000, poll = 100 } = {}) => {
    const deadline = Date.now() + timeout;
    let lastSeen = bugseeCalls.length;
    let lastChange = Date.now();
    for (;;) {
      if (bugseeCalls.length !== lastSeen) {
        lastSeen = bugseeCalls.length;
        lastChange = Date.now();
      }
      if (Date.now() - lastChange >= quietMs || Date.now() >= deadline) {
        const slice = bugseeCalls.slice(checkpoint);
        checkpoint = bugseeCalls.length;
        return slice;
      }
      await page.waitForTimeout(poll);
    }
  };

  /** Fire one report (`reportSolidError`) and return the bundles the collector ACCEPTED for it, plus
   *  every upload status seen (so a run that fails because S3 rejected the PUT says so rather than
   *  reporting a bare "0 bundles"). The general way to get wire-level evidence out of a capture stream
   *  with no MCP surface — PLAN §6.6's prescribed fallback. Requires the page to be on /scenarios. */
  const reportAndCollectBundles = async () => {
    const idx = uploadedBundles.length;
    await click(page, 's-report-solid-error', { wait: 0 });
    await waitForCalls(isIssueCall, { timeout: 10_000 });
    const bufs = await waitForAcceptedBundles(idx);
    return { bufs, statuses: bundleStatusesSince(idx), names: bufs.map(zipNames) };
  };
  const hasEntry = (names, wanted) => names.some((list) => list.includes(wanted));

  /** The sample's own `onError` sink, as rendered on /scenarios — empty string when the SDK has raised
   *  no internal diagnostic. Read only into DETAIL strings, never into a boolean: it is the sample's own
   *  DOM (rule 7) and cannot carry a claim. It exists so that a check going silent is DIAGNOSABLE — an
   *  SDK kill-state routes a diagnostic through `onError` and otherwise looks identical to an ordinary
   *  upload stall. */
  const internalErrorsText = async () =>
    ((await page.locator('[data-testid="internal-errors"]').textContent().catch(() => '')) ?? '')
      .replace(/\s+/g, ' ')
      .trim();

  let errorCheckpoint = 0;
  const newPageErrors = () => {
    const count = pageErrors.length - errorCheckpoint;
    errorCheckpoint = pageErrors.length;
    return count;
  };

  const statusText = async (testid) =>
    page.locator(`[data-testid="${testid}"]`).locator('xpath=following-sibling::p').first().textContent();

  /** Poll a locator's textContent until `match` is true, instead of reading it once immediately after
   *  some OTHER signal (e.g. a network call landing) — a click handler's own async continuation can
   *  legitimately finish well after its triggering network call is observed on the wire (the SDK promise
   *  it awaits doesn't settle in lockstep with the HTTP response), so reading too early sees a STALE
   *  value from a previous action instead of "the handler never got there". Returns the last-seen text
   *  either way, so a genuine failure (handler never wrote it) is still visible as an actual value, not a
   *  cropped one. */
  const waitForLocatorText = async (locator, match, { timeout = 8000, poll = 150 } = {}) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const text = await locator.textContent();
      if (match(text)) return text;
      if (Date.now() >= deadline) return text;
      await page.waitForTimeout(poll);
    }
  };

  // ---------------------------------------------------------------------------------------- App smoke
  await page.goto(`${BASE}/issues`, { waitUntil: 'networkidle' });
  const issueCount = await page.locator('.issue-row').count();
  record('app-issues-list', 'Issues index lists seeded issues', issueCount >= 3, `${issueCount} issues`);

  const runTag = Date.now().toString(36);
  const issueTitle = `Verify issue ${runTag}`;
  await page.fill('[data-testid="new-issue-title"]', issueTitle);
  await page.click('[data-testid="create-issue"]');
  await page.waitForTimeout(500);
  const created = await page.locator('.issue-row', { hasText: issueTitle }).count();
  record('app-create-issue', 'Create issue (createResource + API)', created === 1);

  await page.click(`.issue-row a:has-text("${issueTitle}")`);
  await page.waitForSelector('[data-testid="issue-title"]', { timeout: 5000 });
  const detailTitle = await page.locator('[data-testid="issue-title"]').textContent();
  record('app-issue-detail', 'Issue detail route (/issues/:id)', detailTitle === issueTitle, detailTitle ?? '');

  await page.click('.tab-nav >> text=Comments');
  await page.waitForSelector('[data-testid="issue-comments-tab"]', { timeout: 5000 });
  const commentAuthor = `verify-${runTag}`;
  await page.fill('[data-testid="comment-author"]', commentAuthor);
  await page.fill('[data-testid="comment-body"]', 'a comment from the verify sweep');
  await page.click('[data-testid="submit-comment"]');
  await page.waitForTimeout(500);
  const commentVisible = await page.locator('[data-testid="comment-list"]', { hasText: commentAuthor }).count();
  record('app-add-comment', 'Add comment via nested /issues/:id/comments route', commentVisible === 1);

  // Hard navigation (full page load, not client-side) straight to the nested route — proves the
  // client-side router's path is also servable directly (Vite's dev server SPA fallback).
  const issueUrl = page.url();
  await page.goto(issueUrl, { waitUntil: 'networkidle' });
  const commentsTabAfterHardNav = await page.locator('[data-testid="issue-comments-tab"]').count();
  record('app-nested-route-hard-nav', 'Hard navigation directly to a nested route resolves client-side', commentsTabAfterHardNav === 1);

  await page.goto(`${BASE}/issues/issue-1`, { waitUntil: 'networkidle' });
  const overviewVisible = await page.locator('[data-testid="issue-overview-tab"]').count();
  record('app-overview-tab', 'Overview tab is the index nested route', overviewVisible === 1);
  const statusBefore = await page.locator('[data-testid="toggle-status"]').textContent();
  await click(page, 'toggle-status');
  const statusAfter = await page.locator('[data-testid="toggle-status"]').textContent();
  record(
    'app-toggle-status',
    'Toggle issue status (real API PATCH) — button label flips',
    Boolean(statusBefore) && statusAfter !== statusBefore,
    `before="${statusBefore}" after="${statusAfter}"`,
  );

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

  // getAttribute/clearAttribute/clearAllAttributes — previously implemented (SettingsPage.tsx) but
  // never clicked here, while scenarios.md claimed all 5 methods were covered on one row (overclaim).
  await page.fill('[data-testid="attr-key"]', 'seats');
  await click(page, 'clear-attribute');
  const attrsDumpAfterClear = await page.locator('[data-testid="attrs-dump"]').textContent();
  record(
    's2-clear-attribute',
    'clearAttribute("seats") removes just that key (getAttribute confirms via the status line)',
    Boolean(attrsDumpAfterClear?.includes('gamma')) && !attrsDumpAfterClear?.includes('"seats"'),
    attrsDumpAfterClear ?? '',
  );
  await click(page, 'clear-all-attributes');
  const attrsDumpAfterClearAll = (await page.locator('[data-testid="attrs-dump"]').textContent())?.trim();
  record(
    's2-clear-all-attributes',
    'clearAllAttributes() empties the attribute set',
    attrsDumpAfterClearAll === '{}',
    attrsDumpAfterClearAll ?? '',
  );

  // PLAN §4 S2: "attributes set before AND after the triggering event" — previously undisclosed as
  // unimplemented. Positive control: a real issue call must actually leave the process between the two
  // setAttribute calls, or this proves nothing about ordering.
  sinceCheckpoint();
  await click(page, 'attrs-before-after-event', { wait: 0 });
  const beforeAfterCalls = (await waitForCalls(isIssueCall, { timeout: 10_000 })).filter(isIssueCall);
  // The status line's own setStatus() runs AFTER the awaited logException() call settles inside the
  // click handler, which can legitimately lag the wire-level issue call observed above by a couple of
  // seconds (the SDK's internal submit promise doesn't settle in lockstep with the HTTP response) — so
  // poll for it rather than reading once immediately (that raced and read the STALE "clearAllAttributes()"
  // text from the previous action on a real run; see FINDINGS.md test-quality note).
  const beforeAfterStatus = await waitForLocatorText(
    page.locator('.status-line').first(),
    (text) => Boolean(text?.includes('set-after-event')),
    { timeout: 8000 },
  );
  record(
    's2-attrs-before-after-event',
    'setAttribute called BEFORE and AFTER the triggering logException',
    beforeAfterCalls.length > 0 && Boolean(beforeAfterStatus?.includes('set-after-event')),
    `${beforeAfterCalls.length} issue call(s); status="${beforeAfterStatus ?? ''}"`,
  );

  // ---------------------------------------------------------------------------------- Scenario panel
  await page.goto(`${BASE}/scenarios`, { waitUntil: 'networkidle' });

  // S1: relaunch demos FIRST (each rebuilds the client) — minimal, then full (restores a working client
  // for everything below).
  //
  // "Minimal" is minimal ONLY relative to what `relaunch()` must inject to stay inside the sample's own
  // constraints: `src/bugsee.ts`'s MINIMAL_LAUNCH_OPTIONS really is `{}`, but `relaunch()` (bugsee.ts,
  // the `doLaunch` call) always merges in `endpoint`, `appId`, `appVersion`, `appBuild`, `onError` and
  // `carrier` underneath it. `endpoint` in particular is NOT optional here: without it a bare launch
  // would post to PRODUCTION, which docs/samples/PLAN.md §3 forbids for a sample. So this control
  // exercises "every option this sample can leave at its default", not literally `launch(token, {})`.
  // In particular `sdkVersion` IS left at its default ("0.0.0", packages/browser/src/launch.ts) — but
  // this check makes NO claim about what staging does with that: no bugsee call was observed in this
  // window in any run (the detail below prints the statuses actually seen, which has been `[]`), so
  // there is nothing here to read as a server-side rejection either way. The assertion is exactly what
  // is observable: relaunching on defaults does not throw.
  sinceCheckpoint();
  newPageErrors(); // reset the page-error checkpoint
  await click(page, 's1-relaunch-minimal', { wait: 0 });
  const minimalCalls = await waitForQuiet();
  record(
    's1-relaunch-minimal',
    'relaunch with MINIMAL_LAUNCH_OPTIONS ({}) — every option left at its default EXCEPT the five relaunch() always injects (endpoint/appId/appVersion/appBuild/onError), no throw',
    newPageErrors() === 0,
    `bugsee call statuses in this window: ${JSON.stringify(minimalCalls.map((c) => c.status))}`,
  );

  newPageErrors();
  await click(page, 's1-relaunch-full', { wait: 800 });
  record('s1-relaunch-full', 'launch(FULL_LAUNCH_OPTIONS), no throw', newPageErrors() === 0);

  const isLaunchedText = await page.locator('[data-testid="is-launched"]').textContent();
  record('s1-is-launched', 'isLaunched() reflects the launched client', isLaunchedText === 'true', isLaunchedText ?? '');

  await click(page, 's1-duplicate-launch');
  const dupStatus = await statusText('s1-duplicate-launch');
  record('s1-duplicate-launch', 'second launch() on the same carrier is ignored', Boolean(dupStatus?.includes('true')), dupStatus ?? '');

  // S1: stop(timeout) — previously only incidental inside relaunch() (src/bugsee.ts:128), with no
  // dedicated control or assertion (PLAN §4 S1 row was missing). A standalone click, then restore.
  await click(page, 's1-stop', { wait: 400 });
  const stopStatus = await statusText('s1-stop');
  record(
    's1-stop',
    'stop(timeout) flips isLaunched() false and resolves true (a fresh read, not the frozen `is-launched` span)',
    Boolean(stopStatus?.includes('true; isLaunched() before=true after=false')),
    stopStatus ?? '',
  );
  // Asserts the DERIVED before/after isLaunched() readings, not a fixed banner string. The earlier form
  // matched `relaunched after stop()`, which ScenarioPage printed unconditionally — that check could only
  // go red if relaunch() THREW, and would have passed happily on a relaunch that restored nothing.
  await click(page, 's1-relaunch-after-stop', { wait: 600 });
  const restartStatus = await statusText('s1-relaunch-after-stop');
  record(
    's1-relaunch-after-stop',
    'relaunch() RESTORES the client after stop() — isLaunched() reads false immediately before and true immediately after (fresh reads, not a fixed status string)',
    Boolean(restartStatus?.includes('isLaunched() before=false after=true')),
    restartStatus ?? '',
  );

  // S3 manual telemetry. These stop at LOCAL depth because the BACKEND does not surface captured logs
  // at all — NOT because "MCP has no per-call surface without a triggering report", which was this
  // sample's earlier (wrong) explanation. Measured both ways: the uploaded bundle DOES carry logs.json /
  // breadcrumbs / network.json, populated, while get_issue(..., include_logs: {entries: 'all'}) on an
  // issue from a session with real console activity renders no `# Logs` section at all. That is the
  // cross-sample finding samples/FINDINGS.md F-X4, whose stated open next step this pass closed — see
  // scenarios.md's S3 table. So the real-but-modest assertion available here is "the call didn't throw",
  // which DOES fail if it does (this is what caught this sample's own stale-client-closure bug — see
  // FINDINGS.md F-3).
  newPageErrors();
  for (const level of ['error', 'warning', 'info', 'debug', 'verbose']) {
    await click(page, `s3-log-${level}`, { wait: 150 });
  }
  record('s3-log', 'log() at every LogLevel, no throw', newPageErrors() === 0);
  await click(page, 's3-event-params');
  await click(page, 's3-event-no-params');
  record('s3-event', 'event() with/without params, no throw', newPageErrors() === 0);
  await click(page, 's3-trace');
  record('s3-trace', 'trace(name, value), no throw', newPageErrors() === 0);
  await click(page, 's3-breadcrumb');
  record('s3-breadcrumb', 'addBreadcrumb() — every field, no throw', newPageErrors() === 0);

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
  await click(page, 's4-dedupe', { wait: 0 });
  const dedupeCalls = (await waitForQuiet()).filter(isIssueCall);
  record('s4-dedupe', 'same instance twice — should dedupe (exactly 1 issue, not 0 and not 2)', dedupeCalls.length === 1, `${dedupeCalls.length} issue calls`);

  // flush() under NORMAL load (a handful of reports so far, well under the capture rate limiter's
  // budget) — this is the real "does flush work" check. The storm-adjacent flush later in this script
  // is deliberately NOT gated on draining true, because a 200-exception storm is designed to exceed the
  // rate limiter's budget (samples/FINDINGS.md F-X19: ~100 reports per 60s) — a flush(5000) genuinely
  // cannot drain that backlog in 5s, and that is correct behaviour, not a defect.
  await click(page, 's1-flush', { wait: 1500 });
  const s1flushCleanStatus = await statusText('s1-flush');
  record('s1-flush-clean', 'flush(5000) drains pending uploads under normal load', Boolean(s1flushCleanStatus?.includes('flush() -> true')), s1flushCleanStatus ?? '');
  // s4-storm (200 logException calls) is run LAST — see the note by the S4-storm block below.

  // S5 crashes
  sinceCheckpoint();
  await click(page, 's5-uncaught', { wait: 0 });
  const uncaughtCalls = await waitForCalls(isIssueCall);
  record('s5-uncaught', 'uncaught exception -> window.onerror', pageErrors.length > 0 && uncaughtCalls.some(isIssueCall), `pageErrors=${pageErrors.length}, issueCall=${uncaughtCalls.some(isIssueCall)}`);
  await click(page, 's5-rejection', { wait: 0 });
  record('s5-rejection', 'unhandled promise rejection', (await waitForCalls(isIssueCall)).some(isIssueCall));

  // S6 console
  newPageErrors();
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    await click(page, `s6-${m}`, { wait: 120 });
  }
  await click(page, 's6-circular');
  record('s6-console', 'console.* incl. multi-arg + circular object, no throw (esp. the circular reference)', newPageErrors() === 0);

  // S7 network — reads back the app's OWN status line after each call, so this also proves the
  // "interceptors don't alter app behaviour" binding principle (the app read the real response).
  newPageErrors();
  await click(page, 's7-get');
  const s7get = await page.locator('[data-testid="s7-get"]').locator('xpath=../following-sibling::p[1]').first().textContent().catch(() => '');
  await click(page, 's7-post-json');
  const s7postJson = await page.locator('[data-testid="s7-post-json"]').locator('xpath=../following-sibling::p[1]').first().textContent().catch(() => '');
  await click(page, 's7-4xx');
  const s7get4xx = await page.locator('[data-testid="s7-4xx"]').locator('xpath=../following-sibling::p[1]').first().textContent().catch(() => '');
  await click(page, 's7-5xx');
  const s7get5xx = await page.locator('[data-testid="s7-5xx"]').locator('xpath=../following-sibling::p[1]').first().textContent().catch(() => '');
  await click(page, 's7-connfail', { wait: 700 });
  await click(page, 's7-large-body');
  const s7large = await page.locator('[data-testid="s7-large-body"]').locator('xpath=../following-sibling::p[1]').first().textContent().catch(() => '');
  await click(page, 's7-no-content-type');
  await click(page, 's7-xhr');
  await click(page, 's7-send-beacon');
  const s7beacon = await page.locator('[data-testid="s7-send-beacon"]').locator('xpath=../following-sibling::p[1]').first().textContent().catch(() => '');
  await click(page, 's7-sse', { wait: 1500 });
  const s7sse = await page.locator('[data-testid="s7-sse"]').locator('xpath=../following-sibling::p[1]').first().textContent().catch(() => '');
  const s7ok =
    Boolean(s7get?.includes('"ok":true')) &&
    Boolean(s7postJson?.includes('"received":{"hello":"world","n":42}')) &&
    Boolean(s7get4xx?.includes('404')) &&
    Boolean(s7get5xx?.includes('500')) &&
    Boolean(s7large?.includes('65536 bytes')) &&
    Boolean(s7sse?.includes('SSE event #5')) &&
    newPageErrors() === 0;
  record(
    's7-network',
    'fetch/XHR/SSE GET/POST/4xx/5xx/connfail/large-body/no-content-type — app read the REAL response body',
    s7ok,
    `get=${JSON.stringify(s7get)} postJson=${JSON.stringify(s7postJson)} 4xx=${JSON.stringify(s7get4xx)} 5xx=${JSON.stringify(s7get5xx)} large=${JSON.stringify(s7large)} sse=${JSON.stringify(s7sse)}`,
  );

  // WIRE level (PLAN §6.6): the app's status line proves it READ a good response, but not that the
  // REQUEST that actually left the process carried the right shape. Intercepts the real outgoing POST.
  const echoRequest = apiRequestCalls.find((c) => c.method === 'POST' && c.url.includes('/scenario/echo') && !c.url.includes('echo-'));
  record(
    's7-network-wire',
    'the POST /scenario/echo request that actually left the process carried the exact JSON body the app sent',
    echoRequest?.body === JSON.stringify({ hello: 'world', n: 42 }),
    JSON.stringify(echoRequest ?? null),
  );

  // `navigator.sendBeacon` — a transport `@bugsee/capture` has a dedicated interceptor for
  // (`send-beacon-interceptor.ts`, wired into `installNetworkCapture`) and that this sample called
  // NOWHERE, so it had zero coverage while S7 claimed to sweep the network umbrella.
  //
  // A beacon has no response to read back, so the LOCAL half asserts the UA's own booleans (derived
  // from sendBeacon's return value, not an unconditionally-printed string). The wire half asserts the
  // real outgoing requests — matched on Chromium's `ping` RESOURCE TYPE, not on the body: a beacon's
  // payload is not exposed to CDP at all (`postData()` is null for both the string and the Blob form,
  // measured, not assumed), which is precisely why the bundle check below is the one that can say
  // anything about the body. `ping` is unique to beacons here, so no other S7 request can satisfy it,
  // and BOTH beacons must be seen — the string one and the Blob one.
  const beaconRequests = apiRequestCalls.filter(
    (c) => c.method === 'POST' && c.url.includes('/scenario/echo') && c.resourceType === 'ping',
  );
  record(
    's7-send-beacon',
    'navigator.sendBeacon (string AND Blob payloads) — the UA accepted both for queueing AND both real POSTs left the process as beacons (Chromium `ping` requests), i.e. the interceptor wrapped sendBeacon without swallowing the call: "interceptors do not change app behaviour"',
    Boolean(s7beacon?.includes('string=true')) &&
      Boolean(s7beacon?.includes('blob=true')) &&
      beaconRequests.length === 2,
    `status="${s7beacon ?? ''}"; ${beaconRequests.length} beacon request(s) on the wire (want 2): ${JSON.stringify(beaconRequests.map((c) => c.url))}`,
  );

  // WIRE (PLAN §6.6 fallback): the requests leaving the process only prove sendBeacon still works — they
  // say nothing about whether the SDK CAPTURED them, and since CDP hides the payload this is the ONLY
  // place the body is observable at all. Read network.json out of an accepted bundle and assert:
  //   - the beacons are captured, tagged `mechanism: "sendBeacon"` (not misfiled as fetch/xhr);
  //   - the STRING payload's marker IS in the captured body (synchronously readable);
  //   - the Blob payload's marker is NOT, and the entry says why — `no_body_reason: "cant_read_data"`.
  //     Deliberate (`send-beacon-interceptor.ts`:28-29): a Blob is readable only asynchronously, and
  //     awaiting it would change app behaviour. Pinned here so the sample documents the limitation
  //     instead of quietly implying beacons carry bodies.
  // Positive control: the same network.json must carry this block's ordinary fetch traffic, so an
  // absence term can never mean "network capture was off".
  const beaconRun = await reportAndCollectBundles();
  const beaconNetJson = beaconRun.bufs.map((b) => zipEntry(b, 'network.json')).filter(Boolean).map((b) => b.toString('utf8')).join('\n');
  const beaconBundleCarriesFetch = beaconNetJson.includes('/api/scenario/') && beaconNetJson.includes('"mechanism":"fetch"');
  const beaconTagged = beaconNetJson.includes('"mechanism":"sendBeacon"');
  const beaconStringBodyCaptured = beaconNetJson.includes('S7_BEACON_MARKER');
  const beaconBlobBodyAbsent = !beaconNetJson.includes('beaconBlob');
  const beaconBlobReasonGiven = beaconNetJson.includes('"no_body_reason":"cant_read_data"');
  record(
    's7-send-beacon-bundle-wire',
    'WIRE: the sendBeacon traffic is actually CAPTURED — network.json in the bundle the collector accepted carries entries tagged `mechanism:"sendBeacon"`, with the STRING payload`s marker in the captured body, while the Blob payload`s body is absent and the entry states `no_body_reason:"cant_read_data"` (a Blob is only asynchronously readable and the interceptor refuses to block on it). Ordinary fetch traffic in the same file is the positive control',
    beaconRun.bufs.length > 0 &&
      beaconBundleCarriesFetch &&
      beaconTagged &&
      beaconStringBodyCaptured &&
      beaconBlobBodyAbsent &&
      beaconBlobReasonGiven,
    `${beaconRun.bufs.length} accepted bundle(s) (statuses ${JSON.stringify(beaconRun.statuses)}); mechanismTagged=${beaconTagged} stringBodyCaptured=${beaconStringBodyCaptured} blobBodyAbsent=${beaconBlobBodyAbsent} blobReasonGiven=${beaconBlobReasonGiven} bundleCarriesFetchTraffic=${beaconBundleCarriesFetch}`,
  );

  // S8 filters
  // Round-4 finding R4-1, first leg: the two report-handler controls must be UNCLICKABLE until the
  // filters (and with them the report handler that does the vetoing) are installed. Before the guard
  // existed, clicking "should be VETOED" with no handler installed uploaded an exception whose own
  // message reads "must never arrive" — which is how SSOLID-82 reached staging while this sweep printed
  // a full pass. Asserted in BOTH directions so the guard cannot be "always disabled" either.
  const vetoDisabledBefore = await page.locator('[data-testid="s8-report-veto"]').isDisabled();
  const mutateDisabledBefore = await page.locator('[data-testid="s8-report-mutate"]').isDisabled();
  await click(page, 's8-install');
  const vetoDisabledAfter = await page.locator('[data-testid="s8-report-veto"]').isDisabled();
  const mutateDisabledAfter = await page.locator('[data-testid="s8-report-mutate"]').isDisabled();
  record(
    's8-report-controls-guarded',
    'R4-1: the report-handler controls (mutate + veto) are disabled while no filters are installed and enabled once they are — so the VETO control cannot be fired with no report handler in place, which uploads the very report it exists to prove never arrives',
    vetoDisabledBefore && mutateDisabledBefore && !vetoDisabledAfter && !mutateDisabledAfter,
    `veto disabled before/after install: ${vetoDisabledBefore}/${vetoDisabledAfter}; mutate: ${mutateDisabledBefore}/${mutateDisabledAfter}`,
  );
  sinceCheckpoint();
  // Bundle-upload watermark for `s8-network-bundle-wire` below, and the backend window start for
  // `s8-report-veto-backend` at the end of the sweep.
  const s8BundleIdx = uploadedBundles.length;
  const s8WindowStart = Date.now();
  await click(page, 's8-network', { wait: 500 });
  await click(page, 's8-veto-network', { wait: 500 });
  await click(page, 's8-veto-request-body', { wait: 800 });
  await click(page, 's8-sensitive-url', { wait: 500 });
  await click(page, 's8-log', { wait: 300 });
  await click(page, 's8-breadcrumb', { wait: 300 });
  await click(page, 's8-report-mutate', { wait: 900 });
  await click(page, 's8-report-veto', { wait: 0 });
  const filterCalls = (await waitForQuiet()).filter(isIssueCall);
  const filterLogText = (await page.locator('[data-testid="filter-log"]').textContent().catch(() => '')) ?? '';
  // The two VETO terms are asserted SEPARATELY, and the report veto is additionally asserted ON THE
  // WIRE. A single `includes('VETOED')` term was satisfied by EITHER of the sample's own two veto log
  // lines (`network: VETOED …` at ScenarioPage.tsx's network filter, `report: VETOED …` at its report
  // handler), so one could vanish entirely and this stayed green — and both lines are written by the
  // sample's own callback BEFORE it returns null, so they only prove the callback RAN, never that the
  // SDK honoured the return value. `filterCalls.length === 1` is the term that actually enforces the
  // report veto: this 8-action block triggers exactly TWO logException calls (`s8-report-mutate`, which
  // must arrive, and `s8-report-veto`, which must not), so exactly one `/v2/issues` call may leave the
  // process. If the veto stopped being honoured this goes to 2 and the check goes red. That count is
  // the same number scenarios.md's S8 "report handler — veto" row cites as its W-depth evidence; before
  // this pass it was computed and printed but never asserted on.
  const filtersOk =
    filterLogText.includes('droppedSecretHeader=true') &&
    filterLogText.includes('redactedSsn=true') &&
    filterLogText.includes('network: VETOED') &&
    filterLogText.includes('report: VETOED') &&
    filterLogText.includes('log: redacted') &&
    filterLogText.includes('breadcrumb: redacted') &&
    filterCalls.length === 1;
  record(
    's8-filters',
    'network/log/breadcrumb/report filters actually redacted/vetoed — checked in the in-app filter log (network AND report vetoes asserted separately, not as one ambiguous "VETOED" substring) AND on the wire: exactly 1 /v2/issues call for the whole 8-action block, i.e. the mutate report arrived and the VETOED one never left the process',
    filtersOk,
    `${filterCalls.length} issue calls while filters installed (expected exactly 1); filterLog="${filterLogText.slice(0, 300)}"`,
  );

  // F-1 (re-graded major, FINDINGS.md): the veto is per-NetworkStage-entry, not per-request. A rule
  // vetoing on a REQUEST-BODY marker (only present on the `before` stage) must ALSO veto the
  // `complete` stage-entry for the SAME logical request — it does not. Positive control: the `before`
  // entry WAS actually vetoed (proves the rule itself works), while at least one other stage-entry for
  // the same URL leaked through un-vetoed.
  record(
    's8-veto-per-entry-hole',
    'F-1: a request-body veto rule does NOT veto every stage-entry of the SAME request — the response-carrying complete stage-entry leaks through',
    filterLogText.includes('VETOED(request-body-rule)') && filterLogText.includes('leaked-despite-veto-intent(request-body-rule)'),
    filterLogText.slice(0, 600),
  );

  // Finding C (FINDINGS.md — re-graded to a DOCS gap, not a defect: the deliberate Android XOR rule,
  // already triaged as such in docs/review/capture.md:216): installing ANY network filter disables the
  // default PII sanitizer entirely — a sensitive `token=` query param (which the default sanitizer
  // would normally redact) reaches the filter callback completely unredacted. What is open is the
  // public-docs line, not the behaviour.
  record(
    's8-sanitizer-disabled',
    "Finding C: installing a network filter silently disables the built-in PII sanitizer — a sensitive `token=` query param reaches the filter's view of the URL unredacted",
    filterLogText.includes('sanitizer-disabled-by-filter') && filterLogText.includes('SUPER_SECRET_TOKEN_VALUE'),
    filterLogText.slice(0, 400),
  );

  // WIRE level for the S8 network rows (round-4 finding R4-5). Every S8 network row above asserts on
  // `filterLogText` — the sample's OWN in-app DOM list, written by the sample's OWN filter callback. That
  // is LOCAL evidence: it proves the callback ran and took a branch, never that the SDK honoured the
  // return value or that the redaction survived into what actually left the process. Network capture has
  // no MCP surface (samples/FINDINGS.md F-X4), so PLAN §6.6's prescribed fallback is "intercept the SDK's
  // own upload and assert the bundle" — no S8 row used it before this pass, even though the machinery
  // (uploadedBundles) was already here for S11. This check reads `network.json` OUT of the bundle
  // the s8-report-mutate report uploaded and asserts, on the real uploaded bytes:
  //   POSITIVE CONTROL — network.json exists, is non-empty, and carries the S8 traffic at all (without
  //   this the three absence terms below would pass on an empty file);
  //   the vetoed URL (`veto-me`) is ABSENT — the SDK really honoured the filter's `null`;
  //   the redacted body field and the dropped secret header are ABSENT, and the filter's replacement
  //   marker IS present — PLAN §6.4's "anything redacted in S8 is absent", checked on the wire.
  // ACCEPTED (2xx) bundles only — R5-1: "the uploaded bundle carries X" is a claim about what the
  // collector took, not about what the SDK put on the wire.
  //
  // WAIT for the upload rather than reading whatever happens to have landed (round-5 finding R5-2). This
  // read used to rely on the incidental slack of the `waitForQuiet()` above, which settles on the
  // /v2/issues traffic and can go quiet BEFORE the S3 PUT is even attempted; a run in this pass caught
  // it doing exactly that — `0 ACCEPTED bundle(s) … (upload statuses: [])`, i.e. both S8 bundle rows
  // failed with nothing to read rather than with a wrong answer. A `waitFor…` is the same fix
  // samples/FINDINGS.md F-X19 prescribes for fixed windows generally.
  await waitForAcceptedBundles(s8BundleIdx);
  const s8Bundles = acceptedBundlesSince(s8BundleIdx);
  const s8NetworkJson = s8Bundles.map((b) => zipEntry(b, 'network.json')).filter(Boolean).map((b) => b.toString('utf8'));
  const s8NetAll = s8NetworkJson.join('\n');
  const s8CarriesTraffic = s8NetworkJson.length > 0 && s8NetAll.includes('/api/scenario/');
  // Three POSITIVE controls, because every absence term below is vacuously true on an empty or
  // never-captured stream. (a) the secret POST itself IS in the bundle, (b) carrying the filter's own
  // replacement marker — so "the SSN is absent" means REDACTED, not "the request was never captured";
  // (c) `veto-body-target` IS present (F-1's leaking `complete` stage-entry, same block, same filter) —
  // so "veto-me is absent" means VETOED, not "network capture was off".
  const s8SecretPostCaptured = s8NetAll.includes('/api/scenario/echo') && s8NetAll.includes('"method":"POST"');
  const s8RedactionMarker = s8NetAll.includes('[REDACTED]');
  const s8VetoBodyTargetPresent = s8NetAll.includes('veto-body-target');
  const s8VetoAbsent = !s8NetAll.includes('veto-me');
  const s8SsnAbsent = !s8NetAll.includes('123-45-6789');
  const s8SecretHeaderAbsent = !s8NetAll.includes('sk_live_should_not_leave_device');
  record(
    's8-network-bundle-wire',
    "WIRE (PLAN §6.6 fallback, R4-5): read network.json OUT of the bundle the S8 mutate report actually uploaded — the vetoed URL is absent from it, and so are the redacted SSN and the dropped secret header, while the request they came from IS present and carries the filter's [REDACTED] marker. This is the first S8 network evidence that is not the sample's own DOM list",
    s8CarriesTraffic &&
      s8SecretPostCaptured &&
      s8RedactionMarker &&
      s8VetoBodyTargetPresent &&
      s8VetoAbsent &&
      s8SsnAbsent &&
      s8SecretHeaderAbsent,
    `${s8Bundles.length} ACCEPTED bundle(s) since S8 opened (upload statuses: ${JSON.stringify(bundleStatusesSince(s8BundleIdx))}), ${s8NetworkJson.length} with network.json; entries=${JSON.stringify(s8Bundles.map(zipNames))}; carriesTraffic=${s8CarriesTraffic} secretPostCaptured=${s8SecretPostCaptured} redactionMarker=${s8RedactionMarker} vetoBodyTargetPresent=${s8VetoBodyTargetPresent} vetoAbsent=${s8VetoAbsent} ssnAbsent=${s8SsnAbsent} secretHeaderAbsent=${s8SecretHeaderAbsent}`,
  );

  // Finding C at WIRE depth (R4-5): the `s8-sanitizer-disabled` check above reads the sample's own filter
  // log, which only proves the URL reached the CALLBACK unredacted. This proves the unsanitized URL is in
  // what actually LEFT the process — the sanitizer really did not run, rather than running later in the
  // pipeline. Kept as its own check so the claim stays separable from the veto/redaction one above.
  const s8RawTokenInBundle = s8NetAll.includes('token=SUPER_SECRET_TOKEN_VALUE');
  record(
    's8-sanitizer-disabled-bundle-wire',
    'WIRE (R4-5): Finding C confirmed in the UPLOADED bundle, not just in the filter callback — the `token=` query param the default PII sanitizer would normally redact is in network.json verbatim, because installing a network filter replaced the sanitizer (Android XOR rule)',
    s8CarriesTraffic && s8RawTokenInBundle,
    `carriesTraffic=${s8CarriesTraffic} rawTokenInUploadedNetworkJson=${s8RawTokenInBundle}`,
  );

  await click(page, 's8-uninstall');

  // S9 performance
  sinceCheckpoint();
  // WIRE, not the status line: `finished OK` is printed unconditionally by the click handler
  // (ScenarioPage.tsx's S9 control), so matching on it proved only that the handler ran to its last
  // statement. The same wire evidence this sweep already trusts as the s9-sample-rate-zero POSITIVE
  // control is available here — use it: the transaction must actually reach
  // POST /v2/performance/transactions, carrying its child spans.
  const s9TxSinceTs = Date.now();
  await click(page, 's9-manual-transaction', { wait: 400 });
  const s9tx = await statusText('s9-manual-transaction');
  const s9WireTx = await waitForPerfTransactions((t) => t.name === 'scenario.manual_transaction', {
    timeout: 8000,
    sinceTs: s9TxSinceTs,
  });
  const s9SpanStatuses = (s9WireTx[0]?.spans ?? []).map((s) => s.status);
  const s9ExpectedStatuses = ['OK', 'ERROR', 'TIMEOUT', 'CANCELLED', 'DEADLINE_EXCEEDED', 'UNKNOWN'];
  record(
    's9-manual-transaction',
    'manual transaction + every SpanStatus child span — WIRE-confirmed: the uploaded transaction finished OK and actually carries all 6 child spans, one per SpanStatus (not just the handler\'s own unconditional "finished OK" line)',
    s9WireTx.length > 0 &&
      s9WireTx[0].status === 'OK' &&
      s9ExpectedStatuses.every((s) => s9SpanStatuses.includes(s)) &&
      s9SpanStatuses.length === s9ExpectedStatuses.length &&
      Boolean(s9tx?.includes('finished OK')),
    `uploaded tx status=${s9WireTx[0]?.status}, child span statuses=[${s9SpanStatuses.join(',')}]`,
  );
  // `sinceTs` on EVERY waitForPerfTransactions call, not just the ones whose name is ambiguous today
  // (round-4 finding R4-2): without it the helper returns the EARLIEST transaction of that name in the
  // whole run, so the check silently reads someone else's evidence the moment a name stops being unique.
  const s9RouteNameSinceTs = Date.now();
  await click(page, 's9-set-route-name', { wait: 0 });
  const routeNamedTx = await waitForPerfTransactions((t) => t.name === '/manual/:demo', { sinceTs: s9RouteNameSinceTs });
  record(
    's9-set-route-name',
    'setRouteName direct call — WIRE-confirmed: the uploaded transaction is actually named "/manual/:demo" with bugsee.name_source:"route" (not just an unconditional status-line claim)',
    routeNamedTx.length > 0 && routeNamedTx[0].attributes?.['bugsee.name_source'] === 'route',
    JSON.stringify(routeNamedTx[0] ?? null),
  );

  // performanceSampleRate: 0 (PLAN §4 S9, previously never exercised). Positive control: the SAME
  // primitive (a manual transaction) DOES reach the wire once sampleRate is restored to 1 — otherwise
  // "the unsampled one never arrived" could just mean the wire listener/relaunch was broken. `sinceTs`
  // pins the control to THIS click specifically (not the earlier, already-sampled s9-manual-transaction
  // click from a few lines up, which would otherwise make the control vacuously true).
  const s9UnsampledSinceTs = Date.now();
  await click(page, 's9-sample-rate-zero', { wait: 500 });
  const unsampledTx = await waitForPerfTransactions((t) => t.name === 'scenario.sample_rate_zero_demo', {
    timeout: 3000,
    sinceTs: s9UnsampledSinceTs,
  });
  await click(page, 's9-sample-rate-restore', { wait: 500 });
  const controlSinceTs = Date.now();
  await click(page, 's9-manual-transaction', { wait: 400 }); // positive control, same primitive, now sampled
  const controlTx = await waitForPerfTransactions((t) => t.name === 'scenario.manual_transaction', { timeout: 5000, sinceTs: controlSinceTs });
  record(
    's9-sample-rate-zero',
    'performanceSampleRate:0 — the transaction is created but never reaches the wire (positive control: the same primitive DOES reach the wire once restored to sampleRate:1)',
    unsampledTx.length === 0 && controlTx.length > 0,
    `unsampled matches while rate=0: ${unsampledTx.length}; control matches after restore: ${controlTx.length}`,
  );

  // Solid-specific: ErrorBoundary + solidErrorHandler
  await click(page, 'arm-guarded', { wait: 600 });
  const guardedFallback = await page.locator('[data-testid="guarded-widget-fallback"]').count();
  record('solid-error-boundary-guarded', 'solidErrorHandler in a local <ErrorBoundary> catches render throw', guardedFallback === 1);
  await click(page, 'disarm-guarded');

  sinceCheckpoint();
  await click(page, 's-report-solid-error', { wait: 0 });
  record('solid-report-error', 'reportSolidError direct call', (await waitForCalls(isIssueCall)).some(isIssueCall));

  await click(page, 's-route-pattern');
  const patternStatus = await statusText('s-route-pattern');
  record('solid-route-pattern', 'routePatternFromSolidMatches -> "/issues/:id/comments" (deepest match, already cumulative)', Boolean(patternStatus?.includes('"/issues/:id/comments"')), patternStatus ?? '');
  // `sinceTs` is LOAD-BEARING here (round-4 finding R4-2), not defensive: unlike `/manual/:demo`,
  // `/issues/:id` is NOT unique to this control. The LIVE RouteNameSync wiring emits it too — two real
  // <A> clicks inside the 1s idle window produce {"name":"/issues/:id","op":"navigation","src":"route"},
  // and the app-smoke block at the top of this sweep does exactly that (issue detail, then its Comments
  // tab). Without sinceTs this check reads the EARLIEST `/issues/:id` transaction of the whole run, so
  // the day finding A is fixed it would assert on app-smoke's navigation instead of on this click and
  // pass whether or not setRouteNameFromSolidMatches works at all. Its two nearest siblings already pin
  // sinceTs for this reason; this one did not.
  const matchesSinceTs = Date.now();
  await click(page, 's-set-route-name-matches', { wait: 0 });
  const matchesNamedTx = await waitForPerfTransactions((t) => t.name === '/issues/:id', { sinceTs: matchesSinceTs });
  record(
    'solid-set-route-name-matches',
    'setRouteNameFromSolidMatches (direct call, synthetic matches) — WIRE-confirmed: the uploaded transaction is actually named "/issues/:id" with bugsee.name_source:"route", scoped by sinceTs to THIS click (the live router wiring emits the same name). This is the DIRECT-call primitive with no @solidjs/router timing race — contrast with `solid-route-name-wire` below (the LIVE router wiring, which is broken)',
    matchesNamedTx.length > 0 && matchesNamedTx[0].attributes?.['bugsee.name_source'] === 'route',
    JSON.stringify(matchesNamedTx[0] ?? null),
  );

  // Solid-specific: createResource error, caught by a local <ErrorBoundary> + reportSolidError
  sinceCheckpoint();
  await click(page, 's-resource-error-arm', { wait: 0 });
  const resourceIssueCalls = await waitForCalls(isIssueCall);
  const resourceFallbackVisible = await page.locator('[data-testid="resource-error-fallback"]').count();
  record(
    'solid-resource-error',
    'createResource fetcher rejects -> reading the resource re-throws -> <ErrorBoundary> + reportSolidError',
    resourceFallbackVisible === 1 && resourceIssueCalls.some(isIssueCall),
    `fallback visible=${resourceFallbackVisible === 1}, issue calls=${resourceIssueCalls.filter(isIssueCall).length}; onError sink="${await internalErrorsText()}"`,
  );

  // Real navigation-driven route naming (useCurrentMatches + setRouteNameFromSolidMatches, wired
  // globally in RootLayout.tsx's RouteNameSync) — WIRE-level check for FINDINGS.md finding A.
  // @solidjs/router flushes its reactive `matches()` update (and so the `createEffect` that calls
  // setRouteNameFromSolidMatches) BEFORE committing history (packages/solid/src/router.ts:8-10), so the
  // effect fires — and renames whatever transaction happens to be active — a moment before the real
  // navigation transaction for THIS route change even starts (packages/performance/src/navigations.ts:
  // 58). Net effect: the refinement never lands on its own navigation transaction. Positive control:
  // a real navigation transaction must actually reach the wire, or "it stayed url-named" proves nothing.
  // The assertion is deliberately over EVERY navigation transaction this click produces, not over a
  // pre-filtered subset. The earlier form filtered to `name === '/issues/issue-2'` and THEN asserted
  // `.every(source === 'url')` — near-tautological, and blind in the one direction that matters: a fix
  // that deferred setRouteName onto the real navigation transaction would leave the 0ms phantom
  // transaction (each <A> click fires TWO `currententrychange` events; the first is superseded before
  // RouteNameSync's effect ever reaches it) still url-named, and the old check would keep PASSING on the
  // phantom alone. `settlePerfTransactions` also replaces `waitForPerfTransactions` here for the same
  // reason: the latter returns on the FIRST matching POST, which held only the phantom.
  //
  // SECOND POSITIVE CONTROL (added this pass — the check was otherwise unfalsifiable in the direction
  // that matters most): "navigation transactions reached the wire, one is named for issue-2, and none is
  // route-named" is ALL still true if `<RouteNameSync/>` is deleted from RootLayout.tsx outright. That
  // would make this check — Finding A's regression pin — silently vacuous: it would keep passing against
  // an SDK where the wiring under test isn't even installed. So the check now ALSO requires positive
  // proof that RouteNameSync exists and its effect fires and reaches setRouteName: the misattribution
  // probe from FINDINGS.md finding A. Two navigations inside the idle-transaction window
  // (packages/performance/src/idle-transaction.ts:53, default idleTimeoutMs 1000) — click into an issue,
  // then click its Comments tab ~400ms later — make the SECOND navigation's route pattern land on a
  // transaction started by the FIRST click, producing a bugsee.name_source:'route' transaction. That IS
  // the defect (a route's timing labelled with another route's name), and it is simultaneously the only
  // available evidence that the effect runs at all. Deleting <RouteNameSync/> takes this term to zero.
  // Asserted over EVERY transaction in the control window, not just `operation: 'navigation'` ones —
  // nothing else in this window calls setRouteName, so any route-named transaction is this wiring's work.
  //
  // WHY THIS STAYS ONE CHECK AND IS NOT SPLIT IN TWO (round-4 review raised the option and left it to
  // this pass; the previously-stated reason, "keep the count comparable", was documentation cosmetics and
  // is withdrawn). The technical reason: the two legs are ONE conjoined claim — "the refinement fires,
  // and never lands on its own navigation transaction" — and EITHER leg alone is vacuous in exactly the
  // way this whole pass has been eradicating. Split out, the negative leg ("no nav transaction is
  // route-named") passes green on an app with `<RouteNameSync/>` deleted, and the positive leg ("a
  // route-named transaction appears") passes green on an SDK where the refinement works perfectly. A
  // split would therefore manufacture two checks that are each individually green-while-meaningless in
  // order to report a number one higher. The failure detail already prints BOTH transaction arrays, so a
  // red here names which leg moved without needing them separated.
  await page.goto(`${BASE}/issues`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500); // let the pageload transaction (and anything else mid-flight) settle
  sinceCheckpoint();
  const navSinceTs = Date.now();
  await page.click('[data-testid="issue-issue-2"]'); // a REAL client-side @solidjs/router <A> navigation
  const liveNavTxs = (await settlePerfTransactions({ sinceTs: navSinceTs })).filter((t) => t.operation === 'navigation');
  const routeNamedNavTxs = liveNavTxs.filter((t) => t.attributes?.['bugsee.name_source'] === 'route');

  // The misattribution probe (positive control for "RouteNameSync is installed and firing").
  await page.goto(`${BASE}/issues`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const misattributionSinceTs = Date.now();
  await page.click('[data-testid="issue-issue-5"]');
  await page.waitForTimeout(400); // well inside the 1000ms idle window of the transaction just started
  await page.click('.tab-nav >> text=Comments');
  const misattributionTxs = await settlePerfTransactions({ sinceTs: misattributionSinceTs });
  const misattributedTxs = misattributionTxs.filter((t) => t.attributes?.['bugsee.name_source'] === 'route');
  record(
    'solid-route-name-wire',
    "LIVE router wiring (RouteNameSync) — KNOWN SDK DEFECT (FINDINGS.md finding A): NO navigation transaction a single <A> click produces is ever named by the route pattern — after the wire settles, every one of them still carries bugsee.name_source:'url'. TWO positive controls, so this cannot pass vacuously: (1) navigation transactions DID reach the wire named for issue-2; (2) the misattribution probe (two navigations inside the 1s idle window) DOES produce a bugsee.name_source:'route' transaction, proving RouteNameSync is installed and its effect reaches setRouteName — deleting <RouteNameSync/> takes control (2) to zero and turns this check RED. It also goes RED the day the refinement lands correctly, which is the point",
    liveNavTxs.length > 0 &&
      liveNavTxs.some((t) => t.name.includes('issue-2') || t.name === '/issues/:id') &&
      routeNamedNavTxs.length === 0 &&
      misattributedTxs.length > 0,
    `single nav: ${JSON.stringify(liveNavTxs.map((t) => ({ name: t.name, source: t.attributes?.['bugsee.name_source'] })))}; misattribution probe: ${JSON.stringify(misattributionTxs.map((t) => ({ name: t.name, source: t.attributes?.['bugsee.name_source'] })))}; onError sink="${await internalErrorsText()}"`,
  );

  // ---- S11 session replay ----------------------------------------------------------------------
  //
  // Round 5 rebuilt this whole block, because the SDK changed underneath it: replay is now ON BY
  // DEFAULT (`packages/browser/src/launch.ts`: `options.replay !== false && domDocument !== undefined`;
  // `replay: false` is the opt-out, and a DOM-less host self-skips silently in
  // `packages/replay/src/register.ts`). Three consequences, each addressed below:
  //
  //  (a) the old `s11-replay-bundle-wire` row — "relaunch with explicit masking, then find replay.bin in
  //      the bundle" — now PASSES FOR THE WRONG REASON. `replay.bin` rides every bundle this sample
  //      uploads, including the ones the S8 block produces, so finding it after clicking a replay
  //      control no longer says the control did anything at all. It is replaced by a matched PAIR:
  //      `s11-replay-default-on` (no `replay` key anywhere in the options -> replay.bin IS there, which
  //      is the flip itself) and `s11-replay-optout-wire` (`replay: false` -> replay.bin is NOT there,
  //      on a bundle proven non-empty by its other entries). Neither can pass without the other's
  //      opposite outcome being reachable.
  //  (b) the sample's own `s11-replay-off` control was a lie after the flip: it called
  //      `relaunch(FULL_LAUNCH_OPTIONS)`, which names no `replay` key, so it left replay ON while its
  //      label said "Restore (replay off)". It now really passes `replay: false`, and a separate
  //      `s11-replay-restore` control does the baseline restore.
  //  (c) masking evidence is now available on EVERY bundle rather than needing a dedicated relaunch,
  //      and `replay.bin` needs no rrweb decoder — it is `gzipSync(strToU8(JSON.stringify(payloads)))`
  //      (`packages/replay/src/encoder.ts`), so `zlib.gunzipSync` + a string search is the whole tool.
  //      The two masking rows below therefore read the DECODED stream instead of resting on a status
  //      line, and they are built around an in-sweep POSITIVE CONTROL (a masking-OFF relaunch in which
  //      the same probe string MUST appear) so neither can be vacuously green on a needle that could
  //      never have matched.
  await page.goto(`${BASE}/scenarios`, { waitUntil: 'networkidle' });
  newPageErrors(); // reset the checkpoint

  // (1) THE FLIP itself, at wire level: FULL_LAUNCH_OPTIONS names no `replay` key at all, and the bundle
  //     it uploads still carries replay.bin. Under the pre-flip SDK this row would be RED.
  await click(page, 's11-replay-restore', { wait: 1200 });
  const defaultRun = await reportAndCollectBundles();
  const defaultHasReplay = hasEntry(defaultRun.names, 'replay.bin');
  record(
    's11-replay-default-on',
    'replay is ON BY DEFAULT — the bundle uploaded under FULL_LAUNCH_OPTIONS, which sets NO `replay` key anywhere, actually contains a replay.bin entry (read from the zip CENTRAL DIRECTORY of an ACCEPTED upload, not a raw-byte substring of whatever was sent)',
    defaultRun.bufs.length > 0 && defaultHasReplay,
    `${defaultRun.bufs.length} accepted bundle(s) (statuses ${JSON.stringify(defaultRun.statuses)}); replay.bin=${defaultHasReplay}; entries=${JSON.stringify(defaultRun.names)}`,
  );

  // (2) The NEGATIVE half of the pair — `replay: false` is a real opt-out. The positive control inside
  //     this row is `crash.json`: it proves the bundle is a real, populated incident bundle, so
  //     "replay.bin absent" means opted out rather than "nothing was uploaded".
  await click(page, 's11-replay-off', { wait: 1200 });
  const optOutRun = await reportAndCollectBundles();
  const optOutHasReplay = hasEntry(optOutRun.names, 'replay.bin');
  const optOutIsRealBundle = hasEntry(optOutRun.names, 'crash.json');
  record(
    's11-replay-optout-wire',
    '`replay: false` really opts OUT — the bundle uploaded after it carries NO replay.bin, while still being a real populated incident bundle (crash.json present). This is the negative control that keeps `s11-replay-default-on` from being a tautology now that replay.bin rides every default bundle',
    optOutRun.bufs.length > 0 && optOutIsRealBundle && !optOutHasReplay,
    `${optOutRun.bufs.length} accepted bundle(s) (statuses ${JSON.stringify(optOutRun.statuses)}); replay.bin=${optOutHasReplay} (want false); crash.json=${optOutIsRealBundle}; entries=${JSON.stringify(optOutRun.names)}`,
  );

  await click(page, 's11-replay-defaults', { wait: 800 });
  record('s11-replay-defaults', 'relaunch with replay: true (fail-closed defaults)', newPageErrors() === 0);
  await click(page, 's11-replay-canvas-fixed', { wait: 800 });
  record('s11-replay-canvas-fixed', 'relaunch with replay.canvas: { fps: 2 }', newPageErrors() === 0);
  await click(page, 's11-replay-canvas-all', { wait: 800 });
  record('s11-replay-canvas-all', "relaunch with replay.canvas: { fps: 'all' }", newPageErrors() === 0);

  // (3) Masking, decoded.
  //
  //     Every probe is plain `[a-z0-9-]`, so JSON encoding cannot turn it into a needle that could never
  //     match (a peer sample shipped a masking check whose multi-line needle was unmatchable by
  //     construction — the stream is JSON, so a real newline is stored as backslash-n).
  //
  //     Probes are also DISTINCT PER RUN AND PER PATH, which the first version of this block got wrong
  //     and which mattered: a relaunch does not reload the page, so whatever is sitting in an input when
  //     the new recorder takes its FULL SNAPSHOT is recorded by the snapshot path, and re-typing the
  //     same string afterwards makes the two paths indistinguishable. With one probe per run this block
  //     "measured" the incremental path while actually reading the snapshot. `…-snap` values are put in
  //     the field BEFORE the relaunch (snapshot path) and `…-typed` values are typed AFTER it
  //     (incremental path), so each row names exactly one path.
  const MASK_PROBE = 'solid-mask-probe-a1b2c3';
  const UNMASK_PROBE = 'solid-unmask-probe-d4e5f6';
  const MASK_SNAP = 'solid-mask-snap-11aa22';
  const MASK_TYPED = 'solid-mask-typed-33bb44';
  const UNMASK_SNAP = 'solid-unmask-snap-55cc66';
  const UNMASK_TYPED = 'solid-unmask-typed-77dd88';
  const replayTextOf = (bufs) =>
    bufs
      .map((b) => zipEntry(b, 'replay.bin'))
      .filter(Boolean)
      .map((b) => gunzipSync(b).toString('utf8'))
      .join('\n');

  //     (3a) POSITIVE CONTROL: masking OFF. The probes MUST appear verbatim in the decoded stream. This
  //     row is what makes (3b)'s absence claim mean something: it proves the probe survives typing,
  //     recording, gzip and JSON encoding, and that this sweep can see it when it IS there.
  await click(page, 's11-replay-unmasked', { wait: 1200 });
  await page.fill('[data-testid="s11-masked-field"]', MASK_PROBE);
  await page.fill('[data-testid="s11-shown-field"]', UNMASK_PROBE);
  await page.waitForTimeout(400);
  const unmaskedRun = await reportAndCollectBundles();
  const unmaskedText = replayTextOf(unmaskedRun.bufs);
  const unmaskedSeesProbe = unmaskedText.includes(MASK_PROBE);
  record(
    's11-replay-masking-off-control',
    'POSITIVE CONTROL for the masking rows: with maskAllText/maskAllInputs OFF, the probe typed into an input DOES appear verbatim in the decoded replay.bin — so the needle is matchable, the decode works, and (3b) below cannot be vacuously green',
    unmaskedText.length > 0 && unmaskedSeesProbe,
    `decoded ${unmaskedText.length} chars of replay stream; probe visible=${unmaskedSeesProbe}`,
  );

  //     (3b) The real masking claim, on BOTH paths separately. `…-snap` values go in while the
  //     masking-OFF client is still running, so the masking client's full snapshot serializes them;
  //     `…-typed` values are typed afterwards, so only the incremental observer can carry them.
  await page.fill('[data-testid="s11-masked-field"]', MASK_SNAP);
  await page.fill('[data-testid="s11-shown-field"]', UNMASK_SNAP);
  await click(page, 's11-replay-masking', { wait: 1200 });
  record('s11-replay-masking', 'relaunch with explicit masking options', newPageErrors() === 0);
  await page.fill('[data-testid="s11-masked-field"]', MASK_TYPED);
  await page.fill('[data-testid="s11-shown-field"]', UNMASK_TYPED);
  await page.waitForTimeout(400);
  const maskedRun = await reportAndCollectBundles();
  const maskedText = replayTextOf(maskedRun.bufs);
  // Structural control: the stream really did serialize this page's DOM, so it HAD the chance to leak.
  const maskedCarriesDom = maskedText.includes('"tagName":"input"') && maskedText.includes('"type":2');
  const maskSnapAbsent = !maskedText.includes(MASK_SNAP);
  const maskTypedAbsent = !maskedText.includes(MASK_TYPED);
  record(
    's11-replay-masking-content',
    'WIRE: the un-marked input`s value is genuinely ABSENT from the decoded replay.bin (gunzip -> JSON) on BOTH paths — the value present at full-snapshot time and the value typed afterwards during recording — while that same stream demonstrably serialized this page`s DOM (a full snapshot carrying <input> nodes), so "absent" means MASKED rather than "nothing was recorded"',
    maskedText.length > 0 && maskedCarriesDom && maskSnapAbsent && maskTypedAbsent,
    `decoded ${maskedText.length} chars; carriesDom=${maskedCarriesDom} snapshotValueAbsent=${maskSnapAbsent} typedValueAbsent=${maskTypedAbsent}`,
  );

  // (4) `.bugsee-unmask` on an input, measured per PATH rather than assumed — and this is where the
  //     per-path probes earned themselves.
  //
  //     Two peer samples independently reported an SDK defect: the mark is honoured only on the
  //     FULL-SNAPSHOT path, so a value TYPED DURING recording stays masked regardless. It lives in the
  //     rrweb fork rather than in `packages/replay/src/masking.ts`, and it FAILS CLOSED (more masking
  //     than asked for), so it is documented, not re-diagnosed, here — see FINDINGS.md finding D.
  //
  //     This sample REPRODUCES it, and the first version of this block very nearly recorded the
  //     opposite: with one probe string reused across the relaunch, the "typed" needle matched the
  //     SNAPSHOT's copy of the same string and the run reported the mark working on both paths. Split
  //     into `…-snap` / `…-typed` the answer inverts — snapshot-path visible, typed-path masked — which
  //     is exactly the peers' finding.
  //
  //     The row PINS the observed split, so it turns RED the day the fork starts honouring the mark on
  //     the incremental path, the same discipline the finding-A and finding-B rows use. Its positive
  //     control against vacuity is twofold: the snapshot term must be VISIBLE (so the needle is
  //     matchable in this very stream, not just in the masking-OFF control run) and the un-marked
  //     sibling must be masked on both paths (so the stream is really applying masking).
  const unmaskSnapVisible = maskedText.includes(UNMASK_SNAP);
  const unmaskTypedVisible = maskedText.includes(UNMASK_TYPED);
  record(
    's11-unmask-mark-typed-value',
    'KNOWN SDK DEFECT (FINDINGS.md finding D, fails closed): `.bugsee-unmask` on an input un-masks the value present at FULL-SNAPSHOT time but NOT a value typed during recording — measured with a distinct probe per path in ONE stream (snapshot probe visible = the needle is matchable here; typed probe absent = the defect; un-marked sibling masked on both paths = masking really is applied). Pinned, so it turns RED when the rrweb fork honours the mark on the incremental path too',
    maskedText.length > 0 && maskedCarriesDom && unmaskSnapVisible && !unmaskTypedVisible && maskSnapAbsent && maskTypedAbsent,
    `unmask-marked: snapshot-path visible=${unmaskSnapVisible} (want true), typed-during-recording visible=${unmaskTypedVisible} (want false = the defect); un-marked sibling absent on both paths=${maskSnapAbsent && maskTypedAbsent}`,
  );

  newPageErrors();
  await click(page, 's11-replay-restore', { wait: 800 }); // restore FULL_LAUNCH_OPTIONS baseline
  record('s11-replay-restore', 'relaunch back to FULL_LAUNCH_OPTIONS baseline, no throw', newPageErrors() === 0);

  // The global (unguarded) throw — propagates past the ThrowingWidget's own scope up to the app-level
  // <ErrorBoundary> wrapping <AppRouter> in main.tsx.
  await page.goto(`${BASE}/scenarios`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  sinceCheckpoint();
  await click(page, 'arm-global', { wait: 900 });
  const globalFallback = await page.locator('[data-testid="error-fallback"]').count();
  record('solid-error-boundary-global', 'unguarded throw reaches the app-level <ErrorBoundary>', globalFallback === 1);

  // S12 — deliberately run BEFORE the S4 storm (FINDINGS.md finding B): the storm is designed to
  // exceed the capture rate limiter's ~100/60s budget, so running it FIRST starves the very recovery
  // this check exists to confirm (a real isolated run produced ZERO /v2/issues calls for S12 when the
  // storm ran first).
  //
  // The expected count is TWO, asserted exactly. FINDINGS.md finding B is NOT a nondeterministic race:
  // once the reload lands after the durable queue has taken its copy of the bundle (the control now
  // reloads at 250ms — see ScenarioPage.tsx's S12 control for why 5ms could never show this), BOTH
  // recovery legs inside coexistence.recoverDeadSiblings run with no de-duplication between them and the
  // same incident is uploaded twice, every time (5ms -> 1 upload in 2/2 runs; 40ms -> 2 in 2/2; 250ms ->
  // 2 in 3/3). The earlier `>= 1 && <= 2` tolerance could never observe 2 at 5ms, so it was reporting a
  // PASS for the one timing that structurally cannot reproduce the defect. Asserting `=== 2` pins the
  // real, observed behaviour: 1 means finding B has been FIXED in the SDK (update this check and
  // FINDINGS.md finding B together), 0 means recovery is broken outright.
  await page.goto(`${BASE}/scenarios`, { waitUntil: 'networkidle' });
  // STRUCTURAL CAVEAT this drain exists to contain: the `arm-global` step immediately above ends with a
  // report whose upload is interrupted mid-flight by THIS `page.goto` — structurally the very same
  // "terminated before the upload settled" shape S12 deliberately exploits. So the launch that follows
  // this goto ALSO runs recovery for arm-global's incident, and any leg of that recovery landing inside
  // S12's window would be miscounted as an S12 delivery — and, worse, could hold the `=== 2` pin green
  // against an SDK where finding B had actually been FIXED (1 real S12 upload + 1 contaminant = 2).
  // The drain is what keeps S12's own count clean: wait for bugsee traffic to go fully quiet AFTER the
  // relaunch (so arm-global's own report AND anything the relaunch recovered from it are already counted
  // and discarded here) and only then open S12's window. This is NOT hypothetical — the drain measured
  // FOUR issue calls on this sample, i.e. arm-global really does leave recoverable work behind. The
  // drained count is printed in the detail below so it stays visible rather than silent.
  const preS12Drain = (await waitForQuiet({ quietMs: 2500, timeout: 20_000 })).filter(isIssueCall);
  sinceCheckpoint();
  await page.click('[data-testid="s12-crash-and-reload"]');
  await page.waitForTimeout(750); // the page navigates away 250ms after the click
  // waitForQuiet (not waitForCalls, which would return as soon as the FIRST call lands) — the duplicate
  // upload's second call arrives ~1.5s after the first, and this check must see BOTH, not stop at 1.
  const recoveryCalls = (await waitForQuiet({ quietMs: 3000, timeout: 15_000 })).filter(isIssueCall);
  const relaunchedText = await page.locator('[data-testid="is-launched"]').textContent().catch(() => '');
  record(
    's12-persist-recover',
    'logException then hard-reload at 250ms — the incident IS recovered on the next launch, and (FINDINGS.md finding B, a known SDK defect, deterministic not racy) is uploaded EXACTLY TWICE: once by recoverSiblingBundleQueue re-uploading the durably-queued bundle, once by core recoverReports rebuilding it from the still-open marker. 1 = finding B fixed (update this check); 0 = recovery broken',
    relaunchedText === 'true' && recoveryCalls.length === 2,
    `isLaunched() after reload -> ${relaunchedText}; ${recoveryCalls.length} /v2/issues call(s) recovered this incident; ${preS12Drain.length} pre-window issue call(s) drained before opening it (arm-global's own report plus whatever the following relaunch recovered from it — measured 4 on this sample, which is exactly why this drain exists: without it those calls could land inside S12's window and hold the "=== 2" pin green against a FIXED SDK)`,
  );

  // S4 storm — run AFTER S12 (see above), not before it. 200 logException calls in ~1s must
  // rate-limit rather than drop the app; its rate-limit window lingering afterward is fine since
  // nothing that still needs the capture budget runs after it.
  await page.goto(`${BASE}/scenarios`, { waitUntil: 'networkidle' });
  sinceCheckpoint();
  await click(page, 's4-storm', { wait: 0 });
  const stormCalls = (await waitForQuiet({ quietMs: 3000, timeout: 60_000 })).filter(isIssueCall);
  record('s4-storm', '200 exceptions in ~1s — rate-limited, app stays responsive', stormCalls.length > 0 && stormCalls.length < 200, `${stormCalls.length} issue calls (of 200 attempted)`);

  // Final flush attempt, right after the deliberate storm. WEAK CHECK, disclosed plainly: it accepts
  // EITHER boolean outcome and only proves the call completes without hanging/throwing — the storm
  // intentionally floods past the rate limiter's budget (see s1-flush-clean above), so flush(5000)
  // legitimately timing out (-> false) here is expected, not a failure, and this check cannot tell
  // "drained" apart from "didn't".
  await click(page, 's1-flush', { wait: 1500 });
  const s1flushPostStormStatus = await statusText('s1-flush');
  record(
    's1-flush-post-storm',
    "flush(5000) after the storm completes without hanging/throwing (WEAK: accepts true OR false — draining fully is not expected here, and this check cannot distinguish the two)",
    Boolean(s1flushPostStormStatus?.includes('flush() -> true') || s1flushPostStormStatus?.includes('flush() -> false')),
    s1flushPostStormStatus ?? '',
  );

  await browser.close();

  // ------------------------------------------------------------------ S8 report handler, BACKEND depth
  // Round-4 finding R4-1, second leg. Before this pass the S8 "report handler — veto" row was verified at
  // W depth only ("exactly 1 /v2/issues call left the process for the whole block") and the sample never
  // once asked staging whether the vetoed message was there. It was: SSOLID-82 carried
  // `S8: report handler should VETO this — must never arrive`, created 2026-08-26T21:42:34Z, and sat
  // undetected across three review rounds because the sample's design structurally could not see it.
  // PLAN §6.3 asks for `list_issues` polling and §6.4 for "anything redacted in S8 is absent" confirmed
  // on the BACKEND — this is that check.
  //
  // POSITIVE CONTROL, and it is the whole point: the MUTATE report from the SAME block must be FOUND, in
  // the SAME window, by the SAME query. Without it "the veto message is absent" passes just as happily
  // when the MCP endpoint is unreachable, the app key is wrong, or the window is mis-computed.
  const VETO_MSG = 'S8: report handler should VETO this';
  const MUTATE_MSG = 'S8: report handler should mutate this';
  if (!MCP_URL) {
    const why =
      'BUGSEE_MCP_URL is not set — the S8 report-veto B-depth check CANNOT run, so "no issue created" is unverified on the backend. Set BUGSEE_MCP_URL (the staging MCP endpoint) in samples/solid-spa/.env; see .env.example. This deliberately FAILS rather than silently skipping: an unverifiable claim is exactly the gap R4-1 was raised for.';
    record('s8-report-veto-backend', 'B: the vetoed report is absent from staging', false, why);
    record('s8-report-mutate-backend', 'B: the mutated report arrived on staging with the added label', false, why);
  } else {
    let candidates = [];
    let mutateIssue = null;
    let vetoIssue = null;
    let queryError = '';
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        candidates = [];
        let cursor;
        for (let page = 0; page < 5; page++) {
          const args = { application_id_or_key: APP_KEY, sort: 'date_desc' };
          if (cursor) args.cursor = cursor;
          const listed = JSON.parse(await mcp('list_issues', args));
          for (const i of listed.issues ?? []) {
            if (Date.parse(i.updated_on) >= s8WindowStart) candidates.push(i);
          }
          cursor = listed.nextCursor;
          if (!cursor) break;
        }
        mutateIssue = null;
        vetoIssue = null;
        for (const c of candidates) {
          const text = await mcp('get_issue', c.key ? { issue_key: c.key } : { issue_id: c.id });
          if (text.includes(MUTATE_MSG)) mutateIssue = { key: c.key || c.id, text };
          if (text.includes(VETO_MSG)) vetoIssue = { key: c.key || c.id, text };
        }
        queryError = '';
      } catch (err) {
        queryError = String(err?.message ?? err);
      }
      // Retry only while the POSITIVE CONTROL has not landed yet (backend processing lag). Once it has,
      // the window has demonstrably been indexed, so a still-absent veto message is a real absence.
      // The grace period is really the sweep itself: this query runs at the END, ~150 s after the S8
      // block, and the veto click is only ~1 s after the mutate click it is compared against — so a
      // backend that has indexed the mutate report has had 150 s to index anything from 1 s later. The
      // retry loop only matters when staging is unusually slow.
      if (mutateIssue || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    record(
      's8-report-veto-backend',
      'B (R4-1): staging has NO issue carrying the vetoed report\'s message anywhere in the window this sweep\'s S8 block opened — queried over every issue updated in that window, with the mutate report from the same block as the positive control that the query can find an S8 report at all',
      Boolean(mutateIssue) && !vetoIssue && !queryError,
      `${candidates.length} issue(s) updated since the S8 window opened; positive control (mutate) found=${mutateIssue?.key ?? 'NO'}; vetoed message found=${vetoIssue?.key ?? 'none (correct)'}${queryError ? `; MCP error: ${queryError}` : ''}`,
    );
    const mutateLabels = /# Labels\n([^\n]*)/.exec(mutateIssue?.text ?? '')?.[1] ?? '';
    record(
      's8-report-mutate-backend',
      'B: the MUTATED report did arrive on staging and carries the label the report handler ADDED (`redacted-before`) alongside the one the app passed (`MUTATE_ME`) — the mutation is visible on the backend, not just at the wire',
      mutateLabels.includes('MUTATE_ME') && mutateLabels.includes('redacted-before'),
      `${mutateIssue?.key ?? 'issue NOT found'} labels="${mutateLabels}"`,
    );
  }

  // ---------------------------------------------------------------------------------------- Report
  const width = Math.max(...results.map((r) => r.id.length)) + 2;
  console.log('\n=== solid-spa scenario sweep ===\n');
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
