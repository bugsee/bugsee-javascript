# Findings — samples/solid-spa

Every SDK defect, data-arrival failure or data inconsistency observed while building and running
this sample. One entry per finding. Do NOT fix SDK code here — record it.

Severity: **blocker** (SDK unusable / data lost) · **major** (feature broken or wrong data) ·
**minor** (cosmetic, docs, ergonomics).

## Open

### A · `setRouteNameFromSolidMatches` names the PREVIOUS transaction — the route-naming refinement never lands, and can mislabel an unrelated transaction's measured duration

- **Severity:** major (the one feature `@bugsee/solid` exists for beyond error reporting is broken,
  and it corrupts data rather than merely no-op'ing)
- **Package:** `@bugsee/solid` (`packages/solid/src/router.ts:8-10` — the documented
  `createEffect(() => setRouteNameFromSolidMatches(matches()))` recipe) + `@bugsee/performance`
  (`packages/performance/src/controller.ts:128-131` `setRouteName` — renames whatever transaction is
  currently `active`; `packages/performance/src/navigations.ts:58` — the real navigation transaction
  starts moments later)
- **Scenario:** the Solid-specific "beyond the catalog" row (`setRouteNameFromSolidMatches` wired
  globally via `useCurrentMatches()` + `createEffect` in `RootLayout.tsx`'s `RouteNameSync`) —
  `scenarios.md` previously (incorrectly) claimed this was verified working. It was not: nothing in
  the sample had ever looked at an actual uploaded transaction until this pass.
- **Root cause:** `@solidjs/router` updates its reactive `matches()` signal and flushes Solid's
  effects **before** committing the history change. Confirmed by reading `@solidjs/router`'s own
  source (v1.0.0, `node_modules/@solidjs/router/dist/routing.js`): `transition()` (`:385-405`) calls
  `setReference(...)` INSIDE `startTransition` — that is what updates `location.pathname`, hence the
  `matches()` memo, hence every effect subscribed to it — and only in that transition's `.finally()`
  batch does it call `navigateEnd()` (`:509-518`), which `setSource(...)`s the new entry into the
  router's history integration (`dist/routers/Router.js:22-31` → `window.history.pushState`). Effects
  first, history commit second, every time. (`packages/solid/src/router.ts:8-10` is Bugsee's OWN
  doc-comment recommending the `useCurrentMatches()` + `createEffect` wiring — it is the recipe under
  test here, not the evidence for the ordering.) So `RouteNameSync`'s `createEffect` fires
  for navigation N **one navigation early** — while the transaction still `active`
  (`packages/performance/src/controller.ts:128-131`) is the transaction for navigation N-1 (or
  whatever else happens to be active at that instant), not navigation N's own transaction. By the
  time navigation N's real navigation transaction actually starts
  (`packages/performance/src/navigations.ts:58`), the effect has already fired and the refinement is
  gone — landed on the wrong span, or on none.
- **Wire evidence (live router wiring, `solid-route-name-wire` in `scripts/verify.mjs`):** a real
  `@solidjs/router` `<A>` click navigation to `/issues/issue-2`, intercepted at
  `POST /v2/performance/transactions`:
  ```json
  [{ "name": "/issues/issue-2", "source": "url" }]
  ```
  The navigation transaction is uploaded named by the concrete URL, `bugsee.name_source: "url"` — the
  route-pattern refinement (`/issues/:id`) never lands on its own navigation transaction, every time.
- **Wire evidence (misattribution — worse than a no-op):** two navigations inside the idle-transaction
  window (`packages/performance/src/idle-transaction.ts:53`, default `idleTimeoutMs: 1000`) — click
  into `/issues/issue-5` (starts a transaction named `/issues/issue-5`, `url`), then click the
  "Comments" tab ~400ms later (`< 1000ms`, well inside the first transaction's idle window) — produced,
  from the SAME wire probe:
  ```json
  [
    { "spanId": "938d9626acd1011d", "name": "/issues/issue-5",         "source": "url",   "start": 1787756643701 },
    { "spanId": "ab9391fa9d7e582d", "name": "/issues/:id/comments",    "source": "route", "start": 1787756643702 },
    { "spanId": "0d2061a513cf5c65", "name": "/issues/issue-5/comments","source": "url",   "start": 1787756644135 },
    { "spanId": "66ac69d6de5c035b", "name": "/issues/issue-5/comments","source": "url",   "start": 1787756644135 }
  ]
  ```
  Span `ab9391fa9d7e582d` started **1ms** after `938d9626acd1011d` — i.e. it IS the issue-5-overview
  navigation's own transaction (same click, same instant) — yet it uploaded named
  `/issues/:id/comments` (the route pattern for the SECOND, later click). The transaction that
  measured the overview page's navigation is labelled as if it measured the comments tab. A latency
  dashboard grouped by transaction name would attribute one route's timing to another route entirely.
  (The comments-tab navigation's OWN transaction, in turn, never gets refined at all and stays
  `url`-named — the same defect as the single-navigation case above.)
- **Reproduce:** `samples/solid-spa`, `pnpm dev`, `pnpm verify` — `solid-route-name-wire` in the printed
  table now covers BOTH cases in one check: the single-navigation case (no navigation transaction is ever
  route-named) and, as its second positive control, the two-click misattribution probe (issue list → an
  issue → its Comments tab ~400ms apart, i.e. inside the 1s idle window), asserting that a
  `bugsee.name_source: "route"` transaction DOES appear there. Both halves read from the same
  `page.on('request')` listener on `/v2/performance/transactions`.
- **Why the misattribution probe is also the check's falsifiability control:** "no navigation transaction
  is route-named" is trivially satisfied by an app that never wired the integration at all — deleting
  `<RouteNameSync/>` from `src/routes/RootLayout.tsx:32` would leave the single-navigation assertions
  green and this finding's regression pin silently vacuous. The misattribution probe is the only
  available positive evidence that `RouteNameSync`'s `createEffect` exists, fires, and reaches
  `setRouteName` — so the check requires it, and deleting `<RouteNameSync/>` now turns
  `solid-route-name-wire` RED.
- **Fix direction (not applied — sample authors don't fix SDK code):** the naming refinement needs to
  target the transaction for the navigation `matches()` is describing, not "whatever is currently
  active" — e.g. defer `setRouteName` until the navigation-start hook has actually created that
  navigation's transaction (matching effect fire to the SAME navigation, not the previous one), or have
  the navigation source itself read the resolved route pattern at start time instead of relying on a
  separately-wired effect that races it.

### B · Recovery after a crash uploads the SAME incident TWICE — deterministically, not as a race

- **Severity:** major (raised this pass). A crash-then-reload double-uploads — two `/v2/issues` POSTs,
  two S3 bundle PUTs, `events_count: 2` on the backend from ONE incident — whenever the reload lands
  **inside the vulnerable window**: past ~40ms (the durable queue has taken its copy of the bundle) AND
  before the original upload settles (**~3.5s on this sample**; see "The window has an upper bound too"
  below). Not an occasional race — inside that window it is 7/7 in this session (2 isolated probes at
  40ms, 3 at 250ms, and both closing full `pnpm verify` sweeps), plus the re-reviewer's 12/12 across six
  different delays, 3/3 in round 3's closing `pnpm verify` sweeps and 5/5 in round 4's. There is also a
  second, opposite leg (recovery starved to ZERO deliveries), below.
- **The window has an upper bound too (measured this pass, on this sample):** the marker is what makes
  the second leg possible, and `client.ts:510-515` clears it once the upload **settles** — so once the
  incident's own upload completes there is nothing left to double up. Timed from the `logException`
  call: the `POST /v2/issues` does not leave until **+1835ms**, and the S3 bundle PUT settles at
  **+3486ms**. A reload after roughly that point finds one durable description, not two, and recovery
  produces at most one upload. The bound is per-app (it is upload latency, not a constant); on a slower
  network or a larger bundle it is wider.
  **Correction (round 4).** An earlier version of this bullet explained `samples/angular-spa`'s single
  delivery as "it waits ~180 s of quiet after the crash before reloading — past the upper edge". That
  was wrong in both halves, and it was the mirror image of the mistake this sample made at 5 ms.
  angular-spa's ~180 s quiet wait PRECEDES its S12 click; it is not between the crash and the reload.
  And angular-spa reloads **5 ms** after `logException`
  (`samples/angular-spa/src/app/scenarios/scenario-panel.component.ts:527`), which is below the window's
  LOWER edge: the bundle has not reached the durable queue yet, so leg 1 has nothing to re-upload and
  only `recoverReports` fires. **angular-spa demonstrates the LOWER edge, exactly as this sample did at
  its own original 5 ms** — the reference measurements are this file's own: 5 ms → 1, 40 ms → 2,
  250 ms → 2. (`samples/react-spa`, a wave-1 sample, is also at 5 ms. angular-spa has DECIDED to keep
  5 ms and record the cost — its S12 does not exercise the duplicate path — because this sample at
  250 ms and `svelte-spa` at 50 ms already cover inside-the-window.)
- **Package:** `@bugsee/core` (`packages/core/src/client.ts:496` persists a `ReportMarker` **before**
  the upload starts; `:510-515` clears it only once the upload **settles**) + `@bugsee/browser-utils`
  (`recoverSiblingBundleQueue`, `packages/browser-utils/src/recover-dead-instances.ts:14-46`) +
  `@bugsee/core` (`recoverReports`, `packages/core/src/capture-recovery.ts:41-104`) — both legs run
  from INSIDE `coexistence.recoverDeadSiblings` (`packages/browser-utils/src/coexistence.ts:181` calls
  `recoverSiblingBundleQueue`; `packages/browser/src/launch.ts:516-533` wires `recoverReports` in as
  `recoverReportsForViews`), inside the SAME `recoverIfDead` callback, with **no de-duplication between
  them** — and **not** `durable.recover()`, which `packages/browser/src/launch.ts:504-508`'s own comment
  says is "a no-op over its fresh prefix" for the persist path (every launch gets a fresh `instanceId`,
  so self's own durable queue is always empty at start; the previous launch is just another dead
  sibling).
- **Scenario:** S12 — `logException` followed by a hard reload (`s12-crash-and-reload`,
  `ScenarioPage.tsx`'s S12 control).
- **Root cause (fully traced):** `@bugsee/core`'s durable upload pipeline persists the bundle to the
  durable queue **and then** hands it to the upload pipeline — the ordering is pinned by the SDK's own
  test at `packages/core/src/durable-upload-pipeline.test.ts:111`
  (`expect(order).toEqual(['put', 'enqueue']) // persisted, THEN uploaded — not the reverse`).
  Independently, the report marker is written before assembly (`client.ts:496`) and cleared only when
  the network upload settles (`client.ts:510-515`). So from the instant the durable `put` lands until
  the upload settles, TWO independent durable descriptions of one incident coexist. Terminate the page
  in that window and the next launch's `recoverDeadSiblings` runs BOTH: `recoverSiblingBundleQueue`
  re-uploads the already-queued bundle, and `recoverReports` rebuilds a *fresh* bundle from the marker
  plus the preserved capture chunks. Nothing tells either leg the other exists.
- **Why this was previously (and wrongly) recorded as "a nondeterministic race this session could not
  re-trigger":** the sample's own control reloaded **5ms** after `logException`. At 5ms the bundle has
  not yet reached the durable queue, so only the marker survives, only the `recoverReports` leg runs,
  and the result is always exactly **1**. 5ms was the single timing that structurally *cannot* expose
  the defect — and no real user reloads 5ms after a crash. Measured on this sample, this pass, by
  remapping only that one timer:

  | reload delay after `logException` | `/v2/issues` POSTs observed | runs |
  | --- | --- | --- |
  | 5ms (the old control) | **1** | 2/2 |
  | 40ms | **2** | 2/2 |
  | 250ms (the control now) | **2** | 3/3 |

  The re-reviewer independently measured 40 / 80 / 150 / 300 / 600 / 1200ms → 2 uploads in 12/12 runs.
  The control now reloads at **250ms** and `scripts/verify.mjs`'s `s12-persist-recover` asserts
  `=== 2` (the previous `1 or 2` tolerance could never observe 2, so it was green on the one timing
  that cannot reproduce the bug).
- **Wire evidence (instrumented single click, this pass):** one click on the S12 control produced two
  `POST /v2/issues` (identical `summary`: `"S12: persist+recover across a hard reload"`, ~1.6s apart)
  and two S3 bundle PUTs ~1.4s apart. Unzipping both by their plaintext zip entry names shows they are
  the two DIFFERENT legs, not a retry of one bundle:
  ```
  PUT#1  +0ms     5283 bytes  8 entries, incl. [request.json, crash.json, viewtree.json]
  PUT#2  +1353ms  2483 bytes  7 entries, incl. [request.json, crash.json]   (no viewtree.json)
  ```
  The entry lists above are ABBREVIATED to the three that distinguish the legs — the real bundles carry
  8 and 7 entries respectively; the entry counts and byte sizes are exact. The `viewtree.json` present
  in the first and absent from the second is what identifies them: only a bundle assembled while the page
  was still alive can carry a view-tree snapshot, so PUT#1 is the pre-crash bundle the durable queue
  had already taken (re-uploaded by `recoverSiblingBundleQueue`) and PUT#2 is the smaller bundle
  `recoverReports` rebuilt from the marker plus the preserved capture chunks after the reload.
- **Backend evidence:** the S12 incident's issue (`S12: persist+recover across a hard reload`,
  `Trigger: error`, `Mechanism: programmatic`) moves by **exactly +2 per click** of the S12 control,
  never +1. When first raised under key `SSOLID-68` it read `events_count: 2` immediately after a SINGLE
  click and `4` after the next sweep's single click. Re-derived this pass as `SSOLID-80` (same incident,
  new stack signature — see the key note in `scenarios.md`), it reads `events_count: 14` after seven
  clicks (10 → 12 → 14 across round 3's three closing sweeps and 26 → 36 across round 4's five, +2 for
  each single click, on eleven consecutive sweeps). Every crash is counted twice.
  (The original `SSOLID-39`/`SSOLID-52`/`SSOLID-68` observations are the same defect under earlier stack
  signatures — in dev the vite `?t=` cache-buster is part of the signature, and a dev-server RESTART
  removes it again, so both an edit and a restart re-mint the key for the identical incident.)
- **Real-world impact:** a crash followed by a reload landing in the ~40ms-to-~3.5s window — which is
  precisely the human range (a user hitting reload on a page that just broke, a crash-loop, an
  auto-refresh) — is counted twice: inflated `events_count`, doubled bundle upload volume and quota, and
  two dashboard events for one user-visible failure. A reload much later than the upload's own settle
  time is unaffected, which is why this stays invisible to any check that waits for quiet before
  reloading.
- **Lost leg — a real ordering hazard this sample's OWN sweep had to correct for:** `scripts/verify.mjs`
  runs a 200-exception storm (S4) that deliberately exceeds the capture rate limiter's ~100/60s budget
  (`samples/FINDINGS.md` F-X19). When S12's single recoverable exception was scripted to run
  **immediately after** that storm (this sample's original ordering), it produced **zero** `/v2/issues`
  calls across the reload — the recovery pipeline's own attempt was itself rate-limited away, not
  merely "not yet delivered." `scripts/verify.mjs` now runs S12 **before** the S4 storm (see the ordering
  comment at the S12 block) specifically so the scenario that must survive is not the one starved of
  budget; the storm runs last, once nothing after it still needs the capture budget.
- **Reproduce (duplicate leg):** `samples/solid-spa`, `pnpm dev`, then either
  (a) `pnpm verify` and read `s12-persist-recover` (it asserts exactly 2 recovered `/v2/issues` calls),
  or (b) manually: `/scenarios` → "logException then hard-reload (250ms)" (`s12-crash-and-reload`),
  ONE click, isolated (no prior storm), with a `page.on('response')` listener counting `v2/issues` for
  at least 8s after the reload — the second call lands ~1.5s after the first. Reload delays from ~40ms
  up to the upload's own settle time (~3.5s here) reproduce; the original 5ms is below the window (the
  bundle has not reached the durable queue yet) and a delay past the settle time is above it (the marker
  is already cleared) — both ends give 1.
- **Fix direction (not applied):** de-duplicate the two recovery legs (e.g. have
  `recoverSiblingBundleQueue` skip an id that a marker-based recovery is already handling for the same
  generation, or clear the marker as soon as the bundle is durably QUEUED rather than once the network
  upload SETTLES — matching the design comment's own stated intent, "safe to hold only until the
  durable bundle queue owns delivery"). Whichever side is chosen, `s12-persist-recover` and this
  finding must be updated together — that check is currently the regression pin for the defect.

### C · Installing ANY network filter disables the built-in PII sanitizer — real, deliberate, and undocumented for filter authors

- **Severity:** minor — **re-graded (round 3) from "major (privacy) SDK defect" to a DOCUMENTATION
  gap.** The behaviour below is real and — as of round 4 — genuinely confirmed at wire level rather
  than only in the sample's own filter callback (see "Observed" below), but it is a deliberate design
  decision with a binding precedent, not an undiscovered defect: see "Why this is graded as a docs
  gap" below. The one thing genuinely missing is a line in the PUBLIC docs — a filter author has no
  way to learn this from the API surface.
- **Package:** `@bugsee/capture` (`packages/capture/src/network-provider.ts:151-160` —
  `if (filters?.network) { … } else if (this.#sanitizeDefault) { … }`: a user filter REPLACES the
  default sanitizer rather than composing with it)
- **Scenario:** S8 — `setNetworkEventFilter`. This sample installs exactly such a filter (see F-1
  below) and, before this pass, never checked whether the default sanitizer still ran alongside it.
- **Observed:** with a network filter installed whose own logic never touches the request URL, a
  request to `/api/scenario/get?token=SUPER_SECRET_TOKEN_VALUE` — a `token=` query parameter, in the
  default sanitizer's own denylist pattern — reached the filter callback with the URL **completely
  unredacted**: `network: sanitizer-disabled-by-filter — raw url reached the filter unredacted:
  /api/scenario/get?token=SUPER_SECRET_TOKEN_VALUE` (confirmed live in the in-app filter log and
  asserted on in `scripts/verify.mjs`'s `s8-sanitizer-disabled` check, PASS). Without ANY filter
  installed, the same URL is redacted by the default sanitizer before anything else ever sees it.
  **Round-4 correction to this entry's own evidence:** until round 4 the only evidence here was that
  filter-log line, which the sample's OWN callback writes — that proves the URL reached the CALLBACK
  unredacted, not that it left the process unredacted (the sanitizer could in principle have run later
  in the pipeline). `scripts/verify.mjs`'s new `s8-sanitizer-disabled-bundle-wire` closes that: it
  unzips `network.json` out of the bundle the S8 report actually uploaded and finds
  `token=SUPER_SECRET_TOKEN_VALUE` verbatim inside it. The claim "confirmed at wire level" is now
  literally true. An
  app that installs a network filter to handle one narrow case (drop a header, redact one body field —
  exactly what this sample's own filter does) loses URL/credential scrubbing, sensitive-header
  sanitization, and the body-key denylist on **every other request**, with no signal at the API
  surface that protection was lost.
- **Why this is graded as a docs gap, not an SDK defect (the correction this pass makes):** the
  original entry cited `network-provider.ts:151-160` while omitting the comment three lines above it,
  **inside the same function**, which names the behaviour: `network-provider.ts:137-139` —
  *"The built-in PII sanitizer is gated by its option (default on); a user network filter supersedes
  it entirely (**Android XOR rule**)."* Android is this SDK's binding API **and** architecture parity
  target (`CLAUDE.md` §Design), `docs/PROGRESS.md` records the XOR as intentional in two places (the
  core DI/filters section and the F.1 capture row: *"The user network filter REPLACES the built-in
  sanitizer (Android XOR)"*), and the SDK's own convergent review already triaged it —
  `docs/review/capture.md:216`: *"The XOR (a user network filter replaces the built-in PII sanitizer)
  is **the deliberate Android rule, not a defect** — but it is worth an explicit line in the public
  docs, because a user adding a filter merely to drop `/health` requests silently forfeits
  `Authorization`/`Cookie` redaction."* This sample's observation lands on exactly the surprise that
  review predicted, at wire level and from a real app — which is worth recording as corroboration. It
  is not a new defect, and filing it as one against the parity target would be arguing that Android's
  own contract is wrong; if that argument is ever made it belongs in a design discussion, not a
  sample's findings file.
- **What is genuinely open:** the public-docs line `docs/review/capture.md:216` asked for still does
  not exist. `setNetworkEventFilter`'s own documentation should state that installing a filter turns
  the built-in sanitizer OFF for network events, and that a filter which wants both must call the
  sanitizing behaviour itself.
- **Reproduce:** `samples/solid-spa`, `/scenarios` → "Install filters" → "sensitive URL" control
  (`s8-sensitive-url`), read the in-app filter log for `sanitizer-disabled-by-filter`.
- **Fix direction (docs, not code):** document the XOR at the `setNetworkEventFilter` surface. Changing
  the composition (sanitize first, then hand the sanitized event to the user filter) would be a
  divergence from Android and needs a cross-SDK decision, not a unilateral JS change.

### D · `.bugsee-unmask` on an input is honoured on the FULL-SNAPSHOT path only — a value TYPED DURING recording stays masked

- **Severity:** minor (fails CLOSED — more masking than the app asked for, never less)
- **Package:** the rrweb fork (`github:bugsee/rrweb#bugsee-dist`), NOT `@bugsee/replay`'s masking config
- **Scenario:** S11 — session replay, `.bugsee-unmask` opt-out on an `<input>`
- **Expected:** an input marked `.bugsee-unmask` has its value recorded verbatim, whenever that value
  is set. `packages/replay/src/masking.ts:544-548` feeds the mark to rrweb as BOTH `unmaskTextSelector`
  and `unmaskInputSelector` (the latter guarded so a sensitive input can never match), i.e. the SDK-side
  configuration asks for the value on both the snapshot and the incremental path.
- **Observed:** only the snapshot path honours it. Measured in ONE decoded `replay.bin`, with a distinct
  probe per path so the two cannot be confused:
  - value present in the field when the recorder took its full snapshot → **present** in the stream;
  - value typed into the same field afterwards, during recording → **absent**.
  The un-marked sibling input is masked on both paths (the control that proves masking is active at all),
  and with `maskAllInputs: false` the typed value DOES come through — so the incremental observer can
  emit raw values; it just does not consult the per-element mark.
- **Independently confirmed:** two peer samples reported the same split. It is not re-diagnosed here.
- **Reproduce:** `pnpm verify` → `s11-unmask-mark-typed-value`, which PINS the split (snapshot probe
  visible, typed probe absent) and therefore turns RED if the fork starts honouring the mark on the
  incremental path.
- **Watch out (this is how the finding was nearly recorded backwards):** a relaunch does not reload the
  page, so whatever is in an input when the new recorder snapshots it is recorded by the snapshot path.
  The first version of this check reused ONE probe string across the relaunch and re-typed it after —
  and reported the mark working on BOTH paths, because the "typed" needle was matching the snapshot's
  copy. Split into `…-snap` / `…-typed` values, the answer inverts. A single-probe masking check cannot
  tell these two paths apart, whatever it claims to measure.

### F-1 · `setNetworkEventFilter` veto is per-`NetworkStage`-ENTRY, not per-REQUEST — a veto rule can leak the other stage's data through

- **Severity:** major (re-graded from minor — see below; this is a data-safety hole, not just an
  ergonomics surprise)
- **Package:** `@bugsee/capture` (`packages/capture/src/network-provider.ts:145` —
  `source.onAny((_stage, raw) => …)` routes every `NetworkStage` of every request through the filter
  SEPARATELY, and a `return null` only drops the entry for THAT stage) + `@bugsee/capture`
  (`packages/capture/src/fetch-interceptor.ts:297` — the async `override:true` `complete` amendment
  that carries the RESPONSE body, a separate stage-entry from `before`, which carries the REQUEST body)
- **Scenario:** S8 — `setNetworkEventFilter`, veto. PLAN §4 S8 lists "veto a request" as a first-class
  case; it is unachievable as a single-predicate rule unless the predicate happens to be
  stage-invariant (present identically on every stage-entry of that request) — e.g. `event.url`, which
  is why the sample's ORIGINAL veto rule (`ScenarioPage.tsx:78-81`, matching on `event.url`) worked and
  never surfaced this hole.
- **Observed (this pass, `s8-veto-per-entry-hole` in `scripts/verify.mjs`, `SSOLID` staging):** a rule
  written the way PLAN §4 describes — veto a request based on its REQUEST BODY containing a specific
  marker (`VETO_REQUEST_BODY_FIELD`) — correctly vetoes the `before` stage-entry (which carries the
  request body), but the SAME logical request's `complete` stage-entry (which carries the RESPONSE
  headers/body, via the `override:true` amendment above, and has no request-body field to match) sails
  through **un-vetoed**: the in-app filter log shows both
  `VETOED(request-body-rule) …/scenario/veto-body-target …` and, moments later,
  `leaked-despite-veto-intent(request-body-rule) …/scenario/veto-body-target …` for the SAME URL.
  **Round 4 added the wire half of this evidence:** both of those lines are written by the sample's own
  callback, so on their own they prove only that the callback ran twice and branched differently.
  `s8-network-bundle-wire` now unzips `network.json` out of the real uploaded bundle and finds
  `veto-body-target` PRESENT in it, while `veto-me` — the URL-keyed rule, stage-invariant, vetoed on
  every stage-entry — is absent from the same file. The leak is therefore visible in what actually left
  the process, and the contrast between the two URLs is the cleanest statement of the defect.
  The app intended to drop the whole request from capture; instead the response half of it — including
  whatever body/headers it carries — reaches capture regardless.
- **Why this is NOT just a documentation gap (upgraded from F-1's original minor grading):** a filter
  author who follows PLAN §4's own framing ("veto a request") and keys the rule on a REQUEST-side
  field, exactly as this sample now does, produces a rule that silently fails to protect half of the
  data it was written to drop. This is a real data-safety hole, not merely a surprising call count.
- **Also still true (the original, now-secondary observation):** the filter fires multiple times per
  logical request (once per `NetworkStage`), each call seeing only whichever subset of
  `custom.headers`/`custom.body` that stage happens to carry — undocumented for filter authors, and
  itself confusing independent of the veto hole above.
- **Reproduce:** `samples/solid-spa`, `/scenarios` → "Install filters" → "veto a request by its BODY"
  (`s8-veto-request-body`), read the in-app filter log.
- **Fix direction (not applied):** either key veto decisions on a per-REQUEST identity (so a veto on
  any stage-entry drops every stage-entry sharing that identity) or clearly document that a filter
  author who wants to veto a whole request must independently recognize and veto EVERY stage shape
  their predicate might see.

### F-2 · A single report can carry a self-contradictory `handled` signal — `crash.json` says `handled: false` while the report `type`/displayed label say "Handled error"

- **Severity:** minor (the individual pieces are each intentional and documented in source; the
  finding is that composing them produces a genuinely contradictory artifact, not that either piece
  alone is wrong)
- **Package:** `@bugsee/browser` (`packages/browser/src/detection-providers.ts:41-46` `crashOf()` —
  unconditionally builds `crash.json` with `handled: false`, used by BOTH the window-error AND the
  unhandledrejection providers, including at `:142` for the rejection path) + `@bugsee/core`
  (`packages/core/src/detection-provider-base.ts:55-58` — `createErrorReport` stamps `source.type:
  'error'`, which the dashboard/`get_issue` render as `Type: Handled error`)
- **Scenario:** S5 — Crashes, unhandled promise rejection.
- **Note — this REPLACES the sample's original F-2, which was mis-diagnosed:** the original entry
  observed that `window.onerror` classifies `Type: Crash` while `unhandledrejection` classifies `Type:
  Handled error`, and concluded this was "by design… a PLAN-wording ambiguity." That observation is
  still accurate (confirmed on `SSOLID-34` vs `SSOLID-49`, which the same control re-derives to
  `SSOLID-77` after this pass's source edits — in dev the vite `?t=` cache-buster is part of the stack
  signature, so every edit re-mints the key for the identical incident), but the diagnosis stopped one
  layer too shallow — the actual defect isn't the wording of a catalog row, it's that the SAME
  uploaded report bundle carries an internal contradiction between two of its own fields.
- **Observed (this pass — read directly from the uploaded bundle, not just the dashboard label):**
  triggering `s5-rejection` and unzipping the resulting S3-uploaded bundle (the matching backend issue
  was `SSOLID-49` at the time of that unzip and is `SSOLID-77` now — re-checked this pass, still
  `Type: Handled error`, `Trigger: error`, `Mechanism: unhandledrejection`) —
  `request.json` in the SAME bundle:
  ```json
  {"type":"error","source":{"type":"error","mechanism":"unhandledrejection"}, ...}
  ```
  `crash.json` in the SAME bundle:
  ```json
  {"exception_type":"error","handled":false,"exception":{"reason":"S5: unhandled promise rejection", ...}}
  ```
  One report says `handled: false` on the wire (`crash.json`) and "Handled error" on screen (derived
  from `request.json`'s `type`), for the identical incident, with `Mechanism: unhandledrejection` sitting
  right next to both.
- **Reproduce:** `samples/solid-spa`, `/scenarios` → "Unhandled rejection" (`s5-rejection`); intercept
  the S3 bundle PUT and unzip `crash.json` + `request.json` (a `page.on('request')` PUT listener +
  `fflate.unzipSync`, the same technique `scripts/verify.mjs`'s `zipEntry` uses for the S7/S8/S11
  bundle checks).
- **Fix direction (not applied):** either stamp `crash.json.handled` from the SAME source-of-truth the
  report `type` comes from (so an `unhandledrejection`-mechanism report's crash payload also says
  `handled: true`/omits the field), or stop deriving the displayed "Handled"/"Crash" label from report
  `type` alone and surface `crash.json.handled` as the authoritative signal instead.

## Resolved (this sample's own bugs, not SDK defects — recorded for the lesson)

### F-3 · `ScenarioPage.tsx` captured `getClient()` once at component creation, going stale after every relaunch — a Solid-specific gotcha, fixed here

- **Severity:** was a real functional bug in THIS sample (not `@bugsee/solid`).
- **What happened:** the first version of `ScenarioPage.tsx` wrote `const client = getClient();` at the
  top of the component, following the exact pattern `react-spa`'s `ScenarioPage.tsx` uses. In React,
  this is safe: a function component's body re-runs on every re-render (triggered by any `useState`
  update anywhere in the tree that owns it), so `getClient()` is re-evaluated constantly and always
  picks up the client `relaunch()` most recently produced. **Solid components run their setup function
  exactly ONCE, at creation** — only the fine-grained reactive computations inside re-run. So after the
  first relaunch in a session (`s1-relaunch-minimal` or `s1-relaunch-full`), every later `client?.xxx`
  call in that same mounted `ScenarioPage` instance was silently operating on the OLD, now-`stop()`ped
  client — every `logException`/`log`/`event`/`trace`/`addBreadcrumb` call became a complete no-op with
  no error, no console output, nothing.
- **How it was found:** this sample's OWN verify-script discipline of asserting real evidence, not
  `record(..., true)` — see the top-level HARD RULES this build followed. Once `s4-error` etc. asserted
  on an actual `/v2/issues` network call rather than "the button was clicked", the whole S4 block failed
  outright after a relaunch, with literally ZERO bugsee/aws requests observed for 90+ seconds (confirmed
  via a `page.on('request')` listener in an isolated repro). Fixed by changing `client` to a getter
  function (`const client = () => getClient();`) and calling it fresh (`client()`) inside every event
  handler, in both `ScenarioPage.tsx` and `SettingsPage.tsx`. Re-ran the full sweep clean afterward:
  46/46, with `s4-error` etc. producing real `/v2/issues` calls within ~1s of the click.
- **Not filed as an SDK finding** — `@bugsee/solid` did nothing wrong; this is a property of Solid's
  reactivity model that any Solid app author (not just this sample) needs to know when caching a value
  across a rebuild. Recorded here because it is exactly the kind of "framework adaptation sharp edge"
  `samples/FINDINGS.md`'s F-X21 (react-spa) warns about, and it was caught by the same discipline.

### F-4 · The app-level `<ErrorBoundary>` fallback used `@solidjs/router`'s `<A>`, which throws when rendered outside a `<Router>` — fixed here

- **Severity:** was a real bug in THIS sample's `ErrorFallback.tsx` (not `@bugsee/solid` or
  `@solidjs/router`).
- **What happened:** `main.tsx` wires `<ErrorBoundary fallback={...}><AppRouter/></ErrorBoundary>`, where
  `<AppRouter/>` is what creates the `<Router>` context (it renders `<Router root={RootLayout}>…`). When
  the boundary's fallback renders, it REPLACES `<AppRouter/>` entirely — so the fallback is rendered
  OUTSIDE any Route context. The original `ErrorFallback.tsx` used `<A href="/issues">`, which throws
  `"<A> and 'use' router primitives can be only used inside a Route"` the moment it tries to render,
  producing a SECOND, uncaught error that escapes past the very boundary that was supposed to contain
  the first one — confirmed via `page.on('pageerror')` and reproduced as issue `SSOLID-10`
  (`Type: Crash`, stack in `@solidjs/router`'s `utils.js:29` `invariant()`), from an early sweep run
  before this was found and fixed.
- **Fix:** `ErrorFallback.tsx` now uses a plain `<a href="/issues">` (a full page reload on click, which
  is the right degradation for a fatal-error screen anyway). Re-verified: `arm-global` now correctly
  shows the app's own fallback (`error-fallback` renders, confirmed both locally and on the backend as
  `SSOLID-7`), with no secondary page error.
- **Not filed as an SDK finding** — this is purely about where this sample's OWN error-boundary
  fallback sits relative to its OWN router, not a defect in either package.

### F-5 · `scripts/verify.mjs`'s `s2-attrs-before-after-event` check raced its own evidence — fixed here

- **Severity:** was a real bug in THIS sample's verify script (not `@bugsee/solid`).
- **What happened:** the check clicked a control whose handler `await`s a `logException()` call, then
  sets attributes and a status line AFTER it resolves. The check waited for the triggering issue call to
  reach the wire (`waitForCalls(isIssueCall, …)`), then read the status-line text IMMEDIATELY —
  assuming the click handler's own continuation (which the wire evidence does NOT bound) had already
  finished. A debug probe showed the handler's final `setStatus()` call landing **~3 seconds** after the
  network response — the SDK's internal submit promise does not settle in lockstep with the HTTP
  response reaching Playwright's listener. The check read a STALE status line (`"clearAllAttributes()"`,
  left over from the PREVIOUS control) and failed, even though the handler was behaving correctly and
  had simply not finished yet.
- **Fix:** added `waitForLocatorText`, a small poll loop, and used it to wait for the actual expected
  text (containing `set-after-event`) instead of reading the locator once. Re-ran clean afterward
  (56/56 at the time; the suite is 67 checks as of round 5).
- **Not filed as an SDK finding** — this is a test-timing bug in this sample's own verify script, not a
  defect in the SDK's `logException`/`setAttribute` behaviour.

### F-6 · The S8 "should be VETOED" control had no `filtersInstalled()` guard, so it could upload the report it exists to prove never arrives — and the scenario had no backend check that would have noticed

- **Severity:** major as a VERIFICATION gap; **not an SDK defect** (see below). Found by the round-4
  re-review, fixed here.
- **Package:** none — `samples/solid-spa` itself (`src/routes/ScenarioPage.tsx`, the `s8-report-veto`
  control; `scripts/verify.mjs`, the S8 block).
- **Scenario:** S8 — `setReportHandler` `before`, veto.
- **The counter-example that surfaced it:** staging carries `SSOLID-82`
  (`6a8f5dcbd58badbb34924a7a`, created 2026-08-26T21:42:34Z, `events_count: 1`), `# Labels` →
  `VETO_REPORT`, message `S8: report handler should VETO this — must never arrive`, stack
  `ScenarioPage.tsx:507:57`. Its sibling `_el$108` at `:504:57` is `SSOLID-78`, the MUTATE control —
  consecutive transpiled element indices, so this is the current source's signature, not a stale build.
  `scenarios.md` meanwhile claimed "no issue created" at depth `W`.
- **Not an SDK defect — verified directly.** `packages/core/src/client.ts:670-673`:
  `applyReportBefore(request)` returning `null` produces `{ok: false}` and returns BEFORE
  `submitReport(handled)` is reached, so a genuinely vetoed report structurally cannot upload. The
  mechanism is entirely sample-side.
- **Root cause:** the veto button carried no `disabled={!filtersInstalled()}` guard, unlike its own
  neighbour `s8-uninstall`. Clicked before "Install filters" (or after "Uninstall filters") there is no
  report handler at all, nothing vetoes anything, and the exception uploads legitimately. Only the
  scripted sweep ever installs filters first; any manual/exploratory click of the panel — which is
  exactly what a scenario panel invites — produced this.
- **Why it survived three review rounds, which is the real finding:** the row's whole point is "this
  report must never reach the backend", and the sample verified it by counting browser requests in a
  ~2 s window. `docs/samples/PLAN.md` §6.3 asks for `list_issues` polling and §6.4 for "anything
  redacted in S8 is absent" confirmed on the BACKEND, and this sample never once queried staging for
  this message. The design structurally could not observe the exact failure the scenario names as its
  purpose.
- **Fixed here, in three parts:** (1) `disabled={!filtersInstalled()}` on BOTH report-handler controls
  (the MUTATE one had the same hole — clicked without filters it uploads without the `redacted-before`
  label, silently weakening `scenarios.md`'s S8 mutate row); (2) `s8-report-controls-guarded` asserts
  the guard in both directions, so it cannot regress to "always disabled" either; (3)
  `s8-report-veto-backend` queries staging over MCP after every sweep, across every issue updated since
  the S8 block opened, and requires the MUTATE report from the same block to be FOUND by the same query
  as its positive control. The matcher was falsified against `SSOLID-82` itself: the exact string
  `s8-report-veto-backend` searches for DOES match that issue's `get_issue` output, so a real leak in
  the window goes red.
- **Status of `SSOLID-82`:** a genuine upload of a real, un-vetoed exception — the data is correct, the
  *label* on it ("must never arrive") is what makes it look alarming. It is a sample artefact, not
  evidence of an SDK veto failure, and it stays on staging as the record of this finding. Nothing needs
  to be filed against the SDK.

### F-7 · This sample marked its replay opt-out input `.bugsee-show`, which does not opt an input out of anything — fixed here

- **Severity:** major (a sample that documents the WRONG privacy mark teaches the wrong mark)
- **Where:** `src/routes/ScenarioPage.tsx`, S11 section
- **What was wrong:** the field was `class="bugsee-show"` and both its label and `scenarios.md` claimed
  it "opts out of masking". It does not. `packages/replay/src/masking.ts:544-549` routes `.bugsee-show`
  to rrweb's `unblockSelector` — it un-BLOCKS media (img/video/audio/canvas) — while the text/input
  opt-out is `.bugsee-unmask`. The claim was never checked, because the whole S11 section stopped at
  "relaunch did not throw".
- **How it survived:** nothing decoded `replay.bin`, so no check could tell an honoured mark from an
  ignored one. Two peer samples shipped the identical defect, which suggests the class pair is easy to
  confuse from the option names alone and is worth an explicit line in the public docs.
- **Fixed:** the input now carries `.bugsee-unmask`, and `s11-unmask-mark-typed-value` measures what the
  mark actually does — per path, in the decoded stream (finding D above).

### F-8 · The sample's "Restore (replay off)" control stopped turning replay off when the SDK flipped its default — fixed here

- **Severity:** major (the control, its label, its status line and its scenarios.md row all asserted
  something that was no longer true, and no check could see it)
- **Where:** `src/routes/ScenarioPage.tsx` S11 control `s11-replay-off`; `scripts/verify.mjs`
- **What was wrong:** the control called `relaunch(FULL_LAUNCH_OPTIONS)` and printed "relaunched with
  replay off". `FULL_LAUNCH_OPTIONS` names no `replay` key at all — which used to mean OFF and now
  means ON (`packages/browser/src/launch.ts`: `options.replay !== false && domDocument !== undefined`).
  After the flip the control left replay recording while claiming the opposite, and the sample had no
  control that exercised the opt-out at all.
- **The check it took down with it:** `s11-replay-bundle-wire` asserted "replay is ON (explicit masking)
  — the uploaded bundle contains a replay.bin entry". Post-flip `replay.bin` rides EVERY bundle this
  sample uploads, so that row stayed green while measuring nothing about the control it named. This is
  the same class as the `CapturedCall.status` gap below: a green row whose subject had moved.
- **Fixed:** `s11-replay-off` now passes `replay: false` and a separate `s11-replay-restore` restores the
  baseline; the single row is replaced by the matched pair `s11-replay-default-on` (no `replay` key →
  `replay.bin` present) / `s11-replay-optout-wire` (`replay: false` → absent, with `crash.json` as the
  positive control). Falsified by mutation: making the opt-out control pass `replay: true` turns the
  negative row red.

### F-9 · Every "the uploaded bundle contains X" row read the bundle the SDK SENT, not the one the collector ACCEPTED — fixed here

- **Severity:** major (a total S3 outage would have left the bundle rows green)
- **Where:** `scripts/verify.mjs` — the bundle tee
- **What was wrong:** bundle bytes were captured on `page.on('request')`, so `s8-network-bundle-wire`,
  `s8-sanitizer-disabled-bundle-wire` and the old S11 replay row all asserted on a request body. The
  upload's response status was never consulted. A peer sample proved the consequence by fulfilling every
  non-localhost PUT with 500 and watching its wire rows stay green.
- **Fixed:** the tee moved to `page.on('response')`, pairing each bundle's bytes with the status S3
  returned; `acceptedBundlesSince()` (2xx only) is the sole accessor the checks use, and the detail
  strings print the statuses so a rejected upload reads as a rejection rather than as "0 bundles".
- **Falsified by mutation, on this sample:** with every bundle PUT fulfilled as 500, all four
  bundle-content rows go RED and their details read `0 ACCEPTED bundle(s) … (upload statuses: [500])` —
  the bytes were still captured, they were simply no longer counted as evidence.

### F-10 · The S8 bundle read had no wait of its own and could read an empty set — fixed here

- **Severity:** minor (flaky red, never a false green)
- **Where:** `scripts/verify.mjs`, `s8-network-bundle-wire` / `s8-sanitizer-disabled-bundle-wire`
- **What was wrong:** the S8 bundle slice relied on the incidental slack of the preceding
  `waitForQuiet()`, which settles on `/v2/issues` traffic and can go quiet BEFORE the S3 PUT is even
  attempted. Caught in this pass on a real run: both rows failed with `0 ACCEPTED bundle(s) … (upload
  statuses: [])` — nothing to read, rather than a wrong answer.
- **Fixed:** `await waitForAcceptedBundles(s8BundleIdx)` before the read, the same "wait for the
  evidence, do not time-box it" rule `samples/FINDINGS.md` F-X19 prescribes.

### F-11 · One run in six went silent for ~20s — UNDIAGNOSED, and the sweep could not see why. Instrumented, not fixed

- **Severity:** unknown (observed once in six consecutive final runs; no data loss claim either way)
- **Where:** `solid-resource-error` and `solid-route-name-wire`, two checks this round did NOT modify
- **Observed:** in run 1 of the six final sweeps, `solid-resource-error` reported
  `fallback visible=true, issue calls=0` after its full 20s `waitForCalls` window, and the very next
  check, `solid-route-name-wire`, saw `single nav: []; misattribution probe: []` — no `/v2/issues` call
  and no performance transaction at all. Everything before it passed, including
  `solid-set-route-name-matches`, whose evidence is a performance transaction that reached the wire
  seconds earlier; everything after it passed too. Runs 2-6 were clean 67/67.
- **Ruled out:** the capture rate limiter. It is applied in `logException` only
  (`packages/core/src/client.ts:640`, 100/60s default) and does not gate performance transactions, so it
  cannot explain both signals going quiet together; and the preceding blocks are nowhere near 100 calls.
  Replay entries do not consume it either.
- **Not attributed to this round's changes.** The only additions upstream of the failure are one extra
  `reportSolidError` in the S7 block and an added `waitForAcceptedBundles` in S8 (which lengthens, not
  shortens, the settling time). Neither is a mechanism for a 20s total silence, and the same two rows
  pass in five of six runs with those changes present. It is recorded as unexplained rather than
  attributed in either direction.
- **What WAS fixed: the blindness.** The sample's `onError` sink was rendered on the page but had no
  `data-testid`, so the sweep could not read it — meaning an SDK kill-state (which routes a diagnostic
  through `onError`) and an ordinary upload stall look identical in the output. The sink now carries a
  testid and both checks print it in their DETAIL string. It is deliberately NOT part of either boolean:
  it is the sample's own DOM, and rule 7 keeps that out of claims. Next occurrence will say whether the
  SDK complained.

<!--
### F-12 · <one-line summary>
- **Severity:** major
- **Package:** @bugsee/x (`packages/x/src/y.ts:NN`)
- **Scenario:** S7 — network capture, POST with a JSON body
- **Expected:** the request body appears in the uploaded bundle
- **Observed:** the body is absent; MCP `get_issue` shows no network entry
- **Reproduce:** `pnpm dev`, click "POST order", then …
- **Evidence:** issue `SAMPLE-12`, captured at 2026-08-20T10:00Z
-->
