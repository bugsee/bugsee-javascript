# `bugsee-cli` in the JavaScript SDK's flows — gap pass (2026-09-17)

A pass over every flow where the JS SDK drives `bugsee-cli`, looking for what the CLI still cannot do.
Written against **bugsee-cli 0.7.9** and `@bugsee/bundler-plugin-core` at `40ef8ff`.

Every finding below is MEASURED unless it says otherwise, and each says how.

## The flow as it exists

`@bugsee/vite-plugin` / `@bugsee/webpack-plugin` → `@bugsee/bundler-plugin-core`
(`orchestrate.ts:133-166`), at build end (webpack `afterEmit`, unplugin `writeBundle`):

1. `bugsee-cli sourcemaps inject <outDir>`
2. `bugsee-cli debug-files upload <outDir> --type sourcemaps --version <v> --build <b>`
3. delete the client `.map` files, only after a confirmed upload.

No meta-framework adapter wires the plugin itself: `@bugsee/nextjs`, `nuxt`, `sveltekit`, `remix` and
`astro` ship no bundler-plugin dependency (`git grep` over their `package.json`s), so the user adds it.
Debug-ids are runtime-portable — `applyDebugIds` (`core/src/crash.ts:197`) runs wherever a crash is built —
so server and edge bundles benefit from the same flow, not only the browser.

## Findings

### 1. Uploads are fully serial — a large app pays a build-time tax (SEV2, measured) — FIXED in bugsee-cli PR #42 (`--concurrency`, default 6)

Each map is two round-trips (metadata POST, presigned PUT) and the loop is sequential
(`debug_files.rs` `run_sourcemap_upload`). Measured: a synthetic 60-map build (36 KB maps) against a local
mock with 50 ms of injected latency per request took **7.15 s wall** for 120 requests — the serial floor.
A 200-chunk Next.js app at a realistic 100 ms RTT is **~40 s of build time**, every build, and CI runners
are further away than that.

Nothing in the protocol requires it: each map is independent, and the server dedups. A `--concurrency N`
(default 4-8) is the obvious fix.

### 2. "No maps here" is a hard failure (SEV2, measured) — FIXED in bugsee-cli PR #42 (`--allow-empty`)

```
$ bugsee-cli debug-files upload <dir-with-js-but-no-maps> --type sourcemaps …
error: input not found: no .map source-map files found under: …      # exit 10
```

Real shapes that hit it: a monorepo package built without maps, a framework whose server output has none
(see §5), or a second plugin pass over a directory that only holds assets. With `failOnError: true` the
user's build fails; with the default it is a warning and the maps that DO exist elsewhere are never
uploaded, because the pass aborted.

The CLI already has the right precedent in `xcode upload-dsyms`, where "nothing to upload" is a success by
design and only a genuine failure fails the build. Source maps want the same, or an `--allow-empty`.

### 3. `inject` stamps every bundle, including ones with no map (SEV3, measured)

`inject_paths` walks every `.js`/`.cjs`/`.mjs` and appends the runtime registration whether or not the
bundle has a paired map. Measured on a real `next build` (`productionBrowserSourceMaps: true`):
**39 files stamped, 12 maps** — 27 of them server bundles with no map, whose registered id can never
resolve to anything. Nuxt's `.output/server/node_modules` holds another 22 `.mjs` with **0** maps; a real
app ships far more, all of it third-party code the CLI rewrites for nothing.

Costs: pointless bytes in every server bundle, third-party files modified, and a slower walk. A bundle
with no map is exactly the case where the id is useless, so skipping it (or an `--exclude` glob, or
skipping `node_modules`) is free.

### 4. The whole flow cannot be dry-run (SEV3, verified in code + measured earlier)

`sourcemaps inject --dry-run` writes nothing, so the maps still carry no debug-id, and
`debug-files upload --dry-run` over the same directory then **fails with exit 11**. The JS plugin works
around it by skipping step 2 entirely on a dry run (`orchestrate.ts:141-152`, with the measurement in its
comment). So the one option documented as the safe diagnostic cannot exercise the upload path at all.

Either `inject --dry-run` should report the ids it would write, or `upload --dry-run` should accept a
map with no id when it is only packing.

### 5. A symbol upload cannot carry the commit it came from (SEV2, verified in code)

`bundler-plugin-core` already collects VCS metadata (`vcs.ts`, 315 lines: commit SHA, branch, dirty
state, CI provider) and then has nowhere to put it: `orchestrate.ts:44-50` carries it only to echo it
back, "until the upload wire protocol has a field to put it in". The symbol metadata POST is
`{uuid, version, build, hash, transform?, format?}` (`upload/presigned.rs`) — no commit.

Consequence: a JS crash cannot be joined to a commit, so no "which deploy introduced this", no
source-context-from-VCS, and the plugin's whole VCS collector is dead weight. This is a wire-protocol
change (appserver + worker + CLI), not a CLI-only fix, but the CLI is where it surfaces.

### 6. There is no build record for a web build (SEV3, verified in code)

`upload build` requires an artefact (`--artifact <.aab/.apk/.ipa>`; `src/cli/upload.rs:82`), and
`upload build-info` takes a producer-built `--payload-json` that only the Gradle plugin and the Xcode
path know how to assemble. A web build therefore registers nothing: no build list, no build metadata, no
size analysis — all of which Android and iOS get from the same CLI.

Whether web builds SHOULD register is a product decision; today the CLI could not accept one if the JS
side wanted to send it.

### 7. Stamping after emit BREAKS Subresource Integrity (SEV1, reproduced 2026-09-18)

Confirmed, and it is the worst finding here: the app's entry script is blocked and nothing runs.

The plugin runs at `afterEmit` / `writeBundle`, i.e. after the bundler has written its assets — and
`inject` then appends bytes to every `.js`. A build that computes SRI hashes during emit
(`webpack-subresource-integrity`, Angular's `subresourceIntegrity: true`) has already embedded a hash of
the pre-stamp bytes in the HTML, so the browser refuses the script.

Reproduced on a real webpack 5.111 build (`html-webpack-plugin` + `webpack-subresource-integrity`,
`mode: production`, `crossOriginLoading: 'anonymous'`), loaded over HTTP in **Chromium 151.0.7922.34**
via Playwright:

| | `window.__ran` | console |
|---|---|---|
| before `sourcemaps inject` | `true` | clean |
| after `sourcemaps inject` | **`false`** | `Failed to find a valid digest in the 'integrity' attribute for resource '…/main.<hash>.js' … The resource has been blocked.` |

`index.html` is byte-identical before and after (319 bytes, `integrity=sha384-KUBb…`); only the JS grew,
114 → 472 bytes. A second build with a dynamic `import()` behaves the same — and there the stale hashes
are not only in the HTML: `webpack-subresource-integrity` writes
`__webpack_require__.sriHashes={480:"sha384-…"}` INTO the runtime chunk for lazily-loaded chunks, so
anything that rewrote the HTML alone would still break every lazy chunk.

This is a plugin-ordering problem, not a CLI bug — the CLI stamps the files it is pointed at, which is
all it can do. Three candidate fixes, none free:

1. **Stamp before the hashes are computed.** For webpack that means injecting during `processAssets`
   (before `webpack-subresource-integrity`'s stage) instead of shelling out at `afterEmit` — the only
   fix that is correct for both HTML and the runtime-embedded lazy hashes. It needs an in-memory
   stamping path (or an earlier write), which the CLI does not offer today.
2. **Recompute the hashes after stamping.** Means rewriting another plugin's runtime data structure;
   fragile, and Angular's builder has its own shape.
3. **Detect and fail loudly** — scan the emitted HTML for `integrity=` on a file we are about to stamp,
   and refuse rather than shipping a page that does not load. Cheap, and strictly better than today.

At minimum the JS plugin must do (3); (1) is the real fix.

### 8. Not a CLI gap, but in the same flow

- **Next.js server maps.** A stock `next build` emits maps for the client and for edge bundles only —
  measured: 9 client maps, 3 in `.next/server` (both edge bundles + the webpack runtime), while 24 server
  bundles have none. SSR frames are therefore unsymbolicated no matter what the CLI does, until the app
  turns server maps on. This belongs in `@bugsee/nextjs` docs.
- **No meta-framework adapter wires the plugin** (above), so every framework user wires source maps by
  hand today.
- **`sourcesContent`** rides into the upload with the map, which is how symbolication shows source lines.
  There is no `--strip-sources-content` for customers who would rather not ship source. Worth an option.

## Evidence
- Next.js: `packages/nextjs-e2e` built with `productionBrowserSourceMaps: true` (`next build`, exit 0),
  then `sourcemaps inject` + `debug-files upload` against a local mock: `uploaded=12 already_existed=0
  skipped=0`, `js_injected=39 … maps_updated=12`.
- Throughput: 60 synthetic maps, mock with 50 ms latency per request, `wall 7.15 s`, 120 requests.
- Empty case: a directory with one `.js` and no map → `exit 10`, message above.
- SRI: webpack 5.111 + `webpack-subresource-integrity` 5.2, served over `http.server`, loaded in
  Chromium 151 via Playwright — probe script and both `dist` trees under the session scratchpad.
- Nuxt: `packages/nuxt-e2e/.output` — 14 `.mjs.map` (pairing works for `.mjs`), 22 `.mjs` under
  `server/node_modules` with no maps.
