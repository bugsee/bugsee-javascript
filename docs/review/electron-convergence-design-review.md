# Adversarial design review — `docs/design/electron-renderer-incident-convergence.md` (33f542b)

Reviewed against the code as of `feat/single-install-adapters` (worktree at review time). Every claim below was
re-derived from source; no constraint was taken on trust. All paths repo-relative.

---

## Verdict

**Not safe to build as specified.** The *direction* is right — Option A (a `triggerPipeline` seam on
`@bugsee/browser`, renderer forwards, main joins, `render-process-gone` backstop) is the correct shape, all five
constraints C1–C5 check out, and rejections B/C/D are sound. But three parts of the spec would produce defects
if a competent implementer built them literally:

1. **The `crash`-entry-as-transport choice corrupts the main capture store and `crash.json`** (SEV1-1) — the
   receiver stores every entry *before* `onEntry` fires, and the assembler emits store-resident `crash` entries
   as a second, wrongly-shaped `crash.json` in every bundle for the rest of the rolling window.
2. **R3's "normal reporting path" does not exist as a public API**, and the only public path (`logException`)
   would rebuild the crash from a main-side Error — wrong stack, `handled: true`, mechanism `programmatic` — a
   renderer crash misfiled as a handled error (SEV1-2).
3. **§4.5's dedup mechanism cannot be implemented** — `checkOrSetAlreadyCaught` is instance-identity tagging
   that cannot cross serialization, and `render-process-gone` carries no error identity at all — while the
   *actual* duplication threat (R4 vs the built native-crash harvest) is never mentioned (SEV2-2/-3).

Fix the transport, specify the join seam, and rewrite §4.5 + the R4 interaction, and this becomes buildable.

---

## Constraint audit (C1–C5)

| # | Verdict | Evidence |
|---|---|---|
| **C1** | **VERIFIED** | `packages/browser/src/launch.ts:191` is exactly `captureStore?: CaptureStore;`; no `triggerPipeline` anywhere in the file; the `createClient` call at `launch.ts:390-409` passes none. **Strengthener the design missed:** core `createClient` *already* accepts `triggerPipeline?` (`packages/core/src/client.ts:238`) and honors it (`client.ts:342-343` — the default assemble/upload pipeline is built only `if (triggerPipeline === undefined …)`). R1 is therefore pure option-plumbing, not a new core seam. |
| **C2** | **VERIFIED** | `packages/webview/src/launch.ts:224-241` — `createWebViewReportPipeline(...)` then `createClient({ …, captureStore, triggerPipeline, … })`. WebView composes the client itself. |
| **C3** | **VERIFIED** | `packages/electron/src/main-receiver.ts:27-28` — the doc comment reads verbatim "*a seam for report joins*"; called at `:55`. `launch-main.ts:101` constructs the receiver as `createElectronMainReceiver({ ipcMain, store })` — no `onEntry`. Repo grep finds no other non-test caller. |
| **C4** | **VERIFIED but MISLEADING** | `crash` ∈ `FileType` (`packages/protocol/src/constants.ts:16-32`, filename `crash.json` at `:50`), and the Electron decoder accepts it (`KNOWN_FILE_TYPES` = `DEFAULT_FILENAMES` keys + `attachment`, `packages/electron/src/protocol.ts:66-73`, checked at `:89`). So the incident *can* travel as an entry. What C4 omits is the consequence: `main-receiver.ts:50-55` `store.add`s **every** decoded entry *before* `onEntry` — the incident becomes rolling capture data. See SEV1-1. |
| **C5** | **VERIFIED** | `packages/electron/src/main-control.ts:53-54` — `renderers = new Set<ControlSenderLike>()`, deduped by webContents object identity. Repo-wide grep for `render-process-gone` / `web-contents-created` / `renderProcessGone` over `packages/` returns nothing. |

§1's supporting citations also all check out: `launch-renderer.ts:72` (browser launch with only the store
swapped), `streaming-capture-store.ts:49-61` (`emptySnapshot` — `stream()` yields nothing, `drainAll()` → empty
Map), `bugsee-api.ts:30` (`sessionId = options.sessionId ?? randomId()` — per-process mint),
`webview/src/launch.ts:224`, `docs/design/electron.md:48` and `:105` (quotes verbatim),
`electron-e2e.test.ts:147-153` (`fakeBrowserLaunch`) and `:225` (`mainClient.logException` — report fired on
MAIN only).

---

## SEV1

### SEV1-1 — The `crash`-entry transport pollutes the main capture store and produces duplicate, wrongly-shaped `crash.json`

- `packages/electron/src/main-receiver.ts:50-55`: the listener `store.add`s **every** decoded entry and *then*
  calls `onEntry`. A forwarded incident (`type: 'crash'`) therefore lands in the main process's rolling capture
  store as a `StoredEntry` — the design never says to filter it, and the receiver as-built cannot.
- `packages/core/src/capture-exporter.ts:54-73`: `drain()` groups **all** stored types with no filtering.
- `packages/core/src/bundle-assembler.ts:144-159`: every drained type is written under
  `DEFAULT_FILENAMES[type]` → the store's `crash` group becomes a file named `crash.json` whose content is a
  JSON **array** of `{ source, report }` wrappers (`serializeFileData` default, `:88-99`) — not the `CrashJson`
  shape the backend crash pipeline symbolicates.
- `bundle-assembler.ts:161-167`: the same assembly *also* writes the report's own `crash.json` from
  `report.crash` → **two files named `crash.json`** in one zip and one manifest.
- Because the entry sits in the rolling window (60 s default), **every subsequent report** — a main-process
  crash, a manual report, a different renderer's incident — carries the stale forwarded crash in its
  `crash.json`. Cross-contamination of unrelated issues.

**Failure scenario:** renderer A throws; the incident is forwarded and joined (working as designed). 10 s later
main's own `uncaughtException` fires. Main's bundle now contains renderer A's crash payload in a duplicate
`crash.json`, mis-shaping the file the backend uses to symbolicate main's crash.

**Fix shape (pick one, and say so in the design):** (a) add a first-class `report` wire kind to the Electron
codec — the protocol is *same-version by declaration* (`packages/electron/src/protocol.ts:1-3`: "main and
renderers run the SAME @bugsee/electron version"), so C4's "no protocol change" optimizes a constraint that
does not exist; note WebView itself distinguishes `entryMessage` from `reportMessage`
(`packages/webview/src/webview-report-pipeline.ts:57-61`); or (b) keep the `crash` entry but have the receiver
special-case it: route to the join, never `store.add`. Either way the receiver changes — "no protocol change"
is not "no receiver change".

### SEV1-2 — R3 ("open a report on the MAIN client via its normal reporting path") names a path that does not publicly exist; the one that does would misreport

- The main client's only public report entry point is `logException(error)`
  (`packages/core/src/client.ts:588-621`). It **rebuilds** `crash.json` from the passed Error via
  `buildCrashJson(error, { parseStack, handled: true })` (`:605`) and stamps
  `source: { type: 'error', mechanism: 'programmatic' }` (`:607`). Joining a forwarded renderer crash through it
  means: renderer stack replaced by a reconstructed main-side Error's stack (or lost for a non-Error), a
  **crash filed as a handled programmatic error**, and main's `logException` rate limiter / instance dedup
  applied to a freshly-deserialized object (dedup never fires).
- The correct shape — submit the deserialized `{ source, report }` as a `ReportingRequest` — exists only on the
  **detection-provider submit callback** (`client.ts:642-647`: `applyReportBefore` → `submitReport(handled)`),
  which is private to `launch()`'s wiring. `ReportingRequest`/`Report` round-trip JSON cleanly
  (`packages/core/src/reporting.ts:46-70` — `id`, `source`, `crash`, `labels`; `attachments` is the one field
  with binary data and is absent on renderer JS crashes), so a direct submit is feasible — but the design must
  name the seam: e.g. `launch-main` registers a synthetic DetectionProvider whose events are the receiver's
  forwarded incidents, or core exposes a `submitReportingRequest` on the client. As written, the naive build is
  `logException(new Error(payload.summary))`, which mis-fixes the very defect this design exists to fix.

---

## SEV2

### SEV2-1 — Renderer report-time snapshots (DOM viewtree) are silently lost — a regression the design introduces

With `options.triggerPipeline` set, `createClient` skips the *entire* default assemble closure
(`packages/core/src/client.ts:342-386`); `reportSnapshots` are pulled **only inside that closure**
(`client.ts:356-372`). `@bugsee/browser` registers the viewtree snapshot source per default
(`packages/browser/src/launch.ts:379-382`, `captureViewHierarchy` default `true`). Under R1+R2 the renderer
never assembles → the report-time DOM snapshot is never taken; main's node-side `reportSnapshots` hold only the
opt-in pixel video (`packages/electron/src/launch-main.ts:67-70`). Today's broken flow at least shipped
`viewtree.json` in the (foreign, otherwise-empty) renderer bundle. The design needs an answer: pull renderer
snapshots *before* forwarding (renderer-side, posting them as entries alongside the incident), or a control-
channel snapshot pull (the WebView precedent: native pulls `__bugsee_bridge.snapshot()`).

### SEV2-2 — §4.5's dedup mechanism is unimplementable as specified

- `checkOrSetAlreadyCaught` (`packages/core/src/dedup.ts:12-31`) tags the **thrown object instance** with a
  symbol. The forwarded incident is a *serialized* payload — a fresh object on every decode; the tag cannot
  cross the IPC boundary. It is also only wired into `logException` (`client.ts:594`), not the detection path.
- The proposed key "window id + the error's identity" cannot be computed on one of its two sides:
  `render-process-gone` delivers `{ reason, exitCode }` — **no error identity exists** there.
- The threat model is also wrong: a JS uncaught error does not kill the renderer process (no
  `render-process-gone` fires), and a process death runs no JS (nothing is forwarded) — the two R3/R4 paths
  are near-disjoint by construction. The dedup that §4.5 describes guards against a collision that essentially
  cannot happen, with a mechanism that cannot work.
- What *is* needed: a reason-gated, time-bounded `(windowId, window)` suppression — and note `webContents.id`
  survives a reload (`main-control.ts:53` comment), so an *unbounded* per-(windowId, signature) key would
  collapse a crash-loop-across-reloads into one incident and suppress legitimate repeats forever.

### SEV2-3 — The real duplicate the design misses: R4 vs the built native-crash harvest (NM path)

`render-process-gone` with `reason: 'crashed'` **also** leaves a Crashpad `.dmp` under
`<crashDumps>/completed/` — the Electron native-crash source harvests **ALL** completed dumps at the *next*
launch and attributes them to the dead marker's session
(`packages/electron/src/native-crash-source.ts:5-17, 65-77`; wired at `launch-main.ts:78-86`;
marker persisted per launch, `packages/node/src/launch.ts:706-711`). If R4 synthesizes an incident at event
time, the same renderer native crash produces a **second** incident at the next app launch from the harvested
dump. The design must reconcile: R4 claims/annotates the session's renderer dump, or R4 skips `crashed` and
leaves it to the NM path (losing immediacy), or the NM recovery learns to skip dumps whose crash was already
reported live. Unaddressed, every renderer native crash double-reports.

### SEV2-4 — `render-process-gone` reason filter unspecified

Electron's `details.reason` includes `clean-exit` and `killed` alongside `crashed`/`oom`/`launch-failed`.
§4.4 says "synthesises an incident" with no reason gating; built literally, ordinary renderer teardown paths
become crash reports. The design must enumerate the reportable reasons (and state what `killed` means in
app-quit vs task-manager-kill terms).

### SEV2-5 — No-main / no-bridge failure mode: incidents silently lost while the pipeline reports success

`resolveRendererPost`/`resolveRendererBridge` **no-op** when `__bugseeElectron` is absent
(`packages/electron/src/launch-renderer.ts:38-57`), and a post to a channel with no `ipcMain` listener
vanishes. §4.1 resolves `{ ok: true }` unconditionally — so with a missing preload, a not-yet/never-launched
main, or a stopped main (`launch-main.ts:126-127` removes the listeners), every renderer incident is dropped
**and reported to the app as delivered**. Today's (defective) behavior at least uploads *something*. The
design must specify: detect bridge absence (synchronously checkable via `readBridge()`, `launch-renderer.ts:32-34`)
and/or handshake-timeout → resolve `{ ok: false }`, and decide whether a bridge-less renderer falls back to the
default local pipeline (which would also cover `@bugsee/browser`-style usage of the renderer entry outside
Electron).

### SEV2-6 — R3 turns untrusted renderer input into report-opening with no validation or rate limit

The review this design descends from already proved the lesson (`packages/electron/src/protocol.ts:49-63`:
renderer input is UNTRUSTED; validated fields are dropped, not sanitized). The forwarded `{ source, report }`
payload is attacker-controlled and R3 makes it trigger session-authenticated uploads on the main session.
Missing from the design: (a) schema validation of the deserialized `ReportingRequest` (a malformed/hostile
`report.crash`, giant `description`, forged `attachments`); (b) any rate limit — the detection-submit path has
**none** (`client.ts:642-647`; only `logException` has `rateLimiter.tryAcquire`, `:598`), and the trigger
pipeline only drops requests beyond queue depth 2 *while an assembly is in flight*
(`packages/core/src/trigger-pipeline.ts:28, 64-71`) — a sustained storm from one compromised/looping renderer
still assembles and uploads unbounded, sequentially. R3 needs a renderer-scoped rate limit.

### SEV2-7 — "with replay" does not hold: no main-side `replay.bin` encoder exists

The design's problem statement promises the joined bundle has the renderer's replay. Renderer replay entries do
stream up as `replay`-typed entries, but the node/main side registers **no** `fileEncoders.replay` (only
`video`: `launch-main.ts:71`; node launch just forwards caller options, `packages/node/src/launch.ts:561`), so
assembly falls to the default JSON path (`bundle-assembler.ts:155-157`) and writes `JSON.stringify(payloads)`
into a file named `replay.bin` (`packages/protocol/src/constants.ts:36`) — not the gzipped rrweb stream the
backend expects. A slice registering `@bugsee/replay`'s encoder (or a portable equivalent) on the main client
is required for the headline claim to be true. (Pre-existing D8 gap, but this design is what makes it
customer-visible: renderer incidents finally produce main-session bundles containing replay entries.)

---

## SEV3

1. **Open question 4 (session rotation) is moot today** — `sessionId` is minted once per process
   (`bugsee-api.ts:30`) and nothing ever rotates it (`invalidateSession` clears only the access token,
   `bugsee-api.ts:90-92`; no other writer in core); main-control replies with the fixed id captured at
   construction (`main-control.ts:82`, `launch-main.ts:106`). Not design-blocking; strike it or mark it
   future-proofing.
2. **The delivery model, and where the WebView analogy breaks, is unstated.** WebView's `post` is a
   *synchronous* JS→native handoff; Electron's is async `ipcRenderer.send` (`preload-bridge.ts:61-63`). For the
   dominant case (JS error, process alive) this is fine — and worth stating is the good property the design
   earns for free: the incident rides the **same channel** as capture (`BUGSEE_STREAM_CHANNEL`), so FIFO
   guarantees main has all of the renderer's prior capture before the trigger arrives. For teardown races
   (crash → app immediately closes the window) there is a genuine loss window that R4 only partially covers;
   the design should state the accepted loss rather than claim "delivery is main's responsibility".
3. **Double `before`-filter.** The renderer applies the report handler's `before` prior to forwarding
   (`client.ts:642-645` runs in the renderer client), and main's `applyReportBefore` runs again on the joined
   request. The same app-supplied filter may mutate twice or veto asymmetrically. Decide which side owns
   filtering (WebView solved the analog with `red` provenance flags).
4. **`launchRenderer` must strip a caller-supplied `triggerPipeline`.** After R1 the option becomes visible on
   `LaunchRendererOptions extends BugseeLaunchOptions` (`launch-renderer.ts:19`); a user passing their own
   silently breaks convergence. Electron must own that option (as it owns `captureStore`).
5. **Report attribution is unspecified.** `onEntry` receives the originating `windowId`
   (`main-receiver.ts:55`); the design never says the joined report records which window faulted (an attribute
   / label). Multi-window apps need it.
6. **Multi-renderer storm semantics unstated.** N renderers faulting simultaneously → the trigger pipeline
   serializes and drops beyond queue depth 2 (`trigger-pipeline.ts:64-71`) — with >3 simultaneous incidents,
   the excess is silently `report queue overflow`-dropped. Possibly acceptable; say so. (No cross-attribution
   hazard exists: all reports drain the one converged store by design, and the receiver has no per-renderer
   mutable state beyond the sender tag.)
7. **R5 should land before (or with) R3, not after.** R3 adds new code (`onEntry` → parse → submit) *inside*
   the exact unguarded `ipcMain` listener SEV1 #6 is about (`main-receiver.ts:41-56`). Building R3 first widens
   the throw surface the containment is meant to close.
8. **Incidents before `launchMain` / before the handshake.** Posts sent before `ipcMain.on` registers are
   dropped (no buffering anywhere); a renderer boot crash — the most common real-world case — is lost if the
   app creates windows before calling `launchMain`. The handshake itself is NOT required for posting (posts
   don't wait for `session`), so the only ordering requirement is launchMain-before-window-load — the design
   should state it (and the docs/API should enforce or warn).

---

## Are the rejections sound?

- **B (compose the renderer client via `createClient` in Electron) — rejection SOUND, and understated.**
  `@bugsee/browser`'s launch is 549 lines of composition: coexistence/IDB namespacing, durable pipelines,
  lazy replay + canvas loading, provider wiring, carrier singleton, recovery
  (`packages/browser/src/launch.ts:256-541`). Duplicating it would drift immediately. Decisive extra fact the
  design missed: core already exposes the exact seam (`client.ts:238`), so Option A costs a few lines — B buys
  nothing.
- **C (post-launch pipeline replacement) — rejection SOUND.** `triggerPipeline` is closure-captured
  (`client.ts:342-386`; consumed inside `submitReport`, `:454-486`); there is no supported mutation point, and
  detection is live from `client.launch()` (`launch.ts:476`) so the early-incident window is real.
- **D (server-side correlation) — rejection SOUND.** The renderer snapshot is empty by construction
  (`streaming-capture-store.ts:49-61`); no backend join can recover data never captured locally.
- **Missing option the design should have weighed:** not a fourth *architecture*, but a different *transport*
  within A — a dedicated `report` wire kind instead of a `crash` entry. The design's own precedent
  (WebView) uses two distinct message kinds (`webview-report-pipeline.ts:57-61`); the Electron codec is
  same-version and free to grow one (`protocol.ts:1-3`). This dissolves SEV1-1 cleanly. C4 optimized a
  non-existent compatibility constraint.

---

## Is R0 genuinely non-vacuous?

**Only if the design pins three things it currently leaves implicit:**

1. **R0 must boot the REAL `@bugsee/browser` `launchCore` in the renderer half.** The existing harness fakes it
   entirely (`electron-e2e.test.ts:147-153`) — the design cites this as the reason SEV1 #2 shipped, but never
   states that R0 must not reuse `fakeBrowserLaunch`. An R0 written over the existing harness passes/fails on
   hand-driven `store.add`s and proves nothing. (Feasibility is fine: `window`/`document`/`transport`/
   `captureStore` are all injectable, `launch.ts:180-203`.)
2. **The renderer's would-be upload path must be observable.** Inject the recording transport into the
   *renderer's* browser options too, and assert **exactly one upload across both transports** plus **zero
   renderer-originated `/v2/sessions` calls**. Without this, the positive half ("one bundle on the main
   session") genuinely fails before R1–R3 (main opens no report at all before R3, so it cannot pass
   vacuously) — but the *negative* half is unprovable: after R1–R3 a renderer that still uploads an empty
   foreign-session bundle via unmocked `fetch` is invisible to a collector watching only main's transport, and
   "the defect half-remains" would pass.
3. **Assert `crash.json` correctness, not just presence**: exactly one `crash.json` in the zip, `CrashJson`
   shape, the renderer's stack frames, `handled: false`, `source.mechanism: 'uncaught'`. This is what makes R0
   detect SEV1-1 (duplicate/array-shaped crash.json) and SEV1-2 (mislabeling) — bundle-count assertions alone
   catch neither.

As written ("a renderer-originated incident produces ONE bundle, on the main session, containing the renderer's
streamed capture") R0 would fail-before/pass-after, but would **pass over a build that contains both SEV1
defects**. That meets the letter of "must fail before R1–R3" and misses the point.

---

## What the design omits

- **Renderer report-time snapshots** (viewtree; any future renderer-side pull source) — SEV2-1.
- **The R4 ↔ native-minidump-harvest interaction** — SEV2-3; and the `reason` filter — SEV2-4.
- **Renderer reload / navigation mid-incident:** same `webContents` id across reload (`main-control.ts:53`)
  means a boot-crash-loop shares one dedup key across attempts; entries from before/after reload interleave in
  the one store (acceptable, but the dedup key needs a time bound — SEV2-2).
- **`webContents.destroy()`:** destroys a renderer without `render-process-gone`; R4 keyed only on
  `render-process-gone` never sees it (usually not a fault — but the design's lifecycle section should say
  which teardown events it deliberately ignores).
- **Preload-only failures / sandbox / nodeIntegration variants:** the bridge is preload-`contextBridge`-based
  (`preload-bridge.ts:54-77`) and works sandboxed; every variant where `registerBugseePreload` did not run
  degrades to the silent-loss mode of SEV2-5. One failure mode, but the design should name it.
- **Incidents before `launchMain` / handshake** — SEV3-8.
- **D8 pixel video:** actually a *win* the design forgot to claim — a main-joined report runs main's assembly,
  which pulls `reportSnapshots` including the pixel-video controller (`launch-main.ts:67-70`,
  `client.ts:356-372`), so renderer incidents gain video for free under this design. Worth stating (and
  testing in R0).
- **Replay encoding main-side** — SEV2-7.
- **`logException` awaited from renderer code** (open question 3): note main's `flush` override broadcasts to
  renderers *fire-and-forget* (`launch-main.ts:136-141`, `renderer-control.ts` `void client.flush()`), so
  "main's flush covers it" is only true for incidents that already crossed the IPC boundary.

---

## Recommended changes before implementation

1. **Replace the transport (kills SEV1-1):** add a `report` wire kind to `packages/electron/src/protocol.ts`
   (same-version codec; mirror WebView's `entryMessage`/`reportMessage` split), route it in the receiver to the
   join *without* `store.add`. If a timeline `crash` entry is still wanted (WebView D5 parity), that is a
   separate, explicit decision that must also specify how assembly treats store-resident `crash` entries.
2. **Specify the R3 join seam (kills SEV1-2):** deserialize + **validate** `{ source, report }` into a
   `ReportingRequest` and submit it through a detection-style submit (a synthetic DetectionProvider registered
   by `launch-main`, or a new core `client.submitReport(request)` — pick one), explicitly *not*
   `logException`. Preserve `source.mechanism` / `handled` / the renderer's `report.crash`. Add a
   renderer-scoped rate limit. (This also answers open question 2: `source.type` already distinguishes
   crash/error — no new field needed.)
3. **Rewrite §4.5:** drop `checkOrSetAlreadyCaught`; specify reason-gated `render-process-gone` handling
   (`crashed`/`oom`/`launch-failed`; never `clean-exit`) and a time-bounded per-`windowId` suppression; add
   the R4↔NM-harvest reconciliation (recommend: R4 handles non-dump reasons; `crashed` defers to the existing
   harvest-and-bundle, or R4 claims the dump immediately).
4. **Renderer snapshots:** pull `reportSnapshots` renderer-side in the new pipeline before forwarding (post
   them as ordinary entries), or add a control-channel snapshot pull. State which.
5. **Honest failure semantics:** `{ ok: false }` when the bridge is absent / never handshaken; decide the
   no-main fallback story.
6. **Add a slice for the main-side `replay` file encoder** (or explicitly descope the "with replay" claim).
7. **Tighten R0 as in the section above** (real `launchCore`, both transports observed, crash.json shape
   asserted, video asserted) and **move R5 before R3** in the slice order.
8. Minor: strip caller-supplied `triggerPipeline` in `launchRenderer`; stamp the faulting `windowId` on the
   joined report; strike open question 4 (no session rotation exists — `bugsee-api.ts:30,90-92`).
