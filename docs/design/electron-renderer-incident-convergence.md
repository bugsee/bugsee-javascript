# Electron renderer incident convergence — design

**Status:** DESIGN — **revised after adversarial review** (`docs/review/electron-convergence-design-review.md`, 2 SEV1 + 7 SEV2 against the first draft). Ready to build. Fixes `docs/review/electron.md` **SEV1 #2** — renderer incidents leave the
converged session, producing an empty bundle under a foreign session id. Sibling of
`docs/design/electron.md` (E0–E8), which specified this and never built it.

---

## 1. The problem

`@bugsee/electron`'s whole premise is that main + renderers + native converge into **ONE** session. That
holds for capture — renderers stream entries UP over IPC and main stores them — and breaks at exactly the
moment that matters.

`launchRenderer` swaps the capture store but leaves `@bugsee/browser`'s own trigger + upload pipeline intact
(`packages/electron/src/launch-renderer.ts:72`). So a renderer uncaught error:

1. assembles a bundle from `createCaptureExporter(captureStore)` over the **streaming** store, whose
   `stream()` yields nothing and whose `drainAll()` returns an empty Map
   (`packages/core/src/streaming-capture-store.ts:49-60`);
2. uploads it from the renderer under the **renderer client's own** random session id
   (`packages/core/src/bugsee-api.ts:30` — each process mints its own).

Meanwhile the main session — which holds every one of that renderer's capture entries — records **no
incident at all**.

The customer gets an issue with no logs, no network, no replay, in a session containing nothing else, plus a
second silent session containing all the data and no issue. **No attacker is required; this is the default
path for every Electron renderer crash.**

**Why this is an omission, not a design choice.** `@bugsee/webview` — the acknowledged source of the
streaming-store pattern — replaces the client's trigger pipeline for precisely this reason
(`packages/webview/src/launch.ts:224`). `docs/design/electron.md:48` and `:105` called for the same thing
("report triggers (renderer-streamed `report` OR render-process-gone) → open one"). It was never built:
`grep triggerPipeline packages/electron/src` returns nothing.

---

## 2. Verified constraints

Read from the code, not assumed.

| # | Constraint | Evidence |
|---|---|---|
| **C1** | **`@bugsee/browser` has NO trigger-pipeline seam.** It exposes `captureStore?` and builds its own pipeline internally, so Electron cannot inject one the way WebView does. | `packages/browser/src/launch.ts:191` (only `captureStore?`); no `triggerPipeline` anywhere in the file |
| **C2** | **WebView could only do it because it composes the client itself** via `createClient`, rather than reusing a platform launch. | `packages/webview/src/launch.ts:224-236` |
| **C3** | **The join seam already exists on the main side and is unused.** `ElectronMainReceiverOptions.onEntry` is documented verbatim as *"a seam for report joins"* and is declared but never wired by `launch-main`. | `packages/electron/src/main-receiver.ts:27-28`; grep shows no caller |
| **C4** | ~~`crash` is a valid `FileType`, so no new wire kind is needed.~~ **WITHDRAWN.** True but irrelevant: the Electron codec is **same-version by declaration** (`packages/electron/src/protocol.ts:1-3` — main and renderers ship together), so adding a wire kind costs nothing. This "optimization" targeted a compatibility constraint that does not exist, and reusing `entry` actively caused SEV1-1 below. WebView itself splits `entryMessage`/`reportMessage` (`packages/webview/src/webview-report-pipeline.ts:57-61`). | — |
| **C5** | **Main has no renderer-lifecycle hooks.** `main-control.ts` tracks registered renderers by sender identity, but nothing subscribes to `render-process-gone` / `web-contents-created`. | `packages/electron/src/main-control.ts:53`; grep finds no lifecycle listener |

---

## 3. Options

### A. Give `@bugsee/browser` a `triggerPipeline` seam, and have Electron inject a forwarding one — **recommended**

Symmetric with the `captureStore` seam that already exists (**C1**), and exactly the shape WebView proved
(**C2**). The renderer's pipeline stops assembling/uploading and instead posts the incident UP as a dedicated
**`report`** message; main receives it beside the existing `onEntry` seam (**C3**) and opens **one** report
against the main session, which holds all of that renderer's capture.

### B. Have Electron compose the renderer client itself with `createClient` — **rejected**

Duplicates `@bugsee/browser`'s entire composition (global error capture, network, replay, IndexedDB
persistence, performance) inside `@bugsee/electron`, and guarantees drift. WebView can do this because it is
a deliberately narrow surface; an Electron renderer is a full browser SDK.

### C. Post-launch pipeline replacement — **rejected.** Mutating a launched client's internals is a private-API
dependency that would break silently on any core refactor, and there is a window between launch and
replacement where an early incident takes the broken path.

### D. Leave the renderer uploading, and merely correlate the two sessions server-side — **rejected.** It needs
a backend change, still produces two sessions, and the renderer bundle is empty regardless.

---

## 4. Recommended design (Option A)

### 4.1 Renderer

A new `createElectronRendererReportPipeline` mirroring `webview-report-pipeline.ts`:

- Posts a **dedicated `report` wire kind** (new in `protocol.ts`, mirroring WebView's
  `entryMessage`/`reportMessage` split). **Not** an `entry`.

  The first draft reused `entry` with `type: 'crash'` to avoid a protocol change. That was wrong twice over:
  the codec is same-version so the change is free, and — the actual defect — `main-receiver.ts:50-55`
  `store.add`s every decoded entry *before* calling `onEntry`. A forwarded incident would therefore land in
  the main rolling capture store, and `bundle-assembler.ts:144-167` would emit **two** files named
  `crash.json`: one array-shaped wrapper from the store group, one real `CrashJson` from the report. Worse,
  the entry sits in the 60 s window, so **every subsequent report** — a main crash, a manual report, another
  renderer — would carry the stale forwarded crash. Cross-contamination of unrelated issues.
- Resolves `{ ok: true }`: delivery is main's responsibility now, and a renderer must not report its own
  upload outcome.
- **Never uploads from the renderer.** That is the defect.

`launchRenderer` passes it through the new `@bugsee/browser` seam.

### 4.2 `@bugsee/browser`

Add `triggerPipeline?: TriggerPipeline` to `BugseeLaunchOptions`, defaulting to today's behaviour. Purely
additive, matching `captureStore?`. Every other consumer is unaffected.

### 4.3 Main

`launch-main` handles the new `report` message (**C3**'s seam, extended to carry it): deserialize, **validate**
`{ source, report }` into a `ReportingRequest`, and submit it through a **detection-style submit** — either a
synthetic `DetectionProvider` registered by `launch-main`, or a new `client.submitReport(request)` on core.
Pick one in R3; both preserve `source.mechanism`, `handled`, and the renderer's own `report.crash`.

**Explicitly NOT `logException`.** The first draft said "the normal reporting path", which does not publicly
exist: the only public entry point is `logException`, which would refile a renderer *crash* as a **handled,
programmatic** error carrying a **main-side stack** — destroying the very attribution this design exists to
fix. Renderer input is untrusted (see Wave 0.2), so the submitted request is validated and **rate-limited
per renderer**.

The bundle is then assembled from the main store — which already contains that renderer's streamed capture —
under the main session id. **One session, one incident, full capture.**

### 4.4 `render-process-gone`

A renderer killed by an OOM or a GPU fault never gets to post anything. Main subscribes to
`render-process-gone` (**C5**, and `docs/design/electron.md:105`) and synthesises an incident for that
renderer, attributed to the session that already holds its capture. `electron` stays an injected argument —
the package keeps no electron dependency.

**Reason-gated.** `render-process-gone` fires on normal teardown too. Handle `crashed` / `oom` /
`launch-failed`; **never** `clean-exit` — synthesising an incident for a closed window would manufacture
crashes that never happened.

**The real duplicate is not the one the first draft named.** For `reason: 'crashed'` the already-built native
minidump harvest (`docs/design/electron-native-crashes.md`, NM1–NM5) also produces an incident for the same
event. R4 must reconcile with it: either R4 handles only the non-dump reasons and defers `crashed` to the
harvest, or R4 claims the dump immediately. **Decide in R4** — this is a real collision between two shipped
subsystems, and the first draft did not mention it at all.

### 4.5 De-duplication

The genuine overlap is renderer-forwarded vs `render-process-gone` for the same fault: the renderer posts,
then dies. Suppress by **`windowId` within a short time bound** (the second signal for a window that just
reported is dropped).

`checkOrSetAlreadyCaught` (`packages/core/src/dedup.ts`) is **not** usable here, contrary to the first draft:
it tags the error *instance*, and an instance cannot cross IPC — the renderer forwards a serialized report,
and `render-process-gone` carries no error identity at all. A key of "window id + the error's identity" is
therefore unimplementable as written. Note also that a reload reuses the same `webContents`
(`main-control.ts:53`), so the suppression window must be short enough not to swallow a genuine second crash
after a reload.

---

## 5. Slices

| Slice | Work | Package |
|---|---|---|
| **R0** | **e2e FIRST.** A renderer-originated incident produces ONE bundle, on the main session, containing the renderer's streamed capture. To be non-vacuous it must additionally: pin the **real** `launchCore` (not the fake the current e2e uses), observe **both** transports (nothing uploaded from the renderer; the report received by main), and **assert `crash.json`'s shape and that there is exactly one** — without that last check it would pass over SEV1-1. Must fail before R1–R3. | `electron` |
| **R1** | `triggerPipeline?` seam on `@bugsee/browser` launch options (additive, default unchanged) | `browser` |
| **R2** | `createElectronRendererReportPipeline` + wire it in `launchRenderer` | `electron` |
| **R3** | Wire `onEntry` in `launch-main`: a `crash` entry opens a report on the main client | `electron` |
| **R4** | `render-process-gone` → synthesised incident, with renderer-scoped dedup against R3 | `electron` |
| **R5** | Contain the `ipcMain` listener throw (**SEV1 #6**). **Ordered BEFORE R3**, not after: R3 adds report submission inside that listener, so the containment must already be in place or a validation throw takes down the channel. | `electron` |

**R0 is written first, and must be seen to fail.** The existing e2e fires reports on the **main** client and
fakes `@bugsee/browser`'s launch entirely (`electron-e2e.test.ts:147-153`, `:225`), so no renderer-originated
report is exercised anywhere today — which is exactly why this shipped.

---

## 6. Open questions

1. **Should the renderer still capture its own `crash.json`?** WebView always streams the incident as a
   timeline entry *and* optionally triggers a report. Electron's main is the bundler, so the forwarded entry
   may be enough — or main may want both a `crash` file and the trigger.
2. ~~**What about `logException` called explicitly in a renderer?**~~ **RESOLVED:** no new field needed —
   `source.type` already distinguishes crash from error, and the validated submit preserves it.
3. **Does a renderer incident need to await the flush?** The renderer returns `{ ok: true }` immediately, so
   an app that awaits `logException` gets a resolved promise before the bundle exists. Acceptable, or should
   main acknowledge over the control channel?
4. ~~**Session id on the wire.**~~ **STRUCK:** there is no session rotation to attribute across — a session
   id is minted once per client (`packages/core/src/bugsee-api.ts:30`, `:90-92`).

5. **Renderer report snapshots.** `reportSnapshots` (the DOM viewtree, D8 pixel video) are renderer-side. The
   forwarding pipeline must either pull them before forwarding and post them as ordinary entries, or main
   must pull them over the control channel. **Decide before R2.**

6. **Failure semantics.** The renderer resolves `{ ok: true }` on hand-off. It should resolve `{ ok: false }`
   when the bridge is absent or the handshake never completed — otherwise an app awaiting `logException` is
   told an incident was delivered when nothing received it.
