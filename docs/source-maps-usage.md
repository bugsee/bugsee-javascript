# Uploading source maps to Bugsee

Bugsee de-minifies production stack traces by matching each frame to its source map via a **debug-ID** — a
per-build UUID injected into the shipped bundle and stamped into the map. The heavy lifting is done by the Rust
**`bugsee-cli`** (packaged for npm under `@bugsee`); the JS bundler plugins are thin conveniences that run it at
build end. See `docs/design/source-maps.md` for the architecture.

## 1. Bundler plugins (zero-config)

Add the plugin for your bundler and pass your app token. At build end it injects debug-IDs, uploads the maps, and
deletes the client `.map`s.

```js
// Vite
import { bugseeVitePlugin } from '@bugsee/vite-plugin';
export default defineConfig({
  build: { sourcemap: true },
  plugins: [bugseeVitePlugin({ appToken: process.env.BUGSEE_APP_TOKEN })],
});
```

```js
// Webpack
const { bugseeWebpackPlugin } = require('@bugsee/webpack-plugin');
module.exports = { devtool: 'source-map', plugins: [bugseeWebpackPlugin({ appToken: '…' })] };
```

Other bundlers are exported from `@bugsee/bundler-plugin-core` (same core, `unplugin`-based):
`bugseeRollupPlugin`, `bugseeEsbuildPlugin`, `bugseeRspackPlugin`. Each injects debug-IDs, uploads the maps and
deletes them at the end of the build, exactly as the Vite/webpack plugins do (Rollup: `writeBundle`; esbuild:
`onEnd`, so it works with the esbuild JS API, `tsup` and any tool that accepts esbuild plugins; Rspack:
`afterEmit`), with the same SRI guard. With esbuild the plugin sets `sourcemap: 'external'` when you did not set `sourcemap` at all (external, so the
shipped bundle carries no `//# sourceMappingURL` comment pointing at a map that is deleted after upload; the CLI
pairs a bundle with its sibling `.map` anyway). An explicit value, including `false`, is left alone: with
`false` there are no maps to upload and the CLI reports that. esbuild builds that share one output directory
(tsup's ESM + CJS) are uploaded one after another, and each upload deletes only the maps that existed when it
started. Use `outdir`: with `outfile` the plugin uploads the whole directory the file is in (every `.js` and
`.map` there, not just yours) and says so in a notice; an `outfile` in the project directory itself or above it (a bare
`outfile: 'bundle.js'`) is refused, with a notice, because that would make the whole project the output directory.
Development builds do not upload and leave the local maps alone unless you set `uploadInDevelopment: true`:
Rspack states its mode (only `development` is skipped; `none` and `production` upload), esbuild states none, so only `NODE_ENV=development` marks a
dev build (a bare `esbuild --watch` without it uploads on every rebuild, so set it or disable the plugin there). Rspack stamps after emit rather than inside the compilation,
so an Rspack build that adds Subresource Integrity hashes is refused, not stamped (§2 covers that case).

**What these do not cover.** **Angular's builder does not accept esbuild plugins**, so `bugseeEsbuildPlugin`
cannot be used with `ng build`: use the post-build recipe in §2. Bun's bundler, `tsc` and `swc` have no hook
either (also §2). Next.js on webpack uses the webpack plugin.

**Where the settings come from.** The lookup order is: the **plugin option**, then the **process environment**,
then the **`.env.bugsee-build-plugin`** file. The setup wizard writes the app token to that file (kept out of
version control) in your project root, as Sentry's plugin does with `.env.sentry-build-plugin`.

- *Which settings.* Only `BUGSEE_APP_TOKEN`, `BUGSEE_APP_VERSION` and `BUGSEE_APP_BUILD` are read from the file.
  `BUGSEE_ENDPOINT`, `BUGSEE_CLI_PATH` and the others are environment / plugin-option only, on purpose: a file
  that could set them could send every upload, token included, to another host or choose which binary runs.
  (`BUGSEE_CLI_PATH` is read from the process environment only.)
- *Which file.* The nearest copy at or above the bundler's project directory (Vite `root`, webpack/Rspack
  `context`, esbuild `absWorkingDir`; the working directory for Rollup, which reports none), but only up to the
  repository or workspace root (a directory holding `.git` or `pnpm-workspace.yaml`). With no such root, only the
  project directory itself is read. The home directory and everything above it are never read, so a stray
  `~/.env.bugsee-build-plugin` cannot give a token to every project below it.
- *Format.* UTF-8 `KEY=value` lines; optional `export`, quotes, `#` comments.
- *Precedence.* The file only fills gaps: a variable the environment already carries is never overridden, and
  `process.env` is never written to. A blank (whitespace-only) environment variable counts as unset, the same
  rule the version and build already follow.
- *Failure.* A missing, unreadable or malformed file never fails the build; without a token the plugin no-ops. A
  file that is found but unusable (unreadable, UTF-16/binary, or holding none of the three keys) is reported once
  through `onNotice`, naming the file but never its contents.
- `bugsee-cli` run by hand (§2) does NOT read this file: export `BUGSEE_APP_TOKEN` there.

**Options** (all optional except a token, which may also come from env or that file):

| option | env fallback | default | meaning |
|---|---|---|---|
| `appToken` | `BUGSEE_APP_TOKEN` (then `.env.bugsee-build-plugin`) | — | required to upload; absent ⇒ the plugin no-ops |
| `appVersion` | `BUGSEE_APP_VERSION`, then the `version` of the nearest `package.json` at or above the bundler's project directory (Vite `root`, webpack `context`, esbuild `absWorkingDir`; a nearest manifest with no version means none) | `0.0.0` | recorded on the symbol; a fallback join key. Blank or whitespace-only values count as unset. A real value is also baked into the bundle, so the app's SDK reports it (Vite, esbuild, webpack 5, Rspack and Rollup; on webpack 4 nothing can be baked, so only an explicit value is recorded). A `define` you set for `__BUGSEE_APP_VERSION__` is used as the recorded value when it is a plain string; for an expression (or on webpack 4 with no explicit value) the recorded value is left at the default and the plugin warns through `onNotice` until you set `appVersion` too |
| `appBuild` | `BUGSEE_APP_BUILD`, then the CI commit id (`GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`, `CI_COMMIT_SHA`, `CIRCLE_SHA1`, `BUILDKITE_COMMIT`, `SOURCE_VERSION`, `RENDER_GIT_COMMIT`, `COMMIT_REF`, `CF_PAGES_COMMIT_SHA`, `GIT_COMMIT`) | `0` | recorded on the symbol; a fallback join key. A real value is also baked into the bundle, so the app's SDK reports it (same bundler coverage and `define` rule as `appVersion`) |
| `endpoint` | `BUGSEE_ENDPOINT` | `https://api.bugsee.com` | API endpoint |
| `deleteMaps` | — | `true` | delete client `.map`s after upload (privacy) |
| `dryRun` | — | `false` | run the CLI with `--dry-run` (no upload, no delete) |
| `uploadInDevelopment` | — | `false` | esbuild / Rspack only: upload from builds the bundler calls development (see §1) |
| `disabled` | — | `false` | turn the plugin off (e.g. dev builds) |
| `vcs` | — | `true` | capture the build's commit SHA / branch (see §1.1); `false` records nothing at all, even an explicit `commit` |
| `commit` | `BUGSEE_BUILD_COMMIT` | detected | explicit commit SHA for this build |
| `allowDirtyCommit` | — | `false` | report a commit even with uncommitted changes |
| `projectRoot` | — | `process.cwd()` | repository root the VCS detection inspects |
| `onNotice` | — | `console.warn` | where user-actionable notices go (distinct from `onError`, which takes failures) |

### 1.1 The build's commit SHA

> **Status: capture only.** The plugin records the commit and `dryRun` prints what it captured, but
> **nothing is uploaded with it yet** — the delivery step is not built. Turning it on today costs two
> short-lived subprocesses (`bugsee-cli vcs-metadata` plus a `git diff` dirtiness probe) per output
> directory and changes nothing else.
> See `docs/design/source-maps.md` §9.4.

The plugin records which commit the build was made from. This exists for one reason: a source map that does
**not** embed `sourcesContent` gives the backend no way to show you the original source of a crashing frame.
Once delivery lands, a commit will let Bugsee fetch that file from the repository you connected to the app.

Most toolchains embed `sourcesContent` already — esbuild, Rollup, Vite (including their `hidden` modes) and
Next.js production builds all do it by default. The gap is `tsc --sourceMap` without `inlineSources`, bare
`terser`, and Rollup's opt-in `sourcemapExcludeSources`.

Detection is delegated to `bugsee-cli vcs-metadata`, the same resolver the Android Gradle plugin and the
iOS/fastlane agents use, so a Bugsee build looks identical whatever produced it. It reads the CI provider's
environment (GitHub Actions, GitLab CI, Bitbucket Pipelines) and otherwise falls back to `git`.

**It never fails a build.** No `git`, no repository, no commits yet, a shallow clone, a detached HEAD, a CI
container with no `.git` at all, or a `bugsee-cli` that is missing or too old — every one of those simply
means no commit is recorded.

**A dirty working tree drops the commit.** If you build with uncommitted changes to tracked files, the SHA no
longer describes what was built, and fetching source at it would show you *the wrong lines of code* for a
frame. That is worse than showing none, so the SHA is omitted (`branch`, `repo` and the rest still ship) and
the reason is printed. Untracked files are not counted — they change nothing about any committed file.

Two consequences worth knowing, because they make the drop permanent rather than occasional:

- The check runs **after** your build has written its output, and covers the **whole repository**, not just
  `projectRoot`. So a repo that tracks generated content — a committed `dist/`, a generated `version.ts`, a
  lockfile the build refreshes — is dirty *because of the build itself*, on every build. In a monorepo, an
  unrelated dirty package also counts.
- Pass `allowDirtyCommit: true` if that describes your repo and you would rather have the approximate
  answer, or commit the generated files before building.

The check covers the whole repository even when your build runs from a subdirectory, and a rewritten
mtime (a fresh CI checkout, a restored build cache) does **not** count as a change — only real content
differences do.

**A known gap.** The check compares your tree against local `HEAD`, but on CI the SHA usually comes from the
provider's environment. If those are different commits (a checkout of an explicit `ref`, a PR merge commit
vs the branch head), the tree reads clean and the recorded SHA still is not what was built.

**Overriding.** A build made from an artifact rather than a checkout has no working tree to inspect; pass
`commit` (or set `BUGSEE_BUILD_COMMIT`) with the SHA. An explicit value skips the dirty check. It must be
7-64 hex characters — a branch name or tag is ignored rather than sent.

## 2. Any other target — the universal CLI step (Bun, Deno, tsc/swc, Angular, no-plugin builds)

The plugins are **not** the mechanism — `bugsee-cli` operates on a finished output directory, whatever produced
it. For toolchains without a usable plugin hook (Bun's built-in bundler, Deno, `tsc`/`swc`, custom pipelines), run
the CLI as a **post-build step**:

```bash
# 1. build with EXTERNAL source maps enabled, e.g.:
bun build ./src/index.ts --outdir dist --sourcemap=external
#   deno … (emits maps) · tsc --sourceMap · ng build --source-map · esbuild --sourcemap …

# 2. inject debug-IDs into the built bundles + their maps (BEFORE you deploy):
bugsee-cli sourcemaps inject ./dist

# 3. upload the maps (keyed by the injected debug-ID):
BUGSEE_APP_TOKEN=… bugsee-cli debug-files upload ./dist \
  --type sourcemaps --version "$APP_VERSION" --build "$APP_BUILD"
```

**Angular (17+, `ng build` with the esbuild application builder).** There is no plugin hook, so add the CLI as a
step after the build (for example an npm script or a CI step):

```bash
ng build --source-map            # or "sourceMap": true in angular.json; the output lands in dist/<project>/browser
export BUGSEE_APP_TOKEN=…        # the CLI does not read .env.bugsee-build-plugin
bugsee-cli sourcemaps inject dist/<project>/browser
bugsee-cli debug-files upload dist/<project>/browser \
  --type sourcemaps --version "$APP_VERSION" --build "$APP_BUILD"
```

If you enable `"subresourceIntegrity": true`, bugsee-cli 0.7.13 `inject` refuses to run (it would invalidate the
integrity hashes Angular writes into `index.html`) unless you pass `--allow-sri`, which you should only do if
the hashes are recomputed after it runs; otherwise turn that option off for builds you symbolicate.

`inject` must run **before deployment** so the shipped bundle carries the debug-ID + the `_bugseeDebugIds` runtime
stub the SDK reads. This is exactly what the plugins automate; the CLI is the same engine, just invoked by hand.

## 3. What links a frame to the right map

- **`inject`** finds each bundle's map via its own `//# sourceMappingURL=` comment (or the `<bundle>.map` sibling)
  and writes the **same** debug-ID into the bundle *and* its map. The bundle is the authority on which map is its own.
- At crash time the SDK reports that debug-ID (from `_bugseeDebugIds`); the server selects the matching map. You
  never pre-pick a "final" map — the debug-ID of the code that actually ran does it. Multiple bundles/chunks coexist,
  each with its own ID.

**Correctness requirements & limits:**
- **Composed maps.** If your build has multiple transform layers (e.g. a separate post-bundler minifier), make sure
  the toolchain emits a *composed* final map (`generated` = shipped code, `sources` = original). Bundlers chain maps
  automatically; a standalone step must compose them (`source-map`'s `applySourceMap`). `bugsee-cli` trusts the final
  map on disk — it does not compose layers itself.
- **Inspect what will be picked.** Both commands take `--dry-run` — run `bugsee-cli sourcemaps inject --dry-run`
  (and `debug-files upload --dry-run`) to see the pairings/uploads without performing them.
- **Not covered: bytecode targets.** React-Native/Hermes compiles JS → bytecode, which drops the injected comment
  and stub, so the running code reports no debug-ID. That needs a Hermes-specific compose flow and is handled by the
  separate React-Native SDK, not this (web/node/bun/deno) SDK.
