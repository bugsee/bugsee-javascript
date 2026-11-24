# @bugsee/bundler-plugin-core

Shared engine of the Bugsee source-map bundler plugins. It collects build context and drives the `bugsee-cli` to inject debug IDs into your bundles and upload source maps, so production stack traces are de-minified.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK. Most users should not install it directly. Install the plugin for your bundler instead:

- Vite: `@bugsee/vite-plugin`
- Webpack: `@bugsee/webpack-plugin`

```bash
npm install --save-dev @bugsee/vite-plugin
```

## What it contains

- The `unplugin`-based plugin factory behind both of those packages.
- Rollup, esbuild and Rspack variants: `bugseeRollupPlugin`, `bugseeEsbuildPlugin`, `bugseeRspackPlugin`. They share the same options, but they are exported only from this package and have no dedicated wrapper package; they are less exercised than the Vite and Webpack plugins. The esbuild plugin uploads at the end of the build (`onEnd`, stamping after emit, with the SRI guard that refuses a build pinning integrity hashes). Rollup, Rspack, Vite and webpack 5 stamp the debug-IDs INSIDE the build (Rollup/Vite `generateBundle` with `order: 'pre'`, Rspack/webpack `processAssets`), so Subresource Integrity hashes taken later describe the stamped bytes; list the Bugsee plugin before any SRI plugin. Every stamp is verified (parses, map pointer intact, bundle and map debug-IDs match; a failure leaves the original bytes and falls back to stamping after emit by default; with `failOnError` a failed in-build stamp fails the build instead), and a script `.map` file is deleted only after a confirmed upload of it (it carries a debug-ID) and only when this build emitted it; this build's own stylesheet and declaration maps (`.css.map`, `.d.ts.map`), which have no debug-ID, are deleted with them once something was uploaded. Details and measured ordering limits: `docs/design/source-maps.md` §7.1. Angular's builder does not accept esbuild plugins; use the `bugsee-cli` post-build recipe in `docs/source-maps-usage.md` §2. If you use them, install this package as a dev dependency and import them from `@bugsee/bundler-plugin-core`.
- Settings lookup order: plugin option, then the process environment, then the nearest `.env.bugsee-build-plugin` (only `BUGSEE_APP_TOKEN` / `BUGSEE_APP_VERSION` / `BUGSEE_APP_BUILD` are read from it; searched from the bundler's project directory up to the repo/workspace root, never in or above the home directory; fills gaps only, a blank variable counts as unset; a missing or malformed file never fails the build). Details: `docs/source-maps-usage.md`.
- Option resolution (`appToken`, `appVersion`, `appBuild`, `endpoint`, `deleteMaps`, `dryRun`, `disabled`, with environment fallbacks such as `BUGSEE_APP_TOKEN`; the version also falls back to the nearest `package.json` above the bundler's project directory (blank values count as unset; Rollup, which reports no project directory, walks up from the output directory and skips a name-less, version-less marker such as a `dist/cjs/package.json` holding only `{"type":"commonjs"}`), the build to a CI commit id, and a real value is baked into the app bundle as `__BUGSEE_APP_VERSION__` / `__BUGSEE_APP_BUILD__` for the runtime SDK: through `define` on Vite, esbuild, webpack 5 and Rspack, and by rewriting each rendered chunk (with a source map) on Rollup; webpack 4 cannot bake, so there only an explicit value is recorded; a constant you define yourself is what gets recorded when it is a plain string), build-commit detection and the CLI runner.

## `bugsee-sourcemaps-doctor`

An offline check of a build output directory: why would a crash from this build not symbolicate? No network call; a token is not required (a missing one is only a warning).

```bash
npx --package=@bugsee/bundler-plugin-core bugsee-sourcemaps-doctor dist            # human report
npx --package=@bugsee/bundler-plugin-core bugsee-sourcemaps-doctor dist --json     # machine-readable report (schemaVersion 1)
npx --package=@bugsee/bundler-plugin-core bugsee-sourcemaps-doctor dist --strict   # exit 1 on warnings too
```

The binary ships in `@bugsee/bundler-plugin-core`, not in a package of its own name, so always name the package (a bare `npx bugsee-sourcemaps-doctor` asks the public registry for an unrelated, unclaimed name unless it happens to be linked into `node_modules/.bin`; pnpm and Yarn link only the bins of direct dependencies). With the package as a direct dependency, `pnpm exec bugsee-sourcemaps-doctor dist` works too.

Exit codes: 0 ok, 1 warnings only (with `--strict`), 2 errors. Options: `--project-root <dir>` (where `.env.bugsee-build-plugin` and `package.json` are looked up; default the working directory), `--max-map-mb <n>`, `--no-env` (skip the token / version / build / `NODE_ENV` checks), `--deployed` (the directory is, or is about to be, served: leftover `.map` files become a warning instead of a note), `--exclude <glob>` (files the build did not emit, e.g. `sw.js` or `pdf.worker.min.mjs*` for scripts copied from Vite's `publicDir` (it lands at the ROOT of the output) or by a copy plugin, relative to the checked directory, a leading `./` is fine; a pattern that matches nothing is reported as `output.exclude-unmatched`: the plugin never stamps those and a doctor cannot tell them from a bundle that lost its stamp; repeatable; `*` stays in a directory, `**` crosses them; matches are listed as `output.excluded`), `--ignore <id>` (drop a check ID; repeatable; `output.dir-missing`, `output.no-js` and `doctor.internal-error` cannot be ignored), `--` (end of options); `--key=value` works for options that take a value, and `--strict=false`-style values on flags are refused. Before the upload (hidden maps still on disk, the plugin will delete them) and after it (maps removed), `--strict` passes on a healthy build; add `--deployed` only when checking the directory you serve. Straight after a default plugin run `--strict` passes for a build whose output directory holds only what the build emitted (add `--exclude` for copied-in scripts): leftover maps are a note unless `--deployed`, and a pointer to maps removed on purpose from a fully stamped build is a note.

It checks, each with a stable ID, a severity and a fix hint: the output directory and its JavaScript; the debug-ID comment and `_bugseeDebugIds` registration on every bundle; a matching map with the same ID; `sourceMappingURL` pointers (dangling, hidden, inline); map validity (v3, `sources`, `sourcesContent` embedded or resolvable on disk, size); mixed stamped/unstamped bundles; duplicate IDs across different contents; Subresource Integrity hazards and mismatches (pages and `*manifest*.json` inside the directory only; a page larger than 8 MiB is reported, not scanned); leftover `.map` files that a deploy would serve; development-mode bundles; and the build environment (token present, version and build resolvable, `NODE_ENV`). The token value is never printed; the report says where it came from (option, environment variable, or `.env.bugsee-build-plugin`), and a missing token is a warning, because uploading by hand is legitimate. When the checked directory is itself a project directory (has a `package.json`) and is, or contains, the working directory, the walk skips `src`/`test`/dot-directories and stops below depth 6 so it stays out of a source tree; the skipped directories are listed as `output.walk-fenced`, never silent. The doctor never throws (an internal failure is a `doctor.internal-error` finding), never reads outside the checked directory, never opens a FIFO, socket or device (they are reported), reads a symlink only when its real path stays inside the checked directory (a pnpm-style `assets/app.js -> ../.store/app.js` is fine; one that leads out, dangles or loops is reported), judges type and size on the open file descriptor, and checks a map's size before reading it. Programmatic use: `diagnoseBuildOutput(dir, options)` returns the same report. The backend-assisted checks (is this ID's map uploaded?) are not part of this command; see `docs/source-maps-usage.md` §4.

The rest of the programmatic API beyond the plugins and the doctor is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/bundler-plugin-core
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
