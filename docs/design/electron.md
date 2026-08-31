# @bugsee/electron — the Electron SDK

Status: **BUILT + on `main`** — slices E0–E8 complete and convergent-reviewed. (Design captured 2026-07-10 as
the author hand-off doc; kept as the architecture reference.) **Delta since:** E5's crashReporter
*direct-upload* was DROPPED in favour of the harvest-and-bundle path in `docs/design/electron-native-crashes.md`
(NM1–NM5, also built). Read alongside `docs/design/sdk-design.md`,
`docs/design/webview-bridge.md` (the capture-streaming precedent this reuses), and `docs/design/multi-instance-disk-coexistence.md`.

## 1. Problem

Electron is three runtimes in one app that must converge into **one Bugsee session / one bundle**:
- **Main process** — Node.js (app lifecycle, native modules, IPC hub). Long-lived; outlives windows.
- **Renderer processes** — Chromium (the UI; N of them, come and go). DOM/JS like a browser tab.
- **Native** — the Electron/Chromium C++ binary + native addons, per desktop OS (macOS/Linux/Windows). Crashes here are
  not JS — they're minidumps.

A crash in any layer should produce ONE incident carrying the full cross-process session (console/network/logs/replay
from every process + the native stack when applicable).

## 2. Key insight: we already have the pieces

- `@bugsee/node` (main) and `@bugsee/browser` (renderer) both expose an injectable **`captureStore`** seam and identical
  `launchCore()` contracts.
- The **WebView bridge** already built the exact streaming seam: `HostBridgeCaptureStore` swaps `CaptureStoreToken` so the
  aggregator's `store.add(entry)` **serializes + posts the entry across a boundary immediately** instead of buffering
  locally — "the host is the ring + bundler." Its wire protocol (`hello`/`entry`/`batch`/`control`/`report`/`bye`,
  capability negotiation, the payload-splice perf trick, wall-clock normalization via `mono`+`timeOrigin`) is reusable.
- **Native crashes need no bespoke native SDK.** Electron ships `crashReporter` (Crashpad/Breakpad) that captures
  minidumps in every process. We hook it, correlate the dump with the JS session, and upload — the backend symbolicates
  (dSYM/ELF/PDB via `bugsee-cli`; confirmed backend-supported).

## 3. Architecture (main-process-centric)

```
 ┌── renderer 1 (Chromium) ─────────┐        ┌── renderer N ──┐
 │ @bugsee/browser launch           │        │  …             │
 │  capture sources → aggregator    │        │                │
 │  CaptureStoreToken ⇐ ElectronRendererCaptureStore  (the swap, reuses the WebView protocol)
 │        store.add(entry) → serialize → ipcRenderer.send('bugsee:msg', wire)   │
 └──────────────┬───────────────────┘        └───────┬────────┘
                │  (preload contextBridge; contextIsolation-safe)
                ▼  Electron IPC
        ┌───────────────────────────── MAIN PROCESS (Node) ─────────────────────────────┐
        │ @bugsee/node launch  = the OWNER: ring + bundler + upload pipeline + durable q │
        │ ElectronMainReceiver  (a capture SOURCE): ipcMain.on → deserialize → normalize │
        │        to wall-clock → aggregator.addEntry(entry)  ── merges ALL processes ──   │
        │ own Node capture (errors/network/system) → same aggregator                     │
        │ report triggers (renderer-streamed `report` OR render-process-gone) → open one │
        │ native: crashReporter minidumps → collect → upload correlated by session_id    │
        └───────────────────────────────────────────────────────────────────────────────┘
                                     │  one session / one bundle
                                     ▼  /v2/sessions + /v2/issues + signed PUT (existing pipeline)
```

**Ownership (D1):** the **main process owns the session** (session_id, upload pipeline, durable queue). Renderers are
pure streaming sources; they never bundle or upload. Main outlives renderers → survives renderer crashes.

**Renderer → main transport (D2):** reuse the WebView wire protocol over **Electron IPC**. The renderer's
`ElectronRendererCaptureStore` is the WebView `HostBridgeCaptureStore` with its `HostBridge` (JS→native) swapped for a
JS→JS channel (`ipcRenderer.send`). Refactor: extract the transport-agnostic core of `HostBridgeCaptureStore` so both
WebView and Electron share it (the store is identical; only the `post(raw)` sink differs).

**contextIsolation (D3):** renderers can't `require('electron')` under `contextIsolation`/sandbox, so the channel is
exposed by a **preload script** via `contextBridge.exposeInMainWorld('__bugseeElectron', { post })`. `@bugsee/electron`
ships that preload + a one-line renderer entry.

**Main receiver (D4):** the inbound direction is NEW (WebView is outbound-only). `ElectronMainReceiver` is a capture
**source** that `ipcMain.on`s wire messages, deserializes each `entry`, normalizes its `mono`+`timeOrigin` to the main
process's wall-clock, and pushes it into the main aggregator via `addEntry` — tagged with the originating window id.
Report triggers open one report against the merged timeline.

**Native (D5):** call `crashReporter.start({ submitURL, uploadToServer, extra:{ session_id } })` (or collect via
`crashReporter.getLastCrashReport()` + the on-disk dump dir) in the main process; on a native crash in ANY process,
upload the minidump correlated to the session (embed `session_id`/`trace_id` in the crash params — Android's model). The
backend symbolicates. App native-module symbols upload at build time via `bugsee-cli debug-files upload --type dsym|elf|pdb`.

## 4. Decisions

| # | Decision | Why |
|---|---|---|
| **D0** | Full v1 = JS convergence **+** native minidumps (user choice); native is JS-side only (Electron crashReporter) — backend symbolication already exists. | No bespoke native SDKs; backend is ready. |
| **D1** | Main process owns the session + upload; renderers are streaming sources. | Main outlives renderers; is the Node aggregator; one session/bundle. |
| **D2** | Renderer→main reuses the WebView capture-streaming protocol over Electron IPC. | The seam + protocol already exist; only the sink changes. |
| **D3** | Bridge exposed via a preload `contextBridge` (contextIsolation-safe). | Electron security model; renderers can't require electron. |
| **D4** | Main-side inbound receiver = a capture SOURCE feeding `aggregator.addEntry` (new; WebView is outbound-only). | Merge all processes into one timeline. |
| **D5** | Native crashes via Electron `crashReporter` minidumps, uploaded correlated by session_id. | Industry approach (Sentry-electron); no native code. |
| **D6** | Extract a transport-agnostic streaming-store core shared by @bugsee/webview + @bugsee/electron. | DRY; the store is identical, only `post` differs. |
| **D7** | Main uses the durable queue + multi-instance coexistence on `dataDir`. | Crash-safe upload; main+workers share dataDir safely (already built). |
| **D8** | **Visual capture = rrweb DOM-replay by default (zero-native) + an OPT-IN pixel-capture video source.** The rrweb default is essentially free: `@bugsee/replay` emits `replay` capture entries that flow through the SAME streaming path (renderer aggregator → streaming store → main → `replay.bin`), so a renderer needs no special video code — replay is ON by default in `@bugsee/browser` (`replay: false` opts out), and `replay:true`/an options object simply configures it. The opt-in pixel source uses **Electron's own capture APIs** — `webContents.capturePage()` (own content, no permission) and/or `desktopCapturer`+`getDisplayMedia` (window/screen; **macOS Screen-Recording TCC permission** for full-screen, via `systemPreferences.getMediaAccessStatus/askForMediaAccess`) — encoded to a video file added to the bundle. Still NO bespoke per-OS native code; the one genuine OS surface is the macOS permission. | Electron UIs are web UIs → rrweb covers the common case at zero native cost + matches the web SDK; pixel capture is a fidelity upgrade (native chrome / GPU / multi-window) for apps that need it. |

## 5. Slice plan (each: design → red test → green → per-entity mutator loop → review → commit)

- **E0 — scaffold + shared streaming-store core.** Extract the transport-agnostic core of `HostBridgeCaptureStore`
  (`createStreamingCaptureStore({ post, … })`) into a shared spot; re-point `@bugsee/webview` at it (no behavior change,
  green its suite). `@bugsee/electron` package skeleton.
- **E1 — `ElectronRendererCaptureStore` + renderer entry.** The renderer store over an injectable `post` (default
  `ipcRenderer.send`); a `launchRenderer(appToken, options)` that runs `@bugsee/browser` launch with this store injected.
  Test with a fake ipcRenderer.
- **E2 — preload bridge.** The preload script exposing `__bugseeElectron.post` via `contextBridge`; the renderer resolves
  it (buffered until attached, like `HostBridge`). Test the resolution/buffering.
- **E3 — `ElectronMainReceiver` (inbound source).** `ipcMain.on` → decode → wall-clock normalize (per-window
  time-origin) → `aggregator.addEntry` tagged with `windowId`. Report-trigger handling. Test with a fake ipcMain + a fake
  aggregator; assert entries land + timestamps normalized + trigger opens a report.
- **E4 — `launchMain(appToken, options)`.** Compose `@bugsee/node` launch (owner) + wire the `ElectronMainReceiver` as a
  source + hook renderer lifecycle (`web-contents-created`/`render-process-gone`). One session across processes.
- **E5 — native crashReporter integration.** `crashReporter.start` with session-correlated `extra`; collect + upload
  minidumps on native crash (incl. `render-process-gone reason:crashed`), tied to the session. Test with fakes.
- **E6 — session handshake + control propagation.** ✅ BUILT. A same-version `control`/`hello` wire codec (`protocol.ts`)
  carries all four WebView control kinds (pause/resume/flush/stop) plus a `session` handshake reply. The DOWNstream
  half is `main-control.ts` (`createElectronMainControl`): it listens on `bugsee:hello`, replies to each renderer's
  `hello` with the owner's session id on `bugsee:control`, registers the sender (deduped by identity — a reload
  re-replies but doesn't double-register), and broadcasts pause/resume/flush/stop to every registered renderer
  (each send guarded — a destroyed webContents can't break the broadcast to the rest). The preload bridge now exposes
  `sendHello` + `onControl` alongside `post`; the renderer dispatcher is `renderer-control.ts` (pause/resume flip the
  streaming store's `paused` flag — the UP stream drops while backgrounded, incidents still report via the separate
  report path; flush/stop forward to the client; `session` → `onSessionId`). `launchMain` wires the control manager
  off the first-launch internals, replies to hellos with `internals.api.sessionId`, and wraps `client.stop`/`flush` to
  broadcast `stop`/`flush` down before the local drain. `launchRenderer` sends `hello` on launch and subscribes to
  control. All gated on `internals` (present only on first launch), so a repeat `launchMain` returns the client
  untouched (no second receiver/control). `pause()`/`resume()` are complete broadcast primitives on the manager,
  ready for an app-background hook (the trigger, not the mechanism, is the only deferral).
- **E7 — e2e.** ✅ BUILT (`electron-e2e.test.ts`). A fake-Electron IPC bus (fake ipcMain + per-renderer
  ipcRenderer/webContents + preload contextBridge + crashReporter) boots the REAL `@bugsee/node` main via
  `launchMain` (no launch seam) and TWO renderers via `launchRenderer` (only `@bugsee/browser`'s renderer internals
  are faked — capture entries are injected into the real streaming store). It asserts: both renderers learn the
  SAME owner session through the handshake; the native `crashReporter` is started once with that session in `extra`
  (minidump↔session correlation) at the derived `/v2/apps/{token}/minidumps` URL; ONE merged bundle is uploaded
  whose `logs.json` contains capture from main + renderer-1 + renderer-2; and `flush`/`stop` from the main
  propagate down to both renderers. The renderer→main transport, the merge, and the real bundle assembly are all
  exercised end to end (5 injected convergence regressions — dropped receiver add, wrong handshake session, no
  stop/flush broadcast, dropped crash correlation — are all caught).
- **E8 — opt-in pixel-capture video source (D8).** ✅ BUILT. The rrweb DOM-replay DEFAULT rides the streaming path
  (renderer replay is on by default, E1/E3) and needs no slice; this is the OPT-IN pixel path, built as a report-time snapshot
  source (the CPU-profile pattern — pulled at report assembly, never streamed). Landed across three packages:
  - **protocol**: the mobile-canonical `'video'` FileType (now also JS-emitted) + `DEFAULT_FILENAMES.video =
    'video.webm'`.
  - **node**: `launchCore` forwards `reportSnapshots` + `fileEncoders` from the launch options into `createClient`
    (concatenated AFTER the internal profiling snapshot) — the generic extension seam for an async-produced
    report-time artifact + its binary encoder.
  - **electron**: two pluggable `VideoCaptureSource`s behind injected seams — `createCapturePageVideoSource` (MAIN,
    periodic `webContents.capturePage()` → bounded frame ring → injected muxer; own-window, no TCC) and
    `createMediaRecorderVideoSource` (RENDERER, `MediaRecorder` over a MediaStream → webm). **Per the user, the two
    combine**: capturePage supplies frames (no Screen-Recording permission) that a canvas→`MediaRecorder` encodes to
    webm — composed into ONE source by the adapter, so `createPixelVideoController` stays source-agnostic. The
    controller is permission-gated (`hasPermission` TCC seam → inert when denied) and exposes the `ReportSnapshotSource`;
    `encodePixelVideo` is the `video` file encoder. `launchMain` accepts `video: { source, hasPermission? }`, builds the
    controller, forwards its snapshot + encoder into the node launch, starts it (async permission), and stops it on
    `client.stop`. The real Electron/DOM capturers + webm muxer are the app-/adapter-supplied injected seams (no
    electron/DOM dependency in the package). The e2e proves an opt-in `video.webm` lands in the SAME merged bundle.

## 6. Open questions / to confirm at slice time
- **Minidump upload path** — `crashReporter.submitURL` posting directly to a Bugsee collector minidump endpoint vs
  SDK-collected upload via the existing pipeline (better session correlation). Confirm the collector's minidump endpoint
  (Android-parity) at E5.
- **Preload composability** — apps already ship a preload; provide both a standalone preload and a `registerBugseePreload()`
  helper to compose into an existing one.
- **Renderer↔main handshake ordering** — the renderer may capture before the session id arrives; buffer + backfill
  (the `HostBridge` bounded-buffer pattern already covers pre-attach).
- **Windows PDB** in `bugsee-cli` is a scaffold — native symbol upload for Windows needs it finished (CLI/backend, not JS).
