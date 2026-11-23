---
'@bugsee/angular': minor
'@bugsee/bundler-plugin-core': minor
---

`ng add @bugsee/angular` and Angular source maps. The schematic enables hidden script source maps in the production configuration, launches the SDK in `main.ts`, registers `BugseeErrorHandler` through Angular's own `addRootProvider` (standalone and NgModule apps; it prints what to add by hand rather than guess when it cannot find the bootstrap), and adds a `build:bugsee` script: `ng build`, then the new `bugsee-angular-upload` command (also `@bugsee/angular/sourcemaps`), which stamps debug-IDs into the browser output, uploads the maps and registers the build. Works on Angular's esbuild `application` builder and the webpack `browser` builder.

`subresourceIntegrity: true` is supported rather than refused: `@bugsee/bundler-plugin-core` gains `resealSri`, which snapshots every script's digests, stamps with `--allow-sri`, swaps each changed script's old digests for its new ones in the pages, an import map, the copy of the page an SSR build embeds in its server modules and the webpack builder's runtime hash table, then verifies the pages. The SRI scan now also reads `<script type="importmap">` integrity tables, which is how Angular 21+ pins its lazy chunks; before, a stamped lazy chunk was blocked by the browser. A build with an `ngsw.json` (service worker) is refused, since it pins a hash of every file.
