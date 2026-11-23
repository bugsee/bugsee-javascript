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

The programmatic API beyond the plugins is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/bundler-plugin-core
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
