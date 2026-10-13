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
- Rollup, esbuild and Rspack variants: `bugseeRollupPlugin`, `bugseeEsbuildPlugin`, `bugseeRspackPlugin`. They share the same options, but they are exported only from this package and have no dedicated wrapper package; they are less exercised than the Vite and Webpack plugins. If you use them, install this package as a dev dependency and import them from `@bugsee/bundler-plugin-core`.
- Option resolution (`appToken`, `appVersion`, `appBuild`, `endpoint`, `deleteMaps`, `dryRun`, `disabled`, with environment fallbacks such as `BUGSEE_APP_TOKEN`; the version also falls back to the nearest `package.json` above the bundler's project directory (blank values count as unset), the build to a CI commit id, and a real value is baked into the app bundle as `__BUGSEE_APP_VERSION__` / `__BUGSEE_APP_BUILD__` for the runtime SDK), build-commit detection and the CLI runner.

The programmatic API beyond the plugins is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/bundler-plugin-core
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
