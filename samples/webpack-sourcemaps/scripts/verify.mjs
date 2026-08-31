// The scripted scenario sweep (docs/samples/PLAN.md §3/§6). Drives the REAL app + REAL SDK headlessly
// via Playwright against the DEV server (`pnpm dev` must be running first: webpack-dev-server on
// :5321 + the local API on :5346) and prints a pass/fail table for what can be checked from the
// browser (LOCAL: no throw / WIRE: the right request left the process). Backend (MCP) verification is
// a separate step run by hand against the printed evidence — see scenarios.md.
import { chromium } from 'playwright';

const BASE = 'http://localhost:5321';
const results = [];

function record(id, description, ok, detail = '') {
  results.push({ id, description, ok, detail });
}

async function click(page, testid, { wait = 300 } = {}) {
  await page.click(`[data-testid="${testid}"]`, { timeout: 5000 });
  await page.waitForTimeout(wait);
}

async function statusText(page, testid) {
  return page.textContent(`[data-status-for="${testid}"]`).catch(() => null);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true });

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  const bugseeCalls = [];
  page.on('response', async (res) => {
    if (!res.url().includes('bugsee.com')) return;
    let ok = false;
    try {
      const json = await res.json();
      ok = json?.ok !== false;
    } catch {
      ok = res.status() >= 200 && res.status() < 300;
    }
    bugseeCalls.push({ url: res.url(), status: res.status(), ok, t: Date.now() });
  });

  let checkpoint = 0;
  let calls;
  // "An issue-create request LEFT the process" — deliberately NOT "the backend accepted it". Used only
  // where the claim really is about a request being made (or NOT made: the s8 veto row, which must go
  // red on a rejected call just as loudly as on an accepted one).
  const isIssueCall = (c) => c.url.includes('issues');
  // ...and the accepting form, for every row whose claim is "the report was FILED". FIXED IN THIS PASS
  // (the substrate-flip re-verification): `bugseeCalls[].ok` was computed at :33-39 and read by NOTHING,
  // so all thirteen group-(B) rows rested on "a POST was sent to a url containing `issues`" and stayed
  // green against a 4xx/5xx staging reply. A peer sample found the identical hole in its own tee. The
  // flip makes it materially likelier to bite: every bundle now carries `replay.bin` (8 KB gzipped in
  // the measurement below, on a page this small), so an upload that the collector rejects on size or
  // content is a real failure mode this sweep previously could not see.
  const isAcceptedIssueCall = (c) => isIssueCall(c) && c.ok;
  const waitForCalls = async (match, { timeout = 15_000, min = 1, poll = 100 } = {}) => {
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
   * Wait until bugsee traffic SETTLES (no new call for `quietMs`) before advancing the checkpoint —
   * used after s4-storm (200 near-simultaneous logException() attempts) so its slow-draining stragglers
   * cannot bleed into a LATER scenario's before/after count (observed: without this, s8-report-veto's
   * "no new issue call" check saw a late storm straggler and reported a false FAIL — reproduced and
   * confirmed via an isolated re-check with the storm removed from the run: veto is NOT broken).
   */
  const waitForQuiet = async ({ quietMs = 1200, maxWaitMs = 8000 } = {}) => {
    const deadline = Date.now() + maxWaitMs;
    let lastCount = bugseeCalls.length;
    let lastChangeAt = Date.now();
    for (;;) {
      await page.waitForTimeout(150);
      if (bugseeCalls.length !== lastCount) {
        lastCount = bugseeCalls.length;
        lastChangeAt = Date.now();
      }
      if (Date.now() - lastChangeAt >= quietMs || Date.now() >= deadline) {
        checkpoint = bugseeCalls.length;
        return;
      }
    }
  };
  /**
   * Bundle-level (WIRE) evidence, via src/bugsee-transport.ts's tee — it forwards every SDK call to
   * real staging verbatim while recording a parsed copy of each uploaded bundle in the page. Polls
   * until a bundle matching `matchFn` shows up, or `timeout` elapses (absence is itself a valid,
   * asserted-on result — e.g. proving a vetoed report never produces a bundle at all). Needed because
   * the S8 in-app filter-log checks below only prove the filter CALLBACK ran, not that the SDK actually
   * applied its return value — PLAN §6.6.
   */
  const waitForBundle = async (matchFn, { timeout = 8000, poll = 150 } = {}) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const bundles = await page.evaluate(() => window.__bugseeTee?.getCapturedBundles() ?? []);
      // ACCEPTED uploads only (fixed in the substrate-flip re-verification, same hole as
      // `isAcceptedIssueCall` above): `CapturedCall.status` — the S3 PUT's real response status,
      // recorded by src/bugsee-transport.ts — was read by ZERO checks, so every "the UPLOADED bundle
      // carries X" row below actually asserted "the bundle the SDK SENT carried X", whether or not S3
      // took it. Filtering here fixes all 22 `-wire` rows plus s12 at once. The `wire-uploads-accepted`
      // row at the end of this sweep reports the accept rate explicitly so a systematic rejection can
      // never hide as a quiet timeout in the rows above.
      const found = bundles.filter((b) => b.status >= 200 && b.status < 300).find(matchFn);
      if (found !== undefined || Date.now() >= deadline) return found;
      await page.waitForTimeout(poll);
    }
  };
  /**
   * Poll a control's own status line until `predicate` matches or `timeout` elapses — evidence-based
   * waiting (never a fixed sleep) for a control whose completion is signalled by its own status text,
   * not by network quiescence or a tee bundle. Used by s4-storm: its handler now awaits
   * `Promise.all(attempts)` (scenarios.ts) before writing the final `drained: …` status, and that
   * drain has been measured to take up to ~90s (100 admitted uploads through the bounded-concurrency
   * upload queue) — so the default timeout has to comfortably clear that.
   */
  const waitForStatus = async (testid, predicate, { timeout = 110_000, poll = 500 } = {}) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const text = await statusText(page, testid);
      if (predicate(text ?? '')) return text;
      if (Date.now() >= deadline) return text;
      await page.waitForTimeout(poll);
    }
  };

  // ===============================================================================================
  // APP-LITERAL AUDIT (fix round 6, R6-4) — the R5-3 / R4-2 defect class, swept across ALL 76 checks
  // (80 after the substrate-flip re-verification — see the re-audit note below)
  // -----------------------------------------------------------------------------------------------
  // The class: a check asserts a string the SAMPLE'S OWN CODE hard-codes (a status template, a UI
  // literal), while its scenarios.md row claims something the SDK, the local API or the wire had to
  // produce. Such a check is green whenever the handler merely RAN. Round 4 (R4-2) split it out of six
  // S7 rows, round 5 (R5-3) out of `s7-no-content-type` — and, exactly as round 5's own recorded lesson
  // predicted, each sweep stopped at the block where the defect was noticed. This is the whole-script
  // sweep. Every one of the 76 checks was classified; the verdicts:
  //
  // ---- SUBSTRATE-FLIP RE-AUDIT (session replay is now ON BY DEFAULT) ---------------------------
  // Groups (A) and (B) were both re-audited against the new reality, and BOTH were found resting on
  // "what was sent", not "what was accepted" — the flip did not create that hole but made it much
  // likelier to bite, since every bundle now carries a `replay.bin` (~8 KB gzipped even on this tiny
  // page). Two concrete verdicts, both fixed in this pass:
  //   * (A): no `-wire` row asserts on `bundle.files` — every one of them matches PARSED CONTENT of a
  //     specific file (logs.json entries, network entries, breadcrumbs, userTraces/userEvents,
  //     request.json labels/summary, manifest attrs). So a new `replay.bin` in the file list cannot
  //     satisfy any of them, and none of the 22 rows started passing for a new reason. What they DID
  //     rest on was an unchecked upload status; `waitForBundle` now filters to accepted uploads.
  //   * (B): `bugseeCalls[].ok` was computed and read by NOTHING — see `isAcceptedIssueCall`. Fixed.
  //   * Replay itself is no longer unasserted: the three new `s11-*` rows below, plus the new
  //     `wire-uploads-accepted` aggregate row. 76 -> 80.
  // Two absence-shaped rows stay vacuous if their bundle never arrives (`s8-veto-network-wire` and
  // `s6-console-trace-wire` both read `mutateBundle`, so an undefined bundle makes them green while
  // their neighbours go red). Left as-is deliberately, and recorded here rather than silently: they
  // are only reachable when the rows sharing `mutateBundle` are red, so the sweep as a whole can
  // never report success on their strength alone.
  // ---------------------------------------------------------------------------------------------
  //
  //  (A) 22 `-wire` rows + `s12-crash-and-reload` read the tee'd copy of the REAL uploaded bundle
  //      (src/bugsee-transport.ts). Immune by construction — nothing in the page can fabricate them.
  //  (B) 13 rows assert on staging HTTP traffic Playwright itself observed (`bugseeCalls`):
  //      s2-attr-before-after, s4-error/string/object/null/cause/options/dedupe, s5-uncaught,
  //      s5-rejection, s8-report-mutate, s8-report-veto — plus s4-storm, whose refused/delivered split
  //      is measured from the 200 promises actually settling (scenarios.ts). Immune.
  //  (C) 9 rows assert content the LOCAL API produced and the app only relayed: s7-get / s7-4xx /
  //      s7-5xx / s7-xhr (real `res.status`/`xhr.status`), s7-post-json (the server's `{"received":…}`
  //      echo, not the request body), s7-no-content-type (the R5-3 fix), s7-large-body (the real
  //      `body.big.length`), s7-sse (`received ${n}` counted from real events), s7-ws (the presence
  //      server's own `{"type":"welcome","message":"connected to presence channel"}` frame,
  //      server/api-server.mjs:134). Immune.
  //  (D) 20 rows match an INTERPOLATED value inside a status template, never the template's fixed
  //      words — the distinction round 3 drew for `s9-set-route-name`. Re-verified one by one against
  //      src/scenarios.ts: s1-flush (:238 `flush -> ${ok}`), s1-duplicate-launch (:242),
  //      s1-relaunch-minimal (:246), s1-relaunch-full (:251), s1-stop (:259-262),
  //      s2-set-user (:273), s2-clear-user (:277), s2-attributes (:285, `JSON.stringify` of the real
  //      attribute map), s2-clear-attributes (:289), s2-get-clear-attribute (:297-300),
  //      s3-log (:340), s3-event (:347), s3-trace (:353), s3-breadcrumb (:365), s6-circular (:487),
  //      s7-connfail (:518 — the `caught:` line exists ONLY in the catch branch),
  //      s9-manual-transaction (:622, `finishedChildren` counted from spans the SDK really created and
  //      finished), s9-set-route-name (:631), s9-sample-rate-0 (:640), s9-sample-rate-1 (:645).
  //  (E) 4 rows assert a filter-log line that installFilters (scenarios.ts:33-90) writes only under a
  //      real condition, with real values: s8-network-filter (`droppedSecretHeader`/`redactedSsn`
  //      computed from the intercepted event), s8-veto-network (`network: VETOED` gated on the url),
  //      s8-log-filter (gated on the message containing SECRET_TOKEN), s8-breadcrumb-filter (gated on
  //      `'secret' in crumb.data`). Their stronger claims are separately carried by the `-wire` rows.
  //  (F) 1 row asserts an app literal that is CONDITIONAL, i.e. real evidence: app-loads matches
  //      'Welcome to Markdown Notes', which occurs exactly once in src/ (storage.ts:18, the seed
  //      note's title) and reaches the DOM only through renderList.
  //  (G) 3 rows WERE in the class and are fixed below: app-suggest-prompt and app-backup (each named
  //      by the round-6 review), plus app-delete-note, whose "removed from the list" half had no
  //      assertion at all. app-new-note's `>= 3` threshold was tightened to a delta in the same pass.
  //
  // Nothing outside the app-smoke block was found still in the class. Scope note: this audit is about
  // WHERE the asserted value comes from. It is not a re-run of the positional-selection audit (see the
  // S7 wire block) or of the "go-red-on-fix" signposting for s6-console-trace-wire.
  // ===============================================================================================
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  record('app-loads', 'Notes app loads with a seeded note', (await page.textContent('body'))?.includes('Welcome to Markdown Notes') ?? false);

  // ---- app smoke: real CRUD -----------------------------------------------------------------
  // FIX ROUND 6 (R6-4) — the R5-3/R4-2 defect class ("the row claims X, the check asserts a literal
  // the APP itself hard-codes") had been swept out of the S6/S7/S8/S9 blocks but never applied to
  // this app-smoke block. Every row below now asserts a value the APP cannot have invented: a DOM
  // delta it had to actually produce, or a string that came from the local API over the wire.
  const noteCount = () => page.locator('[data-testid="note-item"]').count();
  const notesBeforeNew = await noteCount();
  await click(page, 'note-new');
  const notesAfterNew = await noteCount();
  // Was `count >= 3` against a 2-note seed (src/storage.ts's `seed()`): that reads as "there are at
  // least 3 notes", which a changed seed satisfies with no note ever created. Assert the DELTA.
  record(
    'app-new-note',
    `New note appears in the list (sidebar went ${notesBeforeNew} -> ${notesAfterNew})`,
    notesAfterNew === notesBeforeNew + 1,
  );

  // Hoisted to constants because S11 (below) asserts that these exact TYPED-IN input values never
  // appear in the uploaded replay stream — if the literal here and the needle there ever drifted
  // apart, that masking assertion would silently become a search for a string nobody typed.
  const TYPED_TITLE = 'Verify run note';
  const TYPED_BODY = '# Hello\n\nSome **markdown**.';
  await page.fill('[data-testid="note-title"]', TYPED_TITLE);
  await page.fill('[data-testid="note-body"]', TYPED_BODY);
  await page.waitForTimeout(500);
  const previewHtml = await page.innerHTML('[data-testid="note-preview"]');
  record('app-markdown-preview', 'Markdown renders live in the preview pane', previewHtml.includes('<strong>markdown</strong>'));

  // Was `.includes('>')` on the note body. The `> ` prefix is a hard-coded template literal in the
  // app itself (`\n\n> ${data.prompt}`, src/notes-app.ts:180), so the row stayed GREEN on a `{}`
  // response — the body would read `> undefined` — while scenarios.md's Expected claimed the control
  // "fetches from the local API". Capture the REAL /api/prompt response off the wire and require the
  // body to end with exactly that server-chosen prompt, so a missing/empty/malformed response is red.
  // FALSIFIABILITY MEASURED, not argued (isolated probe, `page.route` fulfilling GET /api/prompt with
  // `{}` in the page's own realm): the body tail really did read `"markdown**.\n\n> undefined"`, the
  // OLD `.includes('>')` form stayed GREEN on it, and this new form went RED. Same probe below.
  const promptResponsePromise = page.waitForResponse(
    (r) => r.url().includes('/api/prompt') && r.request().method() === 'GET',
    { timeout: 10_000 },
  );
  await click(page, 'note-suggest-prompt');
  let servedPrompt = '';
  try {
    const promptJson = await (await promptResponsePromise).json();
    if (typeof promptJson?.prompt === 'string') servedPrompt = promptJson.prompt;
  } catch {
    servedPrompt = '';
  }
  await page.waitForTimeout(300); // the append happens in the fetch's own .then, after the response
  const bodyAfterPrompt = await page.inputValue('[data-testid="note-body"]');
  record(
    'app-suggest-prompt',
    `Suggest-a-prompt appended the LOCAL API's own prompt to the body (server sent ${JSON.stringify(servedPrompt.slice(0, 24))}…)`,
    servedPrompt.length > 0 && bodyAfterPrompt.endsWith(`\n\n> ${servedPrompt}`),
  );

  // Was `/backed up/` — also a hard-coded literal (src/notes-app.ts:201). The number in that string is
  // the SERVER's echo of the posted note count (server/api-server.mjs:63-67), which scenarios.md's
  // Expected explicitly claims ("local API echoes a count") and nothing asserted: a `{ok:true}` reply
  // with no `count` renders "backed up undefined notes" and passed. Require the echoed count to be a
  // real number AND to equal the number of notes actually in the store at POST time. MEASURED in the
  // same probe (POST /api/backup fulfilled with `{"ok":true}`): the indicator really did render
  // `"backed up undefined notes"`, the OLD `/backed up/` form stayed GREEN, this form went RED.
  const notesAtBackup = await noteCount();
  await click(page, 'note-backup', { wait: 600 });
  const saveIndicatorText = await page.textContent('[data-testid="save-indicator"]');
  const backupEcho = /backed up (\d+) notes/.exec(saveIndicatorText ?? '');
  record(
    'app-backup',
    `Backup POST round-trips: the local API's echoed count matches the ${notesAtBackup} notes posted (indicator: ${JSON.stringify(saveIndicatorText)})`,
    backupEcho !== null && Number(backupEcho[1]) === notesAtBackup,
  );

  // `Select a note` IS app-hard-coded, but it renders ONLY in renderEditor's empty branch, so it is
  // conditional evidence rather than an unconditional literal. The half that was unasserted is
  // scenarios.md's "removed from the list" — assert that delta too. Both new delta legs (here and
  // `app-new-note`) were probed for responsiveness by skipping the very click each row names: with
  // `note-new` never clicked the sidebar stayed 2 -> 2 and that leg went red; with `note-delete` never
  // clicked it stayed 2 -> 2 with no empty state and this leg went red. NB honesty note: unlike
  // app-suggest-prompt/app-backup these two were not GREEN-on-broken before — `>= 3` happened to fail
  // on the current 2-note seed, and the empty-state literal is conditional. They are a claim-coverage
  // tightening (the "appears in"/"removed from the list" halves had no assertion at all), not repairs.
  await click(page, 'note-delete');
  const notesAfterDelete = await noteCount();
  record(
    'app-delete-note',
    `Delete removes the note (sidebar went ${notesAtBackup} -> ${notesAfterDelete}) and the editor shows its empty state`,
    notesAfterDelete === notesAtBackup - 1 && ((await page.textContent('body'))?.includes('Select a note') ?? false),
  );

  // ---- navigate to Scenario panel ------------------------------------------------------------
  await page.goto(`${BASE}/#/scenarios`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="s1-flush"]');

  // ===============================================================================================
  // S11 — SESSION REPLAY. New in this pass; it was declared "N/A by design" while replay was opt-in
  // and this sample did not opt in. Replay is now ON BY DEFAULT (`packages/browser/src/launch.ts`:
  // `options.replay !== false && domDocument !== undefined`), so this sample records a session and
  // ships `replay.bin` in EVERY bundle whether or not it wants to. "N/A" would now mean "the sample
  // uploads a session recording of a real user's page on every report and asserts nothing about it".
  //
  // WHY IT RUNS HERE and not with the other wire rows: replay is per-CLIENT, and S1/S9 relaunch the
  // client several times. A replay stream read after those relaunches contains only post-relaunch
  // events, which would make the masking leg below vacuous — the typed values could not appear even
  // if masking were completely broken. Running before the first relaunch keeps the app-smoke block's
  // real typing inside the live recording window, so "absent" means "masked", not "never recorded".
  // The goto to `#/scenarios` above is a FRAGMENT navigation (same document), so the recorder is not
  // reset by it — proven by the positive control in `s11-replay-masking`.
  //
  // No rrweb decoder is involved anywhere: `replay.bin` is `gzipSync(strToU8(JSON.stringify(payloads)))`
  // (`packages/replay/src/encoder.ts:14-16`), so the tee's `getReplayDigest` (src/bugsee-transport.ts)
  // recovers the event array with `@bugsee/util`'s `gunzipSync` + `JSON.parse`.
  // ===============================================================================================
  await click(page, 's4-error', { wait: 400 });
  const replayBundle = await waitForBundle(
    (b) => b.bundle?.request?.summary?.startsWith?.('S4: logException(new Error') === true,
    { timeout: 15_000 },
  );
  record(
    's11-replay-file',
    'session replay is ON BY DEFAULT: the UPLOADED bundle carries replay.bin without the sample asking for it',
    replayBundle?.bundle?.files?.includes('replay.bin') === true,
  );
  // MEASURED off a real uploaded bundle before being asserted (isolated probe, same page flow):
  // gzippedBytes 8108, decodedBytes 73884, eventCount 28, types [2,3,4], allTimestamped true.
  // The thresholds below sit far under those numbers so they pin "a real stream" without pinning this
  // machine's exact DOM. Types are rrweb's own EventType enum, passed through untouched by the SDK:
  // 4 = Meta, 2 = FullSnapshot, 3 = IncrementalSnapshot. Requiring all three is what separates a
  // playable recording from a file that merely exists: a Meta-only stream has no DOM, and a
  // FullSnapshot with no incrementals is a screenshot, not a session.
  const replayDigest = replayBundle
    ? await page.evaluate(
        ([seq, needles]) => window.__bugseeTee?.getReplayDigest(seq, needles) ?? null,
        [replayBundle.seq, [TYPED_TITLE, TYPED_BODY, 'note-title']],
      )
    : null;
  record(
    's11-replay-stream',
    `replay.bin decodes (gunzip + JSON.parse, no rrweb needed) to a playable rrweb stream ` +
      `(${replayDigest?.eventCount ?? 0} events, types [${replayDigest?.types ?? ''}], ` +
      `${replayDigest?.gzippedBytes ?? 0} B gzipped -> ${replayDigest?.decodedBytes ?? 0} B JSON)`,
    replayDigest !== null &&
      replayDigest.eventCount >= 5 &&
      replayDigest.decodedBytes > 5000 &&
      replayDigest.allTimestamped &&
      replayDigest.types.includes(4) &&
      replayDigest.types.includes(2) &&
      replayDigest.types.includes(3),
  );
  // The privacy claim, with its own positive control. `maskAllText` / `maskAllInputs` default TRUE and
  // are fail-closed (`ReplayLaunchOptions`, packages/browser/src/index.d.ts), so NEITHER typed value
  // may appear anywhere in the decoded JSON — and the search is over the raw JSON text, so a leak into
  // an attribute or a text node is caught, not just one into the field a structural walk would visit.
  // `note-title` is the positive control and is what makes the two absences mean something: it is the
  // `data-testid` of the very input `TYPED_TITLE` was typed into, so its PRESENCE proves the stream
  // really contains that part of the DOM. Without it, an empty or reset recording would satisfy the
  // two "not found" legs perfectly. NB this also exercises the typed-DURING-recording path (the note
  // was later deleted, so the values survive only as incremental input events), which is the path a
  // peer sample found `.bugsee-unmask` cannot re-open — it fails CLOSED, which is what is asserted.
  record(
    's11-replay-masking',
    'fail-closed masking: neither typed input value appears anywhere in the decoded stream, though the DOM around them was recorded',
    replayDigest !== null &&
      replayDigest.found[TYPED_TITLE] === false &&
      replayDigest.found[TYPED_BODY] === false &&
      replayDigest.found['note-title'] === true,
  );
  // Drain S11's own report before the S2 block starts counting issue calls between checkpoints —
  // without this its straggler would be inside s2-attr-before-after's `min: 2` slice.
  await waitForQuiet();

  // S1
  await click(page, 's1-flush', { wait: 1000 });
  record('s1-flush', 'flush(5000) resolves', /flush -> true/.test(await statusText(page, 's1-flush')));

  await click(page, 's1-duplicate-launch');
  record('s1-duplicate-launch', 'second launch() ignored, same instance', /same instance returned: true/.test(await statusText(page, 's1-duplicate-launch')));

  // Match `isLaunched: true`, NOT the bare word "relaunched": that word is a hard-coded literal in the
  // handler's status template, so it prints whenever `relaunch()` merely RESOLVES — even if the client
  // it built were not actually launched. `isLaunched: …` is interpolated from the real
  // `getClient()?.isLaunched()` (src/scenarios.ts), so this check can now actually go red. Same
  // literal-in-the-template hazard as `s9-set-route-name` below (fix round 3).
  await click(page, 's1-relaunch-minimal', { wait: 800 });
  record('s1-relaunch-minimal', 'relaunch with minimal options', /isLaunched: true/.test(await statusText(page, 's1-relaunch-minimal')));

  await click(page, 's1-relaunch-full', { wait: 800 });
  record('s1-relaunch-full', 'relaunch with every option set', /isLaunched: true/.test(await statusText(page, 's1-relaunch-full')));

  await click(page, 's1-stop', { wait: 1000 });
  const stopStatus = await statusText(page, 's1-stop');
  record(
    's1-stop',
    'stop(timeout) called directly (not just indirectly inside relaunch)',
    /isLaunched\(\) after stop -> false/.test(stopStatus ?? ''),
  );

  // S2
  await click(page, 's2-set-user');
  record('s2-set-user', 'setUserIdentifier', (await statusText(page, 's2-set-user'))?.includes('scenario-panel-user') ?? false);
  await click(page, 's2-attributes');
  const attrText = await statusText(page, 's2-attributes');
  record('s2-attributes', 'every AttributeValue type set', /str_attr/.test(attrText) && /gamma/.test(attrText));
  await click(page, 's2-get-clear-attribute');
  const getClearStatus = await statusText(page, 's2-get-clear-attribute');
  record(
    's2-get-clear-attribute',
    'getAttribute reflects a set value; clearAttribute removes just that one',
    /before clearAttribute: "present"/.test(getClearStatus ?? '') && /after: undefined/.test(getClearStatus ?? ''),
  );
  await click(page, 's2-clear-attributes');
  record('s2-clear-attributes', 'clearAllAttributes empties the set', (await statusText(page, 's2-clear-attributes')) === '{}');
  await click(page, 's2-clear-user');
  record('s2-clear-user', 'clearUserIdentifier', (await statusText(page, 's2-clear-user'))?.includes('null') ?? false);
  await click(page, 's2-attr-before-after', { wait: 800 });
  // The two logException() calls here are CHAINED (the 2nd fires only once the 1st's promise
  // resolves, which is only after its full assemble+upload round trip) — give it real headroom.
  calls = await waitForCalls(isAcceptedIssueCall, { timeout: 10_000, min: 2 });
  record(
    's2-attr-before-after',
    'attribute set before AND after the triggering event -> 2 separate ACCEPTED issue calls',
    calls.filter(isAcceptedIssueCall).length >= 2,
  );
  // The call COUNT above says nothing about the claim scenarios.md actually makes for this row — that
  // each report carries only the attributes that existed at ITS trigger time. Assert that on the real
  // uploaded bundles: the attribute snapshot lives in manifest.json's REPORT-LEVEL `attrs` —
  // `ManifestJson.attrs` (packages/protocol/src/wire.ts:150,154), written by
  // packages/core/src/bundle-assembler.ts:188-196, NOT the per-FILE `ManifestFileEntry.attrs`
  // (wire.ts:142,146) that the earlier `wire.ts:141` citation named (fix round 6, R6-3). The tee
  // reads the report-level one (src/bugsee-transport.ts's `manifest.attrs`). Report 1 must carry ONLY
  // `before_report_attr`; report 2 must carry BOTH.
  //
  // FIXED IN ROUND 5 (R5-2) — the "only" leg was UNFALSIFIABLE as originally written, and its stated
  // rationale ("a regression that snapshotted attributes at ASSEMBLY time would put
  // `after_report_attr` on report 1 too, and this goes red") was simply wrong. `after_report_attr`
  // used to be set inside report 1's own `.then`, and that promise resolves only after report 1's FULL
  // assemble+upload round trip (packages/core/src/client.ts:481-517, `track(triggerPipeline.report(…))`
  // — see the chained-call note above). So the attribute did not exist at ANY point in report 1's
  // lifecycle: submit-time, assembly-time and upload-time snapshotting are indistinguishable here and
  // the leg could not go red under any of them. The other three legs were, and remain, falsifiable.
  // The discriminating form (src/scenarios.ts:310, edited line-neutrally so no issue fingerprint
  // moved): set `after_report_attr` SYNCHRONOUSLY, immediately after firing report 1 and before it
  // settles. `logException` calls `submitReport` synchronously (client.ts:674), and `submitReport`
  // snapshots identity synchronously in that same turn (`const identity = liveIdentity()`,
  // client.ts:492) — so under submit-time snapshotting report 1 still carries only
  // `before_report_attr`, while an assembly-time or upload-time regression now WOULD pick the second
  // attribute up and this leg goes red. MEASURED (isolated probe, timing the tee and reading every
  // manifest): report 1's bundle is assembled and uploaded +3084 ms AFTER the click that set
  // `after_report_attr` synchronously, and its attrs are {build, sample, before_report_attr}; report
  // 2's (+3917 ms) and every later report's are {build, sample, before_report_attr,
  // after_report_attr}. The key is therefore live in the client's store for the whole window in which
  // report 1 is assembled and sent — so its absence here is about snapshot TIME, not about the
  // attribute never existing, which is what made the old form vacuous.
  const beforeOnlyBundle = await waitForBundle(
    (b) => typeof b.bundle?.request?.summary === 'string' && b.bundle.request.summary.startsWith('S2: attribute set BEFORE'),
    { timeout: 12_000 },
  );
  const bothAttrsBundle = await waitForBundle(
    (b) => typeof b.bundle?.request?.summary === 'string' && b.bundle.request.summary.startsWith('S2: attribute set AFTER'),
    { timeout: 12_000 },
  );
  record(
    's2-attr-before-after-wire',
    "each report's UPLOADED manifest.json carries only the attributes that existed at ITS trigger time",
    beforeOnlyBundle?.bundle?.attrs?.before_report_attr === 'set-before' &&
      beforeOnlyBundle?.bundle?.attrs?.after_report_attr === undefined &&
      bothAttrsBundle?.bundle?.attrs?.before_report_attr === 'set-before' &&
      bothAttrsBundle?.bundle?.attrs?.after_report_attr === 'set-after',
  );

  // S3
  // These 4 checks assert on EVIDENCE (the client was actually present when each call fired — see
  // scenarios.ts), not on the literal `true` this script used before. A `record(..., true)` here would
  // pass even if getClient() had silently returned undefined and every call below had been a no-op —
  // exactly the pattern samples/react-spa/FINDINGS.md's F-9-adjacent note warns hid a real defect once.
  // Backend depth is separately blocked for S3 by the known `# Logs` MCP-surface gap — see
  // scenarios.md's S3 section and samples/FINDINGS.md.
  await click(page, 's3-log');
  record('s3-log', 'log() at 5 levels (client present when called)', /client present: true/.test(await statusText(page, 's3-log')));
  await click(page, 's3-event');
  record('s3-event', 'event() with/without params (client present when called)', /client present: true/.test(await statusText(page, 's3-event')));
  await click(page, 's3-trace');
  record('s3-trace', 'trace(name, value) (client present when called)', /client present: true/.test(await statusText(page, 's3-trace')));
  await click(page, 's3-breadcrumb');
  record('s3-breadcrumb', 'addBreadcrumb() every field (client present when called)', /client present: true/.test(await statusText(page, 's3-breadcrumb')));

  // S4
  await click(page, 's4-error', { wait: 400 });
  calls = await waitForCalls(isAcceptedIssueCall);
  record('s4-error', 'logException(new Error) -> issue call ACCEPTED by staging', calls.some(isAcceptedIssueCall));

  await click(page, 's4-string', { wait: 400 });
  calls = await waitForCalls(isAcceptedIssueCall);
  record('s4-string', 'logException(string) -> issue call ACCEPTED by staging', calls.some(isAcceptedIssueCall));

  await click(page, 's4-object', { wait: 400 });
  calls = await waitForCalls(isAcceptedIssueCall);
  record('s4-object', 'logException(object) -> issue call ACCEPTED by staging', calls.some(isAcceptedIssueCall));

  await click(page, 's4-null', { wait: 400 });
  calls = await waitForCalls(isAcceptedIssueCall);
  record('s4-null', 'logException(null) -> issue call ACCEPTED by staging', calls.some(isAcceptedIssueCall));

  await click(page, 's4-cause', { wait: 400 });
  calls = await waitForCalls(isAcceptedIssueCall);
  record('s4-cause', 'nested cause -> issue call ACCEPTED by staging', calls.some(isAcceptedIssueCall));

  await click(page, 's4-options', { wait: 400 });
  calls = await waitForCalls(isAcceptedIssueCall);
  record('s4-options', 'LogExceptionOptions -> issue call ACCEPTED by staging', calls.some(isAcceptedIssueCall));

  await click(page, 's4-dedupe', { wait: 600 });
  calls = await waitForCalls(isAcceptedIssueCall, { timeout: 5000 });
  const dedupeCount = calls.filter(isAcceptedIssueCall).length;
  // === 1, not >= 1: a broken dedupe (both calls create an issue) would still pass a `>= 1` check.
  record('s4-dedupe', `same instance twice -> ${dedupeCount} issue call(s) (dedupe expected: exactly 1)`, dedupeCount === 1);

  // s4-storm is run LAST (see the end of this script, right before closing the browser). CORRECTED
  // understanding (was wrong here and in FINDINGS.md until this fix pass — packages/core/src/
  // rate-limiter.ts:3-10,40 is a HARD CAP, not a pacing scheme): the storm relaunches the client, then
  // fires 200 logException() calls against a fresh 100-per-60s window. Exactly 100 are REFUSED
  // synchronously (client.ts:640 resolves them {ok:false} immediately) and the other 100 are ADMITTED
  // and drain slowly through the bounded-concurrency upload queue (durable-upload-pipeline.ts:200-203)
  // — which is what still makes it important to run this last: the 100 admitted uploads keep leaving
  // the process in the background for a long time afterward, which would contaminate a LATER
  // before/after network-call-count assertion in this sweep (observed: s8-report-veto's "no new issue
  // call" check false-FAILed on stragglers from an earlier storm run — reproduced, isolated, and fixed
  // by reordering). See FINDINGS.md.

  // S5
  await click(page, 's5-uncaught', { wait: 600 });
  calls = await waitForCalls(isAcceptedIssueCall);
  record('s5-uncaught', 'uncaught exception -> issue call ACCEPTED by staging', calls.some(isAcceptedIssueCall));
  // Responsiveness, not "an error occurred" (the OLD `pageErrors.length >= 1` check was INVERTED — it
  // asserts the throw happened at all, which is true whether or not the app then survived it; a dead
  // page would satisfy it identically). Prove the page is still interactive by round-tripping a real
  // click and reading its freshly-updated result.
  await click(page, 's1-duplicate-launch', { wait: 200 });
  const stillResponsive = /same instance returned: true/.test((await statusText(page, 's1-duplicate-launch')) ?? '');
  record('s5-uncaught-app-alive', 'app survives the uncaught throw (page still responsive to a real click)', stillResponsive);

  await click(page, 's5-rejection', { wait: 600 });
  calls = await waitForCalls(isAcceptedIssueCall);
  record('s5-rejection', 'unhandled rejection -> issue call ACCEPTED by staging', calls.some(isAcceptedIssueCall));

  // S6
  const consoleMsgs = [];
  page.on('console', (m) => consoleMsgs.push(m.text()));
  await click(page, 's6-console');
  record('s6-console', 'console.* still prints for real (interceptor is additive)', consoleMsgs.some((m) => m.includes('S6:')));
  await click(page, 's6-circular');
  record('s6-circular', 'console.log(circular) does not throw', /threw: false/.test(await statusText(page, 's6-circular')));

  // S7
  await click(page, 's7-get');
  record('s7-get', 'fetch GET reads the real response', (await statusText(page, 's7-get'))?.includes('200') ?? false);
  await click(page, 's7-post-json');
  record('s7-post-json', 'fetch POST JSON round-trips the body unaltered', (await statusText(page, 's7-post-json'))?.includes('"hello":"world"') ?? false);
  // NB (fix round 4, R4-2): these three rows read ONLY the panel's own status line, which the app's own
  // `fetch`/`XMLHttpRequest` produced — they are LOCAL evidence that the app saw the real status, and
  // say nothing about capture (every one of them stays green with `captureNetwork: false`). Their
  // descriptions no longer claim "captured"; the capture claim is carried by the `-wire` rows added
  // below, which read the real uploaded network.json.
  await click(page, 's7-4xx');
  record('s7-4xx', '4xx: the app itself reads the real 404 (capture asserted by s7-4xx-wire)', (await statusText(page, 's7-4xx'))?.includes('404') ?? false);
  await click(page, 's7-5xx');
  record('s7-5xx', '5xx: the app itself reads the real 500 (capture asserted by s7-5xx-wire)', (await statusText(page, 's7-5xx'))?.includes('500') ?? false);
  await click(page, 's7-connfail', { wait: 1000 });
  record('s7-connfail', 'connection failure caught, no crash', (await statusText(page, 's7-connfail'))?.includes('caught') ?? false);
  await click(page, 's7-large-body');
  record('s7-large-body', 'large body read in full client-side (65536 chars)', (await statusText(page, 's7-large-body'))?.includes('65536') ?? false);
  await click(page, 's7-no-content-type');
  // Match on the RESPONSE BODY, not on `no Content-Type` (fix round 5, R5-3): that phrase is a
  // hard-coded literal inside the handler's own status template (`GET (no Content-Type) -> "…"`,
  // src/scenarios.ts), so it printed whether or not the body was ever read — an empty body passed.
  // `{"ok":true` is server-produced and survives the template's 40-char slice, so this row can now
  // actually support scenarios.md's L claim ("the app reads the body") rather than only "the handler
  // ran without throwing". Same literal-in-the-template hazard as `s9-set-route-name` (fix round 3).
  record('s7-no-content-type', 'response with no Content-Type still read (asserts the real body, not the template literal)', (await statusText(page, 's7-no-content-type'))?.includes('{"ok":true') ?? false);
  await click(page, 's7-xhr');
  record('s7-xhr', 'XHR: the app itself reads a real 200 (capture on the XHR code path asserted by s7-xhr-wire)', (await statusText(page, 's7-xhr'))?.includes('200') ?? false);
  await click(page, 's7-sse', { wait: 1500 });
  record('s7-sse', 'SSE received 5 events', (await statusText(page, 's7-sse'))?.includes('5 SSE') ?? false);
  await click(page, 's7-ws', { wait: 500 });
  const wsStatus = await statusText(page, 's7-ws');
  // Strengthened from "status line is non-empty" (which any stray text would satisfy) to the actual
  // expected protocol content: server/api-server.mjs's presence handler sends a "welcome" message on
  // connect (this client's own `scenario-ping` is only ever broadcast to OTHER connected clients, so
  // the one message this client receives back really is that welcome frame).
  record(
    's7-ws',
    'WebSocket connected + real "welcome" message received from the presence server',
    /"type":"welcome"/.test(wsStatus ?? '') && /connected to presence channel/.test(wsStatus ?? ''),
  );

  // S8
  await click(page, 's8-install');
  await click(page, 's8-network', { wait: 400 });
  const filterLog1 = await page.textContent('[data-testid="s8-filter-log"]');
  record('s8-network-filter', 'network filter fired (secret header dropped, SSN redacted)', /droppedSecretHeader=true/.test(filterLog1) && /redactedSsn=true/.test(filterLog1));
  // NB (fix round 3): `s8-filter-log` is a ROLLING list — every check below reads the WHOLE element,
  // which still holds the lines written by the earlier clicks in this same block. So each pattern must
  // be specific to the line its own control produces, or an earlier control's line satisfies it. This
  // was a real defect for `s8-log-filter`: it matched a bare /redacted/, which the NETWORK filter's
  // `redactedSsn=…` line (written by `s8-network` two clicks earlier) already satisfies — proven by
  // probe, the check passed with the log filter never firing. Each pattern is now anchored on its own
  // control's line prefix (`network:` / `log:` / `breadcrumb:`, see installFilters in src/scenarios.ts).
  await click(page, 's8-veto-network', { wait: 400 });
  const filterLog2 = await page.textContent('[data-testid="s8-filter-log"]');
  record('s8-veto-network', 'network veto fired', /network: VETOED/.test(filterLog2));
  await click(page, 's8-log');
  const filterLog3 = await page.textContent('[data-testid="s8-filter-log"]');
  record('s8-log-filter', 'log filter redacted SECRET_TOKEN', /log: redacted/.test(filterLog3));
  await click(page, 's8-breadcrumb');
  const filterLog4 = await page.textContent('[data-testid="s8-filter-log"]');
  record('s8-breadcrumb-filter', 'breadcrumb filter redacted data.secret', /breadcrumb: redacted data\.secret/.test(filterLog4));
  await click(page, 's8-report-mutate', { wait: 400 });
  calls = await waitForCalls(isAcceptedIssueCall);
  record('s8-report-mutate', 'report handler mutate -> issue still created (and ACCEPTED)', calls.some(isAcceptedIssueCall));

  // ---- Bundle-level (wire) assertions — PLAN §6.6, item 3 of this fix pass. The checks above only
  // prove the scenario panel's OWN filter callback ran and logged what it saw; they say nothing about
  // whether the SDK actually applied the filter's RETURN VALUE to what got uploaded. A mutation that
  // discarded every filter's return value would leave all four checks above green. These checks
  // inspect the tee'd copy of the REAL uploaded bundle instead.
  //
  // CORRECTION (fix round 4, R4-1): that claim was true of the report/log/breadcrumb/veto rows but NOT
  // of `s8-network-filter-wire` as first written — it selected the wrong entry AND made an assertion
  // the SDK guarantees on its own. Both were measured, both are fixed below; the details (and the
  // no-filters probe that proves the new form goes red) are in that check's own comment.
  const mutateBundle = await waitForBundle(
    (b) => b.bundle?.request?.summary === 'S8: report handler should mutate this',
  );
  const mutateLabels = mutateBundle?.bundle?.request?.labels;
  record(
    's8-report-mutate-wire',
    'report handler mutate -> the UPLOADED bundle request.json carries the added label',
    Array.isArray(mutateLabels) && mutateLabels.includes('MUTATE_ME') && mutateLabels.includes('redacted-before'),
  );
  // FIXED IN ROUND 4 (R4-1) — this check was broken in BOTH legs, and three earlier rounds of hunting
  // unfalsifiable checks missed it:
  //  (1) WRONG ENTRY. `find((n) => n.url?.includes('/api/scenario/echo'))` returns the FIRST match, and
  //      `s7-post-json` (src/scenarios.ts) POSTs to that very URL EARLIER in this same sweep. Measured:
  //      the entry it read was s7's — `{type:'before', headerKeys:['Content-Type','traceparent',
  //      'tracestate'], body:'{"hello":"world","n":42}'}` — which never carried `x-secret-token` or an
  //      SSN at all. S8's real entry sat further down the array, unread. Proven non-falsifiable by an
  //      isolated probe run with `s8-install` NEVER clicked (no filter installed): every other -wire
  //      check in this block went red and THIS one stayed green, while S8's real entry still carried
  //      `x-secret-token`.
  //  (2) UNFALSIFIABLE ASSERTION even on the right entry. `!body.includes('123-45-6789')` cannot fail:
  //      `ssn` is in packages/protocol/src/sensitive.ts's SENSITIVE_KEY_SUBSTRINGS (:62) and
  //      REDACTED = '<redacted>' (:6), so the SDK's OWN default sanitizer already scrubs the digits
  //      with no app filter present. Measured in the same no-filters probe: `{"ssn":"<redacted>"}`.
  // The fix: select S8's OWN entry (the `before` stage of the echo POST whose body carries the `ssn`
  // key — s7's body has no such key, so this is unambiguous in BOTH worlds), and assert values only the
  // APP filter can produce. That discriminator is sound because of the Android XOR rule
  // (packages/capture/src/network-provider.ts:137-139): a user network filter SUPERSEDES the built-in
  // sanitizer, so `[REDACTED]` (the app filter's own token, src/scenarios.ts's installFilters) appears
  // ONLY when the app filter ran, and `<redacted>` ONLY when it did not. The header leg is falsifiable
  // on this entry for the same reason: `x-secret-token` is NOT in SENSITIVE_HEADERS (an EXACT-match
  // list — sensitive.ts:10-38; the earlier `:9-37` citation was off by one at both ends, `:9` being the
  // doc comment and `:38` the closing `]);` — corrected in fix round 5, R5-4), so the SDK never drops it
  // by itself. Both halves were confirmed red in the no-filters probe:
  // headerKeys `['Content-Type','x-secret-token','traceparent','tracestate']`,
  // body `{"ssn":"<redacted>"}`.
  const networkEntry = mutateBundle?.bundle?.network?.find(
    (n) =>
      n.url?.includes('/api/scenario/echo') &&
      n.type === 'before' &&
      typeof n.custom?.body === 'string' &&
      n.custom.body.includes('"ssn"'),
  );
  const networkHeaders = networkEntry?.custom?.headers;
  const networkBody = networkEntry?.custom?.body;
  record(
    's8-network-filter-wire',
    "network filter -> the UPLOADED entry FOR THIS REQUEST lost the secret header and carries the APP filter's own [REDACTED] token",
    networkEntry !== undefined &&
      networkHeaders !== undefined &&
      !('x-secret-token' in networkHeaders) &&
      // the filter must drop ONLY that header, not flatten the set
      'Content-Type' in networkHeaders &&
      networkBody === '{"ssn":"[REDACTED]"}',
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
  );
  const redactedCrumb = mutateBundle?.bundle?.breadcrumbs?.find((c) => c.message === 'has secret data');
  record(
    's8-breadcrumb-filter-wire',
    'breadcrumb filter -> the UPLOADED bundle has data.secret redacted, not the raw value',
    redactedCrumb?.data?.secret === '[REDACTED]',
  );

  // ---- S3 wire assertions (F-C, fix round 2) ----------------------------------------------------
  // scenarios.md previously declared S3 "effectively unverified above Local depth" because of the
  // `# Logs` MCP-surface gap. That gap blocks BACKEND verification (get_issue never renders a `#
  // Logs` section) — it says nothing about WIRE. This same mutateBundle (uploaded well after s3-log
  // /s3-event/s3-trace/s3-breadcrumb fired, earlier in this run) already carries their real output —
  // assert on it directly instead of settling for "client present: true".
  const s3LogMessages = mutateBundle?.bundle?.logMessages ?? [];
  record(
    's3-log-wire',
    'log() x5 levels -> the UPLOADED bundle logs.json carries all 5 messages',
    ['S3: error level', 'S3: warning level', 'S3: info level', 'S3: debug level', 'S3: verbose level'].every(
      (m) => s3LogMessages.includes(m),
    ),
  );
  const s3Crumb = mutateBundle?.bundle?.breadcrumbs?.find((c) => c.message === 'S3: every field set');
  record(
    's3-breadcrumb-wire',
    'addBreadcrumb() every field -> the UPLOADED bundle breadcrumbs file carries it, with its data',
    s3Crumb?.data?.field === 'value' && s3Crumb?.data?.n === 1,
  );
  // Assert on the PARSED contents of traces.user.json / events.user.json, not on the manifest's file
  // list (fix round 3, R3-1). A file-presence check was NOT falsifiable for events.user.json:
  // `captureInteractions: true` (src/bugsee.ts) maps EVERY DOM click to an events.user entry
  // (packages/browser/src/input-source.ts), and this sweep clicks ~50 buttons, so the file is in the
  // bundle whether or not `client.event()` ever ran — proven by probe (with s3-event never clicked,
  // events.user.json was still present). Match the actual names/values the S3 controls sent instead.
  const s3Traces = mutateBundle?.bundle?.userTraces ?? [];
  record(
    's3-trace-wire',
    'trace(name, value) -> the UPLOADED bundle traces.user.json carries the real name AND value',
    s3Traces.some((t) => t.name === 'render_ms' && t.value === 12.5),
  );
  const s3Events = mutateBundle?.bundle?.userEvents ?? [];
  const noParamsEvent = s3Events.find((e) => e.name === 'scenario_panel_opened');
  // `find(name === 'note_created')` was ANOTHER instance of the R4-1 positional-selection defect, found
  // by the round-4 audit: `src/notes-app.ts:109` ALSO emits `note_created`, with `{via:'new-button'}`,
  // and the sweep's app-CRUD smoke clicks `note-new` long before S3 runs — so `find` could return the
  // notes-app event and this check would go red for a reason that has nothing to do with `s3-event`.
  // (It happened to pass only because `s1-stop`/`s1-relaunch-*` reset the capture store in between —
  // an accident of sweep order, not a property of the check.) Match on ALL `note_created` entries and
  // require that one of them carries BOTH of the params `s3-event` sent; the notes-app event carries
  // neither, so it can never satisfy this and can never mask a real failure either.
  const noteCreatedEvents = s3Events.filter((e) => e.name === 'note_created');
  record(
    's3-event-wire',
    'event() with AND without params -> the UPLOADED bundle events.user.json carries both by name, with the params',
    noParamsEvent !== undefined &&
      noParamsEvent.params === undefined &&
      noteCreatedEvents.some((e) => e.params?.via === 'scenario-panel' && e.params?.count === 3),
  );

  // ---- S6 console wire assertions (fix round 5, R5-1) -------------------------------------------
  // scenarios.md's S6 row claimed depth **L/W** for `console.log/info/warn/error/debug/trace` while
  // the ONLY evidence it cited was `s6-console` above — Playwright's OWN console listener. That is
  // purely LOCAL: it proves the interceptor is additive (the app's console still prints) and nothing
  // more; it stays green with console capture off entirely. The lesson worth writing down: fix round
  // 4's R4-2 split exactly this "claims capture, asserts app-side text" defect out of the six S7 rows
  // and left S6 — itself a CAPTURE scenario — untouched. That gap is what hid a real, already-filed
  // SDK defect here for four rounds; the missing check was the only thing that would have surfaced it.
  //
  // The evidence was already sitting in the same `mutateBundle` the S7/S8 wire rows read (S6 runs
  // earlier in this sweep and no relaunch resets the capture store between S6 and s8-report-mutate).
  // MEASURED off a real uploaded logs.json before being asserted:
  //   {level:3, source:'console', message:'S6: console.log {"a":1}'}, {3,'S6: console.info'},
  //   {2,'S6: console.warn'}, {1,'S6: console.error'}, {4,'S6: console.debug'} — and NOTHING at all
  //   for console.trace. `level` is the numeric wire value (packages/protocol/src/levels.ts:7-13 —
  //   1=Error 2=Warning 3=Info 4=Debug 5=Verbose), so asserting it also pins DEFAULT_LEVELS' mapping
  //   (packages/capture/src/console-interceptor.ts:24-30), which a message-only check could not tell
  //   apart from a regression that filed every console call as `info`. `source: 'console'` separates
  //   these from S3's `client.log()` entries.
  const consoleEntries = (mutateBundle?.bundle?.logEntries ?? []).filter((e) => e.source === 'console');
  const consoleEntry = (prefix) =>
    consoleEntries.find((e) => typeof e.message === 'string' && e.message.startsWith(prefix));
  record(
    's6-console-wire',
    'console.log/info/warn/error/debug -> the UPLOADED bundle logs.json carries all five, each at its mapped level',
    // the object argument is stringified INTO the captured message, not dropped
    consoleEntry('S6: console.log')?.message === 'S6: console.log {"a":1}' &&
      consoleEntry('S6: console.log')?.level === 3 &&
      consoleEntry('S6: console.info')?.level === 3 &&
      consoleEntry('S6: console.warn')?.level === 2 &&
      consoleEntry('S6: console.error')?.level === 1 &&
      consoleEntry('S6: console.debug')?.level === 4,
  );
  // The sixth method is the defect. `console.trace` is NEVER captured, on ANY runtime:
  // `DEFAULT_LEVELS` (packages/capture/src/console-interceptor.ts:24-30) has no `trace` key, `:86`
  // (`Object.entries(this.#levels)`) patches only the keys it holds, and packages/browser/src/
  // launch.ts:441 calls `createConsoleInterceptor()` with no override. Already filed by a peer sample
  // — samples/angular-spa/FINDINGS.md:429 (F-7, major) — and recorded in this sample's FINDINGS.md
  // "Recurring" section as an independent reproduction on a different platform path.
  // READ THIS ROW CORRECTLY: it DOCUMENTS the defect, so it goes RED the day the SDK is FIXED — which
  // is exactly when scenarios.md's S6 row and FINDINGS.md need updating. It is not guarding the
  // defect; the five-level row above is the one guarding the feature.
  record(
    's6-console-trace-wire',
    'console.trace is ABSENT from the UPLOADED logs.json — reproduces known SDK defect (peer F-7); this row goes RED when that is fixed',
    consoleEntries.every((e) => !String(e.message).includes('S6: console.trace')),
  );

  // ---- S7 large-body wire assertion (F-E, fix round 2) ------------------------------------------
  // Corrected claim: a body over `maxNetworkBodySize` is DROPPED (no_body_reason: 'size_too_large'),
  // never truncated to 2048 bytes — packages/capture/src/fetch-interceptor.ts's readBoundedBody. This
  // same mutateBundle's network.json DOES carry the /api/scenario/large-body entry (it's part of the
  // upload, contrary to the previous claim that this fetch "never becomes part of" an uploaded
  // bundle) — assert the real captured shape instead of the "unobservable" framing.
  const largeBodyEntries = mutateBundle?.bundle?.network?.filter((n) => n.url?.includes('/api/scenario/large-body')) ?? [];
  // The override entry (the bounded body-read amendment) is what carries `no_body_reason` — the
  // FIRST 'complete' entry (emitted before the body read resolves) does not, so match on
  // `override === true` specifically, not merely `type === 'complete'`.
  const largeBodyComplete = largeBodyEntries.find((n) => n.type === 'complete' && n.override === true);
  record(
    's7-large-body-wire',
    'large body -> the UPLOADED bundle carries the request with no_body_reason=size_too_large and no body field',
    largeBodyComplete !== undefined &&
      largeBodyComplete.custom?.no_body_reason === 'size_too_large' &&
      largeBodyComplete.custom?.body === undefined,
  );

  // ---- S7 capture wire assertions (fix round 4, R4-2) -------------------------------------------
  // Six S7 rows used to CLAIM "captured" while asserting only the panel's own status line, which the
  // app's own fetch/XHR produced — all of them stay green with `captureNetwork: false`. The evidence
  // was already sitting in this same `mutateBundle`; these rows assert it. Every shape below was
  // MEASURED off a real uploaded network.json before being asserted, never inferred.
  //
  // POSITIONAL-SELECTION AUDIT (the R4-1 defect class, swept across this whole script): every
  // `find(...)` over `bundle.network` or another rolling array must be selected by a value UNIQUE to
  // the control it belongs to, never by a predicate an earlier control in the sweep also satisfies.
  // Result of the sweep: `/api/scenario/echo` was the one collision (s7-post-json vs s8-network — the
  // exact same collision a peer sample, angular-spa, grew independently) and is fixed above.
  // `/api/scenario/text` collides THREE ways (s7-get fetch, s7-xhr, s8-veto-network's `?veto-me=1`),
  // so every check touching it below discriminates on `mechanism` and/or the query string. The
  // remaining selectors were each re-checked and are unique by construction: `veto-me` and
  // `/api/scenario/large-body` are hit by exactly one control; `logMessages.find(SECRET_TOKEN)`,
  // `breadcrumbs.find('has secret data')`, `breadcrumbs.find('S3: every field set')`,
  // `userTraces('render_ms')` and `userEvents('scenario_panel_opened')` were each verified against the
  // whole of `src/` to be strings only their own control emits. ONE more real collision turned up:
  // `note_created` is emitted by `src/notes-app.ts:109` too — see the fixed `s3-event-wire` above.
  const net = mutateBundle?.bundle?.network ?? [];
  const fetchEcho = net.filter((n) => n.mechanism === 'fetch' && n.url === '/api/scenario/echo');
  record(
    's7-post-json-wire',
    'fetch POST JSON -> the UPLOADED bundle carries the request body AND the real echoed response body',
    fetchEcho.some((n) => n.type === 'before' && n.custom?.body === '{"hello":"world","n":42}') &&
      fetchEcho.some(
        (n) => n.type === 'complete' && n.override === true && n.custom?.body === '{"received":{"hello":"world","n":42}}',
      ),
  );
  // `override !== true`: the initial completion entry is the one carrying `status` (the override
  // amendment re-emits only the body), so match it specifically rather than any `type: 'complete'`.
  const completionWithStatus = (urlPart, mechanism) =>
    net.find(
      (n) => n.mechanism === mechanism && n.url?.includes(urlPart) && n.type === 'complete' && n.override !== true,
    );
  record(
    's7-4xx-wire',
    '4xx -> the UPLOADED bundle carries the request WITH its 404 status and the error response body',
    completionWithStatus('/api/scenario/4xx', 'fetch')?.status === 404 &&
      net.some(
        (n) => n.url?.includes('/api/scenario/4xx') && n.override === true && n.custom?.body === '{"error":"not_found","message":"S7: deliberate 404"}',
      ),
  );
  record(
    's7-5xx-wire',
    '5xx -> the UPLOADED bundle carries the request WITH its 500 status and the error response body',
    completionWithStatus('/api/scenario/5xx', 'fetch')?.status === 500 &&
      net.some(
        (n) => n.url?.includes('/api/scenario/5xx') && n.override === true && n.custom?.body === '{"error":"internal","message":"S7: deliberate 500"}',
      ),
  );
  // The XHR row's whole point is "a DIFFERENT code path from fetch" — so assert on `mechanism: 'xhr'`
  // (packages/capture/src/xhr-interceptor.ts:216) specifically. s7-get fetches the SAME url, so a
  // url-only selector here would be satisfied by the fetch interceptor's entry and prove nothing.
  const xhrComplete = completionWithStatus('/api/scenario/text', 'xhr');
  record(
    's7-xhr-wire',
    "XHR -> the UPLOADED bundle carries an entry from the XHR interceptor (mechanism 'xhr') with its 200 and response body",
    xhrComplete?.status === 200 &&
      xhrComplete?.custom?.body === 'plain text response for S7 GET/text-body coverage' &&
      net.some((n) => n.mechanism === 'xhr' && n.url?.includes('/api/scenario/text') && n.type === 'before'),
  );
  // `captureNetworkBodyWithoutType: true` is what admits this body: the response really does carry no
  // `content-type` (asserted on the captured response headers), and the body is captured anyway.
  const noTypeOverride = net.find(
    (n) => n.url?.includes('/api/scenario/no-content-type') && n.type === 'complete' && n.override === true,
  );
  record(
    's7-no-content-type-wire',
    'no Content-Type -> the UPLOADED bundle carries the body anyway (captureNetworkBodyWithoutType), on a response whose captured headers really have no content-type',
    noTypeOverride?.custom?.body === '{"ok":true,"note":"no Content-Type header on purpose"}' &&
      noTypeOverride?.custom?.headers !== undefined &&
      !Object.keys(noTypeOverride.custom.headers).some((k) => k.toLowerCase() === 'content-type'),
  );
  const wsEntries = net.filter((n) => n.mechanism === 'ws' && n.url?.includes('/api/presence'));
  record(
    's7-ws-wire',
    'WebSocket -> the UPLOADED bundle carries the real connection lifecycle AND both directions of traffic',
    wsEntries.some((n) => n.type === 'before') &&
      wsEntries.some((n) => n.type === 'open') &&
      wsEntries.some((n) => n.type === 'message' && n.direction === 'out') &&
      wsEntries.some((n) => n.type === 'message' && n.direction === 'in'),
  );
  const sseEntries = net.filter((n) => n.mechanism === 'sse' && n.url?.includes('/api/scenario/sse'));
  record(
    's7-sse-wire',
    'SSE -> the UPLOADED bundle carries open + all 5 inbound events + close from the EventSource interceptor',
    sseEntries.some((n) => n.type === 'open') &&
      sseEntries.filter((n) => n.type === 'message' && n.direction === 'in').length >= 5 &&
      sseEntries.some((n) => n.type === 'close'),
  );

  await waitForQuiet(); // drain the mutate call's own traffic before measuring the veto's before/after delta
  const beforeVetoCalls = bugseeCalls.filter(isIssueCall);
  await click(page, 's8-report-veto', { wait: 1500 });
  await waitForQuiet();
  const afterVetoCalls = bugseeCalls.filter(isIssueCall);
  record('s8-report-veto', 'report handler veto -> NO new issue call', afterVetoCalls.length === beforeVetoCalls.length);
  const vetoedBundle = await waitForBundle(
    (b) => b.bundle?.request?.summary === 'S8: report handler should VETO this',
    { timeout: 1500 },
  );
  record(
    's8-report-veto-wire',
    'report handler veto -> the vetoed report never appears as an UPLOADED bundle either',
    vetoedBundle === undefined,
  );
  await click(page, 's8-uninstall');

  // S9
  await click(page, 's9-manual-transaction');
  record('s9-manual-transaction', 'manual transaction + 6 child spans (every SpanStatus), no throw', (await statusText(page, 's9-manual-transaction'))?.includes('6 child spans') ?? false);
  await click(page, 's9-set-route-name');
  // Match `perf present: true`, NOT `/scenarios/manual`: that route string is a hard-coded literal
  // inside the handler's status template (src/scenarios.ts), and nothing in the handler can throw (every
  // SDK call is optional-chained), so it printed unconditionally — the check could not go red. Fix
  // round 2 added `perf !== undefined` evidence but only as setStatus's THIRD argument, which sets a CSS
  // class; `statusText` reads textContent only, so that evidence was invisible to this check. The
  // interpolated `perf present: …` IS in the text (fix round 3, R3-2).
  record('s9-set-route-name', 'setRouteName (performance extension actually resolved)', /perf present: true/.test((await statusText(page, 's9-set-route-name')) ?? ''));
  await click(page, 's9-sample-rate-0', { wait: 800 });
  record('s9-sample-rate-0', 'relaunch with performanceSampleRate: 0', /isLaunched: true/.test((await statusText(page, 's9-sample-rate-0')) ?? ''));
  await click(page, 's9-sample-rate-1', { wait: 800 });
  record('s9-sample-rate-1', 'relaunch with performanceSampleRate: 1 (restore)', /isLaunched: true/.test((await statusText(page, 's9-sample-rate-1')) ?? ''));

  // S12 — REAL persist+recover (not "wait for the report, then reload", which proves nothing about
  // recovery — see scenarios.ts's comment on this control). Fire-and-forget, reload almost
  // immediately, then confirm the NEXT launch's recovery is what actually delivers the report.
  await click(page, 's12-crash-and-reload', { wait: 1500 }); // covers the 100ms fire delay + the reload itself
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForSelector('[data-testid="s4-storm"]'); // the hash-routed scenario panel remounts after reload
  // window.__bugseeTee is fresh page state, wiped by the reload — so any bundle it now records can only
  // be the recovery-triggered re-upload from the NEW launch, never the original (interrupted) attempt.
  const recoveredBundle = await waitForBundle(
    (b) => b.bundle?.request?.summary === 'S12: persist+recover across a hard reload',
    { timeout: 12_000 },
  );
  record(
    's12-crash-and-reload',
    "persist+recover: the report interrupted by the reload is delivered by the NEXT launch's recovery (not merely a normal report round-trip)",
    recoveredBundle !== undefined,
  );

  // S4 storm — run LAST (see the long comment where this used to sit, above S5): its upload queue
  // takes a long time to drain in the background, so nothing in this script depends on network
  // quiescence after this point. The relaunch inside scenarios.ts's s4-storm handler gives it a clean
  // 100-per-60s window; the control's own status line reports the exact refused/delivered split, and
  // "delivered" is MEASURED there (r.ok === true on each of the 200 tracked promises actually
  // settling), not derived as `200 - refused` — see scenarios.ts's s4-storm handler comment.
  await click(page, 's4-storm', { wait: 300 });
  // Measured drain: 9 delivered at t=10s, 34 at t=30s, 71 at t=60s, 100 at t=90s (a prior run of this
  // exact sweep) — poll for the handler's own `drained: …` status instead of guessing a fixed sleep.
  const stormStatus = await waitForStatus('s4-storm', (t) => t.startsWith('drained:'));
  const stormMatch = /refused=(\d+) delivered=(\d+)/.exec(stormStatus ?? '');
  const stormRefused = stormMatch ? Number(stormMatch[1]) : NaN;
  const stormDelivered = stormMatch ? Number(stormMatch[2]) : NaN;
  record(
    's4-storm',
    `storm of 200 against a freshly-relaunched client -> refused=${stormRefused} delivered=${stormDelivered} ` +
      '(hard cap: 100 admissions per rolling 60s — packages/core/src/rate-limiter.ts — not a pacing scheme; ' +
      'delivered is measured from actual upload completion, not derived arithmetic)',
    stormRefused === 100 && stormDelivered === 100,
  );

  // ---- upload-acceptance sweep (fixed in the substrate-flip re-verification) -------------------
  // The hole this closes: `CapturedCall.status` (the S3 PUT's real response status) and
  // `bugseeCalls[].ok` were both RECORDED and read by nothing, so every "the uploaded bundle carries
  // X" row asserted what the SDK SENT, never what the backend TOOK. `waitForBundle` now filters to
  // accepted uploads, which fixes the individual rows; this row makes the aggregate visible so a
  // systematic rejection shows up as its own red line instead of as unexplained timeouts. It is read
  // AFTER the storm deliberately — the storm's 100 admitted uploads are the largest batch of the run,
  // and they are also the ones most likely to be rejected now that every bundle carries replay.bin.
  // NB the S3 PUT does NOT go to a `bugsee.com` host (it is a presigned URL), so Playwright's own
  // `page.on('response')` listener never sees it at all — the tee is the only place this is knowable.
  const allUploads = await page.evaluate(() =>
    (window.__bugseeTee?.getCapturedBundles() ?? []).map((b) => b.status),
  );
  const rejectedUploads = allUploads.filter((st) => !(st >= 200 && st < 300));
  const rejectedApiCalls = bugseeCalls.filter((c) => !c.ok);
  record(
    'wire-uploads-accepted',
    `every bundle upload was ACCEPTED, not merely sent (${allUploads.length} S3 PUTs, ${rejectedUploads.length} rejected; ` +
      `${bugseeCalls.length} bugsee API calls, ${rejectedApiCalls.length} not ok)`,
    allUploads.length > 0 && rejectedUploads.length === 0 && rejectedApiCalls.length === 0,
  );

  await browser.close();

  // ---- print pass/fail table -------------------------------------------------------------------
  const idWidth = Math.max(...results.map((r) => r.id.length)) + 2;
  const descWidth = Math.max(...results.map((r) => r.description.length)) + 2;
  console.log('\n' + '='.repeat(idWidth + descWidth + 10));
  console.log(`${'ID'.padEnd(idWidth)}${'Description'.padEnd(descWidth)}Result`);
  console.log('-'.repeat(idWidth + descWidth + 10));
  let pass = 0;
  for (const r of results) {
    console.log(`${r.id.padEnd(idWidth)}${r.description.padEnd(descWidth)}${r.ok ? 'PASS' : 'FAIL'}`);
    if (r.ok) pass += 1;
  }
  console.log('='.repeat(idWidth + descWidth + 10));
  console.log(`${pass}/${results.length} passed\n`);

  if (pageErrors.length > 0) {
    console.log(`Page errors observed (expected from S5 uncaught): ${pageErrors.length}`);
  }

  if (pass !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
