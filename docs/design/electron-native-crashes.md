# Electron/JS native crashes → the existing minidump pipeline

Status: **Design (Draft v1)** — 2026-07-11. Supersedes the E5 crashReporter *direct-upload* approach in
`docs/design/electron.md` (see Decision Log). Cross-repo: `@bugsee/electron` (this repo), `worker` (Python
crash processor), symbol tooling. No `appserver` ingestion change.

> Research provenance: this design is grounded in a read-only survey of three repos — the Bugsee **worker**
> (`/Users/alexeykarimov/Projects/Bugsee/worker`), **appserver**
> (`/Users/alexeykarimov/Projects/Bugsee/appserver`), and the **Android SDK**
> (`/Users/alexeykarimov/Projects/Bugsee/android/sdk`). File:line refs are as-surveyed and may drift; treat
> them as anchors, re-confirm at slice time.

---

## 1. Problem

The backend already has full **minidump processing mechanics** (stackwalk + debug-id symbolication), but they
are only reachable for crashes coming from the **Android SDK**. We want native crashes captured by the
**JavaScript/Electron SDK** (Electron ships Crashpad; V8/Node/native-addon segfaults produce minidumps) to be
processed by that same machinery and surfaced as issues, correlated to the JS session's other capture
(video/logs/network).

The E5 slice (`docs/design/electron.md`) wired Electron's `crashReporter` to upload dumps **directly** via
Crashpad's `submitURL` to a `/v2/apps/{token}/minidumps` endpoint. **That endpoint does not exist and the
worker has no standalone-minidump ingestion path** (0 `crashpad` references worker-wide) — so those dumps have
nowhere to land. This design replaces that approach.

## 2. Understanding summary

- **What**: route Electron/JS native crash minidumps through the existing worker minidump pipeline and show
  them as symbolicated issues.
- **Why**: reuse the built, debug-id-generic stackwalk + symbol store instead of building a parallel path;
  give Electron apps native-crash coverage stitched to the JS session artifact.
- **For**: Electron apps (main/renderer/GPU/child native crashes). Later: any JS runtime that can produce a
  minidump (bare Node via a native crash reporter is out of scope for v1).
- **Key constraints**: **Android-canonical** (mirror the Android native-crash model, which already uses
  Crashpad); reuse existing appserver bundle + symbol endpoints (no new ingestion endpoint); worker changes
  additive; `@bugsee/electron` keeps **no electron/DOM dependency** (injected seams).
- **Non-goals (v1)**: a new Crashpad-direct upload endpoint; symbolicating JS exceptions (that's the managed
  path + source-maps #158, separate); renderer-only pixel/DOM concerns; bare-Node native crashes.

## 3. Assumptions

- Crashpad minidumps are standard minidump format → the worker's `minidump_stackwalk` (Breakpad/rust-minidump)
  parses them (same as the Android NDK path and the wider ecosystem). **Verify at S-worker-1.**
- The JS SDK's existing **capture-recovery** pipeline (durable per-instance capture subtrees +
  `recoverReports` on next launch — see `node`/`webworker`/browser multi-instance work) can carry a **native
  crash report** whose incident marker is written at crash time and whose payload attaches a foreign binary
  (`.dmp`). **Confirm the recovery pipeline can attach an arbitrary file at S-sdk-2.**
- Electron publishes Breakpad symbols for its shipped binaries per version/arch/OS (it does — the
  `electron/electron` releases include `*-symbols.zip`); we can ingest them keyed by debug-id.
- The app's native `.node` addons are built with symbols the app can extract + upload (Breakpad `.sym`).

## 4. Decision log

| # | Decision | Alternatives | Why |
|---|---|---|---|
| **DN0** | **Path B — harvest-and-bundle** (Android-canonical): SDK harvests the Crashpad `.dmp` on next launch and packs it into a normal Bugsee bundle as `crash.minidumpFile`. | Path A — keep Crashpad direct `submitURL` upload + build a new appserver endpoint that synthesizes a bundle. | Path B reuses the **entire** existing pipeline (worker bundle flow + symbol store) and the JS SDK's recovery infra; Android already does exactly this with Crashpad; Path A needs new endpoint + out-of-band session correlation + bundle synthesis. |
| **DN1** | **Supersede E5's direct upload.** Set `uploadToServer:false`; drop `deriveMinidumpUrl`/`minidumpUrl`/`/v2/apps/{token}/minidumps`. | Keep both paths. | The direct-upload endpoint doesn't exist and diverges from Android. One coherent path. |
| **DN2** | Reuse the **existing symbol-upload endpoint** (`POST /v2/apps/{app}/symbols` + `POST /symbols/system`) — debug-id-keyed, generic. | New Electron-symbol endpoint. | The store + lookup are already debug-id-generic; no reason to fork. |
| **DN3** | **Extract a generic minidump processor** in the worker from the Android NDK one; skip Android-only steps (JTD merge, R8/Proguard deobfuscation). | Duplicate `android_ndk.py`; or bolt Electron onto the Android branch. | Stackwalk + debug-id symbol lookup are already platform-agnostic; factoring them out serves Electron and any future native platform without Android coupling. |
| **DN4** | Route by **`environment.platform.type` (normalized) + a native flag on `crash.json`** (mirror `ndkCrash`). | Route by exception name (managed style); route by presence of `minidumpFile` alone. | Mirrors Android's explicit native-crash flag; keeps the JS-exception path (managed/generic + #158) cleanly separate for the SAME SDK. |
| **DN5** | v1 targets **Electron** specifically (desktop main + renderers). | Generalize to all JS runtimes now. | Electron is the concrete driver + has Crashpad; generalize later. |

## 5. The Android-canonical blueprint (what we mirror)

Confirmed native-crash flow in the Android SDK (Crashpad backend):

1. **Capture** — Crashpad writes `.dmp` to `<data>/ndk/<proc>/<generation>/`; a signal-safe **marker**
   (`bgscrash.marker`) records `timestamp|generation|buildUUID|minidumpPath|uptimeMs|captureGeneration|pid`
   (`ndk/jni/bugsee_crash_handler_common.cc` ~186-248; crashpad init in
   `ndk/jni/bugsee_crash_handler_crashpad.cc`).
2. **Harvest next launch** — `BugseeDetectionCrashNdk.processAllPendingNativeReports()` (~984) scans the dir,
   `getNativePendingCrashReports()` (~866) parses the marker into `NdkCrashReportInfo`.
3. **Re-associate to the dead session** — the marker's `captureGeneration` links the dump to the crashed
   session's persisted capture; `request.openForGeneration(captureGeneration)` (~1280) rebuilds that session's
   report from on-disk capture.
4. **Pack into a normal bundle** — `BugseeExceptionProcessor.addToReportingRequest()`
   (`library/.../reporting/exceptions/BugseeExceptionProcessor.java` ~127-177) attaches the dump as
   `ReportFile.TYPE_MINIDUMP`; `ExceptionSerializer.serializeContainerNdk()` (`ExceptionSerializer.java`
   ~95-149) writes `crash.json` with `exception_type: Native`, `signal`, `minidumpFile`, and the NDK flag.
5. **Upload via the standard flow** — create session → create issue (server mints issue+recording ids +
   presigned S3 PUT) → PUT `recordings/{rec}.zip` → worker `bundle` job.

**Worker side** (`worker/jobs/bundle.py`): `normalize_platform(environment.platform.type)` →
`managed`/`android`/else-`apple`; for `android` + `crash.ndkCrash`, `_download_minidump_file_for_crash()`
(~44-57) pulls the dump from `{org}/{app}/issues/{issue}/{rec}/{minidumpFile}` and
`crash/android.py:process_crash_report()` (~292) runs `process_ndk_crash_report()` →
`crash/helpers/android_ndk.py`: `_execute_minidump_stackwalk()` (generic `minidump_stackwalk`, Lambda OOM
fallback) → extract module debug-ids → `api.get_symbol_files()` → download Breakpad `.sym` → re-stackwalk with
symbols → signatures/summary → write back (issue/recording update, minidump re-stored). **Stackwalk + symbol
lookup are debug-id-generic; JTD-merge + deobfuscation are the only Android-specific steps.**

**Appserver**: no minidump endpoint; the standard bundle flow (`POST /v2/sessions`, `POST
/v2/apps/{app}/issues` → presigned PUT) + a **generic** symbol-upload endpoint (`POST /v2/apps/{app}/symbols`,
`POST /symbols/system`) keyed by debug-id.

## 6. Design

### 6.1 Electron SDK (`@bugsee/electron`) — rework E5 to harvest-and-bundle

- **Capture config**: `crashReporter.start({ uploadToServer: false, submitURL: <unused/placeholder> })` so
  Crashpad writes dumps to its DB dir but **never uploads them itself**. Keep the session-correlation `extra`
  (`session_id`/`app_token`) — it rides inside the minidump and is useful metadata, but correlation now
  primarily flows through the recovered bundle (below).
- **Persist a crash marker at start** (portable analog of Android's marker): the Electron SDK records, in its
  durable per-instance capture subtree, the Crashpad DB dir + the current session/capture-generation, so the
  next launch can find pending dumps and tie them to the crashed session. (Crashpad already timestamps + names
  dumps; we mainly need the DB-dir → session link.)
- **Harvest on next launch**: read Crashpad's DB dir for **pending** completed dumps (Crashpad exposes a
  reports database; the `.dmp` files live under `<dir>/completed` / `pending`). For each pending dump whose
  session subtree is recoverable, build a crash report tied to that session's persisted capture
  (video/logs/network) and **attach the `.dmp`** as `crash.minidumpFile`.
  - **KEY REFINEMENT (session-stitched, confirmed 2026-07-12).** A native crash kills the process INSTANTLY,
    so the JS SDK never detects/submits it → **there is NO report marker** (`ReportMarkerStore` markers are
    written by `client.ts` on a JS-side incident submit — see capture-recovery research). The existing
    `recoverReports` only rebuilds ALREADY-submitted incidents. So the native path must **SYNTHESIZE** the
    incident at recovery: (a) at START persist `<subtree>/incidents/crashpad-session.json` linking the
    Crashpad dump dir → this launch's `captureGeneration` + `sessionId`; (b) at NEXT launch, when
    `recoverSubtree` (`packages/node/src/recover-instances.ts`) processes a DEAD sibling, read that marker,
    harvest its pending `.dmp`s, and for each **synthesize** a crash `ReportingRequest` + native `crash.json`
    (`minidumpFile`) + the `.dmp` attachment, DRAIN the dead generation's capture chunks
    (`backend.snapshot` — the session's video/logs/network), and `assembleBundle` → upload through this
    launch's pipeline. Reuses the per-generation drain + assembler + durable upload; the ONLY core additions
    are (1) report-level binary **attachments** on `assembleBundle` (for the `.dmp`) and (2) a **native
    `crash.json`** shape on `report.crash`.
- **Native `crash.json`**: mirror Android — `exception_type: Native`, a `signal` block if derivable, and a
  **native flag** the worker keys on (see §7). The minidump filename is the attached file's name.
- **Seams / no-dep**: Crashpad DB access is Electron/Node-specific → behind an injected `crashDumpSource`
  seam (real impl reads the DB dir via `node:fs`), consistent with the package's no-electron/DOM-dependency
  rule. Fully unit-testable with a fake dump source.
- **Remove**: `deriveMinidumpUrl`, the `minidumpUrl` option, and the `uploadToServer` default-`true` behavior
  from `crash-reporter.ts`; repurpose it to the `uploadToServer:false` + marker-persist role.

### 6.2 Worker — normalize + route + generic minidump processor

- **`utils/platform.py:normalize_platform()`**: add an Electron branch so `environment.platform.type`
  (`'electron'`, or the OS strings Electron reports) does **not** fall through to the `apple` else-branch.
  Decide the canonical normalized value (e.g. `'electron'`) — **open question OQ-1**.
- **`jobs/bundle.py:_process_crash_report()`**: add a route for the Electron platform + native flag that calls
  `_download_minidump_file_for_crash()` (already generic) then a **new generic minidump processor**.
- **Generic minidump processor** (`crash/processors/electron` or a shared `crash/helpers/minidump.py` factored
  out of `android_ndk.py`): reuse `_execute_minidump_stackwalk`, `_get_modules_uuids`, `_get_symbol_files`,
  the re-stackwalk-with-symbols, signature/summary generation, and the Lambda OOM fallback — **omit** the
  Android-only `.jtd` Java-thread merge and R8/Proguard deobfuscation. Per-app symbol lookup targets the
  **unified `symbols` folder** (see §6.3 note) rather than the legacy `symbols/android` vs `mappings` split.
- **Write-back**: unchanged — the processor returns the same `BugseeBundleProcessResult` (threads, modules,
  signal, signatures, `crash_minidump_file`); `jobs/bundle.py` re-stores the symbolicated dump + updates
  issue/recording status/signatures + triggers integrations on `ready`.

### 6.3 Symbols — Electron runtime + app native addons

Lookup needs **zero** changes (debug-id-generic). The work is **ingestion**. Note the org-wide
**symbols-storage unification** (per user 2026-07-11): the legacy per-app `symbols` (dSYM) vs `mappings`
(ProGuard) split collapses to a single `symbols` folder + `symbols.*` jobs; format is chosen by
content-detection. Electron symbols ride that unified per-app store; the shared **system-symbol** store
(`system/symbols/{platform}`, OS/runtime symbols across apps) is a separate mechanism the unification doesn't
change.

- **Electron runtime symbols**: Electron publishes `*-symbols.zip` (Breakpad `.sym`) per version/arch/OS.
  Ingest them keyed by their `MODULE` debug-id — as **system symbols** (a job analogous to the Android
  system-symbol store `system/symbols/android/`, e.g. `system/symbols/electron/`), so every app on a given
  Electron version resolves them without per-app upload. A periodic/one-shot job fetches + parses + stores
  them. **Open question OQ-2** (system vs per-app; who triggers the fetch).
- **App native `.node` addons**: the app uploads their Breakpad `.sym` via the **existing** `POST
  /v2/apps/{app}/symbols` endpoint (into the **unified `symbols` folder**) — ideally via `bugsee-cli` (a
  natural extension of the #158 source-map tooling to native debug files: `debug-files upload`). Keyed by
  debug-id like any native symbol.

### 6.4 Appserver — no change

The standard session→issue→presigned-PUT bundle flow and the symbol endpoints already cover everything. The
Electron bundle (with `crash.minidumpFile`) is just a normal crash bundle.

## 7. Data contract (native crash.json)

The worker routes native minidump crashes by **normalized platform + an explicit native flag** (DN4). To stay
Android-parity, the Electron native `crash.json` SHOULD carry:

- `exception_type: "Native"` (or the JS-SDK equivalent the worker already recognizes),
- a native flag mirroring Android's `ndkCrash` (final field name is **OQ-3** — reuse `ndkCrash`, or a neutral
  `nativeCrash`/`minidump: true`; the worker gate keys on it),
- `minidumpFile: "<name>.dmp"` (the attached file),
- `signal` block if derivable (Crashpad records the exception/signal),
- `environment.platform.type` set to whatever OQ-1 settles on, `environment.sdk` identifying the JS SDK.

JS exceptions from the SAME SDK keep their existing shape (frames + exception) and flow through the managed/
generic path + source-maps (#158) — the native flag is absent, so they never hit the minidump processor.

## 8. Dual-nature routing (native vs JS) — mirrors Android `ndkCrash` true/false

| Crash source | crash.json signal | Worker path |
|---|---|---|
| Native (V8/Node/Electron/native-addon segfault, Crashpad `.dmp`) | native flag + `minidumpFile` | **new** generic minidump processor (§6.2) |
| JS uncaught exception (main/renderer) | `exception` + `frames`, no native flag | managed/generic + source-maps (#158) |

## 9. Open questions / to confirm at slice time

- **OQ-1** — canonical normalized platform for Electron (`'electron'` vs OS + an sdk marker). Drives the gate
  + routing.
- **OQ-2** — Electron runtime symbols: system-symbol store (per Electron version, shared) vs per-app upload;
  who fetches Electron's published symbols and when.
- **OQ-3** — the native-crash flag field name (reuse `ndkCrash` vs a neutral name) — coordinate the SDK payload
  + the worker gate.
- **OQ-4** — Crashpad minidump compatibility with the worker's `minidump_stackwalk` build (verify with a real
  Electron dump fixture at S-worker-1).
- **OQ-5** — Crashpad DB dir layout + the "pending vs completed" harvest semantics across platforms
  (win/mac/linux) and whether `uploadToServer:false` leaves dumps where we can read them.
- **OQ-6** — how a recovered crash-only bundle (crash happened, process died, harvested next launch) creates
  its session/recording — confirm the JS SDK recovery pipeline mints/re-uses the crashed session id and the
  worker accepts a thin-session bundle (it does; `jobs/bundle.py` supports crash-only).

## 10. Implementation slices

Ordered so each is independently verifiable; worker + SDK can proceed in parallel after S0.

> **SDK build status (2026-07-12).** The whole SDK harvest-and-bundle path is BUILT + on master, test-first
> with per-entity mutator loops + coverage gates:
> - **NM1** (`@bugsee/core`): `NativeCrashJson` + report-level binary `attachments` + assembler writes them.
> - **NM2** (`@bugsee/electron`): crashReporter rework → `uploadToServer:false` harvest mode +
>   `getCrashDumpsDirectory`; dropped `deriveMinidumpUrl`/`minidumpUrl` (= **S-sdk-1**).
> - **NM3** (`@bugsee/core` `recoverNativeCrashes` + `CrashpadSessionMarker`/`NativeCrashSource`;
>   `@bugsee/node-utils` single-file crashpad-session marker store; `@bugsee/node` launch persists the marker
>   at START + threads the source): the session-stitched **synthesis** engine (native crash leaves NO report
>   marker → synthesize at recovery).
> - **NM4** (`@bugsee/core` `recoverReports.keepGenerations`; `@bugsee/node` `recoverSubtree` runs native
>   recovery BEFORE the sweep, protecting the crashed generation for retry): wired into instance recovery.
> - **NM5** (`@bugsee/electron` `createElectronNativeCrashSource` reads `<dumpDir>/completed/*.dmp` via an
>   injected fs seam + `launchMain` wiring) (= **S-sdk-2**). v1 = harvest-all + claim-once; per-dump session
>   matching via minidump-annotation parsing deferred (OQ-5).
>
> REMAINING: the **worker** side (S-worker-1/2, S-sym-1/2) + **S0** dump-fixture spike + **S-e2e** (real
> Electron dump → worker). The worker's JS-crash processor (`crash/javascript.py`) already dispatches native
> minidumps to `android_ndk.process_ndk_crash_report`; the generic-processor factoring is S-worker-1.

- **S0 — spike/verify (OQ-4/OQ-5)**: feed a REAL Electron Crashpad `.dmp` (+ Electron's published `.sym`) to
  the worker's `minidump_stackwalk` locally; confirm it stackwalks + symbolicates. De-risks the whole design.
- **S-worker-1 — generic minidump processor**: factor the reusable core out of `android_ndk.py` into a shared
  helper (stackwalk + debug-id symbol lookup + signatures), test-first with an Electron dump fixture; no
  routing yet.
- **S-worker-2 — platform normalize + route**: `utils/platform.py` + `jobs/bundle.py` route the Electron
  native crash to S-worker-1's processor; Electron symbol-folder path.
- **S-sym-1 — Electron system symbols**: ingest Electron's published `.sym` per version/arch/OS keyed by
  debug-id (system-symbol job).
- **S-sym-2 — app `.node` symbols via bugsee-cli**: `debug-files upload` for native debug files (extends
  #158).
- **S-sdk-1 — crashReporter rework**: `uploadToServer:false` + persist the crash marker (Crashpad DB dir ↔
  session link). Supersede `deriveMinidumpUrl`/`minidumpUrl`.
- **S-sdk-2 — harvest + bundle**: on next launch, read pending Crashpad dumps (behind the `crashDumpSource`
  seam), attach as `crash.minidumpFile` to a recovered crash report tied to the crashed session's persisted
  capture; write native `crash.json` (§7).
- **S-e2e — end-to-end**: real Electron dump → SDK harvest → bundle upload → worker processes → symbolicated
  issue, correlated to the session. (SDK-side hermetic e2e with a fake dump source + the worker fixture from
  S0.)

---

### Reconciliation with `docs/design/electron.md` (E5)

E5's `installNativeCrashReporter`/`deriveMinidumpUrl`/`minidumpUrl` (Crashpad direct `submitURL` upload) are
**superseded** by this design (DN1). The crashReporter is still started in the Electron main (still the right
place — Crashpad covers all processes), but with `uploadToServer:false` + marker-persist, and the harvest +
bundle path (S-sdk-1/2) replaces the direct upload. Update the E5 slice + the `docs/design/electron.md` D5
decision to point here when this is built.
