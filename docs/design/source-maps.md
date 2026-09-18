# Source-map upload tooling (task #158)

Status: **BUILT + on `main`** (#158) — debug-ID-primary; `@bugsee/vite-plugin` / `@bugsee/webpack-plugin` are
thin wrappers over `@bugsee/bundler-plugin-core`, which SPAWNs the existing Rust `bugsee-cli` (no JS
reimplementation); the runtime stamps `StackFrame.debugId` from `_bugseeDebugIds`. **Open:** the exact
debugId wire format, gated on the backend contract. Design captured 2026-07-09 (Draft v2, rewritten after
finding the existing Rust `bugsee-cli`). Read alongside
`docs/design/sdk-design.md` + the framework/meta-framework adapter docs (their P6 "build integration" depends on this).

## 1. Problem

Production JS ships minified. To symbolicate a captured stack trace, Bugsee's backend needs the build's
source-maps, uploaded out-of-band, and a **join key** tying a runtime stack frame to the right map. The SDK runtime
never uploads maps — this is a build-tool concern.

## 2. The engine already exists: the Rust `bugsee-cli`

**`bugsee-cli` v0.7.1** (`/Users/alexeykarimov/Projects/Bugsee/bugsee-cli`, binary `bugsee-cli`, npm-distributed via
cargo-dist under the `@bugsee` scope — the `@sentry/cli` model) already does the **entire** pipeline:

- **`bugsee-cli sourcemaps inject <dir…> [--dry-run]`** — injects debug-IDs: appends `//# debugId=<uuid>` to each
  `.js`/`.cjs`/`.mjs`, embeds `debug_id`+`debugId` into each `.map`, and emits the runtime stub
  `globalThis._bugseeDebugIds[Error().stack] = <uuid>`. The debug-ID is a **deterministic UUIDv5 content hash** →
  reproducible → idempotent. **Since v0.7.8** the hash covers the bundle AND its paired map (bundle-only when it has
  none), and inject re-keys a stamped bundle whose map came back regenerated (webpack `[contenthash]` keeps the JS
  on disk and re-emits only the map). The server dedups source maps by id alone, so a bundle-only id kept a STALE map
  once a duplicate stopped being an error.
- **`bugsee-cli [--app-token <t>] [--endpoint <url>] debug-files upload <dir…> --type sourcemaps --version <v>
  --build <b> [--uuid <id>] [--no-zstd] [--force] [--concurrency N] [--allow-empty] [--dry-run]`** — discovers
  `.map`s, reads the debug-ID + sha1, packs a
  zstd zip, and runs the two-stage `POST /v2/apps/{token}/symbols {uuid,version,build,hash}` → presigned `PUT`,
  `16004`-idempotent. **Before v0.7.8 it was not:** the appserver nests `16004` in its error envelope and the CLI
  matched only a top-level `code`, so an already-uploaded map failed the whole batch (exit 30), and a CSS map in the
  directory did too (exit 11). v0.7.8 (bugsee-cli #35) skips both and continues, and
  `@bugsee/bundler-plugin-core` now REQUIRES it: its `deleteMaps` step runs only after a fully
  successful upload, which an older CLI never reports for a real web build.
- **Since v0.7.10** (bugsee-cli #42) the maps upload SEVERAL AT A TIME — `--concurrency N` is a ceiling that, left
  unset, scales with the batch (one per 8 maps, min 4, max 8). Measured against a mock with 50 ms of latency: 200 maps
  took 23.58 s serially and 4.10 s scaled. The cap is deliberately modest because a CI box on a thin uplink is
  bandwidth-bound, where more streams only add latency. A failure now stops the batch instead of letting the rest run.
  Same release added `--allow-empty` ("nothing to upload" exits 0, not 10), which the plugin passes UNLESS
  `failOnError` is set — a build that emitted no maps is a legitimate shape, but a team that asked for strictness
  wants to hear about it. The plugin therefore requires `^0.7.10`.
- Global `--app-token` (env `BUGSEE_APP_TOKEN`) + `--endpoint` (env `BUGSEE_ENDPOINT`, default `https://api.bugsee.com`).

**Decision (D0): the JS side does NOT reimplement any of this.** No JS upload/discovery/pack/inject. The plugins
**collect context and SPAWN `bugsee-cli`** — exactly like `@sentry/webpack-plugin` shells out to the Rust `sentry-cli`.
(An earlier v1 draft reimplemented upload+discovery in a `@bugsee/cli` JS package; that was removed once `bugsee-cli`
was found — it duplicated the Rust engine and collided on the npm name.)

## 3. Identity model (decided)

**Debug-ID-primary** (what `bugsee-cli` injects/uploads) with an `appVersion`/`appBuild` fallback. Rationale
(competitive research, v1 §2): debug-IDs are the TC39 standards-track key, natively supported by every major bundler,
and the web analog of Android's `BUILD_UUID` — a per-build UUID reported at runtime, matched server-side, slotting into
the existing `/v2/apps/{token}/symbols` envelope as `uuid`. `bugsee-cli` already computes it as a UUIDv5 content hash
(of the bundle and its map, since v0.7.8).

## 4. Architecture (spawn model)

```
 build (vite/webpack)
   │  @bugsee/vite-plugin | @bugsee/webpack-plugin  (thin unplugin entries)
   │     └─ @bugsee/bundler-plugin-core  (unplugin factory)
   │           ├─ collect context { outDir, appToken, appVersion, appBuild, endpoint, deleteMaps, dryRun }
   │           ├─ resolve the bugsee-cli binary (dep @bugsee/bugsee-cli, or PATH / BUGSEE_CLI_PATH)
   │           ├─ after the bundle is written:  spawn `bugsee-cli sourcemaps inject <outDir>`
   │           ├─ then:                          spawn `bugsee-cli debug-files upload <outDir> --type sourcemaps …`
   │           └─ delete client `.map`s by default (privacy)
   ▼
 bugsee-cli (Rust) — the engine: inject → discover → pack → POST /v2/apps/{token}/symbols → presigned PUT
```

**Runtime side (SDK, JS):** the one piece `bugsee-cli` can't do — read the injected `globalThis._bugseeDebugIds`
registration (maps a script's own `Error().stack` → its debug-ID) and stamp `debugId` onto each captured `StackFrame`
so the report carries it and the server matches per frame. `StackFrame` gains an optional `debugId`. No plugin ⇒ no
debugId ⇒ server falls back to `appVersion`/`appBuild`.

**Packages:**
- `@bugsee/bundler-plugin-core` — unplugin factory + a `bugsee-cli` **resolver/spawner** (`runBugseeCli(args, opts)`)
  + context collection + the inject→upload→delete orchestration. `@bugsee/bugsee-cli` (the cargo-dist binary) is an
  optional dependency; also resolvable from PATH / `BUGSEE_CLI_PATH`.
- `@bugsee/vite-plugin` / `@bugsee/webpack-plugin` — per-bundler entry points (`unplugin/vite`, `unplugin/webpack`).

## 5. Decisions

| # | Decision | Why |
|---|---|---|
| **D0** | Spawn the existing Rust `bugsee-cli`; **no JS reimplementation** | The engine exists + is npm-distributed; user's architecture (plugins collect, CLI packs+uploads). |
| **D1** | Debug-ID-primary + appVersion/appBuild fallback | §3 — standards-track, bundler-native, Android-aligned; what `bugsee-cli` already does. |
| **D2** | Plugins built on `unplugin` over a shared `@bugsee/bundler-plugin-core` | One core, many bundlers (vite/webpack now; rollup/esbuild/rspack later — meta-framework adapters need rollup). |
| **D3** | Injection = `bugsee-cli sourcemaps inject` run after the bundle is written | The CLI owns injection (single owner, no double-inject). |
| **D4** | Delete client `.map`s by default after upload | Privacy. Opt-out flag. |
| **D5** | Binary resolution: `@bugsee/bugsee-cli` dep → `BUGSEE_CLI_PATH` → PATH; a clear error if unresolved | Works in CI + local; spawn-only (no JS fallback, per decision). |
| **D6** | The runtime debug-ID attach is a SEPARATE, SDK-side slice | It's the only piece the CLI can't do; keep it decoupled from the build tooling. |

## 6. Slice plan (each: design → red test → green → per-entity mutator loop → review → commit)

- **SM-A — `@bugsee/bundler-plugin-core`.** (a) `runBugseeCli(args, {token, endpoint, cwd, dryRun})` — resolve the binary
  (`@bugsee/bugsee-cli` → `BUGSEE_CLI_PATH` → PATH), spawn via an injectable `spawn` seam, surface exit code/stderr;
  (b) `uploadSourcemaps(context)` — orchestrate `sourcemaps inject` → `debug-files upload --type sourcemaps` → delete
  `.map`s; (c) the unplugin factory that wires build-end → `uploadSourcemaps`. Test-first with a fake spawn (no real
  binary): assert argv + ordering + delete + error handling.
- **SM-B — `@bugsee/vite-plugin`** — vite entry over the core (`unplugin/vite`). Resolve outDir/version from vite config.
- **SM-C — `@bugsee/webpack-plugin`** — webpack entry over the core (`unplugin/webpack`).
- **SM7 — runtime debugId attach.** `StackFrame.debugId`; core reads `globalThis._bugseeDebugIds` (the injected stub) and
  stamps frames; report carries it; wire protocol. Fallback: no plugin ⇒ no debugId.
- **SM8 — e2e.** Build a fixture with the plugin; run against a **fake `bugsee-cli`** (a stub script that records argv +
  writes a marker) to assert the plugin drives inject+upload correctly without needing the real Rust binary; plus a
  runtime test that a report carries a debugId injected into a fixture bundle.

## 7. Coverage across targets + map identity (analysis)

**Targets without a plugin hook (Bun's built-in bundler, Deno, `tsc`/`swc`, Angular, custom pipelines).** The plugins
are conveniences, not the mechanism: `bugsee-cli` operates on a finished output dir independent of the bundler, so the
**universal path is the standalone CLI post-build step** (`sourcemaps inject` → `debug-files upload`; run before
deploy). See `docs/source-maps-usage.md §2`. To widen the zero-config plugin experience cheaply, `@bugsee/bundler-plugin-core`
also exports `bugseeRollupPlugin` / `bugseeEsbuildPlugin` / `bugseeRspackPlugin` (same core) — transitively covering
Angular 17+ (esbuild), Vite/meta-framework internals (Rollup) and Rspack/Next-webpack. Deno/Bun stay CLI-post-build.

**Identifying the correct final map (multi-layer).** The identity is the bundle's own `//# sourceMappingURL` + the
debug-ID: `inject` follows each bundle's sourceMappingURL to its declared map and stamps the SAME debug-ID into both,
so at symbolication the server selects the map by the debug-ID the *running code* reports — no pre-selection, and
multiple chunks/layers coexist. Requirements/limits: (a) the toolchain must emit a **composed** final map (bundlers
chain maps; a separate minify step must compose — the CLI trusts the on-disk final map, it doesn't compose layers);
(b) `--dry-run` on both commands is the "show me what you'll pick" diagnostic; (c) **bytecode targets (RN/Hermes) are
out of scope** — bytecode drops the JS comment+stub, so the running code reports no debug-ID; that's the separate RN
SDK's concern (needs `hermes-compose-source-map` + a preserved bundle id).

## 7.1 Subresource Integrity

**The plugin refuses to stamp a build that pins its own script hashes** (`sri.ts`,
`findSriProtectedScripts`). This is not a precaution — it is measured.

`sourcemaps inject` appends the debug-ID comment and the `_bugseeDebugIds` registration to every emitted `.js`.
A build that computed SRI hashes during emit — `webpack-subresource-integrity`, Angular's
`subresourceIntegrity: true` — has already written a hash of the PRE-stamp bytes into the HTML. Measured on a
real webpack 5.111 build loaded in **Chromium 151.0.7922.34**:

| | `window.__ran` | console |
|---|---|---|
| before inject | `true` | clean |
| after inject | **`false`** | `Failed to find a valid digest in the 'integrity' attribute for resource '…/main.<hash>.js' … The resource has been blocked.` |

`index.html` is byte-identical across that pair; only the JS grew, 114 → 472 bytes. The page loads and nothing
runs — strictly worse than having no source maps.

So `uploadSourcemaps` scans the output directory's HTML *before* anything is written, and when a `<script>`
pins a `.js` inside that directory it reports (or, under `failOnError`, throws) and uploads nothing. The build
is left exactly as the bundler emitted it; verified against the real webpack+SRI build — bytes unchanged, page
still runs, `{injected: false, uploaded: false}`.

**Why not rewrite the hashes instead.** `webpack-subresource-integrity` also embeds the lazy chunks' hashes in
the runtime chunk (`__webpack_require__.sriHashes = {480: "sha384-…"}`), so patching the HTML alone would still
break every dynamic import, and Angular's builder has its own shape.

**The real fix, not yet built:** stamp during `processAssets` / `generateBundle`, before the bundler computes
its hashes — the only approach correct for the HTML *and* the runtime-embedded lazy hashes. It needs an
in-memory (or write-then-read-back) stamping path rather than shelling out over already-emitted files, which
is a change to the spawn model in §4 and is tracked as OPEN-FINDINGS D3.

---

## 8. Deferred
- A real-`bugsee-cli` integration e2e (needs the built Rust binary in the harness) — follow-up once CI has it.
- Turbopack loader for Next.js (`turbopack.rules`) — Next-adapter follow-up.
- Node/edge runtime debug-ID wiring (browser done in SM7) — trivial.
- The exact debug-ID WIRE FORMAT — additive ` debugId=<id>` string suffix now; a structured `debug_meta`/per-frame
  field is a refinement gated on the JS-backend symbolication contract.
- Tunnel option (proxy uploads through the app origin) — opt-in, hardened, later.

---

## 9. Build VCS metadata — the commit SHA (SM-A4)

Status: **the capture half is BUILT** (`packages/bundler-plugin-core/src/vcs.ts`). The delivery half is
**designed and blocked on one decision** — see §9.4. Research + build 2026-09-05.

### 9.1 The problem

A remapped JS frame can only show its ORIGINAL source if the uploaded map embeds it in `sourcesContent`.
When it does not, the worker gives up: `symbolfiles/sourcemap.py::_regenerate_context` reports
`context_unavailable = 'no_sources_content'` and the frame ships with no source at all.

Measured across the toolchain (2026-09-03): esbuild, Rollup, Vite (including `hidden` modes) and a real
Next.js production build ALL embed `sourcesContent` by default — all 12 maps in the Next build carried it.
The exceptions are `tsc --sourceMap` (needs `inlineSources`), bare `terser`, and Rollup's opt-in
`sourcemapExcludeSources`. Under zstd-9 the sources cost 3.4x, ~337 KB per app release. So: real, uncommon.

**Option B** is to fetch the file from the customer's connected repository when `sourcesContent` is absent.
Competitively this is the differentiator: Datadog *requires* `sourcesContent`; Sentry expects it and treats
public-URL fetching as an explicitly discouraged fallback; BugSnag and Rollbar fetch over plain HTTP from
the path in the map. **Nobody fetches from a connected VCS repo.**

### 9.2 What already exists (research, 2026-09-05)

Almost all of it. The only genuinely missing piece was the commit SHA of a JS build.

| Piece | Where | State |
|---|---|---|
| Commit SHA field | appserver `build.vcs.commit_sha` (`models/build.js:232-240`), regex `^[0-9a-fA-F]{7,64}$` | **exists**, sanitized (`build.vcs-helper.js::sanitizeVcs`) and indexed (`{application, 'vcs.commit_sha'}`, partial) |
| Build record write path | `POST /v2/apps/{token}/builds` → `builds.service.js:793` `vcs: sanitizeVcs(data.vcs)` | **exists** |
| Canonical VCS resolver | `bugsee-cli vcs-metadata` (`src/cli/vcs_metadata.rs`) | **exists** — GitHub/GitLab/Bitbucket env + `git` fallback; wire-compatible with the Android Gradle plugin's `VcsMetadataResolver` and `sanitizeVcs` |
| Crash → build → SHA lookup | worker `jobs/issues.py::_lookup_build_vcs` — filters `list_builds` on `environment.app.{version, package_id, build}`, returns the first `vcs.commit_sha` | **exists**, live for AI Insights |
| Ref preference | worker `ai/insights_source.py::candidate_customer_refs` — a `commit_sha` short-circuits ahead of tags and branches | **exists** |
| Repo fetch | `ai/insights_source.py::fetch_snippet` + `ai/vcs_auth.py`, driven by `application.vcs` (repo connection, viewer PR #13) | **exists** |
| Commit SHA on a **symbol/sourcemap** record | — | **does NOT exist** anywhere: not on `SymbolFileSchema`, not in bugsee-cli's `Metadata` (`presigned.rs:41-71` is a closed 5-key struct: `uuid`/`version`/`build`/`hash`/`format`), not on the JS plugin |
| A JS **build record** | — | **does NOT exist**: no JS tooling registers one |

Note `get_build_by_commit` is appserver-MCP-only (`mcp/tools/build.get-by-commit.js`), has no REST route, and
is not called by the worker. It is the *reverse* direction (commit → build) and is not the join we need.

### 9.3 Decisions

| # | Decision | Why |
|---|---|---|
| **D7** | The SHA's home is **`build.vcs.commit_sha`** on a build record — NOT a new field on the symbol record. | It already exists, is validated, indexed, webhook-exposed and consumed. The worker's `_lookup_build_vcs` already performs the join. A symbol-level field would be a new schema in three repos for something the backend already models. |
| **D8** | **Spawn `bugsee-cli vcs-metadata`; do not reimplement CI/git detection in JS.** | Per D0. The iOS agent and the fastlane plugin were both *deleted* in favour of shelling out to it precisely to end cross-language divergence; a JS copy would be the fourth implementation and the one that drifts. The output is passed through opaquely so a provider added on the backend needs no release here. |
| **D9** | **A dirty working tree drops `commit_sha` (and `base_sha`) by default.** | The one case the canonical resolver has no notion of. A SHA that does not describe the built source makes the backend display *the wrong lines of code* for a frame — confidently wrong beats nothing. `allowDirtyCommit` opts out. Untracked files are not dirt (they change no committed file, and counting them would disable the feature on most working checkouts). |
| **D10** | **"Cannot tell" is not "dirty".** Only a definite `git diff --quiet HEAD --` exit 1 drops the SHA. | The most common deployment shape there is — a CI container with no `git` binary and no `.git`, whose SHA came from the provider's env var — reports "unknown", and treating that as dirty would disable the feature exactly where it works best. |
| **D11** | Validate the caller's `commit` override against the appserver's own regex; ignore a malformed one. | It is the one untrusted, human-typed value. A branch name or `HEAD` would be silently discarded server-side; rejecting it locally makes that visible. Everything from the canonical resolver is trusted as-is. |

### 9.4 What is built, and the one open decision

**Built (SM-A4):** `resolveVcsMetadata` / `isWorkingTreeDirty` / `resolveCommitOverride` in
`@bugsee/bundler-plugin-core`, plumbed through `resolvePluginOptions` (`vcs`, `commit`, `allowDirtyCommit`,
`projectRoot`) → `runPluginUpload` → `uploadSourcemaps`, echoed on `UploadSourcemapsResult.vcs`. Verified
against the real `bugsee-cli` binary and real repositories: a clean checkout yields
`{commit_sha, branch}`; a dirty one yields `{branch}`.

**Not built — the delivery.** Nothing in the JS pipeline can put the SHA on a build record yet, because
`bugsee-cli` has no register-only build command:

- `upload build` requires `--artifact` and hard-codes `request_artifact_upload: true` (`cli/upload.rs:245-252`).
  A JS build has no `.aab`/`.apk`/`.ipa` to ship.
- `upload build-info` requires at least one sidecar (`cli/upload.rs:160-164`) **and** fails unless the
  response carries `build_info_upload_endpoint`, which is gated on an org build-info feature flag
  (`upload/build_info.rs:260-266`).
- `debug-files upload` — the command the plugin actually runs — carries a closed 5-key metadata struct with
  nowhere to put VCS data.

Options, in preference order:

1. **A register-only build in `bugsee-cli`** (e.g. `upload build --no-artifact`, or a `register-build`
   subcommand) taking the payload the Xcode path already builds (`xcode.rs:629-730`), with `vcs` nested and
   `request_artifact_upload: false` — a shape `build::Params` already supports and documents. The JS plugin
   then spawns it after a successful sourcemap upload. **No appserver change at all.**
2. **A `--sidecar vcs.json=…` build-info upload** — uses only existing commands, and
   `worker/jobs/build_info_bundle.py:22-23` already names `vcs.json` as an anticipated sidecar. Rejected as
   the primary: the org feature-flag gate makes it fail on most apps.
3. **`vcs.commit_sha` on the symbol record** (Rust `Metadata` + `SymbolFileSchema` + worker read). Keys off
   the debug-ID, so it needs no version/build discipline — but it is a new field in three repos, against
   D7.

**A caveat that applies to option 1 and 2 equally.** The join is `environment.app.{version, package_id,
build}` → build record. The SDK reports those from `launch()`; the plugin sends `--version`/`--build` and
defaults them to `0.0.0`/`0`. **The two must agree**, or the lookup finds the wrong build or none. This is
the same discipline the Gradle plugin has (it reads `versionName`/`versionCode`, which the SDK also
reports), but on JS nothing enforces it. Worth a build-time warning when the plugin is left on defaults.

### 9.5 Known limitations (review round 1, 2026-09-05)

Found by the convergent review; each is real, each is documented for users, none is fixed in the capture
slice because each needs a product decision.

1. **The dirty probe runs after the build wrote its output, and covers the whole repository.** A repo that
   tracks generated content (a committed `dist/`, a generated `version.ts`, a refreshed lockfile) is dirty
   *because of the build*, so the SHA is dropped on every build; in a monorepo an unrelated dirty package
   counts too. Mitigated by `allowDirtyCommit` + docs. A pathspec-scoped diff is not the fix — the source
   that matters lives across the repo, not under the output dir.
2. **The gate does not check that the reported SHA is `HEAD`.** `bugsee-cli`'s resolver prefers the CI
   provider's env vars over git, while the probe diffs against local `HEAD`. When those are different
   commits the tree reads clean and the SHA still does not describe the build — the same failure class D9
   exists to prevent. A `git rev-parse HEAD === commit_sha` guard would close it and is cheap; it is not in
   yet because it would also drop the SHA in legitimate setups that build a different ref on purpose.
   **Recommend adding it, defaulting to drop-on-mismatch, once delivery lands.**
3. **Collection is serialized ahead of the upload** (`resolve.ts`), adding up to `VCS_TIMEOUT_MS` +
   `DIRTY_TIMEOUT_MS` = 25 s worst case before the upload's own budget starts. Sequential rather than
   concurrent because the delivery step will need the value *before* `debug-files upload` runs. It runs
   once per OUTPUT DIRECTORY, so a multi-output SSR build pays it per output.

   A per-project-root memo was added and then **removed** (review round 2). It never fired for the case it
   was added for — bundlers await each `bundle.write` in turn (`vite/dist/node/chunks/config.js`,
   `rollup.js` `hookParallel('writeBundle')` inside each write), so the in-flight entry was always gone by
   the next output — while a module-level map shared across every plugin instance in the process meant a
   second instance configured `allowDirtyCommit: false` could join a result collected WITH it, recording a
   SHA for a dirty tree. Shared mutable state for a benefit that was never obtained.

### 9.6 Review round 2 (2026-09-06) — decisions the fixes forced

- **`vcs: false` means OFF, everywhere, including an explicitly configured `commit`.** Round 1 had made the
  resolver honour an explicit commit while the plugin layer discarded it, so the two surfaces answered the
  same configuration differently and a green test pinned each contradictory answer. One option, one
  meaning. A caller who wants a commit recorded leaves `vcs` alone and sets `commit`.
- **Notices go to a new `onNotice`, not to `onError`.** `onError` is documented as taking a contained
  FAILURE and everywhere else receives an `Error`; hosts do `e.message`, `e instanceof Error`, or fail
  their pipeline on a non-empty list. A plain string about a dirty tree broke all three.
- **A throwing notice sink is swallowed.** `resolveVcsMetadata` is public API documented as never
  throwing; an unguarded sink made that conditional, and cost the caller the whole metadata object rather
  than one message.
- **An empty `BUGSEE_BUILD_COMMIT` is absent, not malformed.** CI templating of an unset variable produces
  `''` constantly, and warning on every build forever trains users to ignore the sink. The token
  resolution beside it already treated `''` as absent.
- **The signal-termination line names no binary.** `"bugsee-cli"` was wrong once this adapter also ran
  `git`; `command` is equally wrong, because on the default install it is `process.execPath` — an
  OOM-killed CLI reported that `node` had died. The caller's own error message already says what it ran.

### 9.7 Review round 3 (2026-09-06)

Round 2's fixes held; round 3 found one instance of the same "the fix broke something" pattern plus doc
drift. All fixed.

- **The dry-run diagnostic was the one unguarded sink call.** Round 2 made a throwing `onNotice` harmless
  *inside the resolver*, but `collectVcs` calls the sink directly, inside the try whose catch discards the
  metadata — so a throwing host logger cost the caller the whole `VcsMetadata` object. Guarded at the layer
  that owns the sink, and now pinned there too.
- **The malformed-commit notice fired on the `enabled: false` path**, promising a fallback to "the detected
  commit" on the one path where nothing is detected. The off-return now precedes it.
- Two tests carried names describing behaviour that no longer exists (`onError` notice routing) or that
  they cannot reach (the resolver's short-circuit, which the plugin layer never gets to). One was a
  duplicate and was deleted; the other renamed to state the half it actually asserts.
- The sample verification docs quoted the old signal string and claimed *every* `BugseePluginOptions`
  field had been driven from a real build; the five VCS options have not been, and both now say so.

**A hazard, a wrong fix for it, and the real one (rounds 3-6).** `git diff` is often described as
stat-sensitive when the index is stale, and a CI checkout or restored build cache rewrites every mtime —
if that read as dirty, the SHA would be dropped on every CI build, killing the feature exactly where it
matters most. Round 3 measured it and found the probe safe. Round 4 objected that this made the guarantee a
property of the HOST'S CONFIG, since the child inherits the environment and reads `~/.gitconfig`, where
`diff.autoRefreshIndex=false` would restore the failure — and a pin for it was added.

**That objection was wrong, and the pin was a no-op.** It was accepted without being measured, which is the
mistake worth recording here. Measured directly (git 2.50.1, content identical, mtime rewritten):

| command | `autoRefreshIndex=true` | `autoRefreshIndex=false` |
|---|---|---|
| `git diff --quiet HEAD --` (porcelain, what we run) | 0 clean | **0 clean** |
| `git diff-index --quiet HEAD --` (plumbing) | — | **1 dirty** |

Porcelain `git diff` compares CONTENT for a stat-unmatched entry at either setting. The setting cannot
affect this command, so the pin protected nothing; it was removed in round 6. Round 3's original conclusion
was right all along, for a better reason than it gave: the safety comes from **using the porcelain**, and a
future switch to `diff-index` would be a silent regression costing every CI build its SHA. That is now what
the mtime test guards — flipping the argv to `diff-index` fails it.

**One pin survives, and it is real.** `diff.relative=true` in a host's config scopes the diff to the CWD's
subtree. Measured: probing `<repo>/pkg` with a modified `<repo>/a.txt` exits 0 (clean) inherited, 1 (dirty)
with `-c diff.relative=false`. In a monorepo built from one package directory a dirty sibling silently
stopped counting, contradicting the whole-repository behaviour both docs promise. Backed by a real-git
behavioural test, not just an argv assertion.

Still inherited and deliberately not pinned: `diff.ignoreSubmodules=all` (a `-c` would not fix it —
per-submodule `submodule.<name>.ignore` outranks the diff-level setting) and the ambient
`GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` git sets for every hook. Both fail toward recording a SHA,
never toward breaking a build.

### 9.8 Review round 4 (2026-09-06)

The code changes in round 3 were correct — the first round that introduced no new functional defect. What
it did introduce was three false claims, and round 4 caught all three:

- **A rename the commit message and §9.7 both recorded had never happened.** The edit was an unasserted
  string replace whose anchor had already been changed by round 2, so it silently did nothing while the
  documentation stated it was done. The test kept a name claiming to cover the resolver's `enabled: false`
  branch at a layer that returns before the resolver is ever called. *Lesson, and the reason this is
  written down: assert every anchor. A no-op edit that reports success is worse than a failed one.*
- A botched sentence ("costs one two short-lived subprocesses") in the very user-facing line round 3 was
  correcting.
- A comment pointing "below" at code that is above it.

Plus the substantive one, now fixed: the dirtiness guarantee was conditional on host git config. See §9.7.


### 9.9 Review round 5 (2026-09-06) — functionally clean

The first round to find **no correctness defect, no build-failure path and no security regression**. The
pinned argv was verified valid on any git (`-c` keys are not validated against a registry, so on a git
predating `diff.relative` in 2.31 the pin is a silent no-op rather than an error), the hostile-config tests
were confirmed to be genuinely falsifying and to leak nothing, and the round-3 rename was confirmed real
this time.

Two accuracy items, both fixed:

- The probe's docstring claimed to pin **the** settings its answer depends on. It pins the two most likely
  ones; `diff.ignoreSubmodules=all` and the ambient `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` that git
  sets for every hook also change the answer. `ignoreSubmodules` is deliberately NOT pinned, because a
  third `-c` would not actually fix it — per-submodule `submodule.<name>.ignore` outranks the diff-level
  setting. Named in the docstring rather than papered over. Both remaining cases fail toward recording a
  SHA, never toward breaking a build.
- The `autoRefreshIndex` test rewrote the mtime to **now**, which only falsifies on a git built with
  `USE_NSEC`. Without it mtime is compared at SECOND granularity and the whole test body runs inside one
  second, so the stat would match and the test would have passed with the pin removed — on several Linux
  distro builds of git, the assertion protecting the CI-checkout hazard was inert. It now uses the epoch,
  which cannot match at any granularity and cannot be racily-clean. Re-verified by mutation: removing
  either pin, or flipping `autoRefreshIndex` to `false`, now fails.


### 9.10 Review round 6 (2026-09-06) — the round that caught the reviewer, and me

Round 6 was meant to be the convergence check on round 5's two small edits. Verifying them instead
uncovered that **two of the previous rounds' conclusions were wrong**, both because a plausible claim about
git was accepted without being run:

1. **The `diff.autoRefreshIndex` pin added in round 4 did nothing.** See §9.7. Removed.
2. **The mutation evidence for it was tautological.** Rounds 4 and 5 recorded "removing either pin fails
   the tests". It did — but only the literal argv assertion failed, never a behavioural one, because the
   setting cannot change this command's answer. A test that asserts an argv will always "catch" an argv
   change; that is not evidence the argv matters. Every pin is now backed by a test that exercises real
   git and would fail on the behaviour, and the argv assertion is treated as documentation rather than
   proof.
3. **A hostile-config assertion was inert for a second reason.** It re-applied the same mtime after a
   previous probe in the same test, and porcelain `git diff` REWRITES the refreshed stat into `.git/index`
   — so the stat simply matched. An assertion riding on the side effect of the assertion above it. Deleted
   rather than repaired, since the setting it tested is irrelevant anyway.

The lesson generalises past this branch: **a review finding about tool behaviour is a hypothesis until it
is run.** Three rounds of careful reasoning about `git diff` produced a no-op fix, a false doc claim, and
two assertions that could not fail — and one five-line shell script settled it.
