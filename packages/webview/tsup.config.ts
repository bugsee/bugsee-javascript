import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// Two build targets (docs/design/webview-bridge.md §9):
//  1. the dual ESM+CJS npm/ESM entry (baseConfig) — for web apps that detect-and-adapt + tests; deps externalized.
//  2. the SELF-CONTAINED injectable IIFE single-string (native resource, D7) — bundles every @bugsee/* dep into
//     one minified script that defines the `BugseeWebView` global (the native bootstrap calls
//     `BugseeWebView.launch`). Only `node:*` builtins stay external: they are guarded DYNAMIC imports that are
//     dead code in a WebView/browser, so leaving them external keeps a STATIC `node:` import out of the bundle.
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
    external: ['node:*'], // …except node builtins (guarded dynamic imports, dead in a browser)
    outExtension: () => ({ js: '.iife.js' }),
  },
]);
