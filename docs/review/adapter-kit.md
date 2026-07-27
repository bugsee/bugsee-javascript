# Adversarial review — @bugsee/adapter-kit

**Reviewed:** 2026-07-26 · **Scope:** packages/adapter-kit (impl 95 LOC across 3 files, tests 171 LOC across 2 files)

**What this package actually is:** A **two-primitive** runtime-portable kit for the SSR meta-framework
adapters, depending only on `@bugsee/core`. It exports exactly:

- `reportServerError(error, options)` — P4, the server-error bridge (`report-server-error.ts:23`)
- `getTraceparent()` / `traceMetaEntries()` / `traceMetaTag()` — P5, the trace-`<meta>` channel (`trace-data.ts:20,37,47`)
- plus the two option types.

**Correction to the stated prior:** the prior said this is "plausibly where the 6 reusable primitives live."
It is not. `docs/design/meta-framework-adapters.md:15` names 6 primitives, but line 42 states that only
**P4 and P5** are "runtime-portable and framework-agnostic"; P1/P2/P3/P6 are framework-specific by design and
correctly stay in each adapter. `docs/design/meta-framework-adapters.md:89` ("K0 — ✅ DONE") confirms the kit
was scoped to P4+P5 deliberately. So the kit shipping 2-of-6 is **correct**, not rot. The rest of the prior
held: all five dependents (`astro`, `nextjs`, `nuxt`, `remix`, `sveltekit`) declare and use it, and
`@bugsee/core` is its only dependency.

**Verdict:** This is a genuinely well-built package — and unusually, the adversarial angles that normally
produce SEV1s here all come back clean, verifiably. It holds **zero module-level mutable state** (the only
module-level binding is `const W3C_VERSION` at `trace-data.ts:12`), so the HMR / multiple-module-instantiation
hazard that dominates SSR adapters does not exist here. It caches nothing and re-reads the active context on
every call, so it **cannot** cross-contaminate concurrent requests. It wraps no host handler, so there is no
`this`/arity/return-value preservation surface to break. Both primitives are total (blanket `try/catch`), and
the one async escape (`void client.logException(...)`) is provably safe because core's `track()` attaches a
rejection handler before returning. I found **no SEV1**. The one substantive finding is a defense-in-depth
gap: `traceMetaTag` builds raw HTML by interpolation and documents an "it's always hex, no escaping needed"
invariant that it does not itself enforce — currently unreachable, but it is the SDK's only raw-HTML sink and
four of five adapters splice its output straight into SSR responses. The rest is test-strength: 17/17 pass and
typecheck is clean, but the DI interaction is mocked so thoroughly that **swapping in the wrong DI token still
passes**, and there is no test anywhere that runs these primitives against a real `@bugsee/core` client.

## SEV1

None. See "Checked and found clean" for the specific SEV1-class hypotheses I tested and disproved.

## SEV2

### 1. `traceMetaTag` interpolates the trace id into raw HTML and asserts, but does not enforce, the invariant that makes that safe

- **Where:** `packages/adapter-kit/src/trace-data.ts:49` (sink), justified by the comment at `trace-data.ts:43-45`
- **What:** The tag is built by string interpolation with no escaping and no validation:
  ```ts
  return traceparent === undefined ? '' : `<meta name="traceparent" content="${traceparent}">`;
  ```
  The comment states: *"`traceparent` is a fixed `version-hex-hex-hex` shape (no HTML-special chars), so no
  attribute escaping is needed."* That is a claim about **upstream producers**, enforced nowhere at this sink.
  `getTraceparent` (`trace-data.ts:27-29`) reads `provider.getCurrent()?.trace` and formats
  `trace.traceId` / `trace.spanId` verbatim — it never checks they are hex.
- **Why it matters:** This is the only place in the SDK that emits attacker-adjacent data into raw HTML, and
  it is consumed by 4 of the 5 adapters, which splice the result directly into the SSR response body:
  `sveltekit/src/handle.ts:36`, `astro/src/middleware.ts:77`, `remix/src/meta-tag-transformer.ts:42`,
  `nuxt/src/nitro.ts:95`. A non-hex `traceId` containing `">` breaks out of the attribute and injects markup
  into every SSR page. (`nextjs` is the exception — `traceMetaEntries` feeds Next's `Metadata.other`, which
  Next escapes.)
- **Evidence / honest reachability:** I traced every producer and **no default path can reach it today**:
  - Inbound headers are strictly validated — `capture/src/traceparent.ts:82-87` rejects anything failing
    `TRACE_ID_RE = /^[0-9a-f]{32}$/` and `SPAN_ID_RE = /^[0-9a-f]{16}$/` (`capture/src/traceparent.ts:49-50`).
  - Generated ids are hex — `performance/src/span.ts:132-134` (`toHex(randomBytes(16|8))`).
  - The only `setTrace` writer is `node/src/server-instrument.ts:411`, fed by one of those two.
  So this is **not** an exploitable XSS today, and I am not claiming it is. It is SEV2 rather than SEV3
  because the invariant is reachable through *supported injection seams* without touching kit code:
  `contextProvider` is an injectable client option (`core/src/client.ts:263,301-303`) and `newTraceId` is an
  injectable dependency (`performance/src/span.ts:355`). A caller supplying either — or any `getClient`
  returning a client whose provider yields a non-hex id — lands unescaped output in five frameworks' HTML.
  A single hex guard at `trace-data.ts:29` would make the invariant local and self-enforcing.
- **Test gap:** no test exercises a hostile or non-hex trace id; `trace-data.test.ts:5-6` uses only the
  spec-conformant W3C example ids.

## SEV3

### 1. A throwing attribution `event()` silently drops the error report entirely (ordering is unpinned by tests)

- **Where:** `packages/adapter-kit/src/report-server-error.ts:27-30`
- **What:** `client.event(...)` and `client.logException(...)` share one `try`. `event()` runs **first**, so if
  it throws, control jumps to the `catch` at line 31 and `logException` — the actual error report — never runs.
  The decoration can annihilate the payload. All five adapters pass an `event`
  (`nextjs/src/on-request-error.ts:61`, `remix/src/handle-error.ts:56`, `sveltekit/src/handle-error.ts:51`,
  `nuxt/src/nitro.ts:74`, `astro/src/middleware.ts:50`), so all five are exposed to the ordering.
- **Why it's SEV3, not SEV2:** not reachable with a real core client. `client.event()`
  (`core/src/client.ts:557-569`) delegates to `captureAggregator.addEntry` → `route()`, and `route()` is total —
  `core/src/capture-aggregator.ts:57-66` catches everything and routes to `onError`. The exposure only
  materializes via the public `getClient` seam with a non-core client.
- **Evidence (empirical):** I swapped the two statements so `logException` runs first. **The mutation survived
  — 17/17 still passed.** No test pins the ordering. Worse, the existing test at
  `report-server-error.test.ts:51-64` ("never throws when the client throws") uses a throwing `event` and
  asserts only `not.toThrow()` — it never asserts `logException` still ran, so it *locks in* the drop.

### 2. Test theater: the DI interaction is mocked so completely that the wrong DI token passes

- **Where:** `packages/adapter-kit/src/trace-data.test.ts:8-12` (the `clientWith` double) vs. `trace-data.ts:24-26`
- **What:** The double is `getServiceProvider: () => ({ getImmediate: () => provider })` — both functions
  **ignore their arguments entirely**. So no test can observe which token is requested or which options are
  passed to `getImmediate`.
- **Evidence (empirical, two surviving mutations):**
  - Replacing `ContextProviderToken` with `undefined as never` at `trace-data.ts:25` → **SURVIVED**. Nothing
    verifies the kit asks for the *context provider* at all.
  - Deleting `{ optional: true }` at `trace-data.ts:26` → **SURVIVED**. That flag is the documented guard
    against the known `getImmediate` throw-on-missing-service behavior; its removal is invisible to the suite.
  There is no integration test anywhere that runs `getTraceparent` against a real `@bugsee/core` client, so
  the single most important cross-package contract in this file is unverified. (Control mutations — version
  `00`→`01`, always-sampled flags, dropped event params, changed default mechanism — were all **CAUGHT**,
  confirming the harness is valid.)

### 3. Blanket `try/catch` with no diagnostic seam makes internal failure silent and untestable

- **Where:** `packages/adapter-kit/src/report-server-error.ts:31-33` and `trace-data.ts:30-32`
- **What:** Both primitives swallow every error into an empty `catch`. Core's convention elsewhere is to route
  swallowed errors to the injected `onError` (e.g. `core/src/capture-aggregator.ts:64`,
  `core/src/filters.ts:55`); this kit has no such seam, so a misconfigured adapter degrades to "no trace meta,
  no report" with **zero** signal — indistinguishable from "no active trace."
- **Evidence (empirical):** two guards are equivalent mutants because the blanket catch masks them —
  removing `if (trace === undefined) return undefined;` (`trace-data.ts:28`) **SURVIVED**, and removing
  `if (client === undefined) return;` (`report-server-error.ts:26`) **SURVIVED**. In both cases the deleted
  guard's job is instead done by a `TypeError` being swallowed. The behavior is correct by accident, and no
  test can distinguish the guarded from the unguarded version.

### 4. `getTraceparent` is an unused export

- **Where:** `packages/adapter-kit/src/index.ts:7`, defined at `trace-data.ts:20`
- **What:** Exported from the package index, but **no dependent imports it**. Repo-wide, the only references
  outside the kit's own tests are the two internal callers (`trace-data.ts:38,48`). `traceMetaEntries` is used
  only by `nextjs/src/trace-data.ts:13`; `traceMetaTag` by the other four.
- **Caveat:** plausibly intentional API surface for users who want the raw value for a custom injection. Flagged
  as dead surface only because the package is `private: true` and consumed solely by the five in-repo adapters.

### 5. Design-doc signature drift

- **Where:** `docs/design/meta-framework-adapters.md:47,49` vs. `report-server-error.ts:23`, `trace-data.ts:20,47`
- **What:** The doc specifies `reportServerError(getClient, error, { mechanism, attributes })` and
  `getTraceparent(getClient)` / `traceMetaTag(getClient)`. The shipped API is `reportServerError(error, options)`
  and `getTraceparent(options)`, with `getClient` **inside** the options object, and the second option is
  `event` (not `attributes`). The implementation's shape is the better one; the doc is stale.

### 6. Logic the kit does *not* own is duplicated across dependents (drift risk)

- **Where:** three independent copies of the `</head>` splice — `sveltekit/src/handle.ts:34-36`,
  `astro/src/middleware.ts:74-81`, `remix/src/meta-tag-transformer.ts:42`
- **What:** Each dependent re-implements "find `</head>`, splice the tag before it." They have already
  diverged in ordering (sveltekit checks for `</head>` *before* calling `traceMetaTag`; astro calls
  `traceMetaTag` *before* buffering the body) — harmless today, but this is precisely the divergence the shared
  kit exists to prevent. Separately, the `traceparent` **format string** now exists in three places:
  `adapter-kit/src/trace-data.ts:29`, `node/src/server-instrument.ts:155`, `capture/src/traceparent.ts:154`.
  Neither duplication is a defect today; both are the mechanism by which the shared-primitive promise rots.

### 7. `@bugsee/nuxt`'s edge path bypasses the kit and loses route attribution

- **Where:** `packages/nuxt/src/nitro-edge.ts:73-82` vs. `packages/nuxt/src/nitro.ts:72-83`
- **What:** The edge preset calls `client.logException(error, { mechanism: 'http-error' })` directly instead of
  `reportServerError`. The bypass itself is **justified** (it must `await` inside `waitUntil` before the isolate
  freezes — the kit's fire-and-forget shape cannot express that). But in re-implementing it, the edge path
  **drops the `nuxt.request-error` attribution event** that the node path emits at `nitro.ts:74-81`. The same
  Nuxt app therefore produces incidents with method/path/tags attribution on node and without it on edge.

## Dependent-usage audit

| dependent | primitives used | used as promised? | re-implements something the kit provides? | file:line |
|---|---|---|---|---|
| `@bugsee/astro` | `reportServerError`, `traceMetaTag`, `TraceDataOptions` | Yes — conditional-spread of `getClient`, explicit `mechanism`, rethrows after reporting so Astro still renders its error page | No. The `</head>` splice is its own (kit provides no injection primitive) — see SEV3-6 | `astro/src/middleware.ts:12,48-58,71-81,97` |
| `@bugsee/nextjs` | `traceMetaEntries`, `reportServerError`, `TraceDataOptions` | Yes — thin, correctly-named re-export; the only consumer of `traceMetaEntries`, and the only one whose output is framework-escaped | No | `nextjs/src/trace-data.ts:13,33`, `nextjs/src/on-request-error.ts:18,59-71` |
| `@bugsee/nuxt` | `reportServerError`, `traceMetaTag` | Node path: yes, and it adds its own `try/catch` around `head.push` (defensible — guards the *host* object, not the kit call) | **Yes, on edge** — `nitro-edge.ts:76` re-implements the P4 bridge and loses the attribution event (SEV3-7) | `nuxt/src/nitro.ts:10,72-83,90-99`; `nuxt/src/nitro-edge.ts:73-82` |
| `@bugsee/remix` | `traceMetaTag`, `reportServerError`, `TraceDataOptions` | Yes. Note `meta-tag-transformer.ts:31` reads the trace **once at transformer creation** — correct, since a transformer is created per response inside the request's async context | No, but owns a third `</head>` splice copy (SEV3-6) | `remix/src/trace-meta.ts:10,15`, `remix/src/handle-error.ts:12,54-65`, `remix/src/meta-tag-transformer.ts:18,31,42` |
| `@bugsee/sveltekit` | `traceMetaTag`, `reportServerError`, `TraceDataOptions` | Yes. `handle.ts:48` exports a module-level `createHandle()` singleton, but it closes over `{}` only and resolves the client lazily per call — **HMR-safe** | No, but owns a second `</head>` splice copy (SEV3-6) | `sveltekit/src/handle.ts:12,33-44,48`, `sveltekit/src/handle-error.ts:13,49-60` |

All five declare `@bugsee/adapter-kit` in `dependencies`; no undeclared imports.

## Upstream-defect applicability

- **`runFilter` falsy-return (core) — NOT APPLICABLE at this boundary; contained.** The kit registers no
  filters and never calls `runFilter`. The one reachable path is `logException` → `applyReportBefore`
  (`core/src/client.ts:609,439-440`), which is called *outside* any core-level guard. Even if a user's report
  filter throws or returns `undefined`, `reportServerError`'s `try/catch` (`report-server-error.ts:24,31`)
  contains the synchronous throw, and `trigger-pipeline.ts:37-45` contains the async path. Net effect at this
  boundary is a **dropped report, never a broken host request**. Note `runFilter` itself
  (`core/src/filters.ts:52-57`) already catches throws and returns `null`; the defect is the un-normalized
  `undefined` return, which flows on to `submitReport` — still not a throw into the kit.
- **`InterceptorBase` `#active`-before-`onActivate()` — NOT APPLICABLE.** The kit installs no interceptor,
  extends no emitter, and registers no capture source. It has no activation lifecycle at all.
- **`getImmediate({ optional: true })` rethrow — APPLICABLE SURFACE, but contained; and untested.** The kit
  does expose DI access at `trace-data.ts:24-26`. A throwing service factory would rethrow on first access,
  but the enclosing `try/catch` (`trace-data.ts:30-32`) converts it to `undefined` → no trace meta injected →
  no host impact. Unlike the six backend adapters, the kit does **not** re-expose `getImmediate` to callers, so
  the hazard does not propagate outward to the five adapters. However, per SEV3-2, deleting `{ optional: true }`
  is a **surviving mutation** — the protection is real but entirely unverified by the suite.

## Checked and found clean

- **No module-level mutable state** — the sole module-level binding is `const W3C_VERSION` (`trace-data.ts:12`).
  Nothing is memoized, no client/provider/trace is cached. Re-evaluating these modules under a framework's
  dev-mode HMR or multiple instantiations is a no-op. This is the classic SSR bug class and it is absent.
- **No cross-request contamination (SEV1-class hypothesis, disproved).** Both primitives resolve the client and
  re-read `provider.getCurrent()` on **every call** (`trace-data.ts:22,27`; `report-server-error.ts:25`). There
  is no state that could outlive a request, so one request cannot observe another's context. The kit does not
  call `enterWith` (nor `run`) anywhere — it is a pure reader of whatever context the platform opened, so the
  `enterWith` leak footgun does not apply here.
- **The floating promise at `report-server-error.ts:30` is safe (SEV1-class hypothesis, disproved).** I
  initially flagged `void client.logException(...)` as an unhandled-rejection → Node-process-crash risk. It is
  not: `logException` returns `submitReport`'s promise, and `track()` (`core/src/client.ts:386-401`) attaches
  `report.then(onFulfilled, forget)` *before returning it*, explicitly "so a stray rejection can't surface as
  an unhandled rejection." `trigger-pipeline.ts:33-46` additionally converts all failures into resolved
  `{ok:false}` values. `void` here matches the established repo-wide pattern (12+ sites).
- **Host-behavior preservation.** The kit wraps no user handler, request, or response — so there is no return
  value, `this`, arity, or async semantic to preserve. `reportServerError` returns `void` and never rethrows;
  `traceMetaTag`/`traceMetaEntries`/`getTraceparent` are pure reads. Removing either `catch` is **CAUGHT** by
  the suite (both mutations failed tests), so the never-throw contract is genuinely pinned.
- **Runtime portability.** Zero `node:*` and zero DOM imports; the only import is `@bugsee/core`
  (`report-server-error.ts:8`, `trace-data.ts:9`). `package.json` declares exactly one dependency. Safe in
  node, edge, and browser graphs as the header claims. Degradation is graceful everywhere (missing client →
  no-op; missing provider → `undefined`; no trace → `''`/`{}`).
- **`private: true` is consistent, not a packaging defect.** I checked whether the five published-shaped
  dependents would break resolving a private dependency: `adapter-kit`, `nextjs`, `nuxt`, `remix`, `sveltekit`,
  `astro`, `core`, `browser`, `node`, and `bugsee` are **all** `private: true`. The repo is uniformly
  pre-publication; nothing anomalous about this package.
- **Type/consistency gates.** `pnpm --filter @bugsee/adapter-kit exec tsc --noEmit` clean;
  `vitest run` 17/17 passing.
- **Mutation harness validated with controls.** Caught: default-mechanism change, dropped event params,
  `W3C_VERSION` `00`→`01`, always-sampled flags, `traceMetaEntries` wrong key, `traceMetaEntries` always `{}`,
  `traceMetaTag` emitting a tag with no trace, dropped quotes around the `content` attribute, both
  `catch`-removals, both `getClient`-seam removals, ignored custom mechanism. **One false "survivor" was
  self-corrected**: mutating the literal `{ traceparent }` first matched the JSDoc text at `trace-data.ts:35`
  rather than the code at line 39; re-run against the actual return statement, it was CAUGHT.
- **Read-only discipline.** All mutations were applied to `cp` backups and restored from them (never
  `git checkout`). Post-review `git status --short packages/` is **empty**, and both files' md5 sums match the
  pre-review backups (`015e1751dac86de2f2ca77c60d58602f`, `e9be4fa23d6c595ced38b175b028f103`).
