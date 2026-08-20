# Findings — samples/react-spa

Every SDK defect, data-arrival failure or data inconsistency observed while building and running
this sample. One entry per finding. Do NOT fix SDK code here — record it.

Severity: **blocker** (SDK unusable / data lost) · **major** (feature broken or wrong data) ·
**minor** (cosmetic, docs, ergonomics).

## Headline

Building this sample surfaced **five independent, unconditional defects (F-1..F-5)** that, stacked
together, mean: as of this run, **zero JavaScript SDK data can ever reach the real Bugsee staging
backend from a real customer's browser, for any app created the way `docs/samples/PLAN.md` §6
instructs every sample to create one** (`type: "javascript"`). None of these are edge cases — every
one of them fires on the very first `logException()` call a brand-new app makes. `scripts/verify.mjs`
and `scripts/staging-workarounds.mjs` install diagnostic-only bypasses for F-1..F-4 (never something a
real customer could do) purely so the REST of the pipeline could still be verified end-to-end; with
those bypasses in place, 25 real issues landed on the `SREACT` app and were confirmed correct via MCP,
including a full production-build source-map round trip (see the "Also confirmed working" section for
the one part of that pipeline that is NOT broken).

## Open

### F-1 · Staging's CORS policy hardcodes `Access-Control-Allow-Origin`, rejecting every browser origin except `https://appdev.bugsee.com`

- **Severity:** blocker
- **Package:** appserver (not in this repo — `apidev.bugsee.com`'s CORS middleware)
- **Scenario:** every scenario that uploads from a browser (S1–S12)
- **Expected:** a browser SDK running on any origin (a customer's own domain, or a local dev server)
  can complete the CORS preflight for `POST /v2/sessions` / `POST /v2/issues`.
- **Observed:** the preflight `OPTIONS /v2/sessions` always returns
  `access-control-allow-origin: https://appdev.bugsee.com` regardless of the request's actual `Origin`
  header — a static single-origin allowlist, not an echo/reflect of the requesting origin, and not
  configurable via `create_application` (checked: no origin/CORS field in that tool's schema). Every
  fetch from `http://localhost:5302` fails with `net::ERR_FAILED` / "blocked by CORS policy" before any
  byte reaches the server.
- **Reproduce:**
  ```
  curl -sD - -o /dev/null -X OPTIONS https://apidev.bugsee.com/v2/sessions \
    -H "Origin: http://localhost:5302" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: content-type"
  # access-control-allow-origin: https://appdev.bugsee.com   (regardless of the Origin sent)
  ```
- **Impact:** blocks 100% of real-browser delivery for every browser-family sample in the sweep
  (`browser-vanilla`, `react-spa`, `vue-spa`, `svelte-spa`, `solid-spa`, `angular-spa`, the client half
  of every meta-framework sample, `webview-host`, and Electron renderers), on every origin except one
  literal dashboard URL.
- **Workaround used to keep verifying (NOT available to a real customer):**
  `scripts/staging-workarounds.mjs` launches Chromium with `--disable-web-security`.

### F-2 · `@bugsee/core`'s `X-Client-Type: web` header is hardcoded for every runtime, and staging rejects it for an app created with `type: "javascript"`

- **Severity:** blocker
- **Package:** `@bugsee/core` (`packages/core/src/bugsee-api.ts:38`)
- **Scenario:** every scenario that creates a session/issue (S1–S12), for ANY app created per PLAN §6
  step 1 (`type: "javascript"`) — not react-spa-specific.
- **Expected:** the SDK identifies itself in a way the backend's app-type check accepts for the
  `javascript` app type PLAN.md §6 tells every sample to create.
- **Observed:** `baseHeaders()` in `bugsee-api.ts` unconditionally sends `'x-client-type': 'web'` on
  every request, for every platform (browser, node, bun, deno, electron — this is tier-1 `@bugsee/core`,
  not a browser-only file). The appserver's `isValidForClient(clientType, app)`
  (`appserver/code/utils.js:1090-1101`) does `return clientType === app.type` once `clientType` isn't
  `unknown`/`chrome_ext` — and `'web' !== 'javascript'` — so `POST /v2/sessions` returns HTTP 200 with
  `{"ok":false,"error":{"type":"ApplicationTypeMismatchError","code":11004}}`. No session is ever
  created for an app of the exact type this repo's own sample plan tells every sample to create.
- **Reproduce:** launch against a `type: "javascript"` app and inspect the `/v2/sessions` response body
  (with F-1's CORS bypass in place to see it at all) — `ApplicationTypeMismatchError` on the first call.
- **Note:** `@bugsee/node`'s app-type/runtime is ALSO reported through this same hardcoded header path
  (this file is runtime-agnostic core), so this is not browser-specific — every JS runtime is affected
  identically against a `javascript`-typed app.
- **Workaround used to keep verifying:** `staging-workarounds.mjs` rewrites the outgoing
  `x-client-type` header to `javascript` in a Playwright `page.route` handler.

### F-3 · `BugseeApi.ensureSession`/`postIssue` decode the response body as a flat shape; the real server wraps every response in `{ok, result: {...snake_case...}}` — silently, with no throw

- **Severity:** blocker
- **Package:** `@bugsee/core` (`packages/core/src/bugsee-api.ts:72` for `ensureSession`; the `postIssue`
  helper at `bugsee-api.ts:42-53` has the identical bug for issue creation)
- **Scenario:** every scenario that produces an issue (S3–S9, S11, S12; anything past F-1/F-2)
- **Expected:** `ensureSession()` resolves to the real access token; `createIssue()` resolves to the
  real `{endpoint, issueId, recordingId}`.
- **Observed:** the real server's `/v2/sessions` response is
  `{"ok":true,"result":{"access_token":"…", ...}}`, but `ensureSession` reads
  `(decode(response.body) as {access_token}).access_token` — a FLAT read — so `accessToken` becomes the
  literal JS value `undefined`. Because `undefined !== null`, the guard on the next line
  (`if (accessToken !== null) return accessToken;`) treats it as "already have a session" FOREVER, and
  `postIssue`'s own guard (`if (accessToken === null) throw`) also does not catch it. Every subsequent
  `createIssue`/`renewUpload` call sends the literal header `Authorization: Bearer undefined`. The
  SAME flat-decode bug hits `postIssue`'s own response parsing (`return decode(response.body) as
  IssueCreateResult` — no `.result` unwrap, and the real fields are `issue_id`/`recording_id`, not
  `issueId`/`recordingId`), so even a request that somehow got a valid token would resolve
  `{endpoint: undefined, issueId: undefined, recordingId: undefined}` — the bundle-upload PUT
  (`upload-pipeline.ts`) then gets called with `endpoint = undefined` and never fires at all.
- **This is silent by design-accident, not by throw**: the SDK's own unit tests
  (`bugsee-api.test.ts:39`, `body: enc({ access_token: token })`) encode the SAME flat assumption as the
  implementation, so nothing in the test suite could have caught the mismatch against the real server.
- **Reproduce:** with F-1/F-2 bypassed, watch the raw `/v2/sessions` response
  (`{"ok":true,"result":{"access_token":"…"}}`) vs. the next request's `Authorization` header
  (`Bearer undefined`).
- **Workaround used to keep verifying:** `staging-workarounds.mjs` unwraps `.result` and remaps
  `issue_id`/`recording_id` → `issueId`/`recordingId` in the fulfilled response body for both endpoints,
  so the SDK's own (buggy) flat decode happens to read the right values afterward.

### F-4 · `BundleUploader` always sends `x-amz-checksum-sha256` on the bundle PUT; the presigned S3 URLs this backend issues do not authorize that header, so every upload fails with `SignatureDoesNotMatch`

- **Severity:** blocker
- **Package:** `@bugsee/core` (`packages/core/src/bundle-uploader.ts:25`)
- **Scenario:** every scenario that uploads a bundle (all of S1–S12, once F-1..F-3 are bypassed)
- **Expected:** the signed `PUT` to the S3 `endpoint` from `createIssue()` succeeds.
- **Observed:** `putBundle` sends `{'Content-Length', 'x-amz-checksum-sha256', 'fileName'}` on every
  PUT. AWS's V2 query-string presigned-URL scheme computes its `StringToSign` over whatever `x-amz-*`
  headers are ACTUALLY present on the request; the presigned URL this backend issues was not generated
  expecting `x-amz-checksum-sha256`, so S3 recomputes a different signature and rejects with
  `403 SignatureDoesNotMatch` on every single PUT — proven by a clean `curl` isolation:
  ```
  curl -X PUT "$presignedUrl" -H "Content-Type:" --data-binary test        # -> 200 OK
  curl -X PUT "$presignedUrl" -H "Content-Type:" \
       -H "x-amz-checksum-sha256: $(printf test | openssl dgst -sha256 -binary | base64)" \
       --data-binary test                                                 # -> 403 SignatureDoesNotMatch
  ```
  (full `<StringToSign>`/`<StringToSignBytes>` from AWS's own error XML captured during
  investigation — the checksum header is the only variable between the two requests.)
- **Impact:** even a customer who somehow got past F-1/F-2/F-3 would have the bundle PUT itself
  rejected by AWS on every attempt — no capture data ever lands, only the empty issue shell.
- **Workaround used to keep verifying:** `staging-workarounds.mjs` strips `x-amz-checksum-sha256`
  from the PUT request before it reaches S3.

### F-5 · `BugseeErrorBoundary` wrapping `<RouterProvider>` never sees a route-element render throw with a react-router v6 DATA router — react-router's own per-route `RenderErrorBoundary` intercepts it first, silently

- **Severity:** major
- **Package:** `@bugsee/react` (`packages/react/src/error-boundary.ts`) — a documentation/integration gap, not a crash in the package itself
- **Scenario:** React-specific — "an unguarded component that throws during render" (adjacent to the
  PLAN §5.2 `BugseeErrorBoundary` bullet), exercised via the Scenario panel's `arm-global` control
- **Expected (the natural reading of PLAN §5.2 and of `main.tsx`'s own architecture — a single
  `BugseeErrorBoundary` wrapping the whole `<RouterProvider>`):** a render throw anywhere in the routed
  tree reaches the outer `BugseeErrorBoundary`, gets reported, and the app's own (Bugsee-aware) fallback
  renders.
- **Observed:** react-router v6 data routers (`createBrowserRouter` + `<RouterProvider>`) install their
  OWN internal `RenderErrorBoundary` around each matched route element. That boundary catches a
  route-element render throw BEFORE it can propagate to any boundary OUTSIDE `<RouterProvider>` — so
  `BugseeErrorBoundary.componentDidCatch` never runs, `reportReactError` is never called, and the user
  sees React Router's own generic **"Unexpected Application Error!"** page instead of the app's fallback
  — with NO issue reported to Bugsee and NO indication anything went wrong. Confirmed via
  `scripts/verify.mjs`'s `react-error-boundary-global-GAP` check across every sweep run: the app-level
  fallback (`data-testid="error-fallback"`) never renders; React Router's own text
  ("Unexpected Application Error!") always does.
- **Reproduce:** `pnpm dev`, go to `/scenarios`, click "Arm + throw (replaces this page)" under
  "React — BugseeErrorBoundary / withBugseeErrorBoundary". Compare with the LOCAL (guarded) widget just
  above it, wrapped in `withBugseeErrorBoundary` directly around the throwing component — that one DOES
  work (a boundary placed INSIDE the routed tree, closer to the throw, wins over both react-router's own
  boundary and the outer one).
- **Fix direction (not applied):** either document that `BugseeErrorBoundary` must be placed INSIDE each
  route element (or wrapped per-`Component`/`errorElement` via `reportReactError`) when using a react-router
  v6+ data router, or add a small documented seam (e.g. an `errorElement` helper) so the common
  "one boundary around the whole app" pattern — which is what a Bugsee-inexperienced React dev would
  reach for by default — actually reports.
- **Evidence:** every `scripts/verify.mjs` run (44-46/46 the rest passing); MCP: no `SREACT` issue is
  ever created by this control despite dozens of runs.

### F-6 · `resolveBugseeCli()`'s bare `'bugsee-cli'` PATH lookup only works from INSIDE the monorepo — it fails for any real consumer, including this sample, installed exactly the way `docs/samples/PLAN.md` §2 says a customer installs it

- **Severity:** blocker
- **Package:** `@bugsee/bundler-plugin-core` (`packages/bundler-plugin-core/src/run-cli.ts:84-95`)
- **Scenario:** the "source-map half" — `@bugsee/vite-plugin`'s whole reason to exist
- **Expected:** `pnpm build` with `bugseeVitePlugin({appToken})` in `vite.config.ts` runs `bugsee-cli`
  with no extra configuration ("zero-config", per the file's own doc comment).
- **Observed:** `resolveBugseeCli()` returns the bare command `'bugsee-cli'` and relies entirely on it
  being resolvable via `PATH`, reasoning (in its own comment) that "`@bugsee/bugsee-cli` … is a DIRECT
  dependency of this package, so the binary is present with no extra install". That is true only INSIDE
  the monorepo, where `@bugsee/bundler-plugin-core`'s own `pnpm --filter` scripts run with ITS
  `node_modules/.bin` on `PATH`. For any real consumer — including this sample, installed exactly per
  PLAN §2 (`@bugsee/vite-plugin` → depends on → `@bugsee/bundler-plugin-core` → devDependency
  `@bugsee/bugsee-cli`) — `@bugsee/bugsee-cli` is a TRANSITIVE dependency two levels down. pnpm's
  (and npm ≥7's) isolated `node_modules` never hoists a transitive dependency's `bin` entry into the
  CONSUMING package's `node_modules/.bin`, so `bugsee-cli` is never on `PATH` when `vite build` runs
  from the app's own root — exactly where every real customer runs it. `pnpm build` fails outright:
  `[bugsee] spawn bugsee-cli ENOENT`.
- **Reproduce:** `node scripts/pack-local.mjs && node scripts/new-sample.mjs x @bugsee/vite-plugin &&
  cd samples/x && pnpm install`, wire `bugseeVitePlugin({appToken})` into `vite.config.ts`, then
  `pnpm exec vite build` — `spawn bugsee-cli ENOENT`, every time, with zero workspace context.
- **Escape hatch that DOES work (documented in the same file, `BUGSEE_CLI_PATH`):**
  `BUGSEE_CLI_PATH=<path to run-bugsee-cli.js> pnpm build` — this sample's `README.md` documents the
  exact command. Once pointed at the real binary, the REST of the pipeline works correctly (see below)
  — this is purely a resolution defect, not a defect in what `bugsee-cli` itself does.
- **Fix direction (not applied):** resolve the binary via `require.resolve('@bugsee/bugsee-cli/…')` (or
  `import.meta.resolve`) relative to `@bugsee/bundler-plugin-core`'s OWN location instead of trusting
  `PATH` — the same fix class as other vendors' bundler plugins, which resolve their native helper
  binaries from their own package rather than assuming the consumer's PATH.
- **Related:** `@bugsee/webpack-plugin` shares the exact same `run-cli.ts`, so it has the identical
  defect (not verified independently here — out of scope for react-spa — but the code path is shared).

### F-7 · `@bugsee/vite-plugin`, `@bugsee/bundler-plugin-core`, `@bugsee/webpack-plugin`, `@bugsee/replay`, `@bugsee/replay-canvas`, `@bugsee/rrweb`, `@bugsee/electron` all ship without `publishConfig`, so their packed tarballs resolve to `./src/index.ts` (uncompiled TypeScript) instead of `dist/`

- **Severity:** blocker
- **Package:** `packages/{vite-plugin,bundler-plugin-core,webpack-plugin,replay,replay-canvas,rrweb,electron}/package.json`
  — none of the seven has a `publishConfig` block, unlike every other publishable package (verified by
  diffing all 55 `packages/*/package.json` for the field: e.g. `packages/react/package.json` HAS one
  rewriting `main`/`module`/`types`/`exports` to `dist/*`; these seven do not, so `pnpm pack` leaves
  `main`/`exports` pointing at `./src/index.ts`).
- **Expected:** installing any of these from a packed tarball resolves `.` to the built `dist/` output,
  same as every other package.
- **Observed, two distinct failure shapes depending on the package's `src/index.ts`:**
  1. **`@bugsee/vite-plugin` / `@bugsee/bundler-plugin-core`** — `src/index.ts` has no relative
     imports, so it IS present in the tarball (npm/pnpm auto-include the file the `main`/`exports`
     field points at even when `files` doesn't list it), but `vite.config.ts` loading fails outright
     under Node 24: `Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently
     unsupported for files under node_modules, for ".../@bugsee/vite-plugin/src/index.ts"` — Node
     refuses to type-strip a `.ts` file that lives inside `node_modules` by design. Nothing loads at
     all.
  2. **`@bugsee/replay` / `@bugsee/replay-canvas` / `@bugsee/rrweb`** — worse: `src/index.ts` imports
     SIBLING files (`./encoder`, `./masking`, `./recorder`, `./register`, `./canvas-config`) that are
     NOT included in the tarball (`files: ["dist"]` legitimately excludes them), so esbuild/Vite's
     resolver fails outright: `Could not resolve "./encoder"` etc. — a lazy `import('@bugsee/replay')`
     (exactly how `@bugsee/browser` loads it when `replay` is set) throws.
  3. **`@bugsee/electron`** not independently reproduced here (out of scope — no Electron runtime in
     this sample) but shares the same missing-`publishConfig` root cause; flagging by inspection for
     whoever builds `electron-app`.
- **Impact:** `@bugsee/vite-plugin` (this sample's OWN package under test) and `@bugsee/webpack-plugin`
  are unusable as installed; `@bugsee/replay`/`@bugsee/replay-canvas` — transitive dependencies of
  `@bugsee/browser`, therefore of `@bugsee/react` — break the FIRST TIME any app enables `replay` (S11),
  for every browser-family sample, not just this one.
- **Reproduce:** `node scripts/pack-local.mjs`, install `@bugsee/react` from the tarball, set
  `replay: true` in `launch()`, run a dev server — `Could not resolve "./canvas-config"` /
  `"./encoder"` / `"./masking"` / `"./recorder"` / `"./register"`, four to five separate resolve
  failures, build aborts.
- **Workaround used to keep verifying (NOT available to a real customer without patching
  `node_modules` by hand):** manually rewrote each affected package's on-disk `package.json`
  (`main`/`module`/`types`/`exports` → `./dist/*`) inside `node_modules/.pnpm/...` after `pnpm install`
  — the same shape `publishConfig` would produce, applied post-hoc. Confirmed this is sufficient (no
  further code changes needed) — once repointed at `dist/`, both failure classes disappear and S11
  (replay defaults, masking options, `blockAllCanvas`, `canvas.fps` fixed and `'all'`) all relaunch
  cleanly with zero console errors.
- **Fix direction (not applied):** add the same `publishConfig` block every other package already has.

### F-8 (observed, not fully attributed) · One issue (`SREACT-2`) shows `symbolication_status: "ready"` in `list_issues` but `get_issue` returns "Crash data for the issue was not found"

- **Severity:** minor (recorded as an anomaly, not a confirmed root cause — see caveat)
- **Package:** unclear — could be `@bugsee/core`'s bundle assembler under concurrency, or an artifact
  of this sample's own diagnostic S3/session-response-rewriting proxy racing under load; NOT confirmed
  against a customer-realistic (non-workaround) path.
- **Scenario:** S4 storm (`s4-storm` — 200 `logException()` calls fired in a tight loop, ~1s)
- **Expected:** every issue `get_issue` can enumerate also returns readable exception/crash content.
- **Observed:** `SREACT-2`'s `list_issues` entry shows `"summary":"<missing crash details>"` and
  `events_count` growing (2 → 18) across repeated sweep runs (i.e., MULTIPLE storm-fired reports
  deduped into this one issue, all with the same missing-content symptom); `get_issue` for it returns
  only `Crash data for the issue was not found`, no environment/exception/stack section at all.
  Every OTHER storm-produced report (the small number that get past the rate limiter) resolved
  normally in the same runs.
- **Caveat:** the storm scenario fires 200 near-simultaneous `logException()` calls through
  `staging-workarounds.mjs`'s response-rewriting `page.route` handler (F-2/F-3's workaround), which
  itself does async work (`route.fetch()` + JSON reparsing) per request — a race INSIDE that diagnostic
  proxy under this much concurrency cannot be ruled out as the cause. Recorded here rather than
  suppressed, but not asserted as a confirmed `@bugsee/core` defect.
- **Evidence:** issue `SREACT-2` (`6a86e0472aa216776bbb7905`), `SREACT` app.

### F-9 · `client.ext('performance')` (and any other `NameExtensionMapping` augmentation) has no usable TYPE without an extra, undocumented direct dependency

- **Severity:** minor
- **Package:** `@bugsee/bugsee` (`packages/bugsee/src/index.ts`) / `@bugsee/performance`
  (`packages/performance/src/extension.ts:19-23`)
- **Scenario:** S9 — manual `client.ext('performance').startTransaction(...)`
- **Expected:** a customer who installs only `@bugsee/react` (which re-exports the FULL `@bugsee/bugsee`
  umbrella, including a `launch()` that wires `@bugsee/performance` on by default) can call
  `client.ext('performance')` with a real, non-`never` type.
- **Observed:** `NameExtensionMapping` (the interface `ext()` is typed against) starts as `{}` in
  `@bugsee/types`; `@bugsee/performance`'s `declare module '@bugsee/types' { interface
  NameExtensionMapping { performance: PerformanceApi } }` augmentation only merges into the TypeScript
  program if SOMETHING imports `@bugsee/performance`'s types. Neither `@bugsee/bugsee`'s public
  `dist/index.d.ts` nor `@bugsee/react`'s re-export touches `@bugsee/performance` at all — confirmed:
  moving `node_modules/@bugsee/performance` aside and re-running `tsc --noEmit` in this sample produces
  `error TS2307: Cannot find module '@bugsee/performance'` the INSTANT anything tries `import type {...}
  from '@bugsee/performance'`, and without that import `client.ext('performance')` has no usable type at
  all (not merely `unknown` — the key doesn't exist on `{}`). A customer must add `@bugsee/performance`
  as their OWN explicit dependency purely for its ambient type augmentation — undocumented anywhere in
  the umbrella's public surface — even though the umbrella wires the runtime behavior automatically.
- **Reproduce:** `mv node_modules/@bugsee/performance /tmp/…`, `pnpm typecheck` in this sample —
  `Cannot find module '@bugsee/performance'`.
- **Workaround used:** added `@bugsee/performance` as an explicit `devDependency` in this sample's own
  `package.json` purely for the `import type { SpanStatus } from '@bugsee/performance'` in
  `ScenarioPage.tsx`.

## Also confirmed working (recorded for completeness — the source-map half was the point)

- **`@bugsee/vite-plugin` debug-ID injection + upload, end to end, once F-6 is worked around**: a
  production `pnpm build` (with `BUGSEE_CLI_PATH` pointed at the real binary) injects
  `//# debugId=<uuid>` + a `_bugseeDebugIds` runtime stamp into every chunk, deletes the client-facing
  `.map` files (`deleteMaps: true` default), and uploads the real maps. Throwing from the MINIFIED
  production bundle (`pnpm preview`) and checking `get_issue` (issue `SREACT-25`) shows the stack
  resolved to the exact original source and line:
  `onClick () (../../src/routes/ScenarioPage.tsx:296)` — verified against the actual source line
  (the `new Error(...)` call inside the `s4-error` handler). React-DOM's OWN production bundle also
  resolved via its published source map, confirming the symbolication path is generic, not
  react-spa-specific munging.
- **`@bugsee/babel-plugin-component-annotate`**: `data-bugsee-component="ScenarioPage"` /
  `"BoardPage"` / etc. appear on every host (lowercase) JSX element, confirmed by DOM inspection in
  both dev and the production build.
- **Cross-session dedup**: repeated `logException(new Error('S4 storm #i'))`-shaped reports across
  MULTIPLE separate `verify.mjs` runs (separate SDK sessions each time) deduped into the SAME backend
  issue (`events_count` incrementing 2 → 18 → …) rather than creating a new issue per run — this is
  server-side signature-based dedup working correctly across sessions, beyond just the same-instance
  case S4 asks for.

## Resolved
