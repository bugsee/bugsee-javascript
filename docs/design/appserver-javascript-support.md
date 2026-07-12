# Appserver support for the `javascript` application type (whole JS SDK)

Status: **Design (Draft v1)** — 2026-07-13. Implementation-ready. Grounds the appserver half of the
`javascript` umbrella application type for the **entire** JS SDK (browser/web, node, bun, deno, electron,
workers, edge) — not just Electron. Companion to `docs/design/javascript-application-type.md` (the umbrella
model + cross-repo picture) and `docs/design/electron-native-crashes.md` (the native-minidump crash type).

> Provenance: a read-only survey of the appserver (`/Users/alexeykarimov/Projects/Bugsee/appserver`,
> Node/Fastify/Mongo/S3). File:line refs are as-surveyed 2026-07-13; re-confirm at slice time. The worker
> side (JS-exception sourcemap symbolication + native minidump processing + the Electron system-symbol
> ingestion job) is already **built + on worker master** — see `javascript-application-type.md` §5.2 + the
> memory hand-off.

---

## 1. Understanding summary

- **What**: teach the appserver a new **`javascript`** application type (an UMBRELLA over all JS runtimes) so
  a customer can create a JS/Electron app, upload its symbols (JS sourcemaps for every runtime + native
  `.node`/Electron minidump symbols), and have crash/error reports ingested + symbolicated + retained like
  any first-class platform.
- **Why**: the SDK + worker already emit + process JS crashes (routing on `environment.sdk.type=='javascript'`,
  crash-time symbol lookup by debug-id/uuid); the appserver is the remaining gap — app creation, the symbol
  upload/storage/lookup pipeline, SDK-version config, and the surfacing enums.
- **For**: every JS runtime under one app (an isomorphic app — e.g. Next.js — emits browser + node + edge
  sessions under ONE `javascript` app; the per-session runtime is `environment.platform.type`).
- **Key constraints**: additive + low-blast-radius (do not disturb the live iOS/Android symbol paths);
  `web` stays deprecated (we introduce a FRESH `javascript`, never reuse `web`); the per-session runtime is
  read from `environment.platform.type`, NOT coupled to `app.type`.
- **Non-goals (v1)**: the org-wide symbols/mappings **unification** (deferred — JS rides the existing
  `symbols/` folder pragmatically); viewer changes (J3/J4, separate); the bundler-plugin/bugsee-cli upload
  tooling itself (#158, already built — this design only ensures the appserver accepts what it uploads).

## 2. Decision log

| # | Decision | Alternatives | Why |
|---|----------|--------------|-----|
| **DA1** | **Route `javascript` symbols to the existing per-app `symbols/` folder** + the `symbols.*` worker jobs (mirror iOS). | Do the full org-wide symbols/mappings unification now. | Lowest risk — zero change to the live iOS/Android paths + worker jobs. The unification is a separate future refactor; JS does not need to trigger it. (User, 2026-07-13.) |
| **DA2** | **Per-runtime nested SDK-version config** under `cfg.core.sdk.javascript` (`{ node:{version…}, browser:{…}, electron:{…}, … }`). | A single flat `javascript.version` block. | The JS SDK ships many runtime packages that can diverge in minimum/current; the version check must be runtime-aware. (User, 2026-07-13.) |
| **DA3** | **The JS SDK sends `clientType == 'javascript'`** → `isValidForClient` passes unchanged. | Add an appserver runtime-allowlist branch. | We control the SDK; a one-line client convention keeps the appserver untouched. The per-session runtime rides `environment.platform.type`, not `clientType`. (User, 2026-07-13.) |
| **DA4** | **Umbrella + per-session runtime** — `app.type='javascript'` (immutable), per-session runtime from `environment.platform.type`; `app.subtype` = OPTIONAL onboarding hint (node/electron/nextjs). | App-type-per-runtime. | Isomorphic apps emit multiple runtimes under one app. (Confirmed 2026-07-11, `javascript-application-type.md` OQ-A.) |

## 3. Design

### 3.1 J0 — data model + config (small, additive)

- **App-type enum** (`code/components/shared/dao/models/_application.js:15-19`): add
  `APPLICATION_TYPE_JAVASCRIPT: 'javascript'` to `applicationTypes`. The schema `type` enum (line ~160) is
  `_.values(applicationTypes)`, so it widens automatically. No new subtype enum is required — `subtype` is
  already optional and free-form-ish (used by Android for react_native/unity/…); JS onboarding may set
  `node`/`electron`/`nextjs` as a hint (DA4).
- **App creation** (`application.service.js:755-770`): NO branch needed — `javascript` flows through the enum.
  KEEP the `web` rejection at line 768 (deprecated). No per-type required fields today.
- **SDK-version config** (`config/default.js:132-147`): add a per-runtime block (DA2):
  ```js
  javascript: {
      // one coordinated umbrella line, refined per runtime where they diverge
      node:     { version: { current, old, minimum } },
      browser:  { version: { current, old, minimum } },
      electron: { version: { current, old, minimum } },
      bun:      { version: { current, old, minimum } },
      deno:     { version: { current, old, minimum } },
      // workers / edge as they ship
  }
  ```
  The version-check lookup (`cfg.core.sdk[app.type]`, used by `isSupportedSdkVersion`) must become
  runtime-aware for `javascript`: pick the sub-block by the report's `environment.platform.type` (map
  `web→browser`, `electron-main/electron-renderer→electron`, `service-worker/web-worker→browser` or a
  `workers` block, else the runtime name), falling back to a default umbrella line. **A0 open detail**:
  confirm the exact `isSupportedSdkVersion` shape (`code/utils.js`, near `isValidForClient`) and thread the
  runtime.

### 3.2 J2 — symbols pipeline (the primary work)

The JS SDK produces two symbol kinds; BOTH ride the existing per-app pipeline once `javascript` routes to
`symbols/` (DA1). The worker already processes both (sourcemap symbolication W2; native minidump W3/S-worker;
Electron system-symbol ingestion job) — the appserver just has to **accept, store, and dispatch** correctly.

**(a) JS-exception sourcemaps — the common case, ALL runtimes.** A `javascript` app uploads sourcemaps (via
the #158 bundler-plugins / `bugsee-cli debug-files upload --type sourcemaps`) to the existing
`POST /apps/{app}/symbols` with `format: 'sourcemap'` (already in the `symbolfile` model enum,
`symbolfile.js:42` — no enum change). The appserver must store them under the per-app `symbols/` folder and
dispatch the `symbols.process` job (which already handles the `sourcemap` format). At crash time the worker's
`crash/javascript.py` resolves them by per-frame `debug_id` via `api.get_symbol_files` (already built).

**(b) App native `.node` addons.** Uploaded as a RAW ELF/Mach-O via `bugsee-cli debug-files upload`
(`transform:'breakpad'`, keyed by GNU build-id) to the SAME `POST /apps/{app}/symbols`. Routes to per-app
`symbols/`, dispatched to `symbols.process` (which generates the `.breakpad` server-side). Crash-time lookup
`is_system=false` → `{org}/{app}/symbols/{id}.zip` (the worker's `_js_symbol_path(false)='symbols'`).

**(c) Electron RUNTIME symbols (electron/node/V8) — SHARED system store.** Uploaded once per Electron version
to `POST /symbols/system` (org-global, no per-app), stored at `system/symbols/electron/{id}.zip`; the worker
ingests them via the **already-built `jobs/electron_symbols.py::System`**. Crash-time lookup `is_system=true`
→ `system/symbols/electron/{id}.zip` (worker `_js_symbol_path(true)='symbols/electron'`). **A3 open detail**:
the appserver `POST /symbols/system` must enqueue the `electron_symbols.system` worker action for an Electron
`.sym` (today the system path enqueues `symbols.system`/`mapping.system`); decide the discriminator
(upload `format`/a platform param) — this is Electron-specific + secondary to (a)/(b).

**Concrete symbol-routing change (DA1).** iOS and javascript both map to the `symbols` folder + `symbols.*`
jobs; Android keeps `mappings`/`mapping.*`. Rather than sprinkle `|| app.type === 'javascript'` across five
sites, add two tiny helpers in `symbols.service.js` and use them at each branch:
```js
const usesSymbolsFolder = (app) => app.type === 'ios' || app.type === 'javascript'; // vs 'mappings'
const symbolJobPrefix   = (app) => usesSymbolsFolder(app) ? 'symbols' : 'mapping';
```
Apply at the surveyed branches:
- `:74` `symType = app.type === 'ios' ? 'symbols' : 'mapping'` → `symbolJobPrefix(app)` (the `.deletebulk` action).
- `:275-286` reprocess `switch (app.type)` → add `case 'javascript': targetHandler = 'symbols'; break;`.
- `:535` upload staging folder `app.type === 'ios' ? 'symbols' : 'mappings'` → `usesSymbolsFolder(app) ? 'symbols' : 'mappings'`.
- `:653` delete action `app.type === 'ios' ? 'symbols.delete' : 'mapping.delete'` → `` `${symbolJobPrefix(app)}.delete` ``.
- `:683` download folder → `usesSymbolsFolder(app) ? 'symbols' : 'mappings'`.
- `:426` Android collision guard `if (app.type !== 'android' || app.subtype) return cb()` — **NO change**: a
  `javascript` app already satisfies `app.type !== 'android'` → returns early → never hits the Breakpad↔ProGuard
  guard (correct — JS has no ProGuard collision).

**The batch lookup** (`getSymbolsByList` / `POST /apps/{app}/symbols/batch`, the worker's `api.get_symbol_files`)
is app-type-agnostic (matches `images.uuid $in uuids`, `system:true` OR `organization` scoped) — **no change**;
it already returns the right `system`/per-app split the worker's `symbol_path_for` resolver consumes.

### 3.3 Ingestion / per-session runtime — no appserver change

Session/issue creation does NOT branch on `app.type`. `environment.platform.type` (our SDK sets it to the
RUNTIME: `web`/`node`/`bun`/`deno`/`electron-main`/… per `@bugsee/protocol` `PlatformType`) is stored verbatim
on the embedded `EnvironmentSchema` (`_environment.js`). So the **per-session runtime needs no new field**
(OQ-D resolved): the viewer reads `environment.platform.type`. The only type gate is `isValidForClient`
(§3.4).

### 3.4 Client validation — no change (DA3)

`isValidForClient(clientType, app)` (`code/utils.js:1090-1101`) returns `clientType === app.type`, and treats
a missing/`unknown`/`worker` clientType as valid. With the JS SDK sending `clientType='javascript'` (DA3), a
`javascript` app validates with **zero appserver change**; even if the SDK sends nothing, `!clientType` →
valid. (Cross-repo item: ensure the JS SDK's client-type identifier is `'javascript'` — a one-line SDK
convention; the runtime stays in `environment.platform.type`.)

### 3.5 Surfacing enums + misc

- **MCP** (`code/components/mcp/tools/application.list.js:68`): add `'javascript'` to the Zod
  `z.enum(['ios','android','web'])`.
- **Retention / billing**: NO change — `javascript` gets normal retention (do NOT copy the `web` exemption at
  `billing.utils.js:296`).
- **Integrations / public-API formatters**: pass `app.type` through unchanged — no branch.

### 3.6 Migration

Widening the mongoose `type` enum is **additive** — existing docs are unaffected and Mongoose accepts the new
value on next boot; **no data migration required**. Optionally add an audit migration
(`0NN-add-javascript-application-type.migration.js`) for an explicit trail (metadata-only).

## 4. Change set (file:line → change)

| Area | File:line | Change |
|---|---|---|
| Enum | `models/_application.js:18` | `+ APPLICATION_TYPE_JAVASCRIPT: 'javascript'` |
| SDK config | `config/default.js:~146` | `+ javascript: { node:{…}, browser:{…}, electron:{…}, … }` (DA2) |
| Version check | `code/utils.js` (`isSupportedSdkVersion`) | runtime-aware lookup for `javascript` (map `platform.type`→sub-block) |
| Symbols folder/jobs | `symbols.service.js:74,275-286,535,653,683` | route `javascript`→`symbols`/`symbols.*` via `usesSymbolsFolder`/`symbolJobPrefix` helpers |
| Android guard | `symbols.service.js:426` | **no change** (JS already early-returns) |
| System (Electron) | `symbols.service.js` system path (`createSystemSymbol`) | enqueue `electron_symbols.system` for an Electron `.sym` (A3 — discriminator TBD) |
| MCP enum | `mcp/tools/application.list.js:68` | `+ 'javascript'` |
| Migration | new `0NN-*.migration.js` | optional audit only |
| Client validation | `code/utils.js:1090-1101` | **no change** (DA3) |
| Ingestion / retention / billing / formatters | — | **no change** |

## 5. Slice plan (each independently shippable)

- **A0 — data model + config**: enum constant + `cfg.core.sdk.javascript` (per-runtime) + runtime-aware
  `isSupportedSdkVersion` + MCP enum. (No behavior beyond "a `javascript` app can be created + versions
  resolve.") Test-first (appserver = mocha, `NODE_ENV=test`).
- **A1 — symbol routing (JS exceptions + `.node`)**: the `usesSymbolsFolder`/`symbolJobPrefix` helpers +
  the five branch edits + the reprocess `case`. Verifies a `javascript` app's sourcemap/ELF upload stages to
  `symbols/`, stores at `{org}/{app}/symbols/`, and dispatches `symbols.process`. This unblocks S-sym-2
  (app `.node`) + the #158 sourcemap upload for JS apps.
- **A2 — Electron system-symbol dispatch**: route a `POST /symbols/system` Electron `.sym` to
  `electron_symbols.system` (discriminator decision). Secondary (Electron-only).
- **A3 — migration + audit** (optional).

## 6. Cross-repo dependencies + open items

- **JS SDK** (javascript repo): send `clientType='javascript'` (DA3, one-line); confirm the SDK's
  version-report shape feeds the runtime-aware version check.
- **bugsee-cli** (Rust): the sourcemap (`--type sourcemaps`) + `.node` (ELF) uploads already POST to
  `/apps/{app}/symbols`; a `upload-electron-symbols` helper (system `.sym` per version) feeds A2.
- **worker**: `electron_symbols.system` job exists; per-app sourcemap + `.node` processing exist. The A2
  dispatch discriminator must match what the worker expects.
- **A3 discriminator** (open): how `POST /symbols/system` picks `electron_symbols.system` vs
  `symbols.system`/`mapping.system` — inspect the current system-symbol → worker-job dispatch and choose a
  format/param marker.
- **isSupportedSdkVersion shape** (A0 open): confirm exact signature to thread the per-runtime lookup.
- Deferred: symbols/mappings **unification** (DA1); viewer J3/J4; S0 real-dump validation; S-e2e.
