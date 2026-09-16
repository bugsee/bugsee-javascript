# Findings — samples/angular-spa

Every SDK defect, data-arrival failure or data inconsistency observed while building and running
this sample. One entry per finding. Do NOT fix SDK code here — record it.

Severity: **blocker** (SDK unusable / data lost) · **major** (feature broken or wrong data) ·
**minor** (cosmetic, docs, ergonomics).

## Open

### F-2 · The `node:`-stripping IS real, and ~30× wider than F-1's own blast radius — `tsup`'s `removeNodeProtocol` defaults to `true` and is never overridden

- **Severity:** major
- **Package:** build tooling shared by every package (`tsup.config.base.ts`, spread by every package's
  own `tsup.config.ts`) — confirmed root cause:
  `node_modules/.pnpm/tsup@8.5.1.../node_modules/tsup/dist/index.js:494,1426` shows
  `options.removeNodeProtocol && nodeProtocolPlugin()` gated on a flag that defaults `true`
  (`removeNodeProtocol: true` at the same file's option defaults); `tsup.config.base.ts` (repo root)
  sets `entry`/`format`/`dts`/`sourcemap`/`clean`/`treeshake`/`target`/`outDir` but never
  `removeNodeProtocol: false`. Confirmed both facts directly (read the installed tsup source; read
  `tsup.config.base.ts`).
- **Scope:** measured **149** `node:`-prefixed static/dynamic import-or-require specifiers across
  `packages/*/src` (`grep -rhoE "(from|import\(|require\() ['\"]node:[a-zA-Z_/]+['\"]" packages/*/src`).
  `packages/node/dist/index.js` alone ships **13** of its Node-builtin imports with the prefix stripped
  to a bare specifier (`fs`, `path`, `os`, `crypto`, `http`, `https`, `worker_threads`, `perf_hooks`,
  `async_hooks`, `buffer`, `process`, `module`, `inspector` — verified by grepping the built dist for
  each bare builtin name) — this is ~30× F-1's single-line blast radius, and it is NOT limited to the
  one ignore-commented fallback F-1 covers; it is every static Node-builtin import in every package's
  build output. (Note: stripping is not 100% uniform within one file either — `packages/node/dist/index.js`
  still has a couple of `require('node:fs')`/`require('node:worker_threads')` call sites that DID keep
  their prefix, e.g. lines 326/1609/1613 — the plugin's coverage is itself inconsistent.)
- **Highest-priority consequence to verify — NOT CONFIRMED on real infrastructure, flagged here as the
  top item to check next, not as a confirmed break:** `@bugsee/cloudflare`'s own source header documents
  that `AsyncLocalStorage` is reachable on workerd ONLY via the `node:async_hooks` specifier ("verified
  on real workerd across the flag × compatibility-date matrix"), yet `packages/cloudflare/dist/index.js:3`
  ships `import { AsyncLocalStorage } from 'async_hooks';` (no `node:` prefix) — plain `nodejs_compat`
  on workerd does not resolve a bare `async_hooks`, per the same source header's own claim about what
  workerd requires. If that claim is accurate, the SHIPPED dist contradicts the package's own documented
  and "verified" requirement. **This was NOT re-verified against real workerd during this pass** — only
  the source-vs-dist mismatch was confirmed by reading both files. Same shape for Deno:
  `packages/deno/dist/index.js:3` ships `import process from 'process';` (no `node:` prefix), and Deno's
  ESM resolver requires the `node:` prefix for built-ins.
- **Reproduce:** read `node_modules/.pnpm/tsup@*/node_modules/tsup/dist/index.js` for the
  `removeNodeProtocol` default; read `tsup.config.base.ts` for its absence; `grep` any package's
  `dist/index.js` for a bare Node builtin specifier.
- **Not fixed here:** `packages/` is out of scope for this sample; recorded for the orchestrator/backend
  team. The one-line fix candidate (`removeNodeProtocol: false` in `tsup.config.base.ts`, then rebuild
  every package) was not applied.

### F-4 · S12 persist+recover of an exception logged immediately before a page reload is unreliable when preceded by heavy prior SDK activity in the same session

- **Severity:** major (a real crash report can be silently lost under exactly the circumstances a crash
  is likely to happen in — after the app has been busy)
- **Package:** `@bugsee/core` (`packages/core/src/client.ts:494-505`, and — corrected citation, was
  previously mis-attributed to `@bugsee/browser` — `packages/core/src/client.ts:717-724`'s `stop()`) +
  `@bugsee/browser-utils` (`packages/browser-utils/src/idb-report-marker-store.ts:52-56`,
  `packages/browser-utils/src/idb-chunk-backend.ts:188-228,338-347`,
  `packages/browser-utils/src/coexistence.ts:91-119`,
  `packages/browser-utils/src/web-lock-liveness.ts:52-60`) +
  `@bugsee/browser` (`packages/browser/src/launch.ts:516,553-557`) —
  see "Investigation" below for how these interact.
- **Scenario:** S12 — persistence & recovery. The Scenario panel's `s12-crash-and-reload` control calls
  `client.logException(new Error('S12: persist+recover across a hard reload'))`, then
  `setTimeout(() => window.location.reload(), 5)` — with `persist: true` and `recover: true` both set in
  `FULL_LAUNCH_OPTIONS`, the exception is expected to be captured, durably persisted to IndexedDB before
  (or despite) the reload, and re-uploaded as a recovered report on the next page load.
- **Expected:** the exception arrives as its own issue, every time this control is exercised.
- **Observed:** **isolated** (a fresh page load, `s1-relaunch-full` to get a clean client, then
  IMMEDIATELY clicking `s12-crash-and-reload` with nothing else happening first) — it worked correctly,
  1/1: issue `SANGULAR-43`, message `S12: persist+recover across a hard reload`, correctly recovered
  (`# Report source`: `Trigger: error`, `Mechanism: programmatic`). **Inside the full `pnpm verify`
  sweep** — where this control fires shortly after a 200-call `logException` storm (`s4-storm`) and five
  SDK `relaunch()` cycles (the S11 replay-option demos, each a `stop()` + fresh `launch()`) — it produced
  **zero** matching issues across **three separate full sweep runs**. No issue with the message
  `S12: persist+recover across a hard reload` (or any stack frame at `crashAndReload`) appears among
  `SANGULAR-1`..`SANGULAR-42` from those three runs; the isolated run's `SANGULAR-43` is the only one
  that exists.
- **Investigation (read-only, no `packages/` changes made):** a durability race, not a gating/lock
  bug. No "recovery already attempted" flag or lock exists that would explain a clean skip
  (`packages/core/src/capture-recovery.ts:41-108` only skips the CURRENT generation;
  `packages/browser-utils/src/web-lock-liveness.ts:62-69`'s `recoverIfDead` skips a sibling only while
  its lock is still held — the opposite of "skip because already recovered"). Instead:
  1. **`logException()` durability is fire-and-forget, not awaited.** The pending-report marker write
     (`packages/core/src/client.ts:494-505`, `submitReport`) calls `reportMarkers.store.put(...)`
     without awaiting it; `packages/browser-utils/src/idb-report-marker-store.ts:52-56`'s `put()`
     updates an in-memory mirror synchronously, then does `blob.put(id, encode(marker)).catch(onError)`
     **without returning/awaiting that promise** — the actual IndexedDB write happens fully in the
     background. Every captured entry is the same shape:
     `packages/browser-utils/src/idb-chunk-backend.ts:338-347`'s `appendEntry` enqueues the write and
     returns synchronously (the contract's own comment, `packages/core/src/chunk-backend.ts:6`: "Writes
     are SYNC-ISSUE / async-complete" — an earlier revision of this entry cited this to
     `chunk-capture-store.ts:9`, which is a different file and does not carry that comment).
     So `logException()` can return — and the app's `setTimeout` can fire — well before the marker or
     the entry actually lands in IndexedDB.
  2. **The write queue is single-file and strictly serial.** `idb-chunk-backend.ts:188-228`'s `drain()`
     `await`s one queued write at a time (one IDB transaction each, `idb.ts:132-143`) — no batching. A
     200-call storm ahead of the final crash's write means that write may not even be ISSUED to
     IndexedDB, let alone complete, inside the ~5ms before reload.
  3. **Old (relaunched) client instances' write queues/connections are never stopped or closed.**
     `packages/core/src/client.ts:717-724`'s `stop()` calls `haltCapture()` + `drainPending()` but never
     `captureStore.flush()` (only the page-hide hook does that, `packages/browser/src/launch.ts:553-557`,
     and only for the CURRENT store); no `.close()` on any `IDBDatabase` was found anywhere in
     `browser-utils`/`browser`/`core`. Each `relaunch()` opens a BRAND-NEW IDB connection
     (`packages/browser-utils/src/coexistence.ts:91-119`) while the old one's in-flight write queue keeps
     draining, unsupervised, contending for the same origin's IndexedDB — and
     `web-lock-liveness.ts:52-60`'s `holdSelf` only releases a prior instance's lock when its JS realm
     dies (navigation/close), not on `stop()`, so every earlier `relaunch()` instance from the sweep (S11
     alone relaunches 5 times) is still "alive" and still writing right up to the final reload, at which
     point ALL of them become dead siblings simultaneously and `recoverDeadSiblings`
     (`packages/browser/src/launch.ts:516`, fire-and-forget, unbounded) must process them concurrently —
     adding exactly the IDB contention that would make the final write lose its race against the reload.
  This is consistent with "works in isolation" (empty queue, one connection) vs. "fails after a busy
  session" (deep backlog across several lingering connections) — a plausible, evidence-consistent
  explanation from a read-only pass, not one confirmed by instrumenting the actual write (which would
  require changing `packages/`, out of scope for this sample).
- **Reproduce:** `pnpm dev`, then `pnpm verify` three times in a row against a fresh `SANGULAR` (or any)
  staging app; poll `list_issues` after each run for a `crashAndReload` stack frame — it will be absent
  after some or all of the three runs. Contrast with the isolated reproduction: `pnpm dev`, open
  `/scenarios`, click "Relaunch full", then IMMEDIATELY click "logException then hard-reload
  immediately" with nothing else in between — this reliably succeeds.
- **Evidence:** issues `SANGULAR-1`..`SANGULAR-42` (three full sweep runs, `crashAndReload` absent from
  all of them) vs. `SANGULAR-43` (one isolated run, present and correct).
- **UPDATE (round-2 pass, 2026-08-26) — it RECOVERED inside a full sweep, once the backlog ahead of it
  was allowed to drain. This narrows the finding; it does not close it.** The round-2 sweep raised the
  post-storm quiet budget from 60s to 180s (see F-6's retraction — the 60s cap was expiring with ~20s of
  upload work still in flight). In that run the quiet window was genuinely reached after **82s**, and
  `s12-crash-and-reload` — still preceded by the same 200-exception storm and the same five S11
  relaunches — recovered **correctly**: issue `SANGULAR-101`, message `S12: persist+recover across a
  hard reload`, `# Report source: Trigger: error, Mechanism: programmatic`, attributes intact. That is
  **2/2** in full sweeps at the new budget (`SANGULAR-101` `events_count` 1 → 2 across the two completed
  round-2 runs, quiet reached at 82.0s and 79.9s), against 0/3 previously. The distinguishing variable is
  not the prelude's WEIGHT (identical) but whether the IndexedDB write backlog it created had drained
  before the crash fired — which is exactly what the "Investigation" section above predicted. So the
  finding stands as written: a `logException` issued while a deep write backlog is still draining can
  lose its race with the reload, silently. What is now corrected is the earlier phrasing that made it
  sound like an unconditional property of "a heavy sweep prelude" — the prelude only matters while its
  writes are still outstanding. Two observations is not a reliability claim; the loss condition itself
  was not re-provoked in this pass (doing so would mean deliberately re-shortening the wait).
- **UPDATE (round-3 pass, 2026-08-26) — 6/6 at the raised budget.** `SANGULAR-101` reached
  `events_count` **4** over the four round-2/round-3-prelude sweeps that shared its fingerprint (+1 per
  sweep — see the peer-relationship bullet below, this is also the negative-duplication evidence), and
  the round-3 sweeps, whose source edits rolled the fingerprint over, recovered again on a FRESH key:
  `SANGULAR-124`, `events_count` 1 → **2** across two back-to-back sweeps (again +1 each, never +2),
  message `S12: persist+recover across a hard reload`,
  `# Report source: Trigger: error, Mechanism: programmatic`, `# Attributes` `build: dev` /
  `sample: angular-spa`, quiet reached after **96.9s** and **85.8s**. Running total at the raised budget: **6/6**,
  against 0/3 at the old 60s budget. Still not a reliability claim, and the loss condition was again NOT
  deliberately re-provoked in this pass.
- **UPDATE (round-4 pass, 2026-08-26) — 11/11 at the raised budget.** `SANGULAR-124` (the round-3
  fingerprint) went `events_count` **2 → 4** — one for the round-4 reviewer's reproduction sweep and one
  for this pass's first sweep, both of which ran before any source edit and therefore shared that
  fingerprint. This pass's single app-source edit then rolled the fingerprint over, and the
  three back-to-back final sweeps recovered again on a FRESH key: `SANGULAR-146`, `events_count`
  1 → **3** (again +1 per sweep, never +2), message `S12: persist+recover across a hard reload`, quiet
  reached after **86.0s**, **81.9s** and **83.4s**. Running total at the raised budget: **11/11**. Unchanged in kind: still
  observations, not a reliability claim, and the loss condition was again not deliberately re-provoked.
- **UPDATE (round-5 pass, 2026-08-27) — 19/19 at the raised budget.** `SANGULAR-146` (the round-4
  fingerprint) reached `events_count` **8**: five further recoveries from the two previously
  undocumented sweeps at ~21:47/~21:50 UTC on 2026-08-26 plus the round-5 reviewer's three at
  ~04:48-04:50 UTC on 2026-08-27 (the arithmetic is laid out in `scenarios.md`'s corrected inventory).
  This pass's own source edits rolled the fingerprint again, and the three closing sweeps recovered on a
  FRESH key: `SANGULAR-165`, `events_count` 1 → **3**, +1 per sweep, never +2, message
  `S12: persist+recover across a hard reload`, quiet reached after **82.2s**, **82.9s** and **86.0s**.
  Running total at the raised budget: **19/19** (11 documented + 5 + 3). Unchanged in kind: observations,
  not a reliability claim; the loss condition was again not deliberately re-provoked.
- **Correction: it is NOT the 3-second post-reload wait.** An earlier draft of this finding left open
  the possibility that `verify.mjs:1030-1031`'s `page.waitForTimeout(3000)` after the reload — closing
  the browser before a slow recovery upload finishes — was the whole explanation. A reviewer eliminated
  that confound: even with the wait extended to 25-45 seconds, the loss is still deterministic when
  preceded by the heavy prelude (200-storm + five relaunches) — 3/3 lost — while the SAME longer wait
  with a LIGHT prelude recovers correctly (`SANGULAR-43` events_count 1→2 on a second click). The storms
  themselves uploaded fine in the same runs (`SANGULAR-42` events_count 157→315), so the client was
  healthy and connected throughout — this rules out "just needed to wait longer" and narrows it to the
  IDB-contention race described in "Investigation" above.
- **It is SILENT — zero diagnostic signal when it happens.** No `bugsee: dropped N capture write(s)`
  console warning is ever emitted for this path (`packages/browser-utils/src/idb-chunk-backend.ts:180-186`
  is the only place that class of warning is emitted, and it does not cover this loss), and no
  `[bugsee:onError]` fires either (`src/app/bugsee.ts`'s `reportInternalError` sink, wired to every
  `relaunch()`/`launchApp()` via `onError:`, recorded nothing across all three failing sweep runs). The
  report simply never uploads — an app author has no signal, from the SDK or from this sample's own
  error-visibility plumbing, that a crash was lost.
- **Relationship to a peer finding — CORRECTED, and this sample's own data is a NEGATIVE result.**
  `samples/svelte-spa/FINDINGS.md` F-1 found a **duplicate** issue event across a hard reload. An
  earlier revision of this paragraph called that "the same seam, opposite symptom" and attributed it to
  a lost race on `packages/core/src/client.ts:508-515`'s un-awaited `reportMarkers.store.remove(...)`.
  **That is not the mechanism.** The duplicate is *deterministic*, not a race: on the next launch,
  `packages/browser/src/launch.ts:511-538` runs TWO undeduped recovery legs against the same dead
  sibling — leg 1 `recoverSiblingBundleQueue` (`packages/browser-utils/src/recover-dead-instances.ts:14-46`)
  re-uploads the sibling's leftover DURABLE bundle, and leg 2 `recoverReports`
  (`launch.ts:520-535`) independently rebuilds the same incident from the sibling's preserved capture
  chunks + surviving marker. Both run, in sequence, for every dead sibling
  (`packages/browser-utils/src/coexistence.ts:181,188`). Confirmed across three peer samples with
  controlled backend ratios and byte-level bundle identification. The duplicate therefore needs BOTH
  inputs present: a leftover durable bundle (leg 1 has something to send) AND a surviving marker (leg 2
  has something to rebuild). Its window is narrow — "crash between the durable persist and the upload
  settling" — not "any crash followed by a reload".
- **This sample does NOT duplicate — recorded as a negative, not omitted.** `SANGULAR-101`'s
  `events_count` went 2 → 3 → 4, exactly **+1 per sweep**, with S12 recovering 4/4; the round-3 sweeps'
  fresh-fingerprint successor `SANGULAR-124` likewise went 1 → **2** over two sweeps, not 2 → 4.
  **Round-5 correction — the earlier explanation named the WRONG EDGE of the window, and its reproduce
  recipe was backwards.** It said the sweep's 180-second post-storm quiet wait "lets the upload settle
  *before* the reload", putting this sample past the window's UPPER edge, and that SHORTENING that wait
  would make the duplicate reachable here. Both halves are wrong. That quiet wait runs *before* the S12
  control is even clicked (`scripts/verify.mjs`'s storm → `s1-flush` → S12 order); what governs the
  duplicate is the delay between `logException` and the reload, and this sample's control reloads
  **5 ms** after it (`src/app/scenarios/scenario-panel.component.ts:527`,
  `setTimeout(() => window.location.reload(), 5)`). 5 ms is below the window's **LOWER** edge, not above
  its upper one: `packages/core/src/durable-upload-pipeline.ts:13-17` pins the ordering — a bundle is
  written to the durable queue BEFORE its upload is attempted — and at 5 ms the durable queue does not
  yet own anything, so leg 1 has nothing to re-upload and only leg 2 (`recoverReports`, rebuilding the
  incident from the surviving marker + capture chunks) fires. Exactly +1, every time. The peer that
  MEASURED the window says the same outright
  (`samples/solid-spa/src/routes/ScenarioPage.tsx:955-966`): *"a reload timed at the ORIGINAL 5ms lands
  before the durable queue owns anything … 5ms -> 1 upload (2/2 runs); 40ms -> 2 (2/2); 250ms -> 2
  (3/3)"* — which is why that sample moved its control to 250 ms. So the correct reproduce recipe here
  is to **LENGTHEN** the reload delay, not to shorten any wait: raise
  `scenario-panel.component.ts:527`'s `5` to `250`, re-run `pnpm verify`, and poll `list_issues` — the
  S12 key should gain **2** events per sweep instead of 1.
  (`samples/solid-spa/FINDINGS.md:101-105` carries the mirror-image of the same mis-statement about THIS
  sample — it attributes angular-spa's single delivery to waiting "~180s of quiet after the crash before
  reloading", i.e. past the UPPER edge. That file is out of scope for this pass and was not edited;
  flagged here so the next reader of either file sees the correction.)
- **Deliberate decision: this sample KEEPS its 5 ms reload delay.** Measured across the sample set (grep
  for `location.reload(` on 2026-08-27): `samples/solid-spa` is at **250 ms** (inside the window, by its
  own measurement), `samples/svelte-spa` at **50 ms** (also inside — its F-1 is the duplicate finding),
  and `samples/react-spa` and this sample at **5 ms**. This sample deliberately stays below the lower
  edge, for three reasons. (1) F-4 — the finding this whole section is about — is a LOSS observed at
  exactly this timing, and its recovery series (0/3 at the old quiet budget, then 11/11 at the raised
  one, extended by this round's sweeps) is a longitudinal record that a timing change would silently
  reset. (2) With the peers that MEASURED the window sitting inside it, keeping this one below the lower
  edge means the two regimes are covered by different samples rather than all of them landing in the
  same one. (3) The duplicate defect is already fully characterised, with measured timings, by the peer
  that owns it — re-deriving it here would add a second observation of a known defect and cost the loss
  observation that is unique to this sample. The cost of the decision, stated plainly: S12 here does NOT
  exercise the leg-1/leg-2 duplicate path, and this sample must not be cited as evidence that the
  duplicate does not occur.
  So: angular-spa's F-4 (loss) and svelte-spa's F-1 (duplicate) are
  **different defects at different seams**, not two faces of one — the loss is the marker/entry write
  losing its race with the reload; the duplicate is two recovery legs with no cross-leg dedupe. Neither
  is fixed here (`packages/` out of scope for both samples).

### F-5 · Chained `Error#cause` STACKS reach the backend, but the cause MESSAGES do not

- **Severity:** minor (the chain is still traceable via stack frames, but the human-readable "why" at
  each level of the chain is lost — for a chained cause, the message is usually the whole point)
- **Package:** ambiguous — could be `@bugsee/core`'s exception serialization (not inspected directly;
  `packages/` out of scope for this sample) or backend/viewer rendering of an already-complete payload;
  **this build's tooling (MCP `get_issue` only) cannot distinguish the two**, so this is recorded as
  observed-behavior, not attributed to a specific package/file.
- **Scenario:** S4 — `logException` with a chained `cause` (`s4-cause`,
  `src/app/scenarios/scenario-panel.component.ts:167-171`):
  ```ts
  const root = new Error('S4: root cause');
  const mid = new Error('S4: middle', { cause: root });
  ```
  (the top-level exception logged is a third error whose `cause` is `mid`).
- **Expected:** `scenarios.md` originally claimed "the whole `Error#cause` chain reaches the backend" —
  i.e. that `S4: middle` and `S4: root cause` would be findable somewhere in the issue.
- **Observed:** issue `SANGULAR-13` (original run) / `SANGULAR-87` (re-verified in the round-2 run) does show `## Reason/message` (top-level message `S4: top-level, chained via cause`) followed
  by **two** `Cause:` sections — the chain depth is correct — but each `Cause:` section contains ONLY a
  stack trace, never a message line. Neither `S4: middle` nor `S4: root cause` appears anywhere in the
  issue text. So the chain's SHAPE (depth, stack frames per level) reaches the backend; the chain's
  CONTENT (why each level was raised) does not.
- **Reproduce:** `pnpm dev`, `/scenarios`, click "logException with chained cause" (`s4-cause`); poll
  `list_issues`/`get_issue` for the resulting issue; confirm two `Cause:` blocks exist but neither
  contains `S4: middle` or `S4: root cause` as text.
- **Evidence:** issue `SANGULAR-13` (original run) / `SANGULAR-87` (re-verified live against staging
  during the round-2 pass — two `Cause:` blocks, neither carrying a message; the finding still holds).
- **Not fixed here:** `packages/` is out of scope for this sample. Whether the fix belongs in the SDK's
  exception serializer (drop the cause's message when building the payload) or in backend/viewer
  rendering (payload has the message, rendering omits it) cannot be determined from this sample's MCP
  vantage point alone — flagged for the orchestrator to route to whichever team owns the actual gap.
- **Correction:** `scenarios.md`'s S4 "nested cause chain" row previously stated the claim above as
  fact; corrected in this pass to describe what was actually observed (stacks yes, messages no).

### F-6 · `client.flush(timeout)` can resolve **`true` while launch-time dead-sibling recovery is still running** — `recoverDeadSiblings` is fire-and-forget and nothing tracks it

- **Severity:** minor. No data is lost: every bundle the recovery still holds is, by construction, still
  DURABLE (leg 1's bundles stay in the sibling's IndexedDB prefix until a delivery confirms; leg 2's
  marker + capture chunks stay until its report uploads), so a later launch recovers them. What is wrong
  is the ANSWER: a caller who does `await client.flush(N)` and reads `true` as "everything this client
  had to send has been sent" is told that while a recovery loop has bundles it has not even enqueued yet.
  **Not demonstrated by this sample; recorded from a code read of the cited sites.**
- **Package:** `@bugsee/browser` — `packages/browser/src/launch.ts:516` (`void coexistence.recoverDeadSiblings({…})`),
  with `@bugsee/core` `packages/core/src/client.ts:727-729` (`flush` → `drainPending`), `:439-441`
  (`drainPending`), `:419-426` (`pendingReports`, what it actually covers).
- **HEADLINE CORRECTED (round-3 pass).** This entry previously headlined a DIFFERENT symptom: `flush()`
  resolving `true` "with up to `maxWaiting` (200) bundles still queued in `waiting`". That symptom is
  **not reachable through `client.flush()`** and the headline has been withdrawn. Independently
  re-checked: every non-report enqueue site is a sequential `await` inside a loop —
  `packages/core/src/capture-recovery.ts:76`, `packages/core/src/native-crash-recovery.ts:132`,
  `packages/browser-utils/src/recover-dead-instances.ts:38` — and
  `packages/core/src/durable-upload-pipeline.ts:209-225`'s `pump` hands over exactly ONE bundle per
  completion (`void attempt(id, bundle); return;`). None of them can put more than ~1 bundle in
  `waiting`. The only site that drives `waiting` deep is the report path,
  `packages/core/src/trigger-pipeline.ts:50` — and that path is fully covered, because `client.flush()`
  goes through `drainPending` (`client.ts:439-441`), which awaits `[...pendingReports]`
  (`client.ts:419-426`) *before* `uploadPipeline.flush(timeout)`. So the "200 queued" framing had no
  caller that could produce it.
- **The residual REAL gap.** `packages/browser/src/launch.ts:516` starts dead-sibling recovery as
  `void coexistence.recoverDeadSiblings({…})` — fire-and-forget, its promise stored nowhere. It is not a
  report (so not in `pendingReports`), and its bundles reach `uploadPipeline.enqueue` only as its own
  `await` loop gets to them. A `flush()` issued while that loop is mid-pass sees an `inFlight` set that
  simply does not yet contain the bundles the loop has not reached, and both halves of `drainPending`
  answer `true`. Fixing it is a one-line shape change — retain the promise and await it in
  `drainPending` — but that is `packages/` and out of scope here.
- **Underlying pipeline shape (kept for the record, now non-headline).** `packages/core/src/upload-pipeline.ts:254-263`
  (`flush`) awaits `Promise.allSettled([...inFlight])`, a SNAPSHOT of at most `bufferSize` (`:67`,
  default 4) promises taken once, while `start()`'s `finally` (`:221-227`) refills that same Set from
  `waiting` as uploads settle (`maxWaiting` at `:70`, enforced at `:235-241`). That shape is what MAKES
  the gap above possible; on its own, with no caller able to drive `waiting` deep, it is not a defect.
- **RETRACTION — this entry previously recorded the OPPOSITE, and wrong, symptom.** Earlier revisions
  claimed `flush(5000)` timing out (`-> false`) in this sample's sweep was evidence of an SDK defect, on
  the premise that it was called "well after traffic had gone quiet". That premise was FALSE, and the
  measurement that established it is now built into the harness. `scripts/verify.mjs`'s `waitForQuiet`
  had no way to report WHICH exit it took; instrumenting it showed the pre-flush wait was exiting by its
  60-second **timeout**, with traffic still flowing and roughly 20 seconds of genuine upload work left.
  `flush(5000) -> false` was therefore the CORRECT answer — the pipeline had not drained, and said so.
  (An adversarial review established that first, including a `flush(120000) -> true` on the same state;
  that particular measurement is theirs, not re-run here.) The sweep now raises the quiet budget from 60s
  to 180s so quiet is actually reachable, records the exit reason in the `s4-storm`/`s1-flush` detail
  lines, and FAILS `s1-flush` as inconclusive if the precondition did not hold — so this misreading
  cannot recur silently. **Directly re-measured here:** across two round-2 full sweeps, quiet was reached
  at 82.0s and 79.9s and `flush(5000)` returned **`true`** both times; re-measured again across two
  round-3 sweeps — quiet at **96.9s** and **85.8s**, `flush(5000) -> true` both times.

  Two secondary claims from those revisions are also withdrawn: `waiting` is **not** unbounded (`:70` —
  `maxWaiting`, default 200, enforced at `:235-241`), and the citation `:252-273` for `flush` was wrong
  (it is `:254-263`).
  A third claim from those revisions is withdrawn by the HEADLINE CORRECTION above: that the
  true-too-early window was reachable from `capture-recovery.ts:76` / `native-crash-recovery.ts:132`
  "recovering more than `bufferSize` crash bundles". It is not — both are sequential `await`s in a loop,
  so neither ever has more than one bundle outstanding. The reachable gap is the UNTRACKED recovery
  promise, not a deep `waiting` queue.
- **Reproduce:** not reproducible from this sample as an observation. It needs a dead sibling with
  leftover durable bundles AND a `client.flush()` issued inside the window in which
  `recoverDeadSiblings` is still iterating them — this sample's sweep waits for quiet before flushing,
  which is exactly the condition that closes that window (the same 180s wait that makes S12 non-duplicating,
  see F-4). This is a code read of the cited sites, confirmed independently against the current sources —
  **stated as such, not as an observed failure.** A direct unit-level reproduction would stub
  `recoverDeadSiblings` with a slow multi-bundle loop and assert that `client.flush()` resolves `true`
  before the loop's last `enqueue`.
- **Evidence:** source only, cited line-by-line above. The `flush(5000) -> false` observations from the
  earlier revisions are NOT evidence for this finding and have been withdrawn as such.
- **Not fixed here:** `packages/` is out of scope for this sample.

### F-7 · `console.trace()` is NEVER captured — on ANY runtime. The shared console interceptor's `DEFAULT_LEVELS` has no `trace` key and no platform overrides it

- **Severity:** major (a documented, universally-available console method is silently dropped on every
  platform — the call is not captured, not tagged, not reported anywhere. It is *not* a blocker: the
  other five methods work, and the app's own `console.trace` output is untouched, since the interceptor
  never patches the method at all)
- **Package:** `@bugsee/capture` (`packages/capture/src/console-interceptor.ts`), cross-runtime — the
  same defect reaches `@bugsee/browser`, `@bugsee/node`, `@bugsee/webworker`, `@bugsee/vercel-edge` and
  `@bugsee/webview` (and therefore `@bugsee/bun`/`@bugsee/deno`/`@bugsee/electron`, which compose those).
- **Scenario:** S6 — the panel's `console.trace` control (`s6-trace`,
  `src/app/scenarios/scenario-panel.component.ts:212-216` → `console[method](...)`).
- **Expected:** `scenarios.md`'s S6 row claimed `console.log/info/warn/error/debug/trace` → "captured".
  `console.trace` is a standard method in every runtime this SDK targets (browsers, Node, Bun, Deno,
  workers), and `LogLevelName` (`packages/types/src/index.ts:17`) already carries a `verbose` level that
  is the natural mapping for it (Android's `Log.v` equivalent).
- **Observed:** the message never reaches the wire. `DEFAULT_LEVELS`
  (`packages/capture/src/console-interceptor.ts:24-30`) maps exactly five methods —
  `log`/`info`/`debug`/`warn`/`error` — and `trace` is absent. `onActivate` (`:81-90`) iterates
  `Object.entries(this.#levels)` and patches ONLY those keys, so `console.trace` is never wrapped: no
  `LogEvent` is emitted, nothing is filtered, nothing is dropped later — the call simply never enters the
  SDK. Nothing overrides the default anywhere: every platform calls `createConsoleInterceptor()` with no
  arguments (`packages/browser/src/launch.ts:441`, `packages/node/src/launch.ts:625`,
  `packages/webworker/src/launch.ts:302`, `packages/vercel-edge/src/launch.ts:312`,
  `packages/webview/src/launch.ts:510`), and a repo-wide search for a `levels:` option being passed
  returns no non-test hit.
- **Reproduce:** `pnpm dev`, `/scenarios`, click ONLY `console.warn` and `console.trace`, then force a
  report (any S4 control). The uploaded bundle's `logs.json` carries the warn message and no trace
  message at all. The sweep now shows this on every run: `s6-console`'s detail line prints the per-method
  wire result, and `trace` is the only `false` among the six while all six status lines report their
  handler ran to completion.
- **Evidence:** `scripts/verify.mjs`'s `s6-console` detail, e.g.
  `in logs.json: {"log":true,"info":true,"warn":true,"error":true,"debug":true,"trace":false}` — the
  five/one split comes from a SINGLE `logs.json`, so it is not a timing or ring-eviction artifact.
  Independently confirmed by the round-4 reviewer with a two-click (`s6-trace` + `s6-warn`) minimal
  repro.
- **Not fixed here:** `packages/` is out of scope for this sample. The fix looks like one line
  (`trace: 'verbose'` in `DEFAULT_LEVELS`), but it is a capture-behavior change across every runtime and
  belongs to whoever owns `@bugsee/capture` — including the question of whether `console.trace`'s
  implicit stack should be captured as part of the message.
- **Correction made here:** `scenarios.md`'s S6 row asserted `trace` → "captured"; corrected to state
  what actually happens and to point here. `verify.mjs`'s `s6-console` was strengthened to assert the
  five captured levels AT WIRE LEVEL (previously it could only detect an interceptor that THREW, not one
  that silently captured nothing); `trace` is deliberately excluded from the pass condition so the check
  does not start failing the day the SDK is fixed — its status is printed in the detail every run.

### F-8 · CONFIRMED — `.bugsee-unmask` on an `<input>` is honoured ONLY on the FULL-SNAPSHOT path; a value typed WHILE recording stays masked

- **Status: CONFIRMED (round 7), by a deliberate experiment here AND independently by a peer sample.**
  It was UNCONFIRMED for one reason only, stated in round 6: this sample's fixtures are typed BEFORE the
  S11 replay relaunch, so the stream a check could read contained no `source:5` incremental input event
  at all, and the experiment could not be run. **The replay default flip removed that obstacle** — the
  browser tier now records from the primary launch (`packages/browser/src/launch.ts:433`), so by the time
  the sweep reaches `/scenarios` a recorder is already live and anything typed is an incremental event.
  The experiment that was impossible became a two-minute probe. `samples/svelte-spa` confirmed the same
  behaviour independently, on its own substrate, in the same round.
- **It fails CLOSED, and that is why it is a note and not a bug report.** The discrepancy runs in the
  safe direction in every case: more masking than the markup asked for, never a leak. The failure mode is
  a replay less useful than intended, not a replay that exposes a value the app marked as safe.
- **Still NOT filed as an SDK defect, and deliberately NOT fixed here.** Whether the incremental path
  *should* honour the mark is a design question owned by `@bugsee/replay` and the rrweb fork; the code
  that would have to change is **cross-repo** — `github:bugsee/rrweb#bugsee-dist`, not
  `packages/replay/src/masking.ts`, which passes `unmaskInputSelector` correctly
  (`masking.ts:548`). `packages/` is out of scope for this sample either way, and the fork doubly so.
- **Severity:** **minor**, fails safe (see above).
- **Package:** the rrweb fork (`github:bugsee/rrweb#bugsee-dist`, shipped as `@bugsee/rrweb-record`).
  `@bugsee/replay` (`packages/replay/src/masking.ts`) is NOT where the asymmetry lives — it builds and
  passes the selector; the fork's input observer never receives it.
- **The round-7 experiment (this sample, on the flipped substrate).** With replay recording from the
  primary launch and no relaunch anywhere in the probe, typing into ONLY the `.bugsee-unmask` field —
  so exactly one `source:5` event can exist — and forcing a report gives, from the real uploaded
  `replay.bin`:

  ```
  typed (into .bugsee-unmask only): F8ONLY3sn3bbSHOWN     (17 chars)
  source:5 events = [{"source":5,"text":"*****************","isChecked":false,"id":311}]
  value present anywhere in stream = false
  event kinds = ["4","2","3:0","3:2","3:5","3:3"]
  ```

  Seventeen asterisks for a seventeen-character value, on the element that carries the opt-out mark, and
  the value absent from the entire decoded stream. Run twice (both fields, then the single field) with
  the same result. Contrast the FULL-SNAPSHOT path in the same sweep, where the mark IS honoured —
  `s11-replay-masking-wire` reads `#s11-shown` back verbatim. Same element, same mark, two paths, two
  answers.
- **The observation (round-6 reviewer, not this pass):** the reviewer put the CORRECT class
  (`.bugsee-unmask`) on `#s11-masked`, relaunched, confirmed the class appeared on the element in rrweb's
  full snapshot, and the field's value still came back fully masked —
  `{"source":5,"text":"********************************"}`. `SENSITIVE_INPUT_GUARD`
  (`masking.ts:99-101`) admits a plain text input, so `unmaskInputSelector` should have matched it.
- **What this pass's R6-2 work settled, and what it did not.** Building the replay decoder
  (`bugsee-transport.ts`'s `getReplayText()`) made the stream directly readable, and it separates the two
  paths cleanly. Typing the values BEFORE the replay relaunch — so they are present when rrweb serializes
  the DOM — produces, from the real uploaded `replay.bin` of this sample's `s11-replay-canvas-all`
  configuration:

  ```
  #s11-masked: {"id":"s11-masked","placeholder":"*****************","value":"***********************"}
  #s11-shown : {"id":"s11-shown","class":"bugsee-unmask","value":"S11VISIBLEmtb3j3vhSHOWN"}
  ```

  So the **full-snapshot** path honours `.bugsee-unmask` exactly as documented. The reviewer's field was
  typed while the recorder was ALREADY running, so what they read was a `source:5` **incremental input**
  event, a different code path. Consistent with that: in the fork bundle
  (`node_modules/@bugsee/rrweb-record/record.js`) the element serializer emits
  `value = unmaskInputSelector && el.matches(unmaskInputSelector) ? rawValue : maskInputValue(...)`,
  while the input-observer factory destructures only
  `inputCb/doc/mirror/blockClass/blockSelector/ignoreClass/ignoreSelector/maskInputOptions/maskInputFn/sampling/userTriggeredOnInput`
  — `unmaskInputSelector` is not among its parameters at all.
- **What is therefore still open:** whether that asymmetry is intended (upstream rrweb behaviour the fork
  inherits) or an oversight, and if the latter, whether it belongs in the fork or is expressible from
  `@bugsee/replay`. Not investigated — out of scope for a sample, and both `packages/` and the fork repo
  are out of scope for this pass either way. What is NO LONGER open is whether it happens: it does,
  reproducibly, on two samples independently.
- **Consequence for this sample (no SDK change needed):** `verify.mjs` types the two S11 fixture values
  BEFORE the replay relaunches, so `s11-replay-masking-wire` reads the full-snapshot path. That ordering
  is documented at the fill site so a future editor does not "tidy" it back and re-derive this puzzle.
  **No sweep check asserts the incremental behaviour**, deliberately: a check that pins the masked-value
  outcome would be a check that FAILS the day the fork starts honouring the mark, i.e. a test asserting
  the very thing it exists to prevent. The evidence lives here, in this finding, where fixing the fork
  makes it obsolete rather than red.
- **Separate and NOT this:** the markup itself was wrong until round 6 — it carried `.bugsee-show` (the
  media/canvas un-BLOCK mark) where `.bugsee-unmask` was needed. That was a SAMPLE defect, fixed, and is
  not an SDK finding. See `scenarios.md`'s S11 `.bugsee-unmask` row.

## Resolved

### F-1 · `@bugsee/util`'s Node fallback for `sha256` is STATICALLY VISIBLE to esbuild-family browser bundlers — the ignore-comment protection doesn't cover esbuild at all, `node:`-prefix or not

- **Status: RESOLVED at the source (2026-09-16).** `@bugsee/util`'s `sha256Hex` is now WebCrypto-only —
  the `node:crypto` fallback is deleted, and `@bugsee/node` injects a `node:crypto` digest into core's
  upload pipeline where `crypto.subtle` is absent. Re-verified on this sample: `.local-registry` re-packed,
  clean install (`rm -rf node_modules pnpm-lock.yaml`), `externalDependencies` REMOVED from `angular.json`,
  `pnpm build` → `Application bundle generation complete`, and `dist/angular-spa/browser/*.js` contains no
  `import("crypto")` / `node:crypto` (only `globalThis.crypto` / `crypto.subtle`). The original write-up
  follows unchanged.
- **Severity:** major
- **Package:** `@bugsee/util` (source: `packages/util/src/sha256.ts:31`; built output:
  `packages/util/dist/index.js:155`, confirmed both in the repo's own built `dist/` and in the packed
  tarball this sample installs, `.local-registry/bugsee-util.tgz`)
- **Scenario:** production build (`ng build`) of any app whose dependency graph reaches `@bugsee/core`
  (which `@bugsee/util` sits under as a tier-0 dependency) — not tied to any one catalog scenario
- **Root cause — CORRECTED from an earlier draft of this finding.** An earlier draft of this entry
  claimed esbuild "recognizes `node:crypto` as a Node built-in and treats it as implicitly external
  without erroring" while a bare `'crypto'` does not. **That is false — measured directly against this
  repo's own esbuild:**
  ```
  node:crypto, platform=browser  →  ✘ Could not resolve "node:crypto"
  crypto,      platform=browser  →  ✘ Could not resolve "crypto"
  ```
  esbuild rejects BOTH spellings identically under `platform: 'browser'`, and Angular's `application`
  builder has no `node:`-prefix special-casing of its own —
  `@angular/build/src/tools/esbuild/application-code-bundle.js:274` passes the configured `external`
  list straight through to esbuild alongside `platform: 'browser'`. So restoring the `node:` prefix in
  `@bugsee/util`'s build would NOT close this finding: `ng build` would still fail, and the
  `externalDependencies` workaround below would still be required — just spelled `["node:crypto"]`
  instead of `["crypto", "node:crypto"]`.

  The real defect: `packages/util/src/sha256.ts:31`'s `import('node:crypto')` fallback is guarded ONLY
  by bundler-specific ignore comments — `webpackIgnore`/`turbopackIgnore`/`@vite-ignore` — and esbuild
  (hence Angular CLI's `@angular/build:application`/`browser-esbuild` builders, Deno's bundler, and
  plain esbuild used directly) understands **none** of them. Those comments make the specifier a
  literal for Vite/webpack/Turbopack, which is real protection for THOSE three bundlers, but esbuild
  still statically resolves the import and fails the build the moment ANY `platform: 'browser'` target
  reaches `@bugsee/core` (which pulls in `@bugsee/util`). This is a gap in bundler coverage, not a
  string-prefix bug.
- **Observed:** `ng build` on this sample failed outright with `externalDependencies` absent:
  `Could not resolve "crypto"` / `The package "crypto" wasn't found on the file system but is built
  into node.` (the packed dist happens to ship the bare `'crypto'` spelling —
  `packages/util/dist/index.js:155` — but per the root-cause correction above, the `node:`-prefixed
  spelling fails identically; this is not the actionable part of the defect).
- **Reproduce:** `cd samples/angular-spa && pnpm build` with `angular.json`'s
  `externalDependencies: ["crypto", "node:crypto"]` REMOVED from the `build` target's options →
  `ng build` fails with the error above, regardless of which spelling `@bugsee/util`'s dist ships. With
  the workaround present (as this sample currently ships), the build succeeds — see `angular.json`'s
  `architect.build.options.externalDependencies`.
- **Workaround used (this sample only):** added `"externalDependencies": ["crypto", "node:crypto"]` to
  `angular.json`'s build options, forcing esbuild to treat both spellings as external. Both spellings
  are listed deliberately — since esbuild has no notion of the ignore comments either way, there is no
  "correct" prefix to standardize on from the bundler's perspective, only both-must-be-covered.
- **Evidence:** `pnpm build` output (captured during this build, reproducible verbatim by removing the
  workaround) plus a direct esbuild repro (`node:crypto` vs `crypto`, both platform=browser, both fail
  identically) — see the reproduction steps above; no MCP evidence needed, this is a build-time failure.
- **Cross-cutting:** yes — this affects **any** consumer of `@bugsee/core` bundled with an esbuild-based
  tool (Angular CLI's `application`/`browser-esbuild` builders, Deno's bundler, plain esbuild, and
  plausibly others that don't special-case Vite/webpack/Turbopack ignore comments), not just Angular.
  Belongs in `samples/FINDINGS.md` too; not added there directly per this sample's instructions — the
  orchestrator aggregates.

### F-3 · The documented `externalDependencies` workaround converts a BUILD error into a SILENT RUNTIME error — no caveat exists anywhere a reader would see it before shipping

- **Status: RESOLVED (2026-09-16), both halves.** The workaround is gone (F-1), so no bundle ships an
  unresolvable `import("crypto")`. And the runtime half no longer depends on bundling at all: without
  `crypto.subtle` (a non-secure context) the SDK's checksum now fails SOFT — `core/src/upload-pipeline.ts`
  computes it best-effort before creating the issue and uploads without it (the checksum is not sent on
  the wire). Before, such a page could never upload, and every launch left an empty issue behind. The
  README's HTTPS-only caveat is removed. The original write-up follows unchanged.
- **Severity:** major
- **Package:** interacts with `@bugsee/core`'s upload path (`packages/core/src/upload-pipeline.ts:77`,
  which calls `sha256` — the same `@bugsee/util` function F-1 is about — to compute the S3 PUT
  checksum) — this sample's own `angular.json`/`README.md` are what's missing the caveat.
- **Observed:** with the `externalDependencies` workaround in place, `pnpm build` succeeds and
  `dist/angular-spa/browser/chunk-*.js` ships a literal `import("crypto")` (verified by grepping the
  built output). That import is only ever reached when `crypto.subtle` is absent from the global —
  i.e. in ANY non-secure browsing context: plain `http://` (not `https://`) on a LAN host, an internal
  admin tool, a staging box without TLS terminated in front of it. In that situation the dynamic
  `import("crypto")` resolves against nothing (no bundler shipped a `node:crypto` shim into the browser
  bundle — it was marked EXTERNAL, meaning "the runtime will provide this," and no browser runtime
  does), so `sha256Hex` throws/rejects, and every upload that needs the checksum fails. This is a
  regression from "build fails loudly" to "build succeeds, then a subset of production traffic silently
  can't upload" — worse for anyone who copies the workaround without reading this finding.
- **Consequence:** neither `README.md` (as it stood before this fix pass) nor `angular.json:27`
  (the `externalDependencies` line itself) carried this caveat. A customer following the README's
  documented build workaround verbatim would ship a production build that fails to upload from any
  non-secure-context deployment, with no warning anywhere in the docs they followed.
- **Fixed in this pass (sample-side only):** added the caveat prominently to `README.md` (both the "Run
  it"/production-build section and the Findings summary). `angular.json` is plain JSON with no comment
  syntax, so the caveat could not be attached inline there without either breaking the schema or adding
  a nonstandard property — left out of `angular.json` for that reason; the README is the single place a
  reader following the build workaround will see it. Not fixed at the source (`packages/util`'s
  `sha256.ts` NOT touched) since this sample does not modify `packages/`.

### F-9 · HARNESS defect (not an SDK one) — every "the UPLOADED bundle carries X" check in this sweep would have passed on a bundle the backend REFUSED

- **Status: found and fixed in round 7.** Recorded here because the failure mode is invisible: it
  produces no error, no FAIL and no warning — it makes ~30 wire checks report success for uploads that
  never reached storage.
- **Severity (as a harness defect):** **major**. The wire checks are this sample's strongest evidence,
  and this hole meant they were evidence for a weaker claim than the one they printed.
- **The defect.** `src/app/bugsee-transport.ts` parses `record.bundle` from the **request body** — the
  bytes handed to the transport — and records the PUT's `status` alongside it. `verify.mjs` read the
  first and never the second: `CapturedCall.status` was parsed by the tee and consumed by **zero**
  checks. So "the UPLOADED bundle carries X" was really "the body handed to the transport carried X".
  A 403 on the presigned S3 PUT — an expired signature, a revoked key, a bucket policy change — would
  have left the entire wire half of the sweep green with nothing whatsoever in the backend.
- **Measured, not reasoned.** Forcing `403` on every `PUT **://*.amazonaws.com/**` through a Playwright
  route (the SDK's own upload path, untouched otherwise) and then forcing a report:

  ```
  playwright saw: [{"m":"PUT","s":403}]
  tee record for the marker bundle: {"status":403,"hasBundle":true,"files":9}
  OLD behaviour (no status gate) — a wire check would find this bundle: true
  NEW behaviour (uploadStored gate)  — a wire check finds it: false
  ```

  A nine-file bundle, fully parsed and fully matchable, from an upload the backend rejected.
- **The fix, in two parts** (both in `scripts/verify.mjs`; the tee only gained a comment explaining why
  it must NOT filter at the source):
  1. `uploadStored()` inside `waitForBundle` — no check can read a bundle whose PUT was not 2xx.
  2. `wire-upload-status`, a run-wide check over Playwright's own response log (which, unlike the
     in-page tee ring, survives this sweep's eight navigations): every presigned bundle PUT in the run
     was stored, and at least one was made. The `> 0` conjunct is deliberate — "none was refused" is
     trivially true when none was sent, and would also go quiet if the upload host stopped matching.
  Part 2 exists because part 1 is silent for the checks that assert a bundle is **absent** (the S8 veto
  pair), where a stricter matcher changes nothing.
- **Credit:** the hole was found first in a peer sample and flagged across the wave; it was present here
  in exactly the described form.


### F-0 · `ScenarioPanelComponent` cached `getClient()` in a readonly field — a SAMPLE bug, not an SDK defect, recorded here only because it looked exactly like one until traced

- **Severity:** n/a (sample-only, fixed before this build was considered done)
- **Not an SDK defect.** `src/app/scenarios/scenario-panel.component.ts` originally had
  `readonly client = getClient();` — a value captured ONCE at component construction. Every S1 "Relaunch"
  control calls `relaunch()` (`src/app/bugsee.ts`), which `stop()`s the current client and builds a NEW
  one — but the component's cached `client` field kept pointing at the OLD, now-stopped instance. Every
  subsequent control on the page (`s4-error`, `s4-string`, ..., `s8-*`, `angular-create-handler`, ...)
  silently called methods on a stopped client: no throw, no error, just no network traffic. The FIRST
  full `pnpm verify` sweep run against this code showed 9 failures (`s1-is-launched: false`, every
  `s4-*` control producing 0 issue calls, etc.) — all traced to this one bug. **Fixed** by making
  `client` a getter (`get client() { return getClient(); }`) that re-resolves on every access; the SAME
  fix was applied to `settings.component.ts`'s equivalent (lower-risk, since that component is
  recreated per-navigation, but the same pattern). Re-ran the full sweep after the fix: 48/48, then
  52/52 once the S2 settings-page checks were added to `verify.mjs`. Recorded here per PLAN §6.6's
  instruction to record every discrepancy — including ones this sample's own author introduced and
  fixed — so the mutator-loop-style "what looked like an SDK bug and wasn't" history isn't lost.
