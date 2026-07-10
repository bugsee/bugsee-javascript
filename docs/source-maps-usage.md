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
