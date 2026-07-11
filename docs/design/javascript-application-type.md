# The `javascript` application type (umbrella + runtime subtypes)

Status: **Design (Draft v1)** — 2026-07-11. Cross-repo: `appserver` (Node), `viewer` (Angular), `worker`
(Python). Companion to `docs/design/electron-native-crashes.md` (native minidumps are ONE crash-type within
this umbrella).

> Research provenance: read-only survey of `appserver` (`code/…`), `viewer` (`src/…`), `worker` (source
> only). File:line anchors are as-surveyed; re-confirm at slice time.

---

## 1. Problem

Bugsee applications have a `type` (currently `ios`/`android`; a legacy `web` exists but is deprecated) and a
`subtype` (framework: `react_native`/`flutter`/`unity`/`dotnet`/`xamarin`/`cordova`/`kmp`). The new
JavaScript SDK targets **every JS runtime** (browser, Node, Bun, Deno, Electron, Web/Service Worker, edge) but
has **no application type**. We need a `javascript` umbrella type + a runtime discriminator, threaded through
appserver (data model, symbol pipeline, validation, API), the viewer (the richest surface — crash rendering,
onboarding, symbol UI, per-runtime display), and the worker (crash routing + processors + jobs).

## 2. Key findings (grounded)

- **`web` is legacy/dead**, not reusable: creation rejected (`appserver/code/components/app/application/application.service.js:764`),
  new issues rejected since 2022 (`.../issue/issue.service.js:1337`), retention bypassed
  (`.../billing/billing.utils.js:296`). → introduce a **fresh `javascript`** type; leave `web` untouched.
- **`type` + `subtype` already model umbrella+sub**: `appserver/code/components/shared/dao/models/_application.js:15-29`
  (`applicationTypes` + `applicationSubTypes`); viewer mirror `viewer/src/app/core/types/applications.ts:25`.
- **The viewer already separates app-level type from per-recording runtime**: `application.type`
  (immutable — onboarding, symbol UI, SDK snippets) vs `recordingSession.data.app_type` /
  `environment.platform.type` (per session — crash rendering, playback, console, device display). ~94 branch
  sites / ~50 files.
- **Worker routes on normalized `environment.platform.type`, NOT app.type**
  (`worker/jobs/bundle.py:161,206-230`; `worker/utils/platform.py:5-23`). It reads `application['type']` only
  for device-model lookup + a mis-named `context.platform_type` (`worker/jobs/bundle.py:673,683,1031`).
- **Symbol format is auto-detected BY CONTENT** (`worker/symbolfiles/utils.py:76-122`: magic bytes → DSYM/BSF/
  BMF/ELF, regex → MAPPING, JSON → SOURCEMAP), and dispatched dynamically
  (`worker/simpleq/jobs.py:96-99`). **Sourcemap symbolication already exists + is in production**
  (`worker/symbolfiles/sourcemap.py`, `worker/symbolfiles/processors/sourcemap.py`, debug-id/`debugId`-keyed;
  invoked by `worker/crash/managed/reactnative.py`). → JS-exception symbolication REUSES this.
- **appserver symbol routing is app.type-coupled**: `symType = app.type==='ios' ? 'symbols' : 'mapping'`; S3
  key `symbols/{type}` vs `mappings/{type}`; worker action `symbols.delete` vs `mapping.delete`; format
  constraints; an Android Breakpad↔ProGuard **collision guard** keyed by `(images.uuid, transform)`
  (`.../symbols/symbols.service.js:74,275-286,426-428,447-469,535,653,683`).
- **SDK-version config is keyed by app.type** (`appserver/config/default.js:132-147` `cfg.core.sdk[type]`),
  and **client validation** requires `clientType === app.type` (`appserver/code/utils.js:1090-1101`).

## 3. Core model decision — umbrella + **per-session** runtime (CONFIRMED 2026-07-11)

The JS runtime (browser/node/electron/…) is **not fixed per app**: an *isomorphic* app (e.g. Next.js) produces
**browser AND node AND edge** sessions from ONE Bugsee app. So the runtime is fundamentally **per-recording**,
not a single app-level attribute. **Confirmed model** (**DJ1/DJ2** — "umbrella + per-session, both"):

- **`app.type = 'javascript'`** — the umbrella application type (immutable; onboarding, symbol UI, SDK
  install, docs routing).
- **The JS SDK already stamps `environment.sdk.type = 'javascript'`** (protocol `wire.ts:45-51`) — the
  **authoritative, already-sent routing discriminator** the worker keys on (see §5.2). No guessing from
  platform strings.
- **Per-session runtime = `environment.platform.type`** ∈ the protocol `PlatformType` union
  (`wire.ts:24-34`): `web` (browser) `| node | bun | deno | workers | edge-light | service-worker |
  web-worker | electron-main | electron-renderer` — **already sent per session**; the **authority** for
  per-recording rendering/routing (mirrors today's `recordingSession.app_type`, more granular). Note the
  browser sends `web`, so `platform.type` alone can't distinguish a JS crash from a legacy `web` crash —
  `sdk.type` does.
- **`app.subtype`** — an **optional app-level "primary runtime / framework" hint** (e.g. `node`, `electron`,
  `nextjs`) used only for onboarding defaults, the default UI lens, and symbol expectations — **NOT** the
  per-session authority. Isomorphic apps keep mixed-runtime sessions accurate because the session runtime
  comes from `environment`.

This honours the "umbrella + subtypes" intuition while staying correct for isomorphic apps + the single-SDK-
all-runtimes reality, and reuses the viewer's existing app-type-vs-per-recording split.

## 4. Decision log

| # | Decision | Alternatives | Why |
|---|---|---|---|
| **DJ0** | Fresh `javascript` app.type; leave legacy `web` alone. | Reuse/revive `web`. | `web` carries deprecation baggage (rejected create/issues, no retention); a clean type avoids all of it. |
| **DJ1** | Per-session runtime from `environment.platform.type` is authoritative for rendering/routing. | App-level runtime only. | Isomorphic apps have mixed-runtime sessions; the SDK already sends per-session platform. |
| **DJ2** ✅ | `app.subtype` = optional app-level primary-runtime/framework HINT (onboarding/default lens), not per-session authority. **CONFIRMED 2026-07-11.** | subtype = the runtime (fixed per app); per-session only (no subtype). | Keeps the umbrella+sub schema, but a single subtype can't represent mixed-runtime apps; per-session `environment.platform.type` is authoritative. |
| **DJ3** | Crash-type matrix: JS exception → sourcemap (reuse existing); native crash → minidump (`electron-native-crashes.md`), routed by a native flag on crash.json. | One JS processor guessing. | Mirrors Android `ndkCrash` true/false; reuses both existing paths cleanly. |
| **DJ4** (rev. 2026-07-11) | Symbols: sourcemaps (debug-id-keyed, already supported) + native Breakpad (.node addons + Electron runtime) ride the **UNIFIED `symbols` folder + unified handling** — no dedicated `sourcemaps` namespace. Worker **content-detection** (magic bytes / JSON→sourcemap) selects the format/processor; Android-style **collision guard** (sourcemap + breakpad share a build id, keyed by `transform`) kept within the unified folder. | A separate `sourcemaps.*` S3 folder + job namespace. | **Org-wide symbols-storage unification** (per user 2026-07-11): all symbol types collapse from the `symbols`/`mappings` split into one `symbols` folder. JS rides that unified pipeline; content-detection already routes format, so no JS-named namespace is needed. |
| **DJ5** | In the viewer, treat `javascript` like `web` for "native-device" branches (hide rotation/touch-frame/jailbreak/battery/device-model), PLUS add JS-specific rendering (runtime badges, JS stacks, Electron native threads). | Per-branch bespoke JS handling everywhere. | Most `app_type` branches are mobile-device concerns that don't apply; `web` already models "no native device". |
| **DJ6** | Worker keeps JS runtimes **granular** in `normalize_platform` (don't fold to `web`); route `javascript` crashes to a new `crash/javascript.py`. | Fold JS runtimes to `web` and reuse. | Per-runtime routing (electron native vs browser JS) + per-runtime stats need the granularity. |

## 5. Per-repo design

### 5.1 appserver (Node)

- **Schema** (`_application.js:15-29,158-166`): add `APPLICATION_TYPE_JAVASCRIPT: 'javascript'` to
  `applicationTypes`; add JS runtime values to `applicationSubTypes` (or a dedicated `jsSubTypes` set):
  `browser`, `node`, `bun`, `deno`, `electron`, `webworker`, `serviceworker`, `edge` (+ framework hints later:
  `nextjs`, …). Push-method pre-save (`:228-239`) → `'none'` for javascript (web-push is a later option).
- **Creation/validation** (`application.service.js:764-769`): allow `javascript` (the `web` rejection stays);
  validate the subtype against the JS set.
- **Client validation** (`utils.js:1090-1101` `isValidForClient`): accept the JS SDK client types
  (`browser`/`node`/…) when `app.type === 'javascript'` (map client runtime → allowed for the umbrella).
- **Platform normalization** (`platform.utils.js`): map SDK `environment.platform.type` JS runtimes to their
  canonical granular values (do NOT fold to a mobile type).
- **Symbol pipeline** (`symbols.service.js`) — **rides the org-wide symbols unification** (see box below):
  the current app.type split (`symType = app.type==='ios' ? 'symbols' : 'mapping'`; S3 `symbols/{type}` vs
  `mappings/{type}`; `symbols.delete` vs `mapping.delete` @ `:74,275-286,535,653,683`) collapses to a single
  `symbols` folder + a single `symbols.*` job namespace. The `javascript` branch then simply accepts
  **sourcemaps + native Breakpad** into that unified folder — no JS-specific split to add. Keep the
  **collision guard** (`:447-469`) so a JS build's sourcemap and its native `.node` Breakpad symbols (same
  build id) don't overwrite each other (keyed by `transform`). Allow reprocessing for javascript.

  > **Symbols-storage unification (org-wide, per user 2026-07-11).** Independent of this design, the symbol
  > directory + handling are being unified: **everything goes to one `symbols` folder** instead of the
  > `symbols` (iOS dSYM) / `mappings` (Android ProGuard) split, with unified job handling. This design
  > **assumes + rides** that unification — the `javascript` type adds sourcemaps + native Breakpad to the same
  > unified pipeline (format chosen by content-detection). If the unification lands after J0–J2, the JS branch
  > targets the unified folder from the start (do not re-introduce a JS-specific `sourcemaps` split).
- **SDK-version config** (`config/default.js:132-147`): add `cfg.core.sdk['javascript']` (per-runtime
  current/old/min, or a single JS-SDK version stream). Formatter `application.formatter.js:57-58` then
  populates `sdk_outdated`/`sdk_latest` for javascript.
- **API surfaces** (`application.formatter.js`, `public_api/.../formatter.js:12`, integration/webhook
  formatters): they already echo `type`/`subtype` generically → just the enum expansion. **MCP tool**
  (`components/mcp/tools/application.list.js:68`): expand `z.enum([...,'javascript'])` + update the subtype
  description.
- **Migration** (`.../dao/migration/migrations/`): add the enum values + `cfg.core.sdk['javascript']`; **no
  data backfill** (new type). Follow the existing enqueue-`bundle.resymbolicate` migration pattern if any
  reprocessing is ever needed.

### 5.2 worker (Python)

- **Routing discriminator = `environment.sdk.type == 'javascript'`** (authoritative; already sent). Add the
  `type` field to the worker's `BugseeEnvironmentSDK` typedef (`typedefs/entities.py`) and read it in
  `jobs/bundle.py`. This routes ALL JS-SDK crashes (any runtime, handled/unhandled, JS-exception or native)
  to a single `crash/javascript.py` — BEFORE the `managed`/`android`/`apple` branches (a browser's
  `platform.type=='web'` would otherwise fall to the `apple` else-branch). React-Native etc. keep their own
  sdk.type, so they still route through `managed`.
- **`jobs/bundle.py:_process_crash_report`** (`:205-230`): insert `if is_javascript: crash_info =
  javascript.process_crash_report(...)` as the first branch. Add a `javascript` device-model/stats branch
  (`:673-686`) for runtime naming (Chrome / Node vX / Electron vX from `platform.type`).
- **`utils/platform.py:normalize_platform`**: the JS runtime values (`web|node|bun|deno|workers|edge-light|
  service-worker|web-worker|electron-main|electron-renderer`) are used only for per-runtime rendering/stats,
  not routing (sdk.type routes). Keep them granular (don't fold to `web`). Canonicalization is **OQ-B** —
  likely a no-op passthrough since the SDK already sends clean values.
- **`crash/javascript.py`** (new): dispatch by the crash payload —
  - JS exception (`exception` + `frames`) → **reuse** `symbolfiles/(processors/)sourcemap.py` symbolication
    (the React-Native path generalized to plain JS stacks; `crash/managed/reactnative.py:228,240` is the
    template).
  - native crash (native flag + `minidumpFile`) → the **generic minidump processor** from
    `electron-native-crashes.md` (factored out of `crash/helpers/android_ndk.py`, minus JTD/deobfuscation).
- **Jobs**: with the symbols unification, all symbol uploads ride the single **`symbols.*`** job namespace
  (the `mapping.*` split collapses); the worker's **content-detection** (`symbolfiles/utils.py:76-122`) already
  selects the processor (sourcemap / ELF / Breakpad / dSYM / mapping) per file — so JS sourcemaps + native
  Breakpad need **no new job namespace**. `crash/javascript.py` just consumes whatever the unified store holds
  for the build's debug-ids.

### 5.3 viewer (Angular) — the richest surface

- **Type model**: `src/app/core/types/applications.ts:25` add `| 'javascript'`; add a JS runtime union (for
  `subtype` and/or a per-recording runtime field). `application-types.constant.ts` + `application-subtypes.
  constant.ts`: add `javascript` (icon/title) + runtime entries (icons: browser→chrome, node, electron, bun,
  deno; labels + i18n in `locale/messages.json`). Type-label/icon maps in `list-row`/`recent-applications`
  components.
- **"Hide native-device" reuse (DJ5)**: for the ~device branches that today gate on `!== 'web'` /
  `=== 'ios'|'android'` — video rotation/device-frame (`video-player.component.ts:396,492,532`), touch overlay
  (`touches.component.ts`), view-tree density (`view-tree-presenter…:486,512`), jailbreak/root
  (`overview…:641`, `application-sessions-view…html:341`), battery/hardware/device-model
  (`context.component.*`, `environment.component.*`) — treat `javascript` like `web` (skip native-device
  chrome). Per-session runtime comes from `environment.platform.type`.
- **JS-specific rendering (new)**:
  - **Callstack** (`callstack.component.ts:143` switch + `.html`): add a `javascript` case — JS stacks with
    sourcemap-symbolicated frames; for `electron` native crashes, render minidump threads/modules (like the
    android native branch). Missing-symbol badges: "missing sourcemap" (JS) / "missing symbols" (native).
  - **Runtime badges**: per-recording runtime (browser/node/electron/…) shown from
    `environment.platform.type` in issue/session lists + detail.
  - **Console** (`console.component.ts:171-222`): add JS log sources (console.log/info/warn/error, plus
    node stdout/stderr) to the source filter.
  - **Onboarding / create-dialog** (`create-dialog.component.*`, `setup-guide…`, `getDocumentationDir.ts:9`):
    a `javascript` wizard branch with per-runtime SDK install snippets (`@bugsee/browser`/`node`/`electron`/…)
    + docs routing.
  - **Symbol-upload dialog** (`symbol/upload-dialog/*`, `setup-dialog/*`): a `javascript` case — upload
    **sourcemaps** (and native debug files for electron/node), with JS-appropriate instructions (bundler
    plugin / bugsee-cli, per #158).
  - **Report/download dumps** (`downloads.ts:428-530`): a `javascript` branch (runtime, Node/Electron
    version, etc.).
- **App-type vs per-session**: keep the existing split — `application.type` drives app-level UI; the new
  per-session runtime (`environment.platform.type`) drives per-recording rendering. `recordingSession.data.
  app_type` becomes/extends to carry the JS runtime.

## 6. Crash-type matrix (within the `javascript` umbrella)

| Session runtime | Crash source | crash.json signal | Worker path | Symbols |
|---|---|---|---|---|
| browser / node / bun / deno / worker | JS uncaught exception | `exception` + `frames` | `crash/javascript.py` → sourcemap symbolication (reuse) | sourcemaps (debug-id) |
| electron / node (native addon) | native segfault (Crashpad `.dmp`) | native flag + `minidumpFile` | `crash/javascript.py` → generic minidump processor (`electron-native-crashes.md`) | native Breakpad (.node + Electron runtime, debug-id) |

Both crash-types share the `javascript` app.type; the native flag on crash.json (Android-parity `ndkCrash`
analog) selects the path. JS exceptions and native minidumps can coexist for the same app.

## 7. Migration + rollout

1. appserver schema enum + `cfg.core.sdk['javascript']` migration; allow creation; MCP enum.
2. worker `normalize_platform` + `crash/javascript.py` (JS-exception path first — reuses sourcemaps).
3. viewer type model + "treat-like-web" device branches + JS onboarding + symbol-upload + callstack.
4. Native minidump path (`electron-native-crashes.md`) layered on once JS-exception + app-type land.
5. Backward-compat: existing ios/android/web branches untouched; `javascript` is additive everywhere.

## 8. Open questions

- ~~**OQ-A** — subtype semantics (DJ2)~~ **RESOLVED 2026-07-11**: umbrella + per-session (both) — app.type=
  'javascript', per-session runtime from `environment.platform.type` (authoritative), `app.subtype` = optional
  app-level primary-runtime/framework hint.
- **OQ-B** — canonical worker/appserver normalized values for the JS runtimes (`browser`/`node`/`bun`/`deno`/
  `electron`/`webworker`/`serviceworker`/`edge`) and whether serviceworker/webworker collapse into `browser`.
- ~~**OQ-C** — symbol namespace~~ **RESOLVED 2026-07-11** by the org-wide symbols-storage unification (per
  user): all symbol types go to a single unified `symbols` folder + `symbols.*` jobs; JS sourcemaps + native
  Breakpad ride it via content-detection — no dedicated `sourcemaps` namespace.
- **OQ-D** — does `javascript` need a per-session-runtime field on the recording model distinct from
  `environment.platform.type` (viewer convenience) or is reading `environment.platform.type` enough?
- **OQ-E** — client-validation mapping: exact set of JS SDK client-type strings accepted for
  `app.type==='javascript'`.

## 9. Implementation slices

- **J0 — data model**: appserver schema enum (`javascript` + JS subtypes) + creation/validation + MCP enum +
  `cfg.core.sdk['javascript']` + migration. Viewer type union + constants/icons/labels. (No behavior yet.)
- **J1 — worker JS-exception path**: `normalize_platform` runtimes + `crash/javascript.py` JS-exception branch
  reusing sourcemap symbolication; route `javascript` in `jobs/bundle.py`. Test-first with a JS-stack fixture.
- **J2 — appserver symbols**: `javascript` symbol branch into the **unified `symbols` folder + `symbols.*`
  job** (rides the org-wide unification; no `sourcemaps` split) + the collision guard; wire the #158
  bundler-plugin/bugsee-cli sourcemap upload to it.
- **J3 — viewer core**: type model + "treat-like-web" device branches + runtime badges + JS callstack
  (sourcemap frames) + docs routing. (Makes JS issues render correctly.)
- **J4 — viewer onboarding + symbol UI**: `javascript` create-dialog wizard + per-runtime SDK snippets +
  sourcemap upload dialog.
- **J5 — native minidumps**: layer `electron-native-crashes.md` (worker generic minidump processor + Electron
  symbol ingestion + the SDK harvest-and-bundle) into `crash/javascript.py` + the electron callstack branch.
- **J6 — e2e**: a JS-exception recording and an Electron native-crash recording both surface as symbolicated
  issues under one `javascript` app, with per-session runtime badges.

---

### Relationship to other designs

- `electron-native-crashes.md` — the native-minidump crash-type within this umbrella (J5).
- Source-maps tooling (#158) — the sourcemap **upload** side that feeds J2's ingestion (debug-id-keyed,
  already worker-supported).
