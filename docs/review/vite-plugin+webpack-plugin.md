# Adversarial review — @bugsee/vite-plugin + @bugsee/webpack-plugin

**Reviewed:** 2026-07-26 · **Scope:** packages/vite-plugin, packages/webpack-plugin (impl 14 LOC each, tests 16 + 14 LOC)

**What these packages actually are:** the prior is **correct on size but wrong on mechanism**. Each package is 14 lines and re-exports one symbol from `@bugsee/bundler-plugin-core` — but that symbol is **not a hand-written bundler plugin**. `bugseeUnplugin` is `createUnplugin(bugseeUnpluginFactory)` from **`unplugin` 2.3.11** (`packages/bundler-plugin-core/src/plugin.ts:63-64`), and `bugseeUnplugin.vite` / `bugseeUnplugin.webpack` are **getters** on that object (`unplugin/dist/index.js:956,962`). So `packages/vite-plugin/src/index.ts:12` and `packages/webpack-plugin/src/index.ts:12` each evaluate an unplugin getter once at module load and re-export the resulting factory. Everything about the *bundler API shape* — the Vite plugin object, the webpack `apply(compiler)` object, the `afterEmit` tap — is produced by unplugin, not by Bugsee code. The only Bugsee-authored bundler-API surface is 12 lines inside the engine (`plugin.ts:45-60`). One further correction to the prior: the two wrappers are **exact structural twins with zero option divergence** — they re-export the same `BugseePluginOptions` type and the same factory, so option-drift between them is structurally impossible.

**Verdict:** The wrappers themselves are correct, minimal, and lint/typecheck clean, and they are not the source of the engine's recursive-unlink SEV1 — I verified that defect is **unreachable through either wrapper** (Vite 6/7/8 all reject `rollupOptions.output.file`; the webpack branch never calls `resolveOutputDir` at all). But the wrapper layer owns the one thing the engine cannot see — the **bundler's own configuration** — and it does nothing with it. The consequence is a new SEV1 that neither the engine review nor the engine's tests could surface: **Vite's `build.sourcemap` defaults to `false` and neither wrapper turns it on**, so a first-time user who adds `bugseeVitePlugin({ appToken })` to an ordinary config gets a build that spawns `bugsee-cli` against a map-free `dist`, receives **exit 10 (`no .map source-map files found`)**, and **fails**. I reproduced this end to end with real Vite 6.4.3 and 7.3.6 and the real Rust `bugsee-cli` v0.7.2. Two further wrapper-layer defects follow from the same "no bundler-config awareness" gap: `vite build --watch` re-uploads on every rebuild, and an ordinary `build.lib` two-format config runs the entire inject→upload→delete pipeline twice. Test quality is the weakest part: 2 tests per package that assert only `typeof === 'function'` and the presence of a hook, a coverage gate that is arithmetically vacuous (**1/1 statements, 0 functions, 0 branches**), and — for `@bugsee/webpack-plugin` — **zero integration coverage anywhere in the repository**, with an engine `/* v8 ignore */` justification citing a "real-webpack e2e" that does not exist.

## SEV1

### 1. On a default Vite (or webpack) config no source maps are emitted, so the plugin fails the build with `bugsee-cli` exit 10
- **Package:** both
- **Where:** `packages/vite-plugin/src/index.ts:12`, `packages/webpack-plugin/src/index.ts:12` (neither wrapper contributes a `config`/`configResolved` hook or touches `compiler.options.devtool`); engine call sites `packages/bundler-plugin-core/src/plugin.ts:48` and `:52-56`; throw at `packages/bundler-plugin-core/src/run-cli.ts:101-107`
- **What:** Vite's `build.sourcemap` defaults to **`false`**, and webpack's `devtool` default emits no standalone `.map` files either. Neither wrapper inspects or amends that. The plugin therefore drives `sourcemaps inject` + `debug-files upload` against an output directory that contains **no `.map` files at all**. The real `bugsee-cli` exits **10** on that input (`error: input not found: no .map source-map files found under: <dir>`), the engine converts the non-zero exit into a thrown `BugseeCliError`, and — per the engine's confirmed no-escape-hatch defect — the user's build aborts.
- **Why it matters:** This is the **default first-run experience**, not an edge case. The documented usage in the wrapper's own header (`packages/vite-plugin/src/index.ts:5-6`) is `plugins: [bugseeVitePlugin({ appToken: '…' })]` with no other change — and that exact snippet breaks the build. If the failure were tolerated instead, the outcome would be the other half of the same bug: symbolication silently never works, because nothing was ever uploaded. This is the one defect class only the wrapper layer can fix — the engine receives a bare `outDir` string and has no access to `build.sourcemap` or `devtool`. Peer plugins solve it here: `@sentry/vite-plugin` sets `sourcemap: true` from a `config` hook.
- **Evidence:** Real `vite.build()` (no fake anything except an unreachable endpoint), plugin constructed as documented:
  - Vite **7.3.6** → `REAL_CLI_DEFAULT_SOURCEMAP: BUILD FAILED -> BugseeCliError | [bugsee] bugsee-cli debug-files upload <dir> --type sourcemaps --version 1.0.0 --build 1 failed (exit 10)`
  - Vite **6.4.3** → identical failure, exit 10.
  - Direct CLI confirmation on a map-free dir: `sourcemaps inject` → exit 0 (and it *does* rewrite the built `.js`, appending the `_bugseeDebugIds` snippet); `debug-files upload …` → exit **10**, with and without `--dry-run`.
  - Instrumented run with a fake CLI confirms the plugin issues both commands even when zero maps exist: `S1_default_no_sourcemap {"cliInvocations":2,"argvSeq":["sourcemaps inject","debug-files upload"],"filesLeft":["assets","assets/main-BrZXlwf9.js"]}`.

## SEV2

### 2. `vite build --watch` re-runs the full inject → upload → delete pipeline on every rebuild
- **Package:** vite-plugin
- **Where:** `packages/vite-plugin/src/index.ts:12` (no watch/`apply` guard added); engine hook `packages/bundler-plugin-core/src/plugin.ts:48`
- **What:** Vite's watch mode calls `writeBundle` after every rebuild. The wrapper adds no `apply: 'build'`, no watch detection, and no dedupe, so each rebuild spawns two `bugsee-cli` processes, performs a **real upload to the Bugsee backend**, and recursively unlinks every `*.map` under `outDir`.
- **Why it matters:** `vite build --watch` is the standard library/SSR development loop. Every file save becomes a network upload and a destructive local delete. It is also the amplifier for SEV1 and for the engine's no-timeout defect: one wedged or failing upload takes down the watch session.
- **Evidence:** Real Vite 7.3.6 watcher + fake CLI, source touched 3 times: `WATCH {"isWatcher":true,"cliCallsAfterFirstBuild":2,"cliCallsAfter3Rebuilds":8}` — i.e. exactly 2 CLI invocations per rebuild, unbounded.

### 3. An ordinary multi-output Vite config runs the whole pipeline once per output (double upload, double recursive delete)
- **Package:** vite-plugin
- **Where:** `packages/vite-plugin/src/index.ts:12`; engine hook `packages/bundler-plugin-core/src/plugin.ts:48` (no per-directory dedupe)
- **What:** Rollup/Vite invoke `writeBundle` **once per output**, and both outputs of an ordinary library build resolve to the *same* directory. `build.lib` with `formats: ['es', 'cjs']` — the single most common library config there is — therefore produces two complete inject→upload→delete cycles over one tree.
- **Why it matters:** 4 subprocess spawns and 2 uploads per build, plus two recursive `*.map` deletes over a shared directory. I observed the two cycles run **sequentially** in Vite 7 (so no data race in that configuration), which bounds this to waste rather than corruption — but nothing in either wrapper or the engine enforces that ordering, and Vite 6+ environment/`buildApp` configurations that build environments concurrently are not covered by any test.
- **Evidence:** Real Vite 7.3.6, `build.lib` two formats, fake CLI: `S3_lib_two_formats {"cliInvocations":4,"argvSeq":["sourcemaps inject","debug-files upload","sourcemaps inject","debug-files upload"],"relTimes":[25,47,71,92]}`. A spy-hook probe over the same configs shows both calls carry the identical `dir`. The same shape appears for an explicit two-element `rollupOptions.output` array.

### 4. Packaging is incoherent: no `publishConfig`, and `require()` — the usage the package itself documents — fails
- **Package:** both
- **Where:** `packages/vite-plugin/package.json:11-16`, `packages/webpack-plugin/package.json:11-16` (`exports` → `./src/index.ts`, `import` condition only; `files: ["dist"]`); documented CJS usage at `packages/webpack-plugin/src/index.ts:5`
- **What:** Neither package declares `publishConfig`. ~30 sibling packages do (e.g. `packages/express/package.json`, which maps `import`→`dist/index.js` and `require`→`dist/index.cjs`). As they stand, these two publish an `exports` map pointing at `./src/index.ts` while `files: ["dist"]` excludes `src` from the tarball, and they offer **no `require` condition at all** — despite `webpack.config.js` being CJS in the overwhelming majority of real webpack projects, and despite the package's own header comment advertising `const { bugseeWebpackPlugin } = require('@bugsee/webpack-plugin')`.
- **Why it matters:** `docs/design/packaging-dual-module.md:4,45-48` establishes `publishConfig.exports` as the mechanism by which dev stays source-based and the tarball ships `dist`. These two packages — the *only* two whose primary consumer is a build config, i.e. the two most likely to be `require`d — opt out of it. (`@bugsee/bundler-plugin-core`, `electron`, `replay`, `replay-canvas`, `rrweb` also lack it, so this is a cluster, not a one-off.)
- **Evidence:** CJS resolution against the current manifests: `@bugsee/webpack-plugin -> require FAILS: ERR_PACKAGE_PATH_NOT_EXPORTED | No "exports" main defined`; identical for `@bugsee/vite-plugin`. Enumerated `publishConfig` presence across all 40 workspace packages — both wrappers are `NO-publishConfig`.

### 5. The public type surface depends on `vite` / `webpack` types that no package in the chain declares
- **Package:** both
- **Where:** `packages/vite-plugin/src/index.ts:12` / `packages/webpack-plugin/src/index.ts:12` re-export `UnpluginInstance['vite']` / `['webpack']`, typed at `unplugin/dist/index.d.ts:141,143` as `VitePlugin` / `WebpackPluginInstance`, which are `import { Plugin as VitePlugin } from "vite"` and `import { … WebpackPluginInstance } from "webpack"` (`unplugin/dist/index.d.ts:8-9`); manifests `packages/vite-plugin/package.json:24-26`, `packages/webpack-plugin/package.json:24-26`
- **What:** Neither wrapper declares `vite` or `webpack` as a `peerDependency`, `peerDependenciesMeta`, or `devDependency` — the sole dependency of each is `@bugsee/bundler-plugin-core`. `unplugin` itself declares **`peerDependencies: {}`**. So the exported type of `bugseeVitePlugin` transitively names types from `vite`, `webpack`, `rollup`, `esbuild`, `rolldown`, `@rspack/core`, `@farmfe/core` and `unloader`, none of which is declared anywhere in the chain.
- **Why it matters:** Keeping `vite`/`webpack` out of *runtime* dependencies is exactly right — and both wrappers do that correctly, importing neither. But an undeclared type dependency is a different problem: it makes the shipped `.d.ts` resolvable only by accident of what else the consumer happens to have installed, and it means the repo has no declared-and-tested version range for either bundler. There is no `peerDependencies` entry to check the used API against.
- **Evidence:** `unplugin@2.3.11` `peerDependencies` is `{}` (verified from its manifest); the d.ts import list above is verbatim; both wrapper manifests contain a single `dependencies` entry and no peers/devDeps. *(I verified the declaration gap and the type chain. I did not execute a downstream consumer `tsc` outside this monorepo, where `skipLibCheck` and hoisting mask it — the downstream failure mode is inferred, the missing declarations are verified.)*

## SEV3

### 6. The tests are theater, and the coverage gate over them is arithmetically vacuous
- **Package:** both
- **Where:** `packages/vite-plugin/src/index.test.ts:1-16`, `packages/webpack-plugin/src/index.test.ts:1-14`; thresholds at `packages/vite-plugin/vitest.config.ts:12`, `packages/webpack-plugin/vitest.config.ts:12`
- **What:** Four assertions per package total: named export is a `function`, default `===` named, the constructed object has `name === 'bugsee'` and a `writeBundle` function (vite) or an `apply` function (webpack). Both construct with `{ disabled: true }` (`index.test.ts:11` / `:11`), so the enabled path — the only path that does anything — is never entered. No hook is ever invoked. The coverage gate demands 100% line/fn/stmt, and both packages report **`Statements 100% (1/1)`, `Functions 100% (0/0)`, `Branches 100% (0/0)`** with an **empty per-file table**: a 14-line re-export module is one v8 statement with no functions and no branches, so the gate is satisfied by importing the file.
- **Why it matters:** For a pure re-export this thinness would be defensible — except these two packages are the *only* place in the repo that owns a bundler-API surface, and the engine's own tests structurally cannot reach it (the engine has no bundler). The gate provides no signal at all. Note there are **no `/* v8 ignore */` annotations** in either package, so the mandate's "exclusion without justification" concern does not apply here — the exclusions live in the engine (`packages/bundler-plugin-core/src/plugin.ts:50,59`).
- **Evidence:** `vitest run --coverage` output for both packages, quoted above; `grep -rn 'v8 ignore' packages/{vite,webpack}-plugin/src` → no matches.

### 7. `@bugsee/webpack-plugin` has zero integration coverage anywhere in the repo, and the engine's `v8 ignore` justification cites an e2e that does not exist
- **Package:** webpack-plugin
- **Where:** `packages/bundler-plugin-core/src/plugin.ts:50` — `/* v8 ignore start -- webpack afterEmit glue; exercised by the real-webpack e2e (SM-C). */`
- **What:** **`webpack` is not installed in this workspace** (`node_modules/.pnpm` contains only `webpack-virtual-modules@0.6.2`), **no package declares a dependency on `@bugsee/webpack-plugin`**, and there is no webpack e2e file. The referenced "SM-C" appears only as a plan item in `docs/design/source-maps.md:89`. So the annotation's justification — required to be accurate by `docs/implementation-standards.md` §4 — is false, and the webpack `afterEmit` glue is untested by anything.
- **Why it matters:** The wrapper's bundler API surface cannot be validated against the real bundler in this repo at all; I had to drive it with a stub compiler. That is itself the finding. It also means webpack 4-vs-5 compatibility, multi-compiler configs, and upload-on-failed-compilation are unverifiable here.
- **Evidence:** pnpm store listing; repo-wide grep for `webpack-plugin` outside the package itself returns only doc/comment mentions plus the unrelated `@sveltejs/vite-plugin-svelte`. The webpack path *does* work when driven by a hand-built webpack-5-shaped stub — `apply()` registers exactly one `afterEmit` tap named `bugsee`, touches neither `module.rules` nor `options.plugins`, no-ops cleanly when `output.path` is absent, and propagates `BugseeCliError` out of the tap on CLI failure.

### 8. The one vite-plugin integration test in the repo is not in the CI gate
- **Package:** vite-plugin
- **Where:** `packages/instrumentation-tests/test/sourcemaps.e2e.ts:18` (the only in-repo consumer of `@bugsee/vite-plugin`); `packages/instrumentation-tests/package.json` scripts = `{ "test:e2e", "typecheck" }` only
- **What:** CI runs `pnpm exec turbo run test:coverage` (`.github/workflows/ci.yml`). `instrumentation-tests` defines no `test` or `test:coverage` script, so `sourcemaps.e2e.ts` never runs in CI. Combined with #6, the CI-enforced coverage of the vite wrapper's actual behavior is nil. (The e2e is good where it exists — it drives the real `writeBundle` against a fake binary and asserts argv + that the token stays off argv — it is simply not gated.)

### 9. Stale documentation on both packages, and a design-doc claim that describes a feature that was never built and is not needed
- **Package:** both
- **Where:** `packages/vite-plugin/README.md`, `packages/webpack-plugin/README.md`; `docs/design/sdk-design.md:285-286,1273,1703`
- **What:** Both READMEs still read "auto-define `__BUGSEE_DEBUG__`, source-map upload trigger" and "**Status:** stub." — for packages that are built, shipped, and do not define anything. `sdk-design.md:1273` goes further: "**We ship `@bugsee/vite-plugin` + `@bugsee/webpack-plugin`** that auto-inject `define: { __BUGSEE_DEBUG__: false }`. Without these the customer's dev mode breaks." Neither plugin injects any `define`, and the identifier `__BUGSEE_DEBUG__` appears in **no package source at all** — the single repo-wide hit is a prose comment at `packages/logger/src/index.ts:2`. So the stated failure mode cannot occur, and the doc misstates these packages' entire purpose.
- **Evidence:** `grep -rn '__BUGSEE_DEBUG__' packages --include='*.ts'` → one comment line in `packages/logger/src/index.ts`.

### 10. The Vite plugin omits `apply` and `enforce`, and carries unplugin's `vite`/`rollup`/`webpack` properties into Vite's plugin container
- **Package:** vite-plugin
- **Where:** `packages/vite-plugin/src/index.ts:12`; plugin object materialized by `unplugin/dist/index.js:806-812` + `toRollupPlugin` at `:608,643`
- **What:** The object handed to Vite is `{ name: 'bugsee', vite: {…}, rollup: {…}, webpack: ƒ, writeBundle: ƒ }` — no `apply`, no `enforce`, and three leftover adapter properties. Peer plugins set `apply: 'build'` to keep build-only plugins out of the dev container.
- **Why it matters:** **Benign today** — I verified a real dev server (`createServer` + `transformRequest`) triggers **zero** CLI invocations, because the plugin contributes no dev-relevant hook. It is listed only because the safety here is incidental (nothing in the wrapper enforces it) and because `apply: 'build'` would not help with watch mode anyway — see #2, which needs a distinct guard.
- **Evidence:** `PLUGIN_SHAPE {"keys":["name","vite","rollup","webpack","writeBundle"],"apply":null,"enforce":null,…}`; `DEV {"cliCallsInDevServer":0}`.

## Engine SEV1 reachability matrix

| Engine defect | vite-plugin | webpack-plugin |
|---|---|---|
| **relative `output.file` → recursive `*.map` unlink** (`bundler-plugin-core/src/plugin.ts:21` → `orchestrate.ts:39-52`) | **NOT reachable.** Vite rejects the trigger outright — **6.4.3, 7.3.6 and 8.0.14** all throw `Vite does not support "rollupOptions.output.file"` (8.0.14 words it `rolldownOptions.output.file`) before any hook runs. Every `writeBundle` call I observed across default / lib / multi-output / SSR builds carried an **absolute `output.dir`** and no `file`, so `plugin.ts:21` is never entered. **The wrapper neither enables nor prevents this — the mitigation is entirely Vite's**, and `packages/vite-plugin/src/index.ts:12` adds no normalization of its own. | **NOT reachable, structurally.** The webpack branch never calls `resolveOutputDir`: `bundler-plugin-core/src/plugin.ts:53` reads `compiler.options.output?.path` directly, so `dirname(output.file)` → `'.'` cannot occur, and `:54` rejects `undefined`/`''`. **Residual (not a confirmed defect):** whatever webpack places in `output.path` is passed verbatim as the recursive-delete root with no validation by wrapper or engine — I could not test webpack's own absolute-path enforcement because webpack is not installed (see SEV3 #7). |
| **CLI failure aborts the build, incl. `dryRun`** (`run-cli.ts:101-107`, no try/catch, no `errorHandler`) | **REACHABLE and hit by a default config.** Real Vite 6.4.3 and 7.3.6 both aborted with `BugseeCliError … failed (exit 10)` on the documented one-line setup (SEV1 #1). Hook site `bundler-plugin-core/src/plugin.ts:48` returns the promise, so the rejection propagates into Vite's build. **`dryRun`:** forwarded verbatim (`resolve.ts:53` → `orchestrate.ts:64,68,82`); I independently reproduced the engine review's finding — real CLI, maps present without a debug-id: `sourcemaps inject --dry-run` → exit 0, `debug-files upload … --dry-run` → **exit 11** → build abort. The wrapper adds no mitigation. | **REACHABLE.** Stub-compiler run with the CLI forced to exit 20: `hookErr: "BugseeCliError: bugsee-cli sourcemaps inject <dir> failed (exit 20)"` rejecting out of the `afterEmit` `tapPromise` registered at `bundler-plugin-core/src/plugin.ts:52`; webpack surfaces such a rejection as a build failure. **`dryRun`:** confirmed forwarded to both commands (`… --dry-run` on both argv lines) with deletion correctly skipped, so the same exit-11 abort applies. The wrapper adds no mitigation. |

## Option pass-through fidelity

Both wrappers re-export **the same type and the same factory** (`packages/vite-plugin/src/index.ts:7,9,12` and `packages/webpack-plugin/src/index.ts:7,9,12`), so pass-through is structurally exact and divergence between the twins is impossible. Every option flows `BugseePluginOptions` → `resolvePluginOptions` (`resolve.ts:41-55`) → `runPluginUpload` (`:58-76`) → `uploadSourcemaps` (`orchestrate.ts:55`), and I verified each end to end.

| Option | Default / env fallback | vite-plugin | webpack-plugin | Verified |
|---|---|---|---|---|
| `appToken` | `BUGSEE_APP_TOKEN`, else `''` ⇒ plugin no-ops | forwarded | forwarded | e2e asserts it reaches the child **via env, never argv**; empty token ⇒ zero CLI spawns |
| `appVersion` | `BUGSEE_APP_VERSION`, else `0.0.0` | forwarded | forwarded | observed as `--version 1.0.0` on both paths |
| `appBuild` | `BUGSEE_APP_BUILD`, else `0` | forwarded | forwarded | observed as `--build 1` on both paths |
| `endpoint` | `BUGSEE_ENDPOINT`, else `undefined` | forwarded | forwarded | passed via child env (`run-cli.ts:92-98`) |
| `deleteMaps` | `true` | forwarded | forwarded | `deleteMaps: false` → maps survive (`filesLeft` retains `main.js.map` **and** `nested/style.css.map`) |
| `dryRun` | `false` | forwarded | forwarded | `--dry-run` appended to **both** commands, deletion skipped |
| `disabled` | `false` | forwarded | forwarded | `disabled: true` → zero CLI spawns, hook still registered |

**Nothing is dropped or renamed.** Two structural notes, neither a defect:
1. **Resolution timing differs by bundler** (upstream, from unplugin): the Vite factory is invoked eagerly when the plugin is constructed (`unplugin/dist/index.js:808`), so `resolvePluginOptions(options, process.env)` (`bundler-plugin-core/src/plugin.ts:35`) reads the environment at config-load time; the webpack factory is invoked inside `apply(compiler)`, so it reads the environment at compiler-creation time. A `.env` loaded between those points would be seen by one and not the other.
2. **The surface is exactly the seven engine options** — neither wrapper accepts any bundler-specific option (no `sourcemap`, `include`/`ignore`, `errorHandler`, `telemetry`, `sourcemaps.filesToDeleteAfterUpload`). SEV1 #1 is the direct cost of the first omission.

## Untested failure modes

Zero coverage — in unit tests, in the e2e suite, and in CI — for every item below.

**Vite (the wrapper's own surface):**
- The hook is **never invoked** by any unit test in `packages/vite-plugin`. `writeBundle` is only asserted to *be a function* (`index.test.ts:14`).
- Enabled path (non-`disabled`) — never constructed in unit tests; both cases use `{ disabled: true }`.
- Behavior under `build.sourcemap: false` (**the default**) — the SEV1 above.
- Watch-mode re-entry / upload storm (SEV2 #2).
- Multi-output and `build.lib` multi-format fan-out (SEV2 #3).
- SSR builds and Vite 6+ environment/`builder.buildApp` configs, including whether environments can build **concurrently** over one `outDir`.
- Whether a dangling (un-awaited) `writeBundle` would be detected — the engine review's surviving mutation H4 shows it would not; nothing in the wrapper packages closes that gap.
- Version-matrix behavior: nothing pins or tests a Vite range, and no `peerDependencies` declares one.

**Webpack (nothing can be tested here at all — webpack is absent):**
- `apply(compiler)` against a **real** compiler; `afterEmit` async-callback contract under real tapable.
- **webpack 4 vs 5** — no declared range, no test, no installed copy.
- **Multi-compiler** (`webpack([cfgA, cfgB])`), including one plugin instance applied to two compilers.
- **Upload when the compilation already has errors** — the tap callback ignores its `compilation` argument entirely (`bundler-plugin-core/src/plugin.ts:52`), so `compilation.errors` is never consulted; whether webpack still runs `afterEmit` on a failed build is documented behavior I could not execute here.
- `webpack --watch` / `webpack-dev-server` (in-memory output; `output.path` pointing at a directory that does not exist on disk).
- Whether webpack's schema truly forbids a relative or `'.'` `output.path` — the last defense against the engine's recursive-unlink defect on this path.
- CJS `require()` of the plugin from a real `webpack.config.js` (SEV2 #4 shows it currently fails).

## Checked and found clean

- **Wrapper implementation is minimal and correct for what it does.** 14 lines each; named + default export identity holds; the `BugseePluginOptions` type is re-exported so consumers need not reach into the engine. `tsc --noEmit` → rc 0 for both. `biome check` → clean, 4 files, no diagnostics. Both test suites pass (2 tests each).
- **No hard runtime dependency on a bundler.** Neither package imports `vite`, `webpack`, `rollup`, or any bundler module — verified by reading both sources in full; the sole `dependencies` entry is `@bugsee/bundler-plugin-core`. (The *type*-level gap is SEV2 #5; the runtime posture is right.)
- **The unplugin getter re-export is safe.** `bugseeUnplugin.vite`/`.webpack` are getters (`unplugin/dist/index.js:956,962`); reading them once at module load yields a factory that returns a **fresh** plugin object per call — verified `bugseeVitePlugin({}) !== bugseeVitePlugin({})`. No cross-build shared mutable state, despite unplugin's internal `Object.assign` mutation of the factory's return value.
- **The two wrappers are true structural twins.** Same imports, same re-export shape, same option type, same engine factory — I found **no divergence** in the option surface, defaults, or naming.
- **The Vite plugin object is well-formed and the hook choice is right.** `name: 'bugsee'`, a `writeBundle` function merged by `toRollupPlugin`; `writeBundle` (post-write) is the correct hook for a tool that reads emitted files from disk — `generateBundle` (pre-write) would have been wrong. The returned promise is propagated by `bundler-plugin-core/src/plugin.ts:48`, so Vite awaits it; the upload is not dropped.
- **The webpack plugin object is well-formed.** A plain object exposing `apply(compiler)` — valid webpack plugin shape. Applying it registers exactly **one** `afterEmit` tap named `bugsee`, and — because the factory declares no `resolveId`/`load`/`transform` — unplugin touches neither `compiler.options.module.rules` nor `compiler.options.plugins` nor `compiler.options.resolve.plugins` (verified: all still length 0 after `apply`). `tapPromise` is the correct async contract; the returned promise is awaited.
- **No double-tap hazard.** unplugin's webpack adapter *also* maps a top-level `writeBundle` to `afterEmit` (`unplugin/dist/index.js:785-787`) calling it with **no arguments** — but the Bugsee factory keeps `writeBundle` nested under `vite`/`rollup` and taps `afterEmit` itself from its `webpack(compiler)` hook, so that path is never taken and exactly one tap is registered. The webpack build correctly never sees the `output`-argument-dependent code.
- **Missing `output.path` is handled gracefully.** With no `output.path`, the tap runs, spawns nothing, and resolves — no throw, no spurious upload (`bundler-plugin-core/src/plugin.ts:54`).
- **`disabled: true` is a genuine kill switch on both paths.** Zero CLI spawns, no filesystem mutation, maps untouched.
- **Vite dev mode is unaffected.** A real dev server with the plugin installed, including a `transformRequest`, produced **0** CLI invocations — the absent `apply: 'build'` causes no dev-time harm (see SEV3 #10 for why this is incidental rather than guaranteed).
- **The recursive delete does reach nested subdirectories, as designed.** The webpack stub run deleted both `main.js.map` and `nested/style.css.map` — confirming the engine's documented behavior (and its breadth, engine review #11) is faithfully reachable through the wrapper, scoped to the build output dir.
- **The engine's spawn-security posture is inherited intact.** Nothing in either wrapper alters argv construction, adds `shell`, or moves the token onto the command line; the token continued to arrive via child env in every run I instrumented.
- **Working tree untouched.** All probes ran from the session scratchpad against symlinked copies; no source file was modified. `git status --short packages/` is **empty**.
