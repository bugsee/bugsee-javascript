# Remediation plan — adversarial review of all 53 packages

Input: `docs/review/ADVERSARIAL-REVIEW.md` + the 44 per-package reports (commit `065fa01`).

**Organising principle: fix root causes, not findings.** The ~90 SEV1s collapse into **9 root causes plus 11
discrete bugs**. Fixing by package would mean ~40 uncoordinated changes; fixing by root cause means one
mechanism applied consistently, with one test strategy that keeps it fixed.

Every item is bound by `docs/implementation-standards.md`: test-first, per-entity mutator loop, 100% line /
≥90% branch, and a convergent multi-agent review per feature. **Effort below assumes that discipline** — it is
the dominant cost, not the code change. Estimates are rough and deliberately coarse.

---

## Wave 0 — Contain the bleeding (discrete, severe, small)

These are contained, high-severity, and independent. Do them first because each is a few lines behind a
serious hole, and none blocks anything else.

| # | Fix | Where | Why first | Est |
|---|---|---|---|---|
| 0.1 | ✅ **DONE** — **Cross-tenant capture-ring sharing in Durable Objects** — each DO instance gets its own partition. Built as `createPartitionedCaptureStore` in `@bugsee/core` (`partitioned-capture-store.ts`), with the tenant `owner` threaded from `instrument-durable-object.ts` / `instrument-class.ts`. Design: `docs/design/cloudflare-tenant-isolation.md`. Tested in `partitioned-capture-store.test.ts` + the cloudflare suites. | `packages/cloudflare`, `packages/core` | 2–3d |
| 0.2 | ✅ **DONE** — **Renderer-controlled `type` reaches `path.join` in main** — `t` is validated against a closed `KNOWN_FILE_TYPES` set and `ts` against a finite-number check, in `packages/electron/src/protocol.ts`. A failing message is DROPPED, not sanitised. `protocol.test.ts` asserts the proven exploit string (`'../../../../victim/pwned.txt'`) and seven sibling shapes are all rejected. | `packages/electron` | 2–3d |
| 0.3 | **Unauthenticated, page-replaceable bridge globals** — mint a per-session token at injection, verify on every inbound message, resolve the native sink ONCE and capture it | `packages/webview` | Any later-loading script on the page taps the whole un-redacted capture stream, or suppresses capture entirely. | 3–4d |

**Decision needed on 0.3:** hardening the bridge is a wire-protocol change and the Android receiver
(separate repo, slice 8) must move in step. Confirm the cross-repo sequencing before starting.

---

## Wave 1 — Stop shipping data to the wrong place (privacy)

| # | Fix | Where | Notes | Est |
|---|---|---|---|---|
| 1.1 | ✅ **DONE** — **Redact URLs on the wire path** — scrub query strings and `user:pass@` credentials at the single choke point | `packages/node` (`node:http` owner — the root cause), `packages/capture` | Root-caused during review: the seven backend adapters are clean; the engine leaks. One fix covers all of them, plus `nestjs`'s `manifest.json` `http.url`. | 3–4d |
| 1.1b | ✅ **DONE** — **Redact URLs embedded in network ERROR MESSAGES** | `packages/protocol`, `packages/capture` | **Not in the original findings** — found by the privacy e2e *after* 1.1 was in place and passing: the URL field was correctly redacted while `customError`/`custom.error` quoted the same URL back verbatim (undici's "Request cannot be constructed from a URL that includes credentials: …"). Android already carries this defense (`NetworkDataSanitizer.sanitizeErrorMessage`). | — |
| 1.2 | ✅ **DONE** — **Form-urlencoded bodies ship credentials in the clear** — apply body sanitisation to urlencoded as it is to JSON | `packages/capture` | Same class as 1.1, different content type. | 1–2d |
| 1.3 | ✅ **DONE** — **Replay masking model** — make the always-masked floor (`password`, `cc-*`) genuinely non-overridable; replace the 11-entry attribute denylist with an allowlist or a value-shape heuristic | `packages/replay` | `.bugsee-unmask` currently defeats the password floor — raw passwords and card numbers get serialised. `data-user-email` leaks at defaults. | 4–6d |
| 1.4 | ✅ **DONE** — **Fail-closed on every privacy path** — a malformed selector, a throwing masking config, or a failed rect computation must obscure MORE, never less | `packages/replay`, `packages/replay-canvas`, `packages/webview` | Today: one typo in `blockSelector` silently disables ALL blocking page-wide; WebView obscuring is fail-open three ways. | 3–5d |
| 1.5 | **Canvas privacy** — make `.bugsee-show` actually work on the canvas path, and make `.bugsee-ignore`/`.bugsee-mask` protect canvas pixels | `packages/replay-canvas` (+ rrweb fork: `unblockSelector` is never passed) | Requires a change in the rrweb fork — cross-repo, so start the fork work early. | 3–5d |

**Wave 1.1 / 1.2 as built.** One portable redactor in `@bugsee/protocol` (`sanitizeUrl`, `sanitizeErrorMessage`,
plus non-JSON body key redaction in `sanitizeBody`), ported from Android's `NetworkDataSanitizer` rather than
invented, with two deliberate supersets over it: **URL userinfo** (`node:http` supports `user:pass@`; browsers
strip it, so Android never needed it) and **fragment params** (OAuth implicit flow returns `#access_token=`).
Wired at every place a URL reaches the wire: the network capture choke point (covers fetch/xhr/ws/sse/
webtransport *and* `node:http`, which folds in via `additionalSources`), `@bugsee/node`'s `server-instrument`
(covers express/fastify/koa/hapi/elysia in one change), plus `nestjs`, `astro`, `vercel-edge` and the
`http.client` span description in `@bugsee/performance`.

**Correction (review round 1).** The form-urlencoded pass shipped here had no shape guard and DESTROYED
non-form bodies — 10 of 20 real files lost >90 % of their bytes as `text/plain` — and JSON leaked whole under
non-canonical JSON media types (`application/x-amz-json-1.1`, the AWS SDK v3 default). Both fixed in
`a73086b`, along with `;` separators, nested-URL values, two `sanitizeErrorMessage` gate misses,
protocol-relative userinfo, and an unbounded shape scan that blocked the app thread for 7.7 s on 200 KB.

**Verification.** A `privacy` e2e scenario re-runs the review's own probe against the real SDK and scans the
delivered bundle bytes. It is teeth-checked: unwiring each of the three redactors individually makes it fail
with the corresponding marker, and it asserts redaction rather than deletion (the non-sensitive param must
still ride). It earned its keep immediately — it found 1.1b, which unit tests at 100% coverage did not.

**Wave 1.3 / 1.4 (replay) as built.** All in `packages/replay/src/masking.ts`, the single choke point:

- **The sensitive floor moved into the SELECTOR.** rrweb resolves an input as
  `unmaskInputSelector.matches(el) ? raw : maskInputValue(…)` — the un-mask check comes first and
  short-circuits, so `maskInputOptions:{password:true}` was never consulted for an un-masked element. Each
  un-mask fragment now carries a `:not(…)` guard per sensitive input (password / tel / `autocomplete*="cc-"` /
  one-time-code), and the caller's `unmaskTextSelector` no longer feeds the input path at all — so
  `unmaskTextSelector:'*'` can no longer un-mask every password on the page. `tel` was added to
  `maskInputOptions` because the fork's LIVE observer gates on that map alone (SEV1 #1, SEV2 #4).
- **Attributes became an allowlist** (SEV1 #2). Only rendering-critical names pass through — including the
  SVG geometry/paint set, without which every icon would be destroyed. `data-*`, `<meta content>` and any
  bespoke attribute are masked, length-preserved.
- **A malformed caller selector can no longer disable privacy** (SEV1 #3, SEV2 #10). Each fragment is
  validated; an invalid one is dropped, reported through `onError`, and — for the opt-IN selectors, where
  dropping would itself weaken privacy — escalated to the strictest setting (`maskTextSelector` →
  `maskAllText`, `blockSelector` → `blockAllMedia`, `ignoreSelector` → `maskAllInputs`).
- **Prototype pollution and falsy non-booleans no longer downgrade defaults** (SEV2 #11): own-property reads
  plus a strict `typeof === 'boolean'` check, so `maskAllText: 0` is no longer passed to rrweb as "off".

**Correction (review round 1).** The floor documented here as absolute was not: with `maskAllInputs:false`
every `autocomplete`-declared sensitive field (cc-number, one-time-code, current/new-password, multi-token
forms) leaked its typed value, because `maskInputOptions` is keyed by input TYPE. The attribute allowlist also
introduced two regressions — masking the `data-*`/`aria-*` UI-STATE attributes broke styling for a default
modern React app, and masking SVG `display` INVERTED it, making deliberately hidden content visible. All
fixed in `6f33f02`.

**Verification.** `masking.integration.test.ts` drives the REAL rrweb over a REAL DOM and asserts the bytes it
emits. This is the gap the review named explicitly: its "Masking fail-closed audit" table has ✗ in the
*"test asserts the real rrweb config?"* column on **every** row, which is why three fail-open defects survived
a suite at 100 % coverage. Every guarantee in that table is now asserted against rrweb's actual output.

**Known residual (measured, not assumed).** URL attributes never reach `maskAttributeFn` — instrumenting it
over a page carrying `href`/`src` shows only `data-x` arriving, because rrweb resolves and absolutizes URL
attributes on its own path. PII inside a URL therefore **cannot** be scrubbed from this seam; closing it needs
a change in the rrweb fork. A test pins the current behaviour so that a fork change surfaces here.

**Wave 1.4 (`replay-canvas` + `webview`) as built.**

- **`replay-canvas` SEV1 #3 closed by the same root cause.** The canvas-specific amplification was that
  rrweb's canvas manager calls its block check from INSIDE the patch it installs on
  `HTMLCanvasElement.prototype.getContext`, *unwrapped* — so a malformed `blockSelector` threw a DOMException
  out of the host application's own `getContext('2d')` (breaking Chart.js, PDF.js, signature pads) while
  simultaneously leaking every canvas's pixels. Validating selectors makes it unreachable at the source;
  pinned as one property — *every resolved selector is parseable* — over a matrix of malformed inputs.
- **`webview` obscuring now fails closed on all three paths** the review identified (SEV1 #1): the
  synchronous native pull, `start()`, and change-tracking recompute. The policy is a **full-frame secure
  rect**, deliberately NOT "last known good": stale rects report success while a field added after the
  failure goes unmasked. Every failure is reported through `onError` rather than being silent.
- **The `obscuring` capability is now gated on a successful probe** (SEV1 #2). Declaring it is what makes
  native stand its legacy masking script down, and the protocol has no retraction message — so on a page
  where collection already throws, the SDK stays silent and native keeps its own masking. No wire change,
  so this needs no Android coordination.

Remaining in `webview`: the bridge-authentication items (SEV1 #3/#4) are **Wave 0.3**, still gated on the
Android receiver per D1. `replay-canvas` SEV1 #1/#2 are **1.5**, gated on the rrweb fork.

---

## Wave 2 — Stop breaking customer applications

This is the single highest-leverage item in the plan. The SDK's own binding rule is *"never alter host
application behavior"*, and it is violated in nearly every tier by the same shape of defect: **SDK code runs
inside host code with no guard**.

| # | Fix | Where | Est |
|---|---|---|---|
| 2.1 | ✅ **DONE** — **One shared `neverThrow` boundary helper** in core, applied at EVERY host-facing entry point. All four targets this plan named are resolved: `core`'s `runFilter` was already contained; the OTel `onEnd`, the vercel-edge `waitUntil`/catch, and the browser window listeners are fixed. | `packages/core` + applied across ~15 packages | 5–8d |
| 2.2 | ✅ **DONE** (13 adapter packages) — **Enforce it** — a `host-boundary.test.ts` per package with two halves: CONTAINMENT (every entry driven with a throwing client AND a throwing app-supplied `getClient`) and COMPLETENESS (the exported surface enumerated, so a new export with no containment test fails the file BY NAME — teeth-checked). | `packages/*` | 2–3d |
| 2.3 | ✅ **DONE** (corrected in review round 1) — **Chain, never clobber, the host's error handler**. The first pass marked this done while express and koa were still unguarded: both build their request `info`, including the app-supplied `user` callback, OUTSIDE the engine. Fixed in `9d11417`, with real-framework tests. | the 5 frontend + 7 backend adapters | 4–6d |
| 2.4 | ✅ **DONE** — **`launch()` must not pin the host process** — `unref` the ANR watchdog worker's MessagePort (it re-refs after `unref` today) | `packages/node` | 1–2d |
| 2.5 | ✅ **DONE** — **`unhandledRejection` must not convert host crashes into `exit 0`** — preserve Node's default behaviour, re-throw after capture | `packages/node` | 1–2d |

**Decision on 2.5: resolved as D2 and BUILT.** `unhandledRejections: 'preserve' | 'warn' | 'none'`, default
`'preserve'` — capture, print, and reproduce Node's own outcome (exit 1). Both process policies additionally
act ONLY when Bugsee is the sole handler for the event: if the host registered its own handler it has taken
responsibility for the outcome, and exiting its process because the SDK happens to be installed is the same
defect inverted. `uncaughtException` also re-prints the error to stderr, which installing a listener had
suppressed (node-A SEV1 #4) — the artifact operators reach for first.

**Verification.** A `lifecycle` e2e runs both claims against REAL node/bun/deno processes, because a
supervisor only ever sees two facts: whether the process exits at all, and with which code. Both are
teeth-checked — reverting the watchdog `unref` hangs the process for the full 15 s budget, and defaulting the
rejection mode back to a passive listener drops the exit code to 0 on all three runtimes.

**Correction (review round 1):** `stop()` never removed the rejection policy listener, so a stopped SDK still
suppressed Node's default disposition and a relaunch accumulated listeners; `exitOnUncaught:false` was ignored
on the rejection path; and the watchdog's DEFAULT scheduler re-installed the very pin 2.4 fixed. All fixed in
`38d6a17`. Two e2e gaps were also real: the tests never asserted the scenario ran, and could not distinguish
`preserve` from `none`. Note the `exit-clean` teeth-check only bites on node — bun and deno never re-ref the
MessagePort.

**The e2e took three attempts to become capable of failing**, which is worth recording: the scenario first
returned before the watchdog worker had spawned, and then the harness entry's own
`runScenario(...).then(() => process.exit(0))` ended the process regardless — so "does it exit on its own"
could never fail. `exit-clean` is now exempt from that explicit exit.

Fixing 2.1 + 2.3 closes, in one coordinated change: the React unmount, the Vue empty-DOM mount failure, the
Solid discarded fallback, the dead SvelteKit error page, the express/koa/hono 500s, the Nest `openSpan` 500,
`web-adapter`'s zero containment, `core`'s `runFilter`, the `browser` listener throw-paths, the `vercel-edge`
`waitUntil` `finally`, and the OTel `onEnd` escape.

---

**Wave 2.1 / 2.3 (frontend) as built.** `neverThrow` / `guarded` in `@bugsee/core`, re-exported from
`@bugsee/web-adapter` so an adapter contains its own pre-report work without taking a core dependency. It
guards BOTH failure modes a host boundary has: a synchronous throw, and a returned promise — because the
idiomatic fire-and-forget `void client.logException(...)` surfaces a rejection as an *unhandled rejection* in
the host process one tick later, which on Node is a crash again now that Wave 2.5 restored the default
disposition.

**Claim correction:** the first version of this section said "measured against real vue / @angular/core /
Hono". Those measurements were the reviewers', not this repo's — no committed test used a real framework, and
a real-Hono suite passed with the guard removed. Real-framework tests for express, koa, hono and vue landed
in `9d11417`.

Applied at the shared `reportError` (the root cause behind all four frontend SEV1s) and at each adapter's own
seam, since vue's component-name lookup, svelte's route read and angular's error unwrapping all run in the
same seam and outside the inner guard. Angular's `BugseeErrorHandler` now chains to Angular's default
behaviour: the documented `{ provide: ErrorHandler, useClass: BugseeErrorHandler }` wiring REPLACED whatever
handler the app had, so an app with no custom handler lost the only thing that surfaces uncaught errors in
the console (measured: 1 `console.error` before, 0 after).

The review noted that **no test in any of the four packages ever injected an SDK client that throws**, and
that the two mutations encoding that gap survived. Each adapter now has one, asserting the customer's handler
still runs. Solid's seam guard is documented as currently redundant (its report path has no pre-work), kept
because the Wave 2.1 rule is enforced by construction rather than re-derived per adapter.

**Also closed here: pre-existing coverage debt in `@bugsee/core`.** `partitioned-capture-store.ts` (Wave 0.1)
had been below the 100 % line/statement/function gate, which nothing had caught because core's own coverage
was never re-run after that wave. Now 100 % line/statement/function, with the two genuinely unreachable
loop guards annotated rather than fake-tested.

---

**Wave 2.3 (backend) as built.** Fixed at the shared engine rather than per adapter: `runServerRequest` in
`@bugsee/node` is what express and koa call with `next()` INSIDE the dispatch callback, so an SDK failure
before dispatch meant the route handler never ran and the SDK's own error became the request's outcome — a
customer-visible 500, with the app's error middleware handed a Bugsee-internal `Error` as if it were their
bug. Any SDK-side failure now degrades to running the request UNINSTRUMENTED.

The subtlety that matters is separating the two error sources. A `dispatched` flag distinguishes "the SDK
failed before the request ran" from "the application's handler threw": the first degrades, the second is
rethrown untouched. Without it the fallback would re-enter dispatch and run the customer's route handler a
SECOND time — a duplicated write, not merely a lost report. A mutation removing the flag initially survived,
because the obvious test (throwing client + throwing handler) fails before dispatch is ever entered and so
cannot tell the two apart; pinning it needs the healthy-engine path.

`@bugsee/hono` additionally guards its own pre-work, which the engine cannot reach: `options.user` is an
APPLICATION-supplied callback that needs no SDK bug to throw (`(c) => c.req.header('authorization').split(' ')[1]`
on any unauthenticated request), and Hono's `compose` laundered that into `app.onError` as a 500. Its
structural peers hapi and elysia already guarded these operations and returned 200 under the same probes.

---

## Wave 3 — Assurance (start 3a immediately, in parallel with Wave 0)

**This is why the other ~90 findings survived ~100% unit coverage.** Without it, every fix above can regress
silently.

| # | Fix | Notes | Est |
|---|---|---|---|
| 3a.1 | ✅ **DONE** — **Run the e2e suites in CI** — `.github/workflows/ci.yml` has a dedicated `e2e` job (node · bun · deno · real frameworks) with a runtime-matrix check so a missing runtime fails loudly instead of silently skipping. | Cheap and urgent. Done first, so the rest is gated. | 0.5–1d |
| 3b.1 | ✅ **DONE** (`18c7757`) — **Harnesses must install the way customers do** — a single umbrella entry, identical for node/bun/deno, so the only variable is which condition each runtime resolves. Found the defect immediately: **Bun 1.3.14 reported as `node` 24.3.0 and Deno 2.8.3 as `node` 24.15.0**, because the umbrella had 3 conditions and both runtimes set `node`. The label was the least of it — `Bun.serve({fetch})` and `Deno.serve()` bypass node:http entirely, so those customers had **no incoming-request instrumentation at all**. Also added a `native-server` scenario: the first coverage `Bun.serve`/`Deno.serve` have ever had. | This single gap is why the Bun/Deno bypass and the umbrella-condition defect were invisible. | 2–3d |
| 3b.2 | ✅ **DONE** (`f1ecde7`) — **Assert bundle CONTENTS, not arrival** — `logs.json`, `network.json` and `events.json` are now in `upload-contract.schema.json` and validated on every upload. Verified by re-injecting the original defect: reverting `logLevelToWire` is caught on all three runtimes, naming the field (`"instancePath": "/0/level"`). | Would have caught `logLevelToWire`. | 3–5d |
| 3b.3 | ✅ **DONE** (`f1ecde7`) — **Schema-validate the mock collector** — the mechanism already existed for the envelopes; 3b.2 extended it to the entry payloads, which is where the wire defects actually were. | A permissive mock is how wire defects survive e2e. | 2–3d |
| 3b.4 | ✅ **DONE** (`84bd879`) — **Concurrency scenarios** — a `concurrent-server` scenario (three overlapping requests, staggered holds, distinct identities) on every runtime. Found **two live defects**: (a) `collectHttpSpans` resolved the parent transaction at COMPLETION from a single slot, so on Node — where a transaction is per incoming request — request A's outgoing call shipped inside request B's trace, with A shipping zero children (fixed: bind the owner at the `before` stage); and (b) via the 3b.2 contract checks, **`client.log()` still shipped a STRING level** — Wave 5.1 fixed only the console-capture path, and the two core tests covering it asserted `level: 'info'`. | Would have caught the cross-request user bleed and the tenant leak. | 2–3d |
| 3b.5 | ✅ **DONE** (`59b9251`) — **Real-runtime coverage for the gaps**. workerd/miniflare was already in place from Wave 0.1 (`durable-object-tenants.e2e.ts` runs real workerd). The `next` half was the gap: **no `next` was installed anywhere**, so the adapter had never been compiled by the framework it adapts. `@bugsee/nextjs-e2e` runs a real `next build` and found that **the build FAILS** — twice over, at two independent layers (see 4.3). Wired into `pnpm test:e2e` and CI. | The review had to install these itself to find the worst bugs. | 4–6d |

---

## Cloudflare SEV1s (were absent from every wave table)

Two `@bugsee/cloudflare` SEV1s from `docs/review/cloudflare.md` appeared in **no** wave. Found while
revisiting 4.1; recorded here so they are not lost again.

| # | Fix | Where | Status |
|---|---|---|---|
| CF.1 | **`instrumentRpcMethods` deleted the customer's RPC surface** — the wrapper was assigned as an OWN property, and Cloudflare dispatches RPC via the PROTOTYPE, so every instrumented method threw "The RPC receiver does not implement the method". Not degraded telemetry — a broken Worker. | `packages/cloudflare` | ✅ **DONE** (`8460edd`), reproduced and verified on real workerd |
| CF.2 | **`globalThis.AsyncLocalStorage` is undefined on workerd under every flag** → per-request isolation permanently inert | `packages/cloudflare` | ✅ Already fixed in Wave 0.1 S0 (reads `node:async_hooks`; the miniflare harness documents the required `nodejs_compat` flag) |

---

## Wave 4 — Features that silently do nothing — ✅ **4.1–4.7 COMPLETE**; 4.8 is a decision

| # | Fix | Where | Est |
|---|---|---|---|
| 4.1 | ✅ **DONE** (`18c7757` + `9924998`) — **Umbrella `exports`: 3 conditions → 7**. `bun`/`deno` first (verified end-to-end on the real runtimes), then `workerd`/`edge-light`/`worker`, each resolving its own composition instead of falling through to the BROWSER entry. ORDER is the contract — every one of these runtimes sets several conditions and resolution takes the first match — and `umbrella-conditions.e2e.ts` pins it by asking a REAL resolver (esbuild `conditions`, read from the metafile) which entry it selected. | `packages/bugsee` | 2–3d |
| 4.2 | ✅ **DONE** (`ed63f6e`) — **Service Worker detection**. `isServiceWorker()` had been exported and unit-tested in `@bugsee/util` with zero callers, so a Service Worker ran as a plain web worker: memory-only, losing everything on each idle termination. `launch.ts` now derives `platformType` from it (still overridable). | `packages/webworker` | 2–4d |
| 4.3 | ✅ **DONE** (`59b9251`) — **Next.js edge build**. Confirmed on real Next 15.5 and fixed at BOTH layers. (a) `register()` read `NEXT_RUNTIME` through a helper, defeating Next's compile-time constant replacement — and webpack cannot fold across a function call, so the dependency was added at PARSE time. Now inline against the literal `process.env.NEXT_RUNTIME`. (b) Underneath it, **`@bugsee/util` (tier-0) pulled `node:crypto` into every edge graph** via `core/bugsee-api` — its comment reasoned about the LOAD being dynamic, which says nothing about bundling. Now ignore-marked for webpack/turbopack/vite. | `packages/nextjs` | 2–3d |
| 4.4 | ✅ **DONE** (`6c868c6`) — **Nuxt ships the Node SDK into Cloudflare Workers bundles**. The preset was read at MODULE-SETUP time; Nitro auto-detects it inside `createNitro()`, long after modules run. Measured on a real build with `CF_PAGES=1`: setup sees `undefined`, `nitro:init` sees `"cloudflare-pages"`. Corrected at `nitro:init` (a correction, not a replacement, so a Nuxt without the hook is left as it was). The existing edge e2e passed only because it SET `NITRO_PRESET` — the one path where the bug cannot appear; the new suite lets Nitro detect it. | `packages/nuxt` | 2–3d |
| 4.5 | ✅ **DONE** (`5164585`) — **Astro turned a 304/204 into a 500**. Measured, not assumed: the fetch spec forbids a body on a null-body status, so the middleware's `new Response('', { status: 304 })` is a `TypeError` — and a 304 legally echoes the cached entity's `Content-Type: text/html`, which is what steered it onto the body path. Null-body statuses (101/103/204/205/304) now pass through untouched. | `packages/astro` | 1–2d |
| 4.6 | ✅ **DONE** (`7df747c` + `d5d2514`) — **`<BugseeProfiler>` recorded zero spans in production React**. Documented first, then made to work: React's `<Profiler>` is inert in a production build, so the component now falls back to its own post-commit measurement there and uses React's accurate timings in development. Verified by rendering a subtree whose Profiler is genuinely neutralised, rather than by mocking our own code. | `packages/react` | 1–2d |
| 4.7 | ✅ **DONE** — **Electron renderer incidents never converge**. SEV1 #2 (renderer incidents forwarded to main instead of uploading a capture-less bundle under a foreign session id) and #3 (`render-process-gone` synthesising an incident in the owner session, with minidump claiming) were built as **R0–R5** (`86a3f7b`, `4bc3045`, `046300e`, `9aa1983`) and the plan row was simply never updated. The remaining piece — the renderer registry never shrinking, which hangs off the same lifecycle signal — is fixed in `f198962`. | `packages/electron` | 4–6d |
| 4.8 | **`@bugsee/integration-shims` is entirely dead code** — delete it, or wire it where the docs claim | repo-wide | 1d |

---

## Wave 5 — Wire correctness — ✅ **5.1–5.3 COMPLETE**; 5.4 blocked on the backend

| # | Fix | Where | Est | Status |
|---|---|---|---|---|
| 5.1 | `logLevelToWire` is never called — `logs.json` ships string levels where the viewer expects numerics | `packages/protocol` + emit path | 1–2d | ✅ `b75f1c3` |
| 5.2 | `NetworkStage` dropped Android's websocket/event encoding — outbound WS frames render as incoming | `packages/protocol` | 1–2d | ✅ `cffe5cb` |
| 5.3 | OTel root span ids fabricated as `traceId.slice(0,16)` — every service in one trace emits an identical root span id | `packages/opentelemetry` | 2–3d | ✅ `80366b2` |
| 5.4 | `environment.sdk.type` has no path in the appserver schema the worker's JS-crash routing reads | `packages/core` + appserver | — | ✅ **DONE** — both halves. (a) `crash.json` now carries `source_sdk`/`source_platform` (`b41b4bd`); (b) the appserver declares `sdk.type` (`566b06d3`). Proven against the worker's own `_crash_source_sdk`: routing now succeeds in all three scenarios, including the two (a) alone can reach. See D3. |

Notes on the three that landed:

- **5.1** was fixed at BOTH emit paths, not just the reported one: `client.log` encodes the wire level
  *after* the user's filter runs (so a filter still sees the friendly name), and `log-provider` does the
  same for captured console output. The e2e assertion that should have caught this had itself encoded the
  defect — it asserted `level: 'info'`.
- **5.2** was not only a stage-encoding gap: `send` vs `message` is what distinguishes an outbound frame
  from an inbound one, so every frame the app SENT rendered in the viewer as one it received.
- **5.3** turned out not to need a new id at all. The transaction's real span id existed the whole time —
  minted by `env.newSpanId()`, used as every child's `parentSpanId`, and propagated in `traceparent`;
  `toTransactionWire()` simply dropped it. `deriveRootSpanId` survives as a legacy-wire fallback only.
  The bug was worse than a collision: a downstream root's `parentSpanId` pointed at a span **no service
  ever emitted**, so the trace broke at every boundary.

---

## Wave 6 — Durability, lifecycle, resource bounds — ✅ **COMPLETE** (2026-08-06)

All eight fixed test-first, each with its mutator loop and each committed against green
lint / typecheck / cycles / per-package coverage / `pnpm test` / `pnpm test:e2e`.

| # | Fix | Where | Est | Status |
|---|---|---|---|---|
| 6.1 | Flush-on-exit never fires on SIGTERM/SIGINT/SIGHUP (bound to `'exit'`) | `packages/node`, `node-utils` | 2–3d | ✅ `119637b` |
| 6.2 | No page-lifecycle flush in the browser at all (no `pagehide`, no keepalive/sendBeacon) — a backgrounded-then-killed mobile tab loses everything | `packages/browser` | 3–4d | ✅ `b52d869` |
| 6.3 | `ENOSPC` → unbounded memory growth instead of back-pressure; IDB write queue has zero back-pressure (~200MB retained) | `node-utils`, `browser-utils` | 3–5d | ✅ `19d7ed9` |
| 6.4 | Durable bundle queue has no retention bound — permanent poison retry + persisted overflow drops | `packages/core` | 2–3d | ✅ `1c71cc7` |
| 6.5 | Torn-record intolerance in the IDB port — one bad record permanently kills a generation | `browser-utils` | 2–3d | ✅ `9d41a26` |
| 6.6 | A live-but-stalled instance has its capture subtree deleted by a sibling coordinator (proven via SIGSTOP) | `packages/node` | 3–4d | ✅ `0ff2235` |
| 6.7 | Phase-2 SAB ring corrupts HEAD on an empty ring (~1.9 GiB overshoot) — opt-in path | `node-utils` | 2–3d | ✅ `6f8ab33` |
| 6.8 | Elysia never finishes 404 transactions (context leak) | `packages/elysia` | 1d | ✅ `ab1d41a` |

### Measurements taken during the wave

Each fix was verified against the behaviour, not only the tests:

| # | Before | After |
|---|---|---|
| 6.1 | `kill -TERM` → exit 143, `'exit'` handler never ran, marker **lost** | exit 143 unchanged, marker **on disk** |
| 6.3 | 20,000 writes / 191 MB held by a stalled IndexedDB; 19,998 doomed syscalls + 19,998 `onError` on a full disk | 835 writes / 8 MB (the byte bound); syscalls and reports both bounded and coalesced |
| 6.6 | real SIGSTOP: alive `true`, subtree on disk **`false`**, writes failing after resume **`true`** | alive `true`, subtree **`true`**, writes failing **`false`** |
| 6.7 | empty 64 KiB ring: `dropped` 0 → **3299**, **2446** phantom frames drained from stale bytes | `dropped` 0, exactly **1** frame |

### Decisions taken (and why)

- **6.4 retention policy is Android's, read from Android's code** — `CommunicationErrorClassifier.java:14-33`
  treats every non-401/408/425/429 4xx as PERMANENT and `ReportUploadExecutor.java:182-199` deletes on that
  outcome. The count/byte/TTL caps follow the idiom of Android's *sibling* queues
  (`NotificationRelayStorage.java:47-49`, `PerformanceUploadStorage.java:35`), since its report queue has no
  such bound either.
- **6.6 keeps an alive-pid MAIN-thread sibling forever**, and the age-based sweep became the sole reclaimer
  for a recycled pid. A stale heartbeat *file* — not age alone — is what distinguishes an abandoned subtree
  from a live instance whose heartbeat is failing.
- **6.7's `TAIL` store in the reposition is an equivalent mutant** (byte-identical over a 38-point sweep). It
  is kept for the `HEAD <= TAIL` invariant and documented, rather than pinned by an invented assertion.

### Test defects found and fixed along the way

Four tests asserted the defect they existed to prevent, all the same shape — a fixture the runtime never
produces:

- **elysia** called `mapResponse` by hand, the one hook Elysia skips for a 404.
- **elysia** (review #7's surviving mutant) handed the route to `onRequest`; real Elysia populates
  `c.route` only at `mapResponse`, so the span name was already correct and deleting `setRoute` changed
  nothing. It survived my *first* replacement test too.
- **node recovery** named a subtree `9-9-…` (pid 9, thread 9) while its `owner.json` said `threadId: 0`, so
  it asserted the worker-thread case while describing the main-thread one — the SIGSTOP data-loss bug.
- **node watchdog** (already noted at 2.4) asserted `unref()` was *called* on a fake, never that the process
  could still exit.

Two of my own first cuts were caught only by the mutator loop: the IDB circuit breaker checked at enqueue
time, where a synchronous burst is fully queued before any write can fail; and two assertions were loose
enough to pass against the very mutation they existed to catch.

### Known open

**IDENTIFIED** (2026-08-06). The intermittent e2e failure is:

    instrumentation.e2e.ts > 'node' > main scenario
      > the AppHang bundle carries a CPU profile whose samples include the blocking frame
    AssertionError: the blocking frame e2eHangSpin is not in the AppHang profile

3 of ~13 **full parallel** `pnpm test:e2e` runs; never once in isolation. What is established:

- **10/10 present** running that package alone, including under synthetic CPU saturation (10 busy cores).
- **Starvation is ruled out**: measured, the spin keeps its CPU under contention — 394 ms of CPU in a
  400 ms wall-clock spin, with only the iteration count dropping (16.8M → 0.9M).
- Rolling-window rotation is ruled out: the window is `maxRecordingTime` = 60 s, far longer than the spin.
- Remaining hypothesis, unverified: a profiler blind spot. `client.logException()` immediately before the
  spin triggers report assembly, which calls `profiler.collect()` — a stop+restart of the V8 session. If
  that overlaps the spin, no samples of `e2eHangSpin` are taken at all.

No fix was shipped, because the condition could not be reproduced and an unverifiable fix is worse than a
known flake. Instead the assertion now **reports the profile window, sample count and busiest frames on
failure**, so one more occurrence settles it.

---

## Wave V — Verification substrate: a sample/test app per package

**Decision D5.** Every consumer-facing package gets a sample app that installs it **the way a customer does**
and exercises every documented capability, asserting against the mock collector's received bundle.

This is the structural fix for the assurance gap. The review's misses trace to harnesses that imported
platform packages **directly** instead of through the umbrella; a sample app that installs
`@bugsee/bugsee` the way the README tells users to would have caught the Bun/Deno bypass, the 3-vs-7 export
conditions, and the `platform.type` mis-report on day one.

**Scope — ~30 apps, not 53.** Tier-0 and shared packages (`types`, `util`, `logger`, `protocol`, `service`,
`core`, `capture`, `browser-utils`, `node-utils`, `web-adapter`, `adapter-kit`) have no meaningful standalone
"app"; they are exercised *through* the consumer-facing ones. Apps are needed for:

| Group | Apps |
|---|---|
| Platforms | node, browser, bun, deno, electron (main+renderer+native), webworker (Web + Service Worker), cloudflare, vercel-edge, webview |
| Umbrella | `@bugsee/bugsee` — install-path matrix: ESM, CJS, and each runtime condition |
| Frontend adapters | react, vue, angular, svelte, solid |
| Backend adapters | express, fastify, nestjs, hono, koa, hapi, elysia |
| Meta-frameworks | nextjs, nuxt, remix, sveltekit, astro |
| Build tooling | vite-plugin, webpack-plugin, both component-annotate plugins |

**Each app must:**
1. Install via the **public entry point** (umbrella where documented), never a workspace-internal deep import.
2. Boot on the **real runtime** — real Bun, real Deno, real workerd/miniflare, real Electron, real framework.
3. Exercise **every documented capability** of that package, including the failure paths (SDK throws, collector
   unreachable, quota exhausted, permission denied).
4. Assert on **bundle CONTENTS** received by the mock collector — manifest, entry payloads, wire field
   names/types, redaction actually applied — not merely that a bundle arrived.
5. Include a **host-integrity assertion**: the host app still works, still exits, still renders, still returns
   the user's real error. This is the check that would have caught most of Wave 2.
6. Run in **CI**.

**Sequencing — do NOT build all 30 before fixing anything.** That would delay the Wave 0 security fixes by
months. Instead:

- **V0 — ✅ DONE (`abc0b9c`).** The shared substrate is `@bugsee/e2e-kit`: the schema-validating mock
  collector + the bundle-assertion library, imported by every harness.

  It had accreted the wrong way round. The collector and assertions existed in ONE harness while the other
  four carried diverged copies (81 differing lines) with **no schema validation and no bundle assertions at
  all** — so the entry-payload contract from Wave 3b.2 covered one suite in five, and the meta-framework
  harnesses asserted only that a bundle *arrived*. Sharing it closed a real blind spot immediately:
  injecting the original `logLevelToWire` defect is now caught by the **nuxt** suite
  (`"instancePath": "/0/level"`), where it was previously invisible.

  Each suite also gained a non-vacuity check — an assertion over an empty set is the same false assurance
  as no assertion.

  **Still outstanding for Wave V:** the ~30 sample apps themselves. The app SCAFFOLD half of V0 is served
  today by `instrumentation-tests/app` + `runtimes.ts` (node/bun/deno, platform-direct AND umbrella entries)
  and the four real-framework harnesses; a generalised per-package scaffold has not been built.
- **Then: each wave's fixes ship with their app.** The app is the fix's acceptance test. This front-loads apps
  for the packages where defects were actually found.
- **Backfill** the remaining apps in Wave 7.

**Effort: ~30 apps × 1–3d = 6–18 engineer-weeks**, comparable to the entire fix plan. It is also the item with
the longest payoff: these apps double as the examples/documentation the SDK does not currently have, and they
are what stops this review's findings from recurring.

**Note on re-verification:** the SEV rankings are the reviewing agents' own. The Wave 0–2 items were proven
empirically against real runtimes (miniflare/workerd, real bun/deno, real react-dom, real Nest, real
Astro/Nuxt) and can be trusted. Everything else should be reproduced by its sample app **before** engineering
time is committed — several findings in the long tail were reasoned from code rather than executed, and at
least one (the `sdk.type` Mongoose strip) says so explicitly.

---

## Wave 7 — Hygiene

Everything else: the ~190 SEV3s.

| # | Fix | Where | Status |
|---|---|---|---|
| 7.1 | **`bundler-plugin-core` could delete a developer's files** — a relative `output.file` resolves the out dir to `'.'`, and the `.map` cleanup then walked the PROJECT ROOT with no exclusions and no depth limit, unlinking maps under `node_modules/` and authored maps under `src/`. On by default. | `bundler-plugin-core` | ✅ **DONE** (`42b5406`) |
| 7.2 | **`dryRun` aborted the build** — `--dry-run` went to both commands, but inject-dry writes nothing, so the upload then exits 11 ("no debug_id"). Measured on the real bugsee-cli v0.7.2. The safe diagnostic broke every freshly-built output dir. | `bundler-plugin-core` | ✅ **DONE** (`42b5406`) |
| 7.3 | **Any CLI failure broke the build, with no opt-out** — an expired token or a Bugsee outage aborted a production deploy. Now contained + reported by default, with `failOnError` to opt in; maps deleted only after a CONFIRMED upload. | `bundler-plugin-core` | ✅ **DONE** (`42b5406`) |
| 7.4 | **No timeout on the spawned `bugsee-cli`** — a hung child hung the build until CI's global timeout. Now a 120 s budget + an AbortSignal so the child is killed, not abandoned. Also made the spawn OPTIONS a pure, assertable function: they were inside a `v8 ignore`'d adapter, which is how the review's `shell: true` mutation survived. | `bundler-plugin-core` | ✅ **DONE** (`98118f0`) |
| 7.5 | **No re-entrancy guard** — outputs resolving to one dir ran two pipelines over one tree, one deleting maps while the other read them. A concurrent caller now joins the in-flight run; the slot frees on `finally` so watch mode keeps working. | `bundler-plugin-core` | ✅ **DONE** (`98118f0`) |
| 7.6 | **Vite's `build.sourcemap` defaults to `false`** and nothing enabled it, so the documented setup produced a map-free `dist` and then failed the build (bugsee-cli exit 10). Verified on real Vite 8.0.14: before → build FAILED, `dist = [main.js]`; after → build OK, `dist = [main.js, main.js.map]`. `'hidden'`/`'inline'` are left alone; a disabled plugin alters nothing. | `bundler-plugin-core` | ✅ **DONE** (`e6b3980`) |
| 7.7 | **`babel-plugin-component-annotate`: a peer's nested `transformSync` wiped the shared stack**, dropping every remaining annotation in the outer file. Stack moved onto babel's per-transform `PluginPass`. Also closed the test theater the review measured — 5/5 targeted mutations survived because the "nested components" fixture contained SIBLINGS, so the stack never exceeded depth 1 and innermost/outermost were indistinguishable. Genuine nesting + `.tsx` now covered. | `babel-plugin-component-annotate` | ✅ **DONE** (`994dcfe`) |
| 7.8 | **Mutual-mocking blind spot** — discarding every caller masking option in `registerReplay` was undetectable across browser (208), replay-canvas (12) and the RP6 e2e, because `browser` mocks `@bugsee/replay` and `replay` mocks `record`. A cross-seam test now runs registerReplay → provider → REAL rrweb → bytes; the review's mutation fails 2 tests. | `packages/replay` | ✅ **DONE** (`5f9d4fe`) |
| 7.9 | **Dead exports in `@bugsee/util`** — measured: **13 of 25** have no non-test consumer. **Closed as NOT-A-DEFECT, on evidence.** Tree-shaking makes them free: importing one symbol bundles to **216 bytes with none of the unused probes present**, versus 16 267 for `import *`. No duplicate implementations exist anywhere (checked for hand-rolled deep-merge and base64). Nine of the thirteen are the runtime-probe set, which is documented, tested, and coherent — `isServiceWorker` IS used, and Wave 4.2 was literally "it exists and is simply not used", i.e. the answer there was to USE one, not delete its siblings. Deleting working, tested, zero-cost code to satisfy a count would be the wrong trade. | `@bugsee/util` | ✅ **CLOSED** (no change) |

---

## Status verification (2026-08-05)

Three items in the tables above were marked open while already being **built and tested**: `0.1`,
`0.2` and `3a.1`. They are corrected in place. The lesson is worth keeping rather than just the
correction — this plan is the shared source of truth, and a stale "open" costs whoever picks it up a
full investigation before they can start. Each status above was re-verified by running the code or
reading the committed test, not by trusting a label.

**Wave 2 is complete.** 2.1's four named targets are resolved and 2.2 is applied to all 13 adapter
packages. The enforcement found **24 real containment defects across 15 packages**, all one shape:
the inner call was guarded and the SEAM was not. Frontend adapters guarded the callee and missed the
public export; backend adapters guarded the request path and missed BOOTSTRAP (every `setup*` could
stop the app starting); OTel and vercel-edge guarded neither of their two host inputs.

**Still genuinely open:** `0.3` (gated on the Android receiver, D1), `1.5` (gated on the rrweb fork),
Wave 3b, Waves 4–7, and Wave V.

### Re-verified 2026-08-06 — and the same staleness had recurred

Waves 3b, 4, 6 and 7 are now complete, and 5.1–5.3 with them. Six rows were **already fixed, tested and
committed while still reading as open**: `4.2` (`ed63f6e`), `4.5` (`5164585`), `4.6` (`d5d2514`),
`5.1` (`b75f1c3`), `5.2` (`cffe5cb`), `5.3` (`80366b2`). Each was re-verified the way the note above
prescribes — by reading the committed code and its test, not by trusting a label — and the rows are
corrected in place.

That this happened a second time, after being called out the first, says the failure is structural rather
than an oversight: the fix commit and the plan row are two separate edits, and only one of them is enforced
by anything. **Update the row in the fix's own commit.**

**The complete open set — nothing else in this plan is outstanding:**

| Item | Why it is open | Who unblocks it |
|---|---|---|
| `0.3` WebView bridge auth | Gated on the Android receiver (D1) | Android team |
| `1.5` Canvas privacy | Gated on the rrweb fork's `unblockSelector` | after D1 |
| `4.8` `integration-shims` | **Needs a human decision**: delete it, or build the §372 integration-object API it presupposes | product/architecture |
| ~~`5.4` `environment.sdk.type`~~ | ✅ **CLOSED 2026-08-06** — both halves done and verified against the worker's own routing function (see D3) | — |
| Wave V | ~30 sample apps; V0 substrate done, the generalised scaffold is not | ~6–18 eng-weeks |
| ~190 SEV3s | Long tail; never individually enumerated | — |
| AppHang e2e flake | Identified, not reproduced; see *Known open* above | one more occurrence settles it |

Two of the seven are gated on other repos or teams, and one is a decision. `5.4` was re-checked on
2026-08-06 and is **no longer** among the blocked — see D3.

---

## Sequencing summary

```
now ──► 3a.1 (turn e2e on in CI)           ── 0.5–1d, gates everything after
   │
   ├──► V0  (app scaffold + assertion lib) ── 1–2 wks  ← every later fix needs it
   │
   ├──► Wave 0  (3 security bugs)          ── ~1.5 wks  } parallelisable
   │      └─ 0.3 gated on Android receiver (D1)         } across people
   ├──► Wave 1  (privacy)                  ── ~3 wks    }
   │      └─ 1.5 gated on rrweb fork, AFTER Android     }
   ├──► Wave 3b (harness depth)            ── ~3 wks    }
   └──► D3 sdk.type (appserver → worker)   ── ~1 wk, cross-repo
        │
        ▼
     Wave 2  (host-boundary guard + D2)    ── ~3 wks   ← highest leverage
        │
        ▼
     Wave 4  (silent no-ops) ─► Wave 5 (wire) ─► Wave 6 (durability) ─► Wave 7
        │
        └─ each wave's fixes ship WITH their sample app (Wave V)
```

**Totals.** Waves 0–6: **~14–20 engineer-weeks**. Wave V (sample apps): **~6–18 engineer-weeks**, but mostly
absorbed into the waves rather than added on top, since each fix ships with its app. Realistic combined range:
**~22–32 engineer-weeks**, with the spread driven by how many sample apps get backfilled versus deferred.

Waves 0/1/3b and the D3 cross-repo change parallelise well. Wave 2 is best done by one person for consistency,
since it is one mechanism applied everywhere. D1 puts the Android receiver on the critical path for `0.3`, so
start that conversation immediately even though the JS work sits later.

## Decisions — RESOLVED (2026-07-27)

### D1. Cross-repo sequencing: **Android first, then rrweb**

`0.3` (WebView bridge auth) lands with the Android receiver first; `1.5` (canvas unblocking, needs the rrweb
fork's `unblockSelector`) follows. Practical consequence: **start the Android-side protocol change now**, since
it gates the JS-side bridge hardening, and treat the rrweb fork change as a second, independent cross-repo
task. Neither blocks Waves 1–4 otherwise.

### D2. `unhandledRejection` — **keep it on by default, but preserve the process outcome**

Researched against competitors rather than assumed, and verified empirically.

**What the market does:**

| SDK | Installs by default? | Effect on process outcome |
|---|---|---|
| **Sentry** (`node/src/integrations/onunhandledrejection.ts`) | Yes | Modes `'none' \| 'warn' \| 'strict'`, **default `'warn'`** — logs to console, **does not exit**. Only `'strict'` calls `logAndExitProcess`. |
| **Sentry** (`onuncaughtexception.ts`) | Yes | Deliberately conservative: counts existing `uncaughtException` listeners and applies fatal handling only if `exitEvenIfOtherHandlersAreRegistered \|\| processWouldExit` — i.e. **it exits only when Node would have exited anyway.** |
| **Bugsnag** | Yes (`autoDetectErrors`, `enabledErrorTypes`) | Uncaught exceptions: report, then exit non-zero — explicitly "mimics what Node.js does by default". Unhandled rejections: report, print, **process stays alive**. `onUncaughtException` hook to customise. |

**The Node semantic that decides it** — verified on Node v24.15.0:

| Case | Exit code |
|---|---|
| No listener (Node default) | **1** (crash) |
| A passive listener registered — *what the SDK does today* | **0** (crash silently becomes success) |
| Listener that re-raises | **1** (default preserved) |

So *merely registering* a listener suppresses Node's default crash. Sentry's default `'warn'` has the same
side effect — but does it **deliberately, visibly (console output), and with a `strict` mode to opt out.**
Bugsee's version is worse on both counts: it is **silent** (the rejection vanishes entirely) and has **no
opt-out**.

**Decision:** installing by default is the market norm — keep it. But Bugsee's own binding rule
("never alter host application behavior") is stricter than Sentry's default, so our default must preserve the
outcome:

- Add `unhandledRejections: 'preserve' | 'warn' | 'none'`, **default `'preserve'`** — capture, then re-raise so
  Node's default crash semantics stay intact (exit 1).
- `'warn'` reproduces Sentry's default for teams that want it; `'none'` disables.
- For `uncaughtException`, adopt **Sentry's listener-count check**: exit only when Node would have exited
  anyway; never exit merely because the SDK is installed.

This is a superset of both competitors' capability and the only option consistent with our stated rule.

Sources: [Sentry `onunhandledrejection.ts`](https://github.com/getsentry/sentry-javascript/blob/develop/packages/node/src/integrations/onunhandledrejection.ts) · [Sentry `onuncaughtexception.ts`](https://github.com/getsentry/sentry-javascript/blob/develop/packages/node/src/integrations/onuncaughtexception.ts) · [BugSnag JS configuration options](https://docs.bugsnag.com/platforms/javascript/configuration-options/) · [bugsnag-node #154 (forced `process.exit`)](https://github.com/bugsnag/bugsnag-node/issues/154)

### D3. `environment.sdk.type` — **synchronise across repos**

Precisely located by the protocol review; the emitter is correct and the fix is in the backend.

| Repo | Change | Detail |
|---|---|---|
| **javascript** | none | All four platforms already emit it correctly (`node/src/environment.ts:91`, `browser/:96`, `vercel-edge/:51`, `webworker/:84`). |
| **appserver** | **the fix** | `EnvironmentSchema.sdk` declares only `build`/`version`/`options` — no `type` path — at `code/components/shared/dao/models/_environment.js:145-151`. Mongoose document `strict` is at its default `true` (only `strictQuery` is relaxed, `dao/index.js:7`), so `sdk.type` is **stripped at persist**. Add the path the same way `platform.type` already does it (`:50-52`). |
| **worker** | none, but re-test | `jobs/bundle.py:210` reads `(environment.get('sdk') or {}).get('type') == 'javascript'` from the **persisted recording** (`:477`), selecting `javascript.process_crash_report` over `managed.` (`:222`/`:224`). With the field stripped, **every JS crash falls through to the managed processor.** |

**Verify before fixing** — the reviewer stated plainly that they read the schema but did **not** execute
Mongoose to observe the strip. Reproduce it first, then fix.

Flow (per repo conventions): appserver goes through Gerrit review (`refs/for/master`); worker is
direct-to-master. Land appserver first, then re-run a real JS crash end-to-end through the worker.

#### REVALIDATED 2026-08-06 — still open, but the cheapest fix is now **in this repo**

**The strip is confirmed by execution, not by reading.** Ran the appserver's real `EnvironmentSchema`
through its own Mongoose 6.12.0, no DB needed (`strict` applies at document construction):

| emitted | persisted |
|---|---|
| `sdk.type: 'javascript'` | **`undefined`** ← stripped |
| `sdk.version: '1.0.0'` | `'1.0.0'` |
| `platform.type: 'node'` | `'node'` (declared via the keyword escape hatch) |
| `wrapper.type: 'electron'` | `'electron'` (same escape hatch) |

→ `is_javascript = false`. The reviewer's inference was right, and the caveat is now discharged.

**What changed since the review: the worker no longer treats `sdk.type` as authoritative.**
`jobs/bundle.py:143` `_crash_source_sdk()` now prefers **`crash.json`'s own `source_sdk`**, keeping
`environment.sdk.type` only as a fallback "for SDKs that do not emit `source_sdk` yet". The reason given is
exactly the failure mode that matters here — the two fields do not travel together: on the resymbolicate
path `crash.json` comes from S3 while `environment` comes from a separate `api.get_recording`, so an absent
or partial environment leaves the crash unroutable.

**The Rust SDK already emits it** (`bugsee-core/src/model/crash.rs:141`, set at all five crash-construction
sites, with a conformance test asserting every crash.json variant identifies its source). **The JS SDK emits
it nowhere** — `source_sdk` has zero occurrences in this repo, and `CrashJson` (`core/src/crash.ts:28`) has
no such field. So JS is the one SDK still riding the stripped fallback.

**Two independent gaps; EITHER one alone restores routing:**

| # | Gap | Repo | Status |
|---|---|---|---|
| a | `crash.json` carries no `source_sdk` | **javascript** | ✅ **DONE** (`b41b4bd`) — stamped in the bundle assembler, the one place holding both the crash and the environment |
| b | `sdk.type` stripped at persist | appserver | ✅ **DONE** (`566b06d3`, awaiting Gerrit) — `type: { type: String }`, the same keyword escape hatch `platform.type`/`wrapper.type` use. 5 tests, full suite 1508 passing |

**On (b)'s mutator loop, because one result is reusable.** Removing the declaration fails 4 tests; the bare
`type: String` form fails 6 (it casts the whole subdocument to a String and takes `version`/`build` with it);
`type: Number` fails 4. Injecting `strict: false` changed **nothing** — measured, it does not reach nested
paths — so the declaration is genuinely load-bearing and "just loosen strict" was never an alternative fix.
The one mutation all four behavioural tests survive is declaring `sdk` as `Mixed`, which is the plausible
lazy fix and admits every typo'd field forever; that is what the fifth test exists to catch, and it does.

**Documented in `report-bundle-structure`** (`8678ee3`): the `sdk` sub-object never listed `type`, even
though `crash.md` already told consumers to fall back to it. Writing the per-SDK values down surfaced that
**iOS emits `IOS` in upper case** while every other producer is lower case, so `sdk.type == "ios"` silently
never matches — invisible so far only because iOS routes on `platform.type` instead.

**Do (a) first.** It is entirely in this repo, needs no Gerrit round-trip, matches what Rust already ships,
and is strictly more robust — it survives the resym path where the environment is absent, which (b) cannot.
Do (b) as well, because the fallback should be correct for any SDK that never adopts `source_sdk`, but it is
no longer the blocking dependency this row was filed as.

#### CLOSED 2026-08-06 — both halves, verified against the worker's own routing function

`_crash_source_sdk` was lifted verbatim out of `worker/jobs/bundle.py` and executed against the documents
the SDK emits before and after. The middle row is what (b) fixes; the bottom row is the one **only (a)**
can reach, and it is the reason both were worth doing:

| scenario | before | after |
|---|---|---|
| environment intact | `javascript` | `javascript` |
| `sdk.type` stripped at persist | `None` → managed processor | `javascript` |
| resym path, no environment at all | `None` → managed processor | `javascript` |

Scope check on (b): the only other reader of `sdk.type` is `appserver/code/utils.js:1128` (per-runtime SDK
version floor), which reads **pre-persist** and is therefore unaffected. The viewer does not read it.

### D4. `BugseeProfiler` and `integration-shims` — **FIX, do not delete**

- `4.6` — make `<BugseeProfiler>` actually produce spans in production React builds (today: zero).
- `4.8` — wire `@bugsee/integration-shims` where the docs claim it is wired, rather than deleting it. Note the
  review found the crash it exists to prevent is **already** prevented by self-noop in the real
  implementations, so "fix" here means: establish what job it uniquely does, make it do that job, and make a
  test prove it — otherwise this decision should be revisited.

  > **INVESTIGATED 2026-08-05 — this decision needs revisiting, and the finding is not "someone forgot to
  > wire it".** The shims' stated job is that "user code that references e.g. `viewHierarchyProvider` still
  > type-checks" and gets a friendly warn-once instead of an opaque crash (§372). That premise does not
  > hold: **`viewHierarchyProvider`, `breadcrumbsProvider` and `xhrInterceptor` are exported by NO platform
  > package — not even the browser.** The names exist only inside `integration-shims` itself, so there is
  > nothing on any runtime for user code to reference, and wiring the shims would mean publishing an API
  > that is a no-op *everywhere*, advertising a capability that does not exist.
  >
  > The reason is architectural, not an oversight. All three capabilities shipped as OPTION-DRIVEN and are
  > wired internally by `launch()`: breadcrumbs via `createUserEventsProvider(createBrowserInputSource(…))`,
  > XHR via `createXhrInterceptor` inside `installNetworkCapture` (which already self-skips when XHR is
  > absent), and the DOM snapshot via `@bugsee/replay`. The §372 model — the user constructs an integration
  > object and passes it in — was never built. The shim file already applies exactly this reasoning to
  > `replay` ("option-driven, not a user-constructed integration … not via a no-op export"); by its own
  > principle, none of the three should be a shim either.
  >
  > **Done now (safe either way):** `@bugsee/browser`, `@bugsee/node` and `@bugsee/vercel-edge` declared
  > `@bugsee/integration-shims` as a runtime DEPENDENCY while importing it in zero files — dead weight
  > shipped to every customer. Removed.
  >
  > **Open decision (needs a human):** delete the package, or build the §372 integration-object API it
  > presupposes. Deleting is the smaller change and matches where the architecture actually went; building
  > the API is a design commitment well beyond Wave 4. Not actioned unilaterally — D4 currently says do not
  > delete, and a package removal is outward-facing.

### D5. Verification — **required, via a sample/test app per package**

Accepted as a first-class workstream: **Wave V** below. Every fix must be verified by an app that exercises the
package the way a customer does, not only by unit tests.
