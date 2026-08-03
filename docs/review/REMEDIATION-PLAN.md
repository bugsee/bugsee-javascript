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
| 0.1 | **Cross-tenant capture-ring sharing in Durable Objects** — give each DO instance its own store; never share module-scope capture state | `packages/cloudflare` | One tenant's uploaded bundle contained other tenants' secrets. This is a data-protection incident class, not a bug class. | 2–3d |
| 0.2 | **Renderer-controlled `type` reaches `path.join` in main** — validate/allowlist every renderer-supplied wire field before it touches the filesystem | `packages/electron` | Arbitrary-path, arbitrary-content file write from any renderer; XSS in loaded content escalates to disk write. | 2–3d |
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
| 1.4 | 🟡 **replay DONE**, `replay-canvas`/`webview` remain — **Fail-closed on every privacy path** — a malformed selector, a throwing masking config, or a failed rect computation must obscure MORE, never less | `packages/replay`, `packages/replay-canvas`, `packages/webview` | Today: one typo in `blockSelector` silently disables ALL blocking page-wide; WebView obscuring is fail-open three ways. | 3–5d |
| 1.5 | **Canvas privacy** — make `.bugsee-show` actually work on the canvas path, and make `.bugsee-ignore`/`.bugsee-mask` protect canvas pixels | `packages/replay-canvas` (+ rrweb fork: `unblockSelector` is never passed) | Requires a change in the rrweb fork — cross-repo, so start the fork work early. | 3–5d |

**Wave 1.1 / 1.2 as built.** One portable redactor in `@bugsee/protocol` (`sanitizeUrl`, `sanitizeErrorMessage`,
plus non-JSON body key redaction in `sanitizeBody`), ported from Android's `NetworkDataSanitizer` rather than
invented, with two deliberate supersets over it: **URL userinfo** (`node:http` supports `user:pass@`; browsers
strip it, so Android never needed it) and **fragment params** (OAuth implicit flow returns `#access_token=`).
Wired at every place a URL reaches the wire: the network capture choke point (covers fetch/xhr/ws/sse/
webtransport *and* `node:http`, which folds in via `additionalSources`), `@bugsee/node`'s `server-instrument`
(covers express/fastify/koa/hapi/elysia in one change), plus `nestjs`, `astro`, `vercel-edge` and the
`http.client` span description in `@bugsee/performance`.

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

**Verification.** `masking.integration.test.ts` drives the REAL rrweb over a REAL DOM and asserts the bytes it
emits. This is the gap the review named explicitly: its "Masking fail-closed audit" table has ✗ in the
*"test asserts the real rrweb config?"* column on **every** row, which is why three fail-open defects survived
a suite at 100 % coverage. Every guarantee in that table is now asserted against rrweb's actual output.

**Known residual (measured, not assumed).** URL attributes never reach `maskAttributeFn` — instrumenting it
over a page carrying `href`/`src` shows only `data-x` arriving, because rrweb resolves and absolutizes URL
attributes on its own path. PII inside a URL therefore **cannot** be scrubbed from this seam; closing it needs
a change in the rrweb fork. A test pins the current behaviour so that a fork change surfaces here.

---

## Wave 2 — Stop breaking customer applications

This is the single highest-leverage item in the plan. The SDK's own binding rule is *"never alter host
application behavior"*, and it is violated in nearly every tier by the same shape of defect: **SDK code runs
inside host code with no guard**.

| # | Fix | Where | Est |
|---|---|---|---|
| 2.1 | **One shared `neverThrow` boundary helper** in core, plus a rule that EVERY host-facing entry point is wrapped: framework error seams, middleware/hooks, interceptors, event listeners, public API methods, and `waitUntil`/`finally` paths | `packages/core` + applied across ~15 packages | 5–8d |
| 2.2 | **Enforce it** — a lint rule or an exported-surface test asserting every host-facing export is wrapped, so this cannot regress | `packages/core` + tooling | 2–3d |
| 2.3 | **Chain, never clobber, the host's error handler** — Angular `ErrorHandler`, Vue `app.config.errorHandler`, Hono `onError`, Fastify `setErrorHandler`, Nest `ExceptionFilter`, Express error middleware (`next(err)`) | the 5 frontend + 7 backend adapters | 4–6d |
| 2.4 | **`launch()` must not pin the host process** — `unref` the ANR watchdog worker's MessagePort (it re-refs after `unref` today) | `packages/node` | 1–2d |
| 2.5 | **`unhandledRejection` must not convert host crashes into `exit 0`** — preserve Node's default behaviour, re-throw after capture | `packages/node` | 1–2d |

**Decision needed on 2.5:** should the SDK install a global `unhandledRejection` listener at all by default?
Recommendation: capture without altering the process outcome, and make any behaviour change explicitly opt-in.

Fixing 2.1 + 2.3 closes, in one coordinated change: the React unmount, the Vue empty-DOM mount failure, the
Solid discarded fallback, the dead SvelteKit error page, the express/koa/hono 500s, the Nest `openSpan` 500,
`web-adapter`'s zero containment, `core`'s `runFilter`, the `browser` listener throw-paths, the `vercel-edge`
`waitUntil` `finally`, and the OTel `onEnd` escape.

---

## Wave 3 — Assurance (start 3a immediately, in parallel with Wave 0)

**This is why the other ~90 findings survived ~100% unit coverage.** Without it, every fix above can regress
silently.

| # | Fix | Notes | Est |
|---|---|---|---|
| 3a.1 | **Run the e2e suites in CI** — `turbo run test:coverage` currently resolves to `<NONEXISTENT>` for all four harnesses | Cheap and urgent. Do this first, before any fix, so the rest is gated. | 0.5–1d |
| 3b.1 | **Harnesses must install the way customers do** — import `@bugsee/bugsee` (the umbrella), not the platform packages directly | This single gap is why the Bun/Deno bypass and the umbrella-condition defect were invisible. | 2–3d |
| 3b.2 | **Assert bundle CONTENTS, not arrival** — manifest correctness, entry payloads, wire field names/types, redaction actually applied | Would have caught `logLevelToWire`. | 3–5d |
| 3b.3 | **Schema-validate the mock collector** against the real backend contract | A permissive mock is how wire defects survive e2e. | 2–3d |
| 3b.4 | **Concurrency scenarios** — overlapping requests with distinct identities | Would have caught the cross-request user bleed and the tenant leak. | 2–3d |
| 3b.5 | **Real-runtime coverage for the gaps** — workerd/miniflare, and a real `next` install (there is none anywhere in the monorepo) | The review had to install these itself to find the worst bugs. | 4–6d |

---

## Wave 4 — Features that silently do nothing

| # | Fix | Where | Est |
|---|---|---|---|
| 4.1 | **Umbrella `exports`: 3 conditions → 7** (add `bun`, `deno`, `workerd`, `edge-light`, `worker`) | `packages/bugsee` | 2–3d |
| 4.2 | **Service Worker detection** — `isServiceWorker()` already exists in `@bugsee/util` and is simply not used; SW currently runs memory-only and loses everything on each idle termination | `packages/webworker` | 2–4d |
| 4.3 | **Next.js edge build** — `register()`'s literal dynamic import drags all of `@bugsee/node` into the edge graph (42 resolution errors) | `packages/nextjs` | 2–3d |
| 4.4 | **Nuxt ships the Node SDK into Cloudflare Workers bundles** on the auto-detected preset path | `packages/nuxt` | 2–3d |
| 4.5 | **Astro turns a 304/204 HTML response into a 500** | `packages/astro` | 1–2d |
| 4.6 | **`<BugseeProfiler>` records zero spans in production React** — either make it work or document it as dev-only | `packages/react` | 1–2d |
| 4.7 | **Electron renderer incidents never converge** — empty-capture bundle under a foreign session id; renderer crashes undetected | `packages/electron` | 4–6d |
| 4.8 | **`@bugsee/integration-shims` is entirely dead code** — delete it, or wire it where the docs claim | repo-wide | 1d |

---

## Wave 5 — Wire correctness

| # | Fix | Where | Est |
|---|---|---|---|
| 5.1 | `logLevelToWire` is never called — `logs.json` ships string levels where the viewer expects numerics | `packages/protocol` + emit path | 1–2d |
| 5.2 | `NetworkStage` dropped Android's websocket/event encoding — outbound WS frames render as incoming | `packages/protocol` | 1–2d |
| 5.3 | OTel root span ids fabricated as `traceId.slice(0,16)` — every service in one trace emits an identical root span id | `packages/opentelemetry` | 2–3d |
| 5.4 | `environment.sdk.type` has no path in the appserver schema the worker's JS-crash routing reads | cross-repo (appserver/worker) | needs backend coordination |

---

## Wave 6 — Durability, lifecycle, resource bounds

| # | Fix | Where | Est |
|---|---|---|---|
| 6.1 | Flush-on-exit never fires on SIGTERM/SIGINT/SIGHUP (bound to `'exit'`) | `packages/node`, `node-utils` | 2–3d |
| 6.2 | No page-lifecycle flush in the browser at all (no `pagehide`, no keepalive/sendBeacon) — a backgrounded-then-killed mobile tab loses everything | `packages/browser` | 3–4d |
| 6.3 | `ENOSPC` → unbounded memory growth instead of back-pressure; IDB write queue has zero back-pressure (~200MB retained) | `node-utils`, `browser-utils` | 3–5d |
| 6.4 | Durable bundle queue has no retention bound — permanent poison retry + persisted overflow drops | `packages/core` | 2–3d |
| 6.5 | Torn-record intolerance in the IDB port — one bad record permanently kills a generation | `browser-utils` | 2–3d |
| 6.6 | A live-but-stalled instance has its capture subtree deleted by a sibling coordinator (proven via SIGSTOP) | `packages/node` | 3–4d |
| 6.7 | Phase-2 SAB ring corrupts HEAD on an empty ring (~1.9 GiB overshoot) — opt-in path | `node-utils` | 2–3d |
| 6.8 | Elysia never finishes 404 transactions (context leak) | `packages/elysia` | 1d |

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

- **V0 (first, ~1–2 wks):** the shared substrate — app scaffold, the mock collector with schema validation,
  and a reusable bundle-assertion library. Everything else builds on this.
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

Everything else: the ~190 SEV3s, dead exports (15/24 in `@bugsee/util` have no consumers), the
`bundler-plugin-core` recursive `*.map` unlink and `dryRun` build-abort, the Vite `build.sourcemap`
default-off setup failure, the mutual-mocking test blind spots, and the missing `.tsx`/TypeScript coverage in
the component-annotate plugins.

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

### D4. `BugseeProfiler` and `integration-shims` — **FIX, do not delete**

- `4.6` — make `<BugseeProfiler>` actually produce spans in production React builds (today: zero).
- `4.8` — wire `@bugsee/integration-shims` where the docs claim it is wired, rather than deleting it. Note the
  review found the crash it exists to prevent is **already** prevented by self-noop in the real
  implementations, so "fix" here means: establish what job it uniquely does, make it do that job, and make a
  test prove it — otherwise this decision should be revisited.

### D5. Verification — **required, via a sample/test app per package**

Accepted as a first-class workstream: **Wave V** below. Every fix must be verified by an app that exercises the
package the way a customer does, not only by unit tests.
