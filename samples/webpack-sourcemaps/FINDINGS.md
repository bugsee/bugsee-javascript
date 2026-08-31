# Findings — samples/webpack-sourcemaps

Every SDK defect, data-arrival failure or data inconsistency observed while building and running
this sample. One entry per finding. Do NOT fix SDK code here — record it.

Severity: **blocker** (SDK unusable / data lost) · **major** (feature broken or wrong data) ·
**minor** (cosmetic, docs, ergonomics).

## Open

### F-1 · A CSS source map alongside the JS ones aborts the ENTIRE source-map upload batch — `bugsee-cli sourcemaps inject` skips CSS maps, but `debug-files upload` walks every `.map` file indiscriminately

- **Severity:** blocker
- **Package:** **CORRECTED (was mis-attributed to the plugin alone below)** — the walk-every-`.map`-
  and-abort-the-whole-batch behavior lives in the **Rust `bugsee-cli`** binary
  (`bugsee_cli::cli::debug_files`'s upload command, a SEPARATE repo from this one): it is `debug-files
  upload` that walks the given directory for every `*.map` file indiscriminately and hard-stops the
  batch on the first one it can't key by debug-id. `@bugsee/bundler-plugin-core`
  (`packages/bundler-plugin-core/src/orchestrate.ts:120` — `run(['sourcemaps', 'inject', outDir, ...])`,
  JS-only in practice — and `:132-143` — the following `run(['debug-files', 'upload', outDir, '--type',
  'sourcemaps', ...])`) contributes two things, both real and both in THIS repo: (1) it passes the
  WHOLE output directory to the CLI in one invocation rather than a filtered file list, so the CLI's
  indiscriminate walk reaches the CSS map at all, and (2) it gates the client-side `deleteMaps` step on
  the whole batch's success (see Impact below). The fix therefore lands in TWO different repos: the CLI
  (stop hard-aborting the batch on one file, or accept a caller-owned file list instead of a directory)
  and/or this plugin (stop passing the whole directory / stop treating the whole batch as atomic for
  `deleteMaps` purposes). F-2's write-up below already states this two-repo split correctly; this entry
  originally blamed the plugin alone, which was wrong. Shared by `@bugsee/webpack-plugin` and
  `@bugsee/vite-plugin` (same engine) — cross-cutting, belongs in `samples/FINDINGS.md` too (not edited
  here).
- **Scenario:** PLAN §5.7b/c/d — a production build with `hidden-source-map` + debug-id injection +
  upload, using this sample's stock webpack config (css-loader + `mini-css-extract-plugin`, the
  ordinary way to ship CSS from a webpack app; CSS source maps are that combination's DEFAULT).
- **Expected:** the plugin uploads every JS chunk's source map; a co-located CSS source map (not itself
  a "source map" bugsee-cli's debug-ID model understands — CSS bundlers don't emit the
  `//# debugId=`-style runtime stub) is either skipped by the upload step too, or excluded from the walk.
- **Observed:** `bugsee-cli sourcemaps inject <dir>` writes a debug-ID into every JS bundle + its `.map`,
  but leaves any `.css.map` untouched (confirmed: `grep debugId` on the CSS map after `inject` — absent).
  `bugsee-cli debug-files upload <dir> --type sourcemaps ...` then walks the SAME directory for every
  `*.map` file with no such distinction, reaches the CSS map, and HARD-STOPS the whole batch:
  ```
  error: input invalid: source map has no debug_id/debugId/uuid: .../dist/assets/main.<hash>.css.map
  — run `bugsee-cli sourcemaps inject <bundle-dir>` first to embed one, or pass --uuid to key by a
  caller-owned id
  ```
  exit code 11. **Corrected:** this entry originally claimed the JS map (`main.<hash>.js.map`) had
  already been identified, packed and successfully uploaded before the CLI hit the CSS map and aborted.
  In both of the reproductions actually behind this finding, the CLI's own log shows it processed ONLY
  the CSS map before erroring — it never reached the JS map at all, so nothing was uploaded in those
  runs. The underlying defect (one incompatible file type aborts the WHOLE batch, not just that file) is
  unchanged and still blocker-severity; what is withdrawn is the specific claim that a real upload had
  already succeeded silently before the abort in the runs observed here.
- **Impact:** with this sample's (and `docs/samples/PLAN.md` §5.7f's) recommended `failOnError: true`,
  **the entire webpack build fails** the first time a customer's project has both a JS and a CSS source
  map on disk — an extremely common webpack shape. With the library's own default (`failOnError:
  false`), the failure is contained (console warning only) but step 3 (delete the client `.map` files,
  the whole point of `deleteMaps`, a privacy feature) NEVER RUNS, because deletion only happens after a
  CONFIRMED (non-throwing) `uploadSourcemaps` call (`orchestrate.ts:145-152`) — so with default options,
  a project that emits CSS source maps silently ships ALL of its `.map` files (JS included) to
  production, forever, with only a single easy-to-miss console line as evidence.
- **Reproduce:** `webpack.config.js` with `devtool: 'hidden-source-map'`, `css-loader` at its default
  `sourceMap` setting (or explicit `true`) + `MiniCssExtractPlugin`, `bugseeWebpackPlugin({ appToken,
  failOnError: true })`. Run `webpack --mode production` against any real app token. This sample's OWN
  `webpack.config.js` reproduced it on the very first build attempt (before the workaround below was
  added) — see the comment left in place at the css-loader rule.
- **Workaround used (this sample only):** `css-loader` options set `sourceMap: !isProd` — no CSS source
  map is emitted in production, sidestepping the collision. This is a real-world-plausible choice (many
  projects don't ship CSS source maps at all) but is a workaround, not a fix — a project that DOES want
  CSS source maps for its own devtools has no escape hatch from this defect today.
- **Fix direction (not applied):** either have `sourcemaps inject` also stamp a `debugId` into CSS maps
  (the Source Map Debug ID spec is language-agnostic — a CSS map is still a JSON file with the same
  schema), or have the upload step (or its invocation from `orchestrate.ts`) exclude files that were not
  actually touched by `inject` (e.g. diff the set of injected files against the upload walk, or pass an
  explicit file list instead of a directory to `debug-files upload`).

### F-2 · A second production build reusing an already-uploaded (unchanged) chunk's debug-ID fails the WHOLE upload batch, not just that one file — makes iterative/CI production builds impossible without every chunk changing every release

- **Severity:** blocker
- **Package:** `@bugsee/bundler-plugin-core` (`packages/bundler-plugin-core/src/orchestrate.ts:132-143`
  — one `bugsee-cli debug-files upload <outDir> ...` call over the WHOLE output directory) combined
  with the external `bugsee-cli` binary's own behavior (hard-stops the entire directory batch on the
  FIRST file it can't upload, rather than skipping a known-duplicate and continuing). Cross-cutting —
  shared with `@bugsee/vite-plugin`; belongs in `samples/FINDINGS.md` too (not edited here).
- **Scenario:** PLAN §5.7d — "the upload step against staging", run twice (any real iterative workflow:
  two CI builds of the same app, a second local `pnpm build`, etc).
- **Expected:** re-running a production build should either upload new/changed chunks and skip
  already-uploaded unchanged ones cleanly, or at minimum not let ONE already-known chunk's rejection
  prevent OTHER, genuinely new chunks in the SAME build from being uploaded.
- **Observed:** this sample's webpack build code-splits a couple of small numbered chunks that never
  change (traced to `@bugsee/browser`'s own internal lazy `import()` of `@bugsee/replay`, bundled
  regardless of whether replay is enabled at runtime — stable content across every build since the
  chunk's own sources do not change). **Parenthetical corrected in the substrate-flip
  re-verification:** this used to end "...since nothing in this app touches it", which is no longer
  true — session replay is now ON BY DEFAULT, so the app DOES load that chunk at runtime (measured:
  `assets/7.<hash>.chunk.js`, 185 KB, fetched with HTTP 200 from the `pnpm preview` server). The
  finding itself is unaffected: what makes the chunk trip `DuplicateSymbolsFoundError` is its BYTES
  being unchanged between builds, not whether anything imports it at runtime. The FIRST production build uploaded everything successfully. Every build
  since — including ones where the APP's own code (and therefore its main chunk) genuinely changed —
  fails outright the moment `bugsee-cli` reaches that unchanged vendor chunk:
  ```
  error: upload failed: server responded with status 200 — server returned error:
  type=DuplicateSymbolsFoundError message=A symbol file with the same identifier already exists
  ```
  exit code 30. Critically, the CLI's own log shows it processed EXACTLY ONE source map before
  erroring — it never reached the OTHER chunks in that same build (confirmed across 3 separate repro
  runs: `7.<hash>.chunk.js.map` was "processing"'d, then the command aborted; `main.<hash>.js.map`,
  freshly changed and never before uploaded, was never even attempted).
- **Impact:** given this sample's (and PLAN §5.7f's) recommended `failOnError: true`, the SECOND
  production build of ANY project that has even one content-stable chunk (extremely common with
  long-term vendor/dependency splitting) fails outright, forever, unless literally every chunk's bytes
  change on every single release — an impractical constraint no real CI pipeline satisfies. This makes
  the plugin's default posture ("fail loudly on a bad upload", which is otherwise exactly correct per
  §5.7f) actively hostile to the most common real-world usage pattern: building the same app more than
  once.
- **Reproduce:** `pnpm build` (real token) twice in a row in this sample with NO source changes between
  runs — the second run fails identically. Confirmed the root cause is per-file dedup (not a general
  re-upload prohibition) by resetting `.build-counter` to force a BYTE-IDENTICAL rebuild of the changed
  (main) chunk too: the resulting debug-ID matched the original exactly
  (`e0c76509-3d6a-50ea-a949-e69f39d0a7ec`), confirming `bugsee-cli`'s debug-ID derivation is
  deterministic content hashing, and that the dedup rejection is legitimate (the file really is
  byte-identical to one already on the server) — the DEFECT is that this single, correct,
  individually-harmless rejection takes down the WHOLE batch.
- **Workaround used (this sample only, to obtain the SWEBPACK-1 evidence in README.md/scenarios.md):**
  reset `.build-counter` to reproduce the exact byte-identical bundle from the one build that DID fully
  succeed, so the shipped `dist/` carries a debug-ID that is confirmed present on the server, without
  needing a fresh successful upload. A real customer has no equivalent escape hatch short of changing
  every chunk's content every release.
- **Fix direction (not applied):** either have `bugsee-cli debug-files upload` treat a per-file
  `DuplicateSymbolsFoundError` as a skippable no-op (log and continue) rather than a batch-fatal error,
  or have `@bugsee/bundler-plugin-core` invoke the upload per-file instead of per-directory so one
  file's outcome cannot block its siblings.
- **Additional findings (reviewer-established, added here):**
  - The duplicate rejection is keyed by **debug_id/content only**, not by `--build`/`--version`: re-
    running with an explicitly different `--build 99 --version 1.0.0` against the same byte-identical
    chunk fails identically. There is no per-release escape hatch via those flags.
  - **Dedup visibility is ASYNCHRONOUS on the server**, which makes "just retry the build" a racy
    workaround rather than a reliable one: uploading the SAME map twice within about 3 seconds of each
    other **succeeded twice** (no `DuplicateSymbolsFoundError` on the second, near-immediate attempt);
    the SAME content THEN failed as a duplicate roughly 30 seconds later. A retry loop that fires
    quickly after a failure can therefore appear to "fix" the problem while actually racing the
    server's own dedup-index catch-up, not resolving it.
  - The CLI already has an `already_existed` counter in its own output/telemetry for exactly this
    condition (a symbol file the server already has) — i.e. "skip a known duplicate and continue" is
    an outcome the CLI's own model already represents server-side. That skip-and-continue handling
    simply isn't applied to `DuplicateSymbolsFoundError` in the upload-batch path today; wiring the
    existing counter's outcome into a continue-rather-than-abort decision is a smaller change than
    inventing a new mechanism.
  - **File-processing order within one `debug-files upload` batch is NOT deterministic across runs**
    (fix round 2 addendum) — confirmed by three consecutive `pnpm build` invocations against
    byte-identical source: run 1 processed `main.<hash>.js.map` first (uploaded successfully under a
    fresh debug-id) and only then hit the unchanged vendor chunk and aborted; the very next run
    processed the vendor chunk FIRST and aborted before ever attempting `main.<hash>.js.map` at all.
    This rules out "just re-run the build, the changed file usually gets uploaded before the abort" as
    a reliable workaround — whether a genuinely NEW chunk in a given build gets uploaded before an
    unrelated stale chunk aborts the batch depends on an order this plugin/CLI pairing does not
    control. See `samples/webpack-sourcemaps/README.md`'s "Production build" callout for the
    counter-reset technique this sample now uses instead (reproduce a specific ALREADY-uploaded
    chunk's exact bytes, so that chunk's server-side validity does not depend on this build's own
    upload call succeeding at all).

### F-3 · Browser persist+recover uploads one incident TWICE — S12 fire-and-forget-then-reload consistently produces `events_count +2` per click, never +1

- **Severity:** major
- **Package:** `@bugsee/browser` (`packages/browser/src/launch.ts:516-538`) with
  `packages/core/src/capture-recovery.ts`. **Root-caused in fix round 3** (it was black-box only
  before). This matches a defect already flagged by a wave-2 peer sample; recorded here as an
  independent corroboration from a different code path (browser IndexedDB persistence, not that
  peer's).
- **Root cause:** `coexistence.recoverDeadSiblings` (`packages/browser/src/launch.ts:516-538`) runs
  **two independent recovery legs over the same dead sibling**, and nothing dedupes one against the
  other:
  - **(a)** re-upload the sibling's leftover DURABLE bundles — `uploadPipeline: baseUploadPipeline`
    (`launch.ts:517`; corrected in fix round 4, R4-4 — the earlier `:512` citation pointed at a
    comment line, not at the code);
  - **(b)** when `recover` is on, `recoverReportsForViews` (the arrow at `launch.ts:520-535`) →
    `recoverReports` (its call at `launch.ts:523-534`, defined at
    `packages/core/src/capture-recovery.ts:41`; corrected in fix round 5, R5-4 — the earlier `:40`
    citation pointed at a blank line, the same off-by-one class R4-4 fixed for `launch.ts`)
    re-ASSEMBLES the sibling's incidents from its preserved report marker + capture chunks and
    uploads them, again via `baseUploadPipeline`.

  The two legs collide exactly in the S12 window. `submitReport`
  (`packages/core/src/client.ts:476-517`) writes the pending marker BEFORE assembly and clears it only
  once the report promise settles — "by which point the durable bundle queue owns delivery, so capture
  recovery need not re-deliver it". A hard reload ~100ms in lands between those two points: the
  assembled bundle is already in the durable queue AND the marker is still pending. On the next launch,
  leg (a) delivers the queued bundle and leg (b) independently rebuilds and delivers the same incident
  from the still-present marker. The differing file sets between the two deliveries (below) are that
  signature — leg (a) ships the bundle as it was assembled in the original session; leg (b) rebuilds it
  from whatever capture chunks survived.
- **Scenario:** PLAN §4 S12 — "data captured before a hard termination still arrives on the NEXT
  start" (`persist`/`recover`, both on in `FULL_LAUNCH_OPTIONS`).
- **Expected:** a `logException()` call that gets interrupted mid-upload by a hard reload, then
  recovered and re-delivered by the next launch, should produce exactly ONE event on the resulting
  issue (`events_count` +1 per click) — the same incident delivered once, just later than usual.
- **Observed:** `scripts/verify.mjs`'s `s12-crash-and-reload` control (see `src/scenarios.ts`) fires
  `logException(new Error('S12: persist+recover across a hard reload'))` WITHOUT awaiting it, then
  reloads the page 100ms later — before the original upload can complete — so it is `recover:true` on
  the next launch that delivers the report. Measured directly and cleanly against the resulting issue
  (`SWEBPACK-22` at the time of writing) by bracketing ONE isolated `pnpm verify` run with two
  `list_issues` calls: `events_count` was **6 immediately before** the run and **8 immediately after**
  — **+2 for exactly one click of the control**, not +1. Across the several other `pnpm verify` runs
  during this fix pass (each also containing exactly one `s12-crash-and-reload` click),
  `events_count` on this same issue was only ever observed at even numbers (2, 4, 6, 8) and never
  landed on an odd count after a run — consistent with every run adding 2, never 1, though only the
  bracketed run above was checked precisely enough to state a single-run delta with confidence.

  **Corrected (fix round 3, R3-4).** This bullet previously claimed that "only ONE bundle-upload PUT is
  ever observed AFTER the reload" and that "the SECOND event is not visible on the wire from a single
  browser tab's own tee". **Both were false, and neither was ever observed** — they were inferred from
  `scripts/verify.mjs`'s `waitForBundle`, which returns the FIRST match and structurally cannot count
  occurrences (it is a `bundles.find(matchFn)` in a poll loop). The duplicate IS visible on the wire.
  Measured in fix round 3 by enumerating `window.__bugseeTee.getCapturedBundles()` after the reload
  instead of taking `waitForBundle`'s first hit (the tee's in-page state is wiped by the reload, so
  everything below is post-reload by construction). One sweep run, one click of the control:
  - **two separately-assembled bundle-upload PUTs**, both carrying the summary
    `S12: persist+recover across a hard reload`, **768 ms apart** (tee `seq 3` at `t=1787759940267`,
    `seq 5` at `t=1787759941035`), with **DIFFERENT file sets** — `seq 3` contains `viewtree.json`,
    `seq 5` does not (both otherwise carry `request.json`/`manifest.json`/`apptoken`/
    `traces.system.json`/`events.system.json`/`events.user.json`/`crash.json`);
  - **two POSTs to `https://apidev.bugsee.com/v2/issues`** in that same post-reload window, 1226 ms
    apart;
  - `SWEBPACK-34`'s `events_count` went **8 → 10** across exactly that one bracketed run (`list_issues`
    immediately before and immediately after), and **10 → 12 → 14** across the two further full sweeps
    run in this round — **+2 per run, three runs in a row**, never +1.

  So: this sample clicks the control exactly once, the SDK assembles and uploads the incident twice, and
  the two uploads differ in content — the differing file sets being what pointed at the two-leg recovery
  path root-caused above (one leg ships the bundle as the original session assembled it, the other
  rebuilds it from the capture chunks that survived).
- **Impact:** an incident whose termination lands inside the collision window above is reported to the
  backend TWICE, and `events_count` (and any alerting/frequency logic built on it) over-counts it by
  exactly 2x. **Narrowed in fix round 4 (R4-3):** this bullet previously said "every incident recovered
  after an unplanned termination", which overstates the window and contradicts this finding's own
  root-cause section. The two legs collide only when the assembled bundle has ALREADY entered the
  durable queue AND the report marker is still pending — i.e. the termination fell between
  `submitReport` writing the marker and the report promise settling. An incident whose termination came
  BEFORE assembly reached the durable queue gives leg (a) nothing to re-upload and is delivered once,
  by leg (b) alone. That is why S12 here (fire-and-forget, hard reload ~100 ms later) lands in the
  window every time and shows +2, while a peer sample whose control reloads FASTER does not.
  **Re-corrected in fix round 6 (R6-1) — the explanation rounds 4/5 gave for that peer named the WRONG
  MECHANISM.** It said angular-spa's "180 s post-storm quiet wait precedes its reload, so leg (a) finds
  an empty durable queue", which places that sample past the window's UPPER edge. Both halves are
  wrong. The 180 s figure is the `timeout` of a `waitForQuiet` run after the S4 storm
  (`samples/angular-spa/scripts/verify.mjs:1090-1102`), and it precedes that sweep's `s1-flush` check
  at `:1111` — the S12 incident is not created until `:1129`, fresh, after the wait is long over, so
  the wait cannot have let S12's upload settle. What actually governs the duplicate is the delay
  between `logException` and the reload, and angular's control reloads **5 ms** after it
  (`samples/angular-spa/src/app/scenarios/scenario-panel.component.ts:525-527`,
  `setTimeout(() => window.location.reload(), 5)`). 5 ms is below the window's **LOWER** edge, not
  above its upper one: at 5 ms the assembled bundle has not reached the durable queue at all, so leg
  (a) has nothing to re-upload and only leg (b) fires. Same +1 outcome, opposite edge. A peer sample
  MEASURED that edge directly, by remapping only that one timer
  (`samples/solid-spa/FINDINGS.md:131-141`): 5 ms -> **1** upload (2/2 runs), 40 ms -> **2** (2/2),
  250 ms -> **2** (3/3). That is also why THIS sample's ~100 ms S12 sits inside the window while
  angular's 5 ms one does not. `SANGULAR-101`'s `events_count` accordingly moves +1 per sweep, never
  +2 (`samples/angular-spa/FINDINGS.md:279-281` — the "This sample does NOT duplicate" bullet of that
  file's F-4, heading at `:132` — for the +1/sweep measurement; the sentence quoted next is at
  `:277-278`, re-derived by reading the file in fix round 6, R6-2, because round 5's own correction of
  this citation landed off — where that sample reaches the same narrowed window independently: "its
  window is narrow — crash between the durable persist and the upload settling — not any crash
  followed by a reload"). As written, the old bullet here would have predicted +2 there too. Does not
  affect NORMAL (non-recovered) reports at all.
- **Reproduce:** in this sample, `pnpm dev` running, then `pnpm verify` (the `s12-crash-and-reload`
  control alone reproduces it without the rest of the sweep) — check `events_count` on the resulting
  issue before and after via `list_issues`/`get_issue` against the `SWEBPACK` staging app. To see it on
  the wire rather than only on the backend, enumerate `window.__bugseeTee.getCapturedBundles()` after
  the reload and filter by `bundle.request.summary` — do NOT use `verify.mjs`'s `waitForBundle`, which
  returns the first match only and cannot count.
- **Fix direction (not applied — this sample records SDK defects, it does not fix them):** the two legs
  of `recoverDeadSiblings` (`packages/browser/src/launch.ts:516-538`) need to agree on who owns a given
  incident. Options for whoever picks this up: have leg (a) report which report ids it re-uploaded and
  have leg (b) skip those markers; or make leg (b) run FIRST and have leg (a) skip a durable bundle
  whose report id was just recovered; or drop the marker at the moment the assembled bundle enters the
  durable queue (the point at which `client.ts:476-479`'s comment already assumes "the durable bundle
  queue owns delivery") rather than when the report promise settles. Note the same two-leg shape exists
  in the node tier's dead-sibling coordinator — `recoverSubtree`
  (`packages/node/src/recover-instances.ts:97-149`) calls `drainBundles(bundleStore, …)` and then
  `recoverReports(…)` over the same subtree, with no cross-leg dedupe either — so a fix should be
  checked there too. (Not reproduced on node from this sample; noted from the code, which is why it is
  a pointer and not a second finding.)

## Recurring (already on record from a peer sample, confirmed again here)

- **F-9 analog** (`samples/react-spa/FINDINGS.md` F-9): `client.ext('performance')` has no usable
  TypeScript type without an extra, undocumented `@bugsee/performance` devDependency purely for its
  ambient `NameExtensionMapping` augmentation. Hit identically here (`pnpm typecheck` failed with
  `Cannot find module '@bugsee/performance'` until it was added as a devDependency — see
  `package.json`). Not re-filed as a new finding; same root cause, same package.
- **angular-spa's F-7 analog — `console.trace()` is NEVER captured, on any runtime**
  (`samples/angular-spa/FINDINGS.md:429`, severity major; NB this is angular-spa's F-7, unrelated to
  react-spa's F-7 in the "Confirmed FIXED" section below). Reproduced here independently, on a
  different platform path (webpack + plain-DOM browser, not Angular), and **measured on the wire**
  rather than inferred: `s6-console` fires all six
  `console.*` methods, and the `logs.json` of the bundle uploaded a few controls later carries exactly
  **five** entries — `S6: console.log {"a":1}` (level 3), `S6: console.info` (3), `S6: console.warn`
  (2), `S6: console.error` (1), `S6: console.debug` (4) — with **no entry for `S6: console.trace` at
  all**. Root cause confirmed against the current sources, all three citations checked line by line:
  `DEFAULT_LEVELS` (`packages/capture/src/console-interceptor.ts:24-30`) holds only
  `log/info/debug/warn/error`; `onActivate` patches exactly the keys it holds
  (`Object.entries(this.#levels)`, `console-interceptor.ts:86`); and the browser tier passes no
  override (`packages/browser/src/launch.ts:441`, `createConsoleInterceptor()`). Not re-filed as a new
  finding — same root cause, same package, and it is cross-runtime (`@bugsee/capture` is shared), so
  angular-spa's F-7 already covers it.
  - **Why it took five rounds to surface here, which is the more useful lesson.** The defect was not
    hard to see; nothing in this sample ever *looked*. S6's row in `scenarios.md` claimed depth `L/W`
    while its only evidence was Playwright's own console listener — Local evidence that the interceptor
    is additive, which stays green with console capture switched off entirely. Fix round 4 (R4-2)
    diagnosed exactly this "claims capture, asserts app-side text" shape, swept the six S7 rows for it,
    fixed them — and left S6, itself a capture scenario, alone. **A defect-class sweep that stops at the
    scenario where the class was first noticed is not a sweep.** The missing check was the only thing
    standing between this sample and a defect a peer had already filed. Closed in round 5 by
    `s6-console-wire` (the five that work, asserted with their levels) and `s6-console-trace-wire` (the
    one that does not) — the latter documents the defect and therefore goes RED when it is fixed, which
    is the intended signal to update this entry and `scenarios.md`'s S6 section.

## Confirmed FIXED (positive result — no longer reproducible)

- **F-6** (`samples/react-spa/FINDINGS.md`): `resolveBugseeCli()`'s bare `'bugsee-cli'` PATH lookup,
  which only worked from inside the monorepo. **Fixed** — `packages/bundler-plugin-core/src/run-cli.ts`'s
  `resolveBugseeCli()` now resolves `@bugsee/bugsee-cli/run-bugsee-cli.js` via `require.resolve` from
  its own module location, independent of PATH. Confirmed working in this sample with ZERO extra
  configuration (`BUGSEE_CLI_PATH` was never needed) — every `pnpm build*` variant in this sample ran
  the real downloaded `bugsee-cli` binary with no workaround.
- **F-7** (`samples/react-spa/FINDINGS.md`): `@bugsee/vite-plugin` / `@bugsee/bundler-plugin-core` /
  `@bugsee/webpack-plugin` shipped without `publishConfig`, so a packed tarball resolved to
  `./src/index.ts` instead of `dist/`. **Fixed** — both `packages/webpack-plugin/package.json` and
  `packages/bundler-plugin-core/package.json` now carry a full `publishConfig` block. Confirmed: this
  sample installed both from `.local-registry/*.tgz` tarballs and they resolved to `dist/index.js`
  cleanly, dual ESM/CJS, no manual `node_modules` patching needed.
- **`code ?? 0` signal-exit-code regression guard** (PLAN §5.7g): still in place.
  `packages/bundler-plugin-core/src/run-cli.ts`'s `SIGNAL_EXIT_CODE = -1` correctly maps a
  signal-terminated child (`close` event with `code: null`) to a NON-zero result. Verified directly:
  `pnpm build:signal-kill` (a stand-in "bugsee-cli" that immediately `SIGKILL`s itself) produced
  `code: -1, stderr: 'bugsee-cli was terminated by signal SIGKILL'`, `BugseeCliError` was thrown, and
  the whole webpack build failed (real process exit code 2) — not the historical false-success.

## Testing-methodology note (not an SDK defect — recorded so the next sample author doesn't rediscover it the hard way)

- **CORRECTED 2026-08-26 (was wrong below until this fix pass):** S4's "storm of 200" is a HARD CAP,
  not a pacing/minimum-interval scheme. `packages/core/src/rate-limiter.ts:3-10,40` admits at most
  `limit` (default 100) captures per rolling `windowMs` (default 60s) and REFUSES every call beyond
  that — `packages/core/src/client.ts:640` resolves a refused `logException()` with `{ok:false}`
  immediately, synchronously (no queueing, no eventual delivery). Measured directly against a
  freshly-relaunched client (clean 100-per-60s window, `scripts/verify.mjs`'s `s4-storm` check, and
  `scenarios.ts`'s handler which now reports the split on its own status line): 200 `logException()`
  calls -> **exactly 100 settle `{ok:false}` within 500ms (refused) and the other exactly 100 are
  ADMITTED** (their promises resolve later, once each one's own assemble+upload round trip completes —
  see the durable-upload-pipeline note below). Reproduced across multiple runs, always 100/100 against
  a clean window. The PREVIOUS text here (quoted below for the record) mischaracterized this as "rate-
  PACED, not dropped or capped" and claimed the queue "only enforces a MINIMUM interval between
  deliveries" — both wrong; excess calls are refused outright, not queued to be delivered later.
  > S4's "storm of 200" is rate-PACED, not dropped or capped — the upload queue drains roughly one
  > `logException()` call every ~800ms in the BACKGROUND for a long time after the storm button
  > returns... a customer relying on a hard upper bound on total reports-per-minute should know the
  > queue does not enforce one; it only enforces a MINIMUM interval between deliveries.
- **What IS still true, and still worth knowing:** the 100 ADMITTED calls each go through the full
  assemble -> enqueue -> upload round trip before their own promise resolves, draining through the
  bounded-concurrency upload queue (`packages/core/src/durable-upload-pipeline.ts:200-203`) — so a
  200-call storm still keeps producing real network traffic in the BACKGROUND for a long time after the
  storm button returns (a 200-call storm can take minutes to fully drain its 100 admitted uploads, not
  seconds). That part of the original observation was correct and is why `scripts/verify.mjs` still
  runs the storm LAST in the sweep, after everything that depends on network quiescence — it originally
  ran the storm mid-sweep and saw a reproducible false FAIL on the S8 report-veto check as a direct
  result (isolated and confirmed via a standalone re-check with the storm removed: the veto path itself
  is correct — no issue is created).

- **Two of this sample's own checks were green because they could not go red — found while
  re-verifying against the replay-on-by-default substrate (2026-08-27).** Both are the same class the
  sweep's own audit block hunts, and both are now fixed and measured:
  1. **"Uploaded" meant "sent", never "accepted".** `src/bugsee-transport.ts` recorded
     `CapturedCall.status` (the presigned S3 PUT's real response status) and `scripts/verify.mjs`
     recorded `bugseeCalls[].ok`, and **neither field was read by a single check**. So all 22 `-wire`
     rows and the 13 issue-call rows asserted what the SDK PUT on the wire, whatever the backend then
     did with it. MEASURED with an isolated Playwright probe that fulfilled every non-localhost PUT
     with `500`: the tee still parsed the bundle happily (`status: 500`, `replay.bin` present) and
     every `-wire` row would have stayed green; a second probe fulfilling `**/issues**` with
     `500 {"ok":false}` showed the old url-only `s4-error` form PASS and the accepting form FAIL. Fixed
     by filtering `waitForBundle` to 2xx uploads, introducing `isAcceptedIssueCall`, and adding the
     `wire-uploads-accepted` aggregate row. A peer sample found the identical hole in its own tee
     independently — worth checking in any sample that tees the transport.
  2. **A multi-line masking needle could never match.** The new `s11-replay-masking` check searches the
     decoded replay stream for values typed into the app. The stream is JSON, so a real newline in a
     recorded value is stored as the two characters `\` `n` — a needle containing a literal newline is
     therefore unfindable by construction. MEASURED with masking deliberately disabled: the note body
     needle came back **absent** in raw form and **present** in JSON-escaped form, i.e. that leg of the
     assertion was passing vacuously in exactly the world it exists to detect. `getReplayDigest` now
     searches both forms. The lesson generalises: any check that asserts a string is ABSENT from a
     serialised blob must first be proven findable when it IS there.
- **The `page.evaluate` caveat has a real exception worth stating.** `page.evaluate` is unsafe for
  FALSIFIABILITY probes (injecting a stub into the page's realm from outside it can silently miss the
  module graph the app actually uses) — but it is the correct tool for READING harness state the page
  already owns, which is all `waitForBundle`/`getReplayDigest` use it for. The falsifiability probes in
  this pass instead mutated `src/bugsee.ts`'s real launch options (`replay: false`, then
  `replay: { maskAllText: false, maskAllInputs: false }`), let webpack rebuild, and were rolled back
  from an `md5`-verified `cp` backup — never `git checkout`, since this sample is untracked.

## Resolved
