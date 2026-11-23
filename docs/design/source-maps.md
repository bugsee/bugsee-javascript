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
- **Since v0.7.11** (bugsee-cli #47, #48, #49) the plugin can preview the WHOLE flow and can keep source out of the
  upload. `debug-files upload --dry-run` no longer fails on a map with no debug-id (which is every map after
  `inject --dry-run`, since that writes nothing), so the plugin stopped skipping the upload step on a dry run —
  the safe diagnostic now exercises the path it is meant to diagnose. And `--strip-sources-content`, surfaced as
  the plugin option `stripSourcesContent` (default off), uploads each map without its embedded source: file,
  line and column symbolication are unaffected, the snippet beside a frame is what is lost, and the maps on disk
  are untouched. Same release refuses to inject into an SRI build from the CLI side too, so a user driving
  `bugsee-cli` directly (Angular, Bun) gets the guard the plugin already had.
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
was found — it duplicated the Rust engine and collided on the npm name; the `@bugsee/cli` name now belongs to the
official package that ships the Rust binary, see §4.)

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
   │           ├─ collect context { outDir, appToken, appVersion, appBuild, endpoint, deleteMaps, dryRun,
   │           │                  stripSourcesContent }
   │           ├─ resolve the bugsee-cli binary (dep @bugsee/cli's binaryPath(), or PATH / BUGSEE_CLI_PATH)
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
  + context collection + the inject→upload→delete orchestration. `@bugsee/cli` (a front package + one optional dependency per platform carrying the Rust binary; no
  install-time download) is a dependency; it replaced the deprecated `@bugsee/bugsee-cli` (frozen at 0.8.2) (#183); also resolvable from PATH / `BUGSEE_CLI_PATH`.
- `@bugsee/vite-plugin` / `@bugsee/webpack-plugin` — per-bundler entry points (`unplugin/vite`, `unplugin/webpack`).

## 5. Decisions

| # | Decision | Why |
|---|---|---|
| **D0** | Spawn the existing Rust `bugsee-cli`; **no JS reimplementation** | The engine exists + is npm-distributed; user's architecture (plugins collect, CLI packs+uploads). |
| **D1** | Debug-ID-primary + appVersion/appBuild fallback | §3 — standards-track, bundler-native, Android-aligned; what `bugsee-cli` already does. |
| **D2** | Plugins built on `unplugin` over a shared `@bugsee/bundler-plugin-core` | One core, many bundlers (vite/webpack now; rollup/esbuild/rspack later — meta-framework adapters need rollup). |
| **D3** | Injection = `bugsee-cli sourcemaps inject` run after the bundle is written | The CLI owns injection (single owner, no double-inject). |
| **D4** | Delete client `.map`s by default after upload | Privacy. Opt-out flag. |
| **D5** | Binary resolution: `BUGSEE_CLI_PATH` → `@bugsee/cli` dep (`binaryPath()`) → PATH; a clear error if unresolved | Works in CI + local; spawn-only (no JS fallback, per decision). |
| **D6** | The runtime debug-ID attach is a SEPARATE, SDK-side slice | It's the only piece the CLI can't do; keep it decoupled from the build tooling. |

## 6. Slice plan (each: design → red test → green → per-entity mutator loop → review → commit)

- **SM-A — `@bugsee/bundler-plugin-core`.** (a) `runBugseeCli(args, {token, endpoint, cwd, dryRun})` — resolve the binary
  (`BUGSEE_CLI_PATH` → `@bugsee/cli` `binaryPath()` → PATH), spawn via an injectable `spawn` seam, surface exit code/stderr;
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

**Targets without a plugin hook (Bun's built-in bundler, `tsc`/`swc`, Angular, custom pipelines).** The plugins
are conveniences, not the mechanism: `bugsee-cli` operates on a finished output dir independent of the bundler, so the
**universal path is the standalone CLI post-build step** (`sourcemaps inject` → `debug-files upload`; run before
deploy). See `docs/source-maps-usage.md §2`. To widen the zero-config plugin experience cheaply, `@bugsee/bundler-plugin-core`
also exports `bugseeRollupPlugin` / `bugseeEsbuildPlugin` / `bugseeRspackPlugin` (same core). Their end-of-build hooks
are Rollup `writeBundle`, esbuild `onEnd` (registered through unplugin's `esbuild.setup`; skipped on a failed build
or `write: false`, which is what tsup always sets, with a notice; the plugin sets `sourcemap: 'external'` only when it is
unset, and says so when it is `false`) and Rspack `afterEmit`, each calling
`runPluginUpload` with the same SRI guard as Vite and webpack (#184; real esbuild and Rspack builds are exercised in
`plugin.real-build.test.ts`). Rollup and Rspack stamp INSIDE the build like Vite and webpack 5 (§7.1); only esbuild
takes the post-emit inject path (an SRI build is refused there, not stamped). They do **not** cover **Angular**: its builder does not accept esbuild
plugins, so Angular uses the documented CLI post-build recipe (`docs/source-maps-usage.md §2`). Next.js on webpack
uses the webpack plugin. Bun, tsup and `tsc`/`swc` stay CLI-post-build (tsup via `onSuccess`).
esbuild builds work on **per-build file lists**: the plugin sets `metafile: true` and, in `onEnd`, takes the build's own
outputs from `result.metafile`: the `.js`/`.mjs`/`.cjs` scripts and the maps OF THOSE SCRIPTS. It runs
`sourcemaps inject <scripts + their maps>` then `debug-files upload <those maps>` (200 paths per CLI call). Stylesheet
maps (`.css.map`) are withheld from the CLI (named as explicit paths they have no debug-id and fail the whole call) and
are deleted together with the script maps, only after a confirmed upload. Deleting is limited to exactly those files.
Invariants: a build only touches files it wrote, so nothing is deleted without being uploaded, nothing is uploaded
under another build's options, nested/concurrent builds never wait for each other, and there is no per-directory
state (watch mode needs none). A build that emits JavaScript the plugin cannot upload must not pass silently: under
`failOnError` it fails, otherwise it is a notice (once per message). That covers a build with scripts but no script map
(`sourcemap: 'inline'`/`false`), a result with no metafile (another plugin turned it off), and maps whose bundle has an
extension `inject` does not stamp (`outExtension: '.bundle.jsx'`). A stylesheet-only build (metafile present, no
scripts, no stray maps) is a quiet no-op. Build registration reads only the build's own bundles. (An earlier design serialised and retried uploads per directory;
four review rounds each found a new race in it, and per-build file lists remove the whole class.) Rspack/webpack
keep the directory-wide `afterEmit` path, whose delete step is limited to the maps that existed when the upload
started and fails closed if they cannot be listed; a Rspack `MultiCompiler` whose compilers share one `output.path`
keeps the webpack behaviour of joining the in-flight run for that directory.

**Identifying the correct final map (multi-layer).** The identity is the bundle's own `//# sourceMappingURL` + the
debug-ID: `inject` follows each bundle's sourceMappingURL to its declared map and stamps the SAME debug-ID into both,
so at symbolication the server selects the map by the debug-ID the *running code* reports — no pre-selection, and
multiple chunks/layers coexist. Requirements/limits: (a) the toolchain must emit a **composed** final map (bundlers
chain maps; a separate minify step must compose — the CLI trusts the on-disk final map, it doesn't compose layers);
(b) `--dry-run` on both commands is the "show me what you'll pick" diagnostic; (c) **bytecode targets (RN/Hermes) are
out of scope** — bytecode drops the JS comment+stub, so the running code reports no debug-ID; that's the separate RN
SDK's concern (needs `hermes-compose-source-map` + a preserved bundle id).

## 7.1 Subresource Integrity

`sourcemaps inject` appends the debug-ID comment and the `_bugseeDebugIds` registration to every emitted `.js`.
Done AFTER the bundler wrote its output, that changes bytes a build step may already have hashed: a build that
computed SRI hashes during emit (`webpack-subresource-integrity`, Rspack's `SubresourceIntegrityPlugin`, a Vite SRI
plugin, Angular's `subresourceIntegrity: true`) has written a hash of the PRE-stamp bytes into the HTML. Measured on
a real webpack 5.111 build loaded in **Chromium 151.0.7922.34**:

| | `window.__ran` | console |
|---|---|---|
| before inject | `true` | clean |
| after inject | **`false`** | `Failed to find a valid digest in the 'integrity' attribute for resource '…/main.<hash>.js' … The resource has been blocked.` |

`index.html` is byte-identical across that pair; only the JS grew, 114 → 472 bytes. The page loads and nothing
runs — strictly worse than having no source maps. Two mechanisms keep that from happening.

### Stamp inside the build (the fix)

The Rust `inject` stays the one implementation (§4): `stampAssets` (`stamp-assets.ts`) stages the build's bundles
and maps in a temp directory with the same relative layout, runs the real `sourcemaps inject` over it, verifies
the result (below) and writes back only what changed. What differs per bundler is WHERE it is called, so that
every later hash is taken over the stamped bytes:

| Bundler | Hook | Ordering |
|---|---|---|
| webpack 5, **Rspack** | `compilation.hooks.processAssets` at `PROCESS_ASSETS_STAGE_DEV_TOOLING + 1` (501) | maps are emitted AT 500; `webpack-subresource-integrity` / Rspack's `SubresourceIntegrityPlugin` hash later (measured: after 700), so they hash the stamped bytes — for the HTML and for the lazy-chunk `sriHashes` table in the runtime. Rspack uses the same `compiler.rspack` API (`Compilation`, `sources.RawSource`) as webpack; verified against a real Rspack 2.2.9 build with the built-in SRI plugin. |
| **Vite**, **Rollup** | `generateBundle` with `order: 'pre'` | the bundle's chunks (`code`) and their `.map` files (bundle ASSETS: measured on Rollup 4.65, Vite 7.3 and Vite 8.3/Rolldown) are in memory and are what gets written. `order: 'pre'` runs before Vite builds `index.html` (where a `transformIndexHtml` SRI plugin hashes) and before default-order and `post` hooks. |

The in-build stamp is **per build**: webpack/Rspack reset it per compilation; Vite/Rollup record it per OUTPUT
(keyed by the output-options object both hooks receive, not the directory, so two outputs written concurrently
into one folder cannot consume each other's answer) in `generateBundle` and consume it in the matching
`writeBundle` (so a stamp can never carry over to a later build, nor from one Vite environment to another; a
write that cannot be matched is simply not stamped). Assets whose names differ only by case cannot be staged on
a case-insensitive disk and fall back to post-emit. A failed or impossible in-build
stamp degrades to the POST-EMIT path below — never to an unchecked page: a chunk whose map is not a bundle asset
(an older Rollup, `sourcemap: 'inline'`) is not stamped in memory and says so once; a failed stamp is reported
(thrown under `failOnError`).

**Ordering limits, measured — do not read them as guarantees.**

- Vite/Rollup hooks of the SAME order run in plugin order: list the Bugsee plugin **before** any SRI plugin
  (`plugins: [bugseeVitePlugin(...), sriPlugin()]`). An SRI plugin with `order: 'pre'` listed first hashes unstamped bytes.
- Vite itself rewrites a chunk that has dynamic `import()`s **after** user `generateBundle` hooks (it replaces
  `__VITE_PRELOAD__` markers, and **regenerates that chunk's `.map` asset from `chunk.map`**). Two consequences,
  both measured: (1) an SRI plugin that hashes in `transformIndexHtml` pins the pre-substitution bytes of such a
  chunk whether or not Bugsee is installed — only an SRI step that hashes last (`generateBundle`, `order: 'post'`)
  is correct for lazy-loading apps; (2) the regenerated map would drop the debugId, so the stamp also carries the
  id on `chunk.map` (`debugId`/`debug_id`), which is the one thing Vite keeps. Both are covered by real builds
  (`plugin.in-build.real-build.test.ts`, and a Chromium run in `instrumentation-tests/test/sri-vite-rollup.e2e.ts`).
- A plugin that rewrites chunks AFTER the Bugsee stamp changes bytes that were already hashed or stamped. The
  post-build checks below detect (not prevent) it.

### Verify the stamp

After ANY stamp (in-build or post-emit), `verify-stamp.ts` checks it, because stamping rewrites shipped JS:

1. every stamped `.js`/`.cjs`/`.mjs` still **parses** (acorn, module then script; a bundle the parser could not read
   before is not blamed on the stamp);
2. the **`//# sourceMappingURL=` comment** is preserved byte-for-byte as the last one (measured, bugsee-cli 0.9.0:
   `inject` APPENDS the runtime stub and the `//# debugId=` comment AFTER the sourceMappingURL line, so "still the
   last line" is not an invariant; "the same pointer, and nothing but the stamp after it" is);
3. every stamped **map** is a JSON object with a `debugId` equal to its bundle's `//# debugId=` comment;
4. nothing else changed: the stamped bundle is the original bytes **plus an appended stamp** (prefix equality —
   skipped for a bundle that was already stamped, where `inject` replaces the old stamp).

In-build, a failure writes NOTHING back (all or nothing: the asset table is exactly what the bundler produced),
reports through `onError` (throws under `failOnError`) and falls back to the post-emit path. Post-emit, the
originals are SPILLED to a temp directory before `inject` with a content hash (not held in memory; one bundle
and its map are in memory at a time), covering everything inject can change: the whole output directory. The
walk skips `src`, `test`, `node_modules` and dot-directories ONLY when the directory is the project root or
above, where it keeps the walk out of the source tree (Rollup `preserveModules` writes `dist/src/*.js`, which
inject stamps and the snapshot must therefore cover). A directory that IS the working directory or contains it
(a bare `output.file` resolves to `.`) is never snapshotted or restored, and says so; an ordinary output
directory is verified even when it holds a `package.json` (`dist/cjs` `{"type":"commonjs"}`, ng-packagr). If
the spill itself fails (a full disk) the spill directory is removed, inject does NOT run, and it is reported
(an unverifiable, unrestorable stamp is not applied). A failing file is restored to its original bytes **together with its pair**
(bundle first, via write-temp-then-rename, keeping the file mode and writing through a symlink); a restore that fails is reported by name as still carrying the
unverified stamp. The pair is resolved from the bundle's `sourceMappingURL` (custom `sourcemapFileName(s)`
names), falling back to `<bundle>.map`. After the bundler wrote an in-build stamp, the files are re-checked on
disk (every bundle with a map carries a debugId its map shares), which is what catches a later step regenerating
a map; only the bundles the stamp wrote are judged, never the directory, so a `public/` script or a stale file
beside them is not mistaken for a miss. A stamped build is also re-checked against
its HTML (`findIntegrityMismatches`, `sri.ts`): any `<script integrity>` / `<link rel=modulepreload integrity>` whose
hash no longer matches the emitted bytes is reported (a warning; thrown only under `failOnError`).

**Known limits of the on-disk verification** (accepted, no code change): the post-emit snapshot walk stops at
a depth of 6 while inject stamps deeper files (those are stamped but neither verified nor restorable); the walk
is unfenced when the output directory is a project directory reached from a different working directory (the
project-root refusal compares against the cwd); and `realpath` does not normalise case on case-insensitive file
systems, so the cwd-equals-output check can miss a differently-cased spelling of the same directory. A spill
directory that cannot be removed (EPERM/EBUSY) is reported, never thrown. Windows paths resolve a custom map
name through the native path API (the in-memory asset names use posix).

### Uploading a pre-stamped directory

A pre-stamped build is uploaded as an **explicit file set**, never as the directory. Only what the in-build
stamp wrote has a debug-id; anything else in the output directory (a `public/` vendor script and its map, a
stale map with `emptyOutDir: false`) has none, and the real bugsee-cli (0.9.0, measured, without `--dry-run`)
exits non-zero for a directory that holds a map without a debug-id ("source map has no debug_id … nothing was
uploaded"), which would lose EVERY map of the build. So the script maps under the directory (the whole output
directory, fenced only at a project root) are partitioned by whether they carry a debug-id BEFORE the CLI call;
the keyed ones are uploaded by path (in batches), the rest are left on disk untouched and reported as a
**notice** (`onNotice`), not an error: they were never part of the build, so they do not fail `failOnError`. If
nothing is keyed there is no CLI call (a notice; under `failOnError` the "no maps" failure the strict CLI used to
give). A dry run still passes the directory (nothing was stamped; `--dry-run` only warns). Rspack development
builds that are not uploaded (`uploadInDevelopment` unset) are no longer stamped either. Covered by real builds
(`plugin.in-build.real-build.test.ts`: Vite 7/8 with a `publicDir` vendor script, Rollup with a stale one; real
CLI, no dry run, `failOnError` on).

### Map deletion

`.map` files are deleted (default) only after a **confirmed** upload: after `debug-files upload` returned success,
and only the maps that carry a debugId (`partitionByKeyed`, `stamp-files.ts`) — a script map without one was not
keyed for upload (bugsee-cli 0.9.0 exits 11 on one in a directory run; a CLI that skipped it with exit 0 would
otherwise lose the only copy). Such maps are kept and reported (thrown under `failOnError`); stylesheet maps are
never uploaded and are still deleted (they embed the source). A failed upload deletes nothing.

### Post-emit path and the guard (esbuild, the standalone CLI, and any in-build failure)

esbuild has no pre-write hook (`write: false` is the caller's), and the CLI runs after the build, so they stamp after
emit. Because that rewrites hashed bytes, **the plugin refuses to stamp a build that pins its own script hashes**
(`sri.ts`, `findSriProtectedScripts`): `uploadSourcemaps` scans the output directory's HTML *before* anything is
written, and when a `<script>` pins a `.js` inside that directory it reports (or, under `failOnError`, throws) and
uploads nothing. The build is left exactly as the bundler emitted it; verified against a real webpack+SRI build —
bytes unchanged, page still runs, `{injected: false, uploaded: false}`. The refusal message names the workaround: a
bundler that stamps in the build (webpack 5, Rspack, Vite, Rollup), or `bugsee-cli sourcemaps inject` BEFORE the
step that computes the hashes (esbuild, Angular, Bun, `tsc`). The CLI has its own guard as of 0.7.13:
`sourcemaps inject` refuses an SRI build unless `--allow-sri` is passed.

**What the guards do NOT see** (each verified against the implementation):

- **Manifest-driven SRI.** `webpack-subresource-integrity` exposes `compilation.assets[*].integrity`
  for server-rendered templates (`webpack-assets-manifest` with `integrity: true`, shakapacker): the hash
  lives in `manifest.json` and the page is rendered at request time, so there is no HTML in the output
  directory to scan. The in-build stamp makes that hash correct on webpack/Rspack; on the post-emit path such a
  build still breaks.
- **HTML emitted outside the output directory.** `html-webpack-plugin`'s `filename` can point anywhere
  (`../templates/index.html` is the usual Django/Rails shape); the scan only walks `outDir`.
- **Importmap integrity** (`<script type="importmap">` whose JSON body carries an `integrity` map) —
  an inline script with no `src`.
- **Lazy-chunk hash tables are not read.** The post-stamp integrity check compares what the HTML pins; the table
  `webpack-subresource-integrity` / Rspack embed in the runtime chunk is correct because it was hashed after the
  stamp (real-build test: every lazy chunk's digest appears in the runtime), but it is not re-verified from disk.
- **In-build stamping covers what is in the bundler's asset table.** A script copied verbatim from a `public/`
  directory (never in the bundle) is no longer stamped, since the post-emit inject is skipped for a pre-stamped build.
- **The standalone CLI path.** Users driving `bugsee-cli` directly (Angular 17+, Bun, `tsc`) get no plugin guard,
  but the CLI's own (`--allow-sri`).

It does see, and refuses: `<script integrity src=…>` and `<link rel=modulepreload|preload integrity href=…>`
in any `.html` under the output directory, quoted or bare, in any attribute order, with a whitespace-padded
URL. It deliberately does NOT fire on a CDN script, a non-JS target, a path outside the output directory, an
empty `integrity`, a `data-integrity`/`data-src` attribute, a commented-out tag, a `rel=prefetch` (a failed
prefetch is discarded, not fatal), or a symlinked page.

**Why not rewrite the hashes instead.** `webpack-subresource-integrity` also embeds the lazy chunks' hashes in
the runtime chunk (`__webpack_require__.sriHashes = {480: "sha384-…"}`), so patching the HTML alone would still
break every dynamic import, and Angular's builder has its own shape. Stamping before the hash is the only approach
correct for the HTML *and* the runtime-embedded lazy hashes (OPEN-FINDINGS D3's "real fix"; now built for webpack 5,
Rspack, Vite and Rollup).

---

## 7.2 Runtime-mapped stacks (`node --enable-source-maps`, #185)

With `node --enable-source-maps` Node rewrites `Error.stack` to ORIGINAL positions before the SDK sees it, but only
when the bundle's `.map` is readable AND source maps were enabled before the bundle loaded
(`process.setSourceMapsEnabled(true)` affects only modules loaded afterwards). Then the stack the injected stub
registers is mapped too: its top frame becomes e.g. `src/main.js:4:1` (the appended stub has no mapping of its own),
so the `file -> debugId` join stamps the bundle's id onto already-mapped frames (measured: `src/main.js:3:3` got the
id; the backend remaps it again, a wrong line).

Two cases look the same from `process.sourceMapsEnabled` but are different, so a global switch is wrong:
- the plugin DELETES `*.map` after upload by default; with the flag on and no map on disk nothing is mapped, the
  registration key and the error frames both stay on `dist/app.js`, and the plain join is correct;
- the flag turned on after the bundle loaded: same, frames are unmapped and the join is correct.

So the guard is PER REGISTRATION. While `process.sourceMapsEnabled === true` (`runtimeMapsStacks`, read through a
`globalThis` cast), `applyDebugIds` keeps a registration only if the injected verifier proves its top-frame file is the
stamped bundle. `@bugsee/node` installs that verifier at launch (`createStampedBundleVerifier`): the file's tail must
carry `//# debugId=<the registered id>` (the same marker `bundler-plugin-core` reads). A mapped registration points at
`src/main.js`, which has no stamp, so it is dropped and the frames stay unstamped (already original, no id needed).
Core stays runtime-portable: no `node:fs`, the verifier is injected (`setDebugIdRegistrationVerifier` / the
`verifyRegistration` option). With no verifier (browsers, Electron renderers: Chromium does not map `Error.stack`
even where `process.sourceMapsEnabled` reads true) every registration is kept, i.e. the previous behaviour.
The verifier reads the path the way core scrubs it, which is not always a plain path: ESM frames arrive
percent-encoded (core strips `file://` without URL-decoding): `/…/my%20app/dist/app.mjs` outside the app root,
`./dist/my%20chunk.mjs` UNDER it (the common case: `launch()` sets the app root to the cwd), possibly with an import
`?v=1`/`#hash`, and on Windows as `/C:/…`. It tries the literal path first, then the decoded form with the query
stripped, then the stripped literal. Answers are cached per (file, id), bounded to 4096 registrations (reports cost no
file I/O after the first for any realistic build; a build with more stamped chunks than that re-reads). Old Node
(18.0-18.18, 20.0-20.6) has no `process.sourceMapsEnabled`, so the probe falls back to `--enable-source-maps` in
`execArgv` / `NODE_OPTIONS` (tokenized on whitespace, double quotes stripped as Node does; `=true`/`=1` forms count, `=false`/`=0` do not); an explicit property always wins. A runtime
`process.setSourceMapsEnabled(true)` on those old versions cannot be observed. With no verifier installed the runtime is
not probed at all. Not handled: a FIFO-backed path (`/dev/fd/N`) would block the synchronous open; a bundle rewritten in
place during a deploy keeps its cached verdict until restart. Known limits: a path scrubbed to
`node_modules/...` has no `./` prefix and is resolved against `process.cwd()`, not the app root, so it verifies when
the first `node_modules` sits in the cwd and is not joined (flag on) in a hoisted monorepo or when `appRoot` differs
from the cwd. Separately (pre-existing): encoded ESM paths never match the app root, so they ship as absolute paths.
Windows hosts were not run. Bun does not map `Error.stack` and has no
`process.sourceMapsEnabled` (Bun 1.4.4, measured), so it keeps stamping, which is correct.

---

## 7.3 Next.js: `withBugsee` (`@bugsee/nextjs/config`)

Status: **BUILT** (`packages/nextjs/src/config/`, real-build e2e `packages/nextjs-e2e/test/source-maps.e2e.ts`).
`withBugsee(nextConfig, options)` wraps a Next config (object, phase function, async, or a promise) so
`next build` stamps debug-IDs and uploads source maps, on **both** bundlers. It takes the plugin options of §4
(through `resolvePluginOptions`, same env / `.env.bugsee-build-plugin` lookup, same identity resolution) plus
`serverSourceMaps` (default on), `deleteServerMaps` (default off) and `silent`. It never touches `next dev`
(`next start`, `next export`): a function config is gated on the phase, an object config on `dev` in the webpack
function and on the hook only existing in a production build.

**Why not the generic webpack plugin (measured).** Adding `@bugsee/webpack-plugin` in `webpack(config)` runs it
three times (client, server, edge) and breaks on Next's layout: the server compilation's `output.path` is
`.next/server/chunks` while its assets are named `../app/page.js`, so (1) the in-build stamp skipped them (an asset
name may not escape the staging directory; the verify step then failed the run) and (2) the plugin's directory-wide
upload of `.next` swept up the server compilation's files. `withBugsee` therefore ships a small per-compilation
plugin that reuses the same core (`stampAssets`, `runPluginUpload`) but stages `../` names under a stand-in
directory and uploads **exactly the files its own compilation emitted** (`files` mode; nothing walks `.next`).

**Detecting the bundler.** `process.env.TURBOPACK` (set by `next build` before the config loads, Next 15.5 and 16
alike); otherwise webpack. `NEXT_RSPACK` (the experimental Rspack adapter) is not special-cased and unverified.

| | webpack (`--webpack`; default <= 15) | Turbopack (default 16; `--turbopack` in 15.x) |
|---|---|---|
| stamp | in the compilation, `PROCESS_ASSETS_STAGE_DEV_TOOLING + 1` (SRI-safe), client + server + edge | after the build, in `compiler.runAfterProductionCompile`: the real `inject` over the written files, with the post-emit verify-and-restore |
| upload | each compilation's `afterEmit`, its own files | the hook: `.next/static` (browser) then `.next/server` (node + edge), explicit file lists |
| maps | client: `productionBrowserSourceMaps` (forced on only if unset); server/edge: `devtool: 'source-map'` unless the app set one | always emitted (browser: `productionBrowserSourceMaps`; server maps are emitted regardless of `serverSourceMaps`, measured on 16.4) |
| SRI (`experimental.sri`) | works: the hashes are of the stamped bytes (verified against the written HTML) | **not stampable**: Turbopack writes `server/subresource-integrity-manifest.json` and the HTML hashes BEFORE the hook (appending one byte in the hook made every `integrity` wrong), so the build is left unmodified, a notice says why, and nothing is uploaded |
| min Next | any with `webpack()` | 15.4.1 (the first release with `compiler.runAfterProductionCompile`; verified in the 15.4.0 and 15.4.1 types); older Turbopack builds get a notice |

**Policy.** Browser maps live in `.next/static`, which `next start` and CDNs serve to every visitor: `deleteMaps`
(default true) removes them after a *confirmed* upload, exactly as the plugins do (and, as there, a failed upload
leaves them for a retry). `.next/server` is never served and a server run with source maps reads it, so server and
edge maps stay unless `deleteServerMaps`. The build is registered once (browser run). The app version and build are baked
through `compiler.define` (applies to all three runtimes; repeating the keys in `defineServer` is a Next error,
measured). Only bundles that have a map are stamped on Turbopack.

**Composition.** The app's `webpack` function runs first (sync or async) and its result is extended; its
`compiler.runAfterProductionCompile` runs before ours; its `compiler.define` keys win; `productionBrowserSourceMaps`
is respected when set. Without a token the integration changes nothing Next emits.

**Open.** Both runs resolve the app identity and the token file from `process.cwd()` at config load, so run
`next build` from the project directory (Next passes no project dir to a config function). A Turbopack SRI build
cannot be symbolicated by upload (see the table); an in-hook alternative would have to re-hash the integrity
manifests and the HTML Next writes later, which is Next's contract, not ours.

## 8. Deferred
- A real-`bugsee-cli` integration e2e (needs the built Rust binary in the harness) — follow-up once CI has it.
- ~~Turbopack loader for Next.js (`turbopack.rules`)~~ — superseded by §7.3 (a post-build hook, not a loader: a loader
  sees one module at a time and cannot stamp a finished chunk).
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
