# Electron renderer incident convergence — design

**Status:** DESIGN, for review. Fixes `docs/review/electron.md` **SEV1 #2** — renderer incidents leave the
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
| **C4** | **`crash` is already a valid `FileType`**, so an incident can travel as an ordinary `entry` message — no new wire kind is needed. | `packages/protocol/src/constants.ts` (`FileType` includes `crash`) |
| **C5** | **Main has no renderer-lifecycle hooks.** `main-control.ts` tracks registered renderers by sender identity, but nothing subscribes to `render-process-gone` / `web-contents-created`. | `packages/electron/src/main-control.ts:53`; grep finds no lifecycle listener |

---

## 3. Options

### A. Give `@bugsee/browser` a `triggerPipeline` seam, and have Electron inject a forwarding one — **recommended**

Symmetric with the `captureStore` seam that already exists (**C1**), and exactly the shape WebView proved
(**C2**). The renderer's pipeline stops assembling/uploading and instead posts the incident UP as a `crash`
entry (**C4**); main receives it on the existing `onEntry` seam (**C3**) and opens **one** report against the
main session, which holds all of that renderer's capture.

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

- Serialises `{ source, report }` and posts it as an `entry` with `type: 'crash'` on the existing stream
  channel — **no protocol change** (**C4**).
- Resolves `{ ok: true }`: delivery is main's responsibility now, and a renderer must not report its own
  upload outcome.
- **Never uploads from the renderer.** That is the defect.

`launchRenderer` passes it through the new `@bugsee/browser` seam.

### 4.2 `@bugsee/browser`

Add `triggerPipeline?: TriggerPipeline` to `BugseeLaunchOptions`, defaulting to today's behaviour. Purely
additive, matching `captureStore?`. Every other consumer is unaffected.

### 4.3 Main

`launch-main` wires the previously-unused `onEntry` seam (**C3**): on a `crash` entry from a renderer, open a
report on the MAIN client via its normal reporting path. The bundle is then assembled from the main store —
which already contains that renderer's streamed capture — under the main session id. **One session, one
incident, full capture.**

### 4.4 `render-process-gone`

A renderer killed by an OOM or a GPU fault never gets to post anything. Main subscribes to
`render-process-gone` (**C5**, and `docs/design/electron.md:105`) and synthesises an incident for that
renderer, attributed to the session that already holds its capture. `electron` stays an injected argument —
the package keeps no electron dependency.

### 4.5 De-duplication

A crash may arrive twice: once forwarded by the renderer, once from `render-process-gone`. The existing
`checkOrSetAlreadyCaught` (`packages/core/src/dedup.ts`) is the natural mechanism; the join key must be
renderer-scoped (window id + the error's identity), not global, so two renderers faulting on the same error
still produce two incidents.

---

## 5. Slices

| Slice | Work | Package |
|---|---|---|
| **R0** | **e2e FIRST** — a renderer-originated incident produces ONE bundle, on the main session, containing the renderer's streamed capture. Must fail before R1–R3. | `electron` |
| **R1** | `triggerPipeline?` seam on `@bugsee/browser` launch options (additive, default unchanged) | `browser` |
| **R2** | `createElectronRendererReportPipeline` + wire it in `launchRenderer` | `electron` |
| **R3** | Wire `onEntry` in `launch-main`: a `crash` entry opens a report on the main client | `electron` |
| **R4** | `render-process-gone` → synthesised incident, with renderer-scoped dedup against R3 | `electron` |
| **R5** | Contain the `ipcMain` listener throw (**SEV1 #6**, adjacent and cheap once R3 touches this path) | `electron` |

**R0 is written first, and must be seen to fail.** The existing e2e fires reports on the **main** client and
fakes `@bugsee/browser`'s launch entirely (`electron-e2e.test.ts:147-153`, `:225`), so no renderer-originated
report is exercised anywhere today — which is exactly why this shipped.

---

## 6. Open questions

1. **Should the renderer still capture its own `crash.json`?** WebView always streams the incident as a
   timeline entry *and* optionally triggers a report. Electron's main is the bundler, so the forwarded entry
   may be enough — or main may want both a `crash` file and the trigger.
2. **What about `logException` called explicitly in a renderer?** Same path, but it is not a crash; the
   forwarded entry's `type` may need to distinguish "incident" from "crash" so main does not mislabel a
   handled exception.
3. **Does a renderer incident need to await the flush?** The renderer returns `{ ok: true }` immediately, so
   an app that awaits `logException` gets a resolved promise before the bundle exists. Acceptable, or should
   main acknowledge over the control channel?
4. **Session id on the wire.** Renderers already receive the main session id via the handshake. Should the
   forwarded incident carry it, so a late-arriving entry after a session rotation is attributed correctly?
