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
`bugseeRollupPlugin`, `bugseeEsbuildPlugin`, `bugseeRspackPlugin`. These transitively cover **Angular 17+**
(esbuild builder), **Vite/meta-framework internals** (Rollup), and **Rspack/Next-webpack**.

**Options** (all optional except a token, which may also come from env):

| option | env fallback | default | meaning |
|---|---|---|---|
| `appToken` | `BUGSEE_APP_TOKEN` | — | required to upload; absent ⇒ the plugin no-ops |
| `appVersion` | `BUGSEE_APP_VERSION` | `0.0.0` | recorded on the symbol; a fallback join key |
| `appBuild` | `BUGSEE_APP_BUILD` | `0` | recorded on the symbol; a fallback join key |
| `endpoint` | `BUGSEE_ENDPOINT` | `https://api.bugsee.com` | API endpoint |
| `deleteMaps` | — | `true` | delete client `.map`s after upload (privacy) |
| `dryRun` | — | `false` | run the CLI with `--dry-run` (no upload, no delete) |
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
