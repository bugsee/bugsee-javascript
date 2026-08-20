# Findings — samples/vue-spa

> **Status update (after the wave-1 fix round).** The wire-contract defects this sample found —
> `x-client-type: web`, the unparsed `{ok, result}` response envelope with its snake_case ids, the
> HTTP-200 rejection read as success, and the `x-amz-checksum-sha256` header on the signed S3 PUT —
> are FIXED in `@bugsee/core` (`0318229`, `84976f7`). The missing `publishConfig` on
> `@bugsee/replay`/`replay-canvas`/`rrweb` and friends is fixed in `3921760`, and the `0.0.0` SDK
> version the collector rejected is fixed in `6d63ba8`. The workarounds this sample carried for those
> have been removed, and it was re-verified against real staging with the SDK as a customer gets it.
>
> What remains open here is tracked in `samples/FINDINGS.md`: the collector's CORS policy (which no
> browser sample can work around honestly), and the upload pipeline deferring bursts of more than four
> concurrent reports to the next process start (F-X8) — which is what several remaining "wire" checks
> in this sample are actually measuring.



Every SDK defect, data-arrival failure or data inconsistency observed while building and running
this sample. One entry per finding. Do NOT fix SDK code here — record it.

Severity: **blocker** (SDK unusable / data lost) · **major** (feature broken or wrong data) ·
**minor** (cosmetic, docs, ergonomics).

## Open

### F-1 · `@bugsee/replay` and `@bugsee/replay-canvas` are packaged without `publishConfig.exports`, breaking every consumer's dev server and production build

- **Severity:** blocker
- **Package:** `@bugsee/replay` (`packages/replay/package.json`), `@bugsee/replay-canvas`
  (`packages/replay-canvas/package.json`)
- **Scenario:** S1 (`pnpm dev` / `pnpm build`) — discovered while just trying to boot the app, before
  any scenario could run.
- **Expected:** installing `@bugsee/vue` from its packed tarball (which transitively depends on
  `@bugsee/browser`, which lazy-`import()`s `@bugsee/replay`/`@bugsee/replay-canvas` when `replay` is
  enabled — `packages/browser/src/launch.ts:474` and `:480`) behaves like every other browser-family
  package: `exports`/`main`/`types` in the packed `package.json` point at `./dist/*`, and `dist`
  contains a complete, self-sufficient build.
- **Observed:** every other browser-tier package (`@bugsee/vue`, `@bugsee/browser`, `@bugsee/react`,
  …) has a `publishConfig` block in its `package.json` that redirects `exports`/`main`/`types` to
  `./dist/*` for the packed tarball. `packages/replay/package.json` and
  `packages/replay-canvas/package.json` have **no `publishConfig` block at all** — confirmed by
  `grep -L publishConfig packages/*/package.json`, which also flags `@bugsee/rrweb`,
  `@bugsee/electron`, `@bugsee/vite-plugin`, `@bugsee/webpack-plugin`, `@bugsee/bundler-plugin-core`
  (all `private: true`, all missing the block; the e2e-only packages in that grep are expected to be
  private-only and are not part of the sample sweep). Their packed tarballs therefore still carry the
  monorepo dev-mode `exports`/`main`/`types` of `./src/index.ts` — and because `files: ["dist"]` is
  the only inclusion rule, the tarball ships `src/index.ts` but **none of its sibling modules**
  (`./encoder`, `./masking`, `./recorder`, `./register` for `@bugsee/replay`; `./canvas-config` for
  `@bugsee/replay-canvas`). The result: `@bugsee/browser`'s `dist/index.js` contains an
  unconditional `await import('@bugsee/replay')` / `import('@bugsee/replay-canvas')` (gated at
  RUNTIME by the `replay` launch option, but the bundler resolves dynamic-import targets at
  build/scan time regardless of whether the branch ever executes) — so **both** `vite dev`
  (dependency pre-bundling) **and** `vite build` (Rollup/Rolldown code-splitting) fail before the app
  ever runs, with `[UNRESOLVED_IMPORT] Could not resolve './masking' in .../@bugsee/replay/src/index.ts`
  (and the same for `./encoder`, `./recorder`, `./register`, `./canvas-config`). This happens
  **regardless of whether `replay` is actually passed to `launch()`** — verified by removing the
  option entirely and reproducing the identical crash.
- **Reproduce:**
  ```
  node scripts/pack-local.mjs
  node scripts/new-sample.mjs tmp "@bugsee/vue"
  cd samples/tmp && pnpm install
  # add any component that calls @bugsee/vue's launch() (re-exported from @bugsee/bugsee), then:
  pnpm exec vite dev
  # → [UNRESOLVED_IMPORT] Could not resolve './masking' in .../@bugsee/replay/src/index.ts, etc.
  ```
  Or directly: `tar xzf .local-registry/bugsee-replay.tgz -C /tmp/x && cat /tmp/x/package/package.json`
  shows `"main": "./src/index.ts"` / `"exports": {".": {"import": "./src/index.ts"}}` with no
  `publishConfig`, and `find /tmp/x/package/src -type f` shows only `index.ts`.
- **Workaround in this sample:** `replay: false` in `src/bugsee.ts` (session replay is therefore
  **untestable**, not merely undemonstrated — S11 is marked N/A in `scenarios.md`), plus
  `optimizeDeps.exclude` + `build.rollupOptions.external` for both packages in `vite.config.ts` so the
  bundler never tries to resolve them at all (required for `pnpm dev`/`pnpm build` to succeed even
  with replay off, since the crash is unconditional).
- **Fix direction (not applied):** add the same `publishConfig` block `@bugsee/vue`/`@bugsee/browser`
  carry to `packages/replay/package.json`, `packages/replay-canvas/package.json` (and audit the other
  five packages the grep flagged that are meant to be published: `@bugsee/rrweb`, `@bugsee/electron`,
  `@bugsee/vite-plugin`, `@bugsee/webpack-plugin`, `@bugsee/bundler-plugin-core`).

### F-2 · The staging collector's CORS policy hardcodes `Access-Control-Allow-Origin` to `https://appdev.bugsee.com`, blocking every browser-based sample regardless of its actual origin

- **Severity:** blocker
- **Package:** not SDK code — the staging collector (`https://apidev.bugsee.com`), reproduced from a
  real browser via the SDK's own fetch calls (`packages/browser-utils`'s transport).
- **Scenario:** every scenario that needs a session (S1 onward) — nothing reaches the backend from
  the actual dev server origin (`http://localhost:5303`) at all.
- **Expected:** a CORS preflight from the sample app's origin (`http://localhost:5303`, the port this
  plan assigns) either succeeds because the collector reflects the request `Origin` (as most
  multi-tenant collectors do) or because `localhost` origins are allow-listed for staging use.
- **Observed:**
  ```
  curl -sS -i -X OPTIONS https://apidev.bugsee.com/v2/sessions \
    -H "Origin: http://localhost:5303" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: content-type,x-bugsee-token"
  # → HTTP/1.1 200 OK
  # → access-control-allow-origin: https://appdev.bugsee.com
  ```
  The header value is a **fixed string**, not a reflection of the request `Origin` — every real
  browser (Chrome, in this case, via Playwright) blocks the actual `POST /v2/sessions` (and every
  subsequent SDK request) with `Access-Control-Allow-Origin' header has a value
  'https://appdev.bugsee.com' that is not equal to the supplied origin`, and the SDK's own `onError`
  sink receives `TypeError: Failed to fetch` for every session/bundle upload attempt. No scenario in
  this sample (or presumably any other browser-family sample: `browser-vanilla`, `react-spa`,
  `svelte-spa`, `solid-spa`, `angular-spa`) can reach the backend from a real browser tab pointed at
  its own dev server, which is the ONLY way `docs/samples/PLAN.md` describes running a web sample.
- **Reproduce:** run the `curl -i -X OPTIONS` above against any origin other than
  `https://appdev.bugsee.com`; every response carries the same fixed `Access-Control-Allow-Origin`.
- **Workaround used for verification only:** launched the Playwright browser with
  `--disable-web-security` (see `scripts/verify.mts`) purely so this sample's OWN scenarios could be
  exercised end-to-end against staging for this report. This is **not** something a real customer can
  do — it is a test-harness-only bypass, not a fix, and every scenario verified this way is flagged in
  `scenarios.md`.
- **Fix direction (not applied):** the collector's CORS middleware should reflect the request's
  `Origin` (optionally checked against an allow-list) rather than emit a single hardcoded origin.

### F-3 · `installBugseeErrorHandler(app)` does not typecheck against a real Vue `App`, only against the package's own `VueAppLike` test double

- **Severity:** minor (ergonomics — runtime behavior is correct, only the public TS surface is wrong)
- **Package:** `@bugsee/vue` (`packages/vue/src/error.ts:61`, `VueAppLike` at `:22`)
- **Scenario:** S1/S4/S5 setup — `installBugseeErrorHandler(app)` called exactly as the package's own
  doc comment shows, right after `createApp(...)`.
- **Expected:** `installBugseeErrorHandler(createApp(App))` typechecks under the SDK's own
  `verbatimModuleSyntax`/strict TypeScript conventions (CLAUDE.md "Module strategy"), since that is
  the only realistic call site — `packages/vue/src/error.test.ts` is the only place `VueAppLike` is
  used directly, always as a hand-built fake, never against real `vue`.
- **Observed:** with `vue@3.5.41`, `pnpm exec vue-tsc -b --noEmit` on `src/main.ts` fails:
  ```
  error TS2345: Argument of type 'App<Element>' is not assignable to parameter of type 'VueAppLike'.
    The types of 'config.errorHandler' are incompatible between these types.
      Type '(err, instance: ComponentPublicInstance | null, info) => void' is not assignable to
      type '(err: unknown, instance: unknown, info: string) => void'.
        Types of parameters 'instance' and 'instance' are incompatible.
          Type 'unknown' is not assignable to type 'ComponentPublicInstance<...> | null'.
  ```
  Real Vue's `app.config.errorHandler` is typed with a narrower `instance` parameter
  (`ComponentPublicInstance | null`) than `VueAppLike`'s `unknown`; under `strictFunctionTypes`
  parameter contravariance, that makes a real `App` NOT assignable to `VueAppLike`. Every consumer
  using strict TypeScript hits this on the very first call.
- **Reproduce:** `pnpm add vue @bugsee/vue`, `createApp(App)` then
  `installBugseeErrorHandler(app)`, `tsc --noEmit` (strict mode).
- **Workaround in this sample:** `installBugseeErrorHandler(app as unknown as VueAppLike)` in
  `src/main.ts`.
- **Fix direction (not applied):** widen `VueAppLike.config.errorHandler`'s `instance` parameter to
  something covariant-safe (e.g. a generic, or drop the parameter type constraint to `any`), or
  document the cast as required usage.

### F-4 · The default SDK version (`0.0.0`) is rejected outright by the staging collector as "no longer supported"

- **Severity:** blocker
- **Package:** `@bugsee/browser` (`packages/browser/src/launch.ts:79`, `const SDK_VERSION = '0.0.0'`)
- **Scenario:** S1 — the very first session-creation call any scenario makes.
- **Expected:** the SDK's default `sdk.version` (unset `sdkVersion` option) is accepted by the
  staging collector, since every package in this unpublished monorepo is at `0.0.0` by design (see
  the root `samples/FINDINGS.md` F-X2 — this is that same gap surfacing at the wire boundary).
- **Observed:** with `sdkVersion` left at its default, every `POST /v2/sessions` returns
  `HTTP 200 {"ok":false,"error":{"type":"UnsupportedSdkError","message":"SDK version is no longer
  supported. Please update to the latest version","code":99098}}` — captured via Playwright network
  interception on a real `logException()` call. No session, therefore no data of any kind, can ever
  reach staging while `SDK_VERSION` stays at `0.0.0`.
- **Reproduce:** `pnpm dev`, open devtools Network tab, click any Scenario-panel button that calls
  `logException`/`log`/etc., inspect the `POST https://apidev.bugsee.com/v2/sessions` response body.
- **Workaround in this sample:** `sdkVersion: '9.9.9'` passed explicitly in `src/bugsee.ts` (documented
  there). The `?minimal=1` "minimum options" launch leg (S1) does NOT apply this workaround —
  it deliberately passes no options beyond `endpoint`, so it reproduces this same
  `UnsupportedSdkError` and is verified at the local level only.
- **Fix direction (not applied):** either the collector should accept `0.0.0` for pre-release/staging
  traffic, or the monorepo needs its versioning pass (already tracked as F-X2 in `samples/FINDINGS.md`)
  before any sample can talk to staging without a per-launch override.

### F-5 · The staging collector rejects EVERY session for a `type: "javascript"` application with `ApplicationTypeMismatchError`, blocking all backend verification

- **Severity:** blocker — this is the finding that most affects this report: **no scenario in this
  sample could be verified at the backend (level 3) depth defined in `docs/samples/PLAN.md` §4**,
  because no data of any kind ever reaches staging for the `SVUE` app (or, per a quick cross-check,
  `SNODE` — this is very likely universal to every `type: "javascript"` sample app, not specific to
  the `vue` subtype).
- **Package:** not SDK code — the staging collector's application-type validation on
  `POST /v2/sessions`, reproduced from a real browser via the SDK's own session-creation call.
- **Scenario:** every scenario (S1 onward).
- **Expected:** a session-creation call from a correctly-configured SDK against the app it was
  launched with (`app_token` for `SVUE`, id `6a86d8ec990cb94c0b8e8f01`, `type: "javascript"`,
  `subtype: "vue"` — confirmed via `list_applications`) succeeds.
- **Observed:** with the F-2 (CORS) and F-4 (SDK version) workarounds both applied, every
  `POST /v2/sessions` still returns
  `{"ok":false,"error":{"type":"ApplicationTypeMismatchError","message":"Application type does not
  match the expected type","code":11004}}` — and every subsequent `/v2/issues` /
  `/v2/performance/transactions` call then fails with `SessionNotFoundError` (code 14002), since no
  session was ever actually created server-side. The full request body sent (captured verbatim):
  ```json
  {"app_token":"c3f2bc97-...","environment":{"platform":{"type":"web","version":"Mozilla/5.0 ...",
  "utc_offset":300,"locale":"en-US","memory_total":34359738368},"hardware":{...},
  "app":{"package_id":"unknown","version":"1.0.0","build":"1","debuggable":false},
  "sdk":{"version":"9.9.9","type":"javascript","options":{...}}},"session_id":"..."}
  ```
  Two hypotheses were tested and both ruled OUT: (1) rewriting `environment.platform.type` from
  `"web"` to `"javascript"` in-flight (via Playwright route interception) — same error; (2) the
  `sdk.type` field is already the literal `"javascript"` the protocol hardcodes
  (`packages/protocol/src/wire.ts:47`), matching the app's `type`. Neither the SDK's `platform.type`
  vocabulary (`'web' | 'node' | 'bun' | 'deno' | ...`, `packages/protocol/src/wire.ts`) nor the wire
  protocol carries an app **subtype** field (`vue`, `react`, `node`, …) anywhere — `create_application`
  accepts a `subtype` but nothing in `EnvironmentEnvelope` echoes it back, so the collector has no
  SDK-supplied signal to reconcile against the app's registered `vue` subtype even if it wanted to.
  This is consistent with the "JS backend-support" work being flagged in-progress (worker JS-crash
  routing is built; the session/app-type validation path for `type: "javascript"` apps was not
  exercised end-to-end here).
- **Reproduce:**
  ```
  node scripts/pack-local.mjs && node scripts/new-sample.mjs tmp "@bugsee/browser"
  cd samples/tmp && pnpm install
  # launch(SVUE_TOKEN, { endpoint: 'https://apidev.bugsee.com', sdkVersion: '9.9.9' }); logException(...)
  # inspect POST /v2/sessions in devtools → ApplicationTypeMismatchError
  ```
- **Impact on this report:** every scenario in `scenarios.md` is marked "covered, backend UNVERIFIED
  (F-5)" rather than backend-verified. Local-level (did the SDK call succeed, did the app stay usable)
  and wire-level (was the right request, with the right method/URL/payload shape, actually sent) are
  fully verified via `scripts/verify.mts` and ad hoc network capture; `list_issues` on `SVUE` was
  polled after a full scenario sweep + `flush()` and returned `{"issues":[],"total":0}` — 0 issues
  after the entire sweep, not a slow arrival.
- **Fix direction (not applied):** outside this repo (appserver); needs the backend engineer who owns
  the `type: "javascript"` application-type validation path.

## Resolved
