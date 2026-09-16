import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// Two build targets (docs/design/webview-bridge.md §9):
//  1. the dual ESM+CJS npm/ESM entry (baseConfig) — for web apps that detect-and-adapt + tests; deps externalized.
//  2. the SELF-CONTAINED injectable IIFE single-string (native resource, D7) — bundles every @bugsee/* dep into
//     one minified script that defines the `BugseeWebView` global (the native bootstrap calls
//     `BugseeWebView.launch`). Any `node:*` builtin reachable from this graph (e.g. a dependency's guarded
//     DYNAMIC fallback that's dead code in a WebView/browser — @bugsee/util's sha256 once had a `node:crypto`
//     one, since removed; a future dependency could pull one in) must not become a
//     STATIC import esbuild tries to resolve under `platform:'browser'` — see the `removeNodeProtocol` note
//     below for how that's actually guarded.
// tsup runs an array of configs CONCURRENTLY, and a config's `clean` does a whole-`outDir` wipe at its build
// start. Both targets share `dist`, so baseConfig's default `clean:true` would race-delete the IIFE output. We
// pin a deterministic clean: baseConfig cleans everything EXCEPT the IIFE artifact, and the IIFE config never
// cleans — so neither target can wipe the other regardless of which finishes first.
const IIFE_FILE = 'bugsee-webview.iife.js';

export default defineConfig([
  { ...baseConfig, clean: ['**/*', `!${IIFE_FILE}`] },
  {
    entry: { 'bugsee-webview': 'src/iife.ts' },
    format: ['iife'],
    globalName: 'BugseeWebView',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    treeshake: true,
    sourcemap: false,
    dts: false,
    clean: false, // never wipe — baseConfig owns the clean (and excludes this file)
    noExternal: [/.*/], // bundle everything (self-contained injectable)…
    // …deliberately with NO `external` carve-out for `node:*`: tsup unconditionally skips its own
    // `externalPlugin` — the thing that reads the `external`/`noExternal` config arrays — whenever
    // `format === 'iife'` (node_modules/tsup/dist/index.js: `format !== "iife" && externalPlugin(...)`).
    // An `external: ['node:*']` entry here would therefore be pure dead config: never consulted, for
    // this build, regardless of what it's set to. (Verified by building this package and reading the
    // emitted `dist/bugsee-webview.iife.js` — no `external`/`noExternal` combination changes its output.)
    //
    // This config object does NOT spread `baseConfig` and must not gain `removeNodeProtocol: false` (from
    // a future spread or an explicit override): leaving `removeNodeProtocol` UNSET here means it falls
    // back to tsup's own default (`true`), so esbuild's `nodeProtocolPlugin` DOES run for this one build —
    // unlike every other package, where `baseConfig` disables it. That plugin is what actually keeps a
    // `node:`-prefixed specifier out of a hard "module not found" failure under `platform:'browser'`: it
    // marks any resolved `node:x` external directly at resolution time, independent of the `external`/
    // `noExternal` config this format ignores. This is the ONLY thing standing between a future `node:*`
    // import reachable from this bundle's graph and a broken/non-self-contained build — do not "fix" it by
    // spreading baseConfig or adding `removeNodeProtocol: false` to this object.
    outExtension: () => ({ js: '.iife.js' }),
  },
]);
