# Adversarial review — @bugsee/integration-shims

**Reviewed:** 2026-07-26 · **Scope:** packages/integration-shims (impl 113 LOC, tests 158 LOC)

**What this package actually is:** Your prior is **correct in every mechanical detail** — I verified each claim
against the source rather than the docs. `packages/integration-shims/src/index.ts` exports exactly five
functions (`createNoopCaptureProvider:87`, `createNoopInterceptor:92`, `createViewHierarchyProviderShim:97`,
`createBreadcrumbsProviderShim:104`, `createXhrInterceptorShim:111`) plus two types. `NoopCaptureProvider:50`
extends `CaptureProviderBase` and warns in `onStart():65`; `NoopInterceptor:70` extends
`InterceptorBase<Record<never,never>>` and warns in `onActivate():81`. Construction is genuinely
side-effect-free (mutations M16/M17 that moved the warn into either constructor were both caught). The key
format `shim:${name}` (`:47`) and the message `` `${name} is a no-op on ${runtime}; ignored` `` (`:47`) match
`docs/PROGRESS.md:83` **verbatim** — no string drift. Logger (`ShimLogger = Pick<Logger,'warnOnce'>`, `:27`)
and `runtime` label are injected; the file contains **zero** `node:*`, DOM, `globalThis`, or runtime-probe
references. `replay` is indeed excluded (`:14-16`). Coverage is a real 100% (17/17 stmts, 2/2 branches,
10/10 fns) with **no** `v8 ignore` escapes; `tsc --noEmit` and `biome check` are both clean.

**Verdict:** The 113 lines are correct, portable, well-tested and do exactly what the doc says. The problem is
that **nothing anywhere calls them.** A repo-wide grep for `@bugsee/integration-shims` across `packages/*/src/`
returns a single hit — the package's own header comment. Every one of the five exports is dead code whose only
consumer is its own test file. Three package manifests declare the dependency and never import it
(`browser:30` — a *DOM* runtime; `node:32`; `vercel-edge:30`), while four of the six DOM-less platforms
(`webworker`, `cloudflare`, `deno`, `bun`, plus `electron`) do not even declare it. Worse, the crash the
package exists to prevent is already prevented upstream by self-noop in the real implementations
(`packages/capture/src/xhr-interceptor.ts:125-129`, `packages/browser/src/launch.ts:377-378`), and the three
names it shims are not exported by **any** platform — including the browser — so the "user code still
type-checks" premise (`docs/design/sdk-design.md:372`) cannot be exercised by anyone. Layered on top: the
package's only observable output is a `warnOnce` that, under the real `@bugsee/logger` and the natural launch
ordering, is provably destroyed before any sink can see it (probe P2). This is a well-built solution to a
problem that the codebase solved a different way, shipped without ever being connected.

## SEV1

### 1. Every export is dead code — no shim is wired on any runtime, DOM-less or otherwise

- **Where:** `packages/integration-shims/src/index.ts:87`, `:92`, `:97`, `:104`, `:111` (all five runtime
  exports). Declared-but-unimported dependents: `packages/browser/package.json:30`,
  `packages/node/package.json:32`, `packages/vercel-edge/package.json:30`.
- **What:** `grep -rn "@bugsee/integration-shims" packages/*/src/` returns exactly one line —
  `packages/integration-shims/src/index.ts:1`, the file's own header comment. A second grep for the five
  factory names across the whole repo (excluding `node_modules`/`dist`/`coverage`) returns only
  `packages/integration-shims/src/index.ts` and `packages/integration-shims/src/index.test.ts`, plus prose in
  `docs/PROGRESS.md:83` and `packages/integration-shims/README.md:18-26`. No platform composition root
  (`packages/node/src/launch.ts`, `packages/webworker/src/launch.ts`, `packages/cloudflare/src/*`,
  `packages/vercel-edge/src/launch.ts`, `packages/deno/src/*`, `packages/bun/src/*`) constructs a shim, and
  no platform `index.ts` re-exports one — `packages/node/src/index.ts` (18 export blocks) and
  `packages/browser/src/index.ts:1-58` contain no shim re-export at all.
- **Why it matters:** The package's entire reason to exist is the wiring. `docs/PROGRESS.md:83` closes with
  *"Per-platform named re-exports land with the platform packages"* — they never landed, and every platform
  listed in `README.md:9` ("Cloudflare / Vercel Edge / workers / Node / bun / deno") shipped without them.
  Consequences: (a) the 100% coverage gate is satisfied entirely by self-tests, so no integration anywhere
  validates the seam; (b) three manifests carry a dependency edge that pulls the package into their dependency
  graph and dual-module build for zero benefit; (c) `packages/browser` — the one runtime that *has* a DOM —
  is one of only three packages declaring the DOM-less shim package, which is backwards on its face.
- **Evidence:** `grep -rn "@bugsee/integration-shims" packages/*/src/` → 1 hit (the comment).
  `grep -rn "createNoopCaptureProvider\|createNoopInterceptor\|create.*ProviderShim\|createXhrInterceptorShim" -r .`
  (minus `node_modules`/`dist`/`coverage`/`.turbo`) → only this package's `src/index.ts`, `src/index.test.ts`,
  its README, and `docs/PROGRESS.md:83`.

### 2. The shim's only observable output is destroyed before it can reach a sink — proven against the real logger

- **Where:** `packages/integration-shims/src/index.ts:46-48` (`warnNoop` → `logger.warnOnce`) against
  `packages/logger/src/index.ts:46` (`return true;` inside `emit`) consumed at
  `packages/logger/src/index.ts:80-82`.
- **What:** `emit()` returns `true` whenever the message clears the **level** gate, regardless of whether any
  handler is registered. `warnOnce` treats that as "delivered" and burns the key. A shim activated during
  `launch()` — which is exactly when providers/interceptors start — against a logger whose sink is attached
  afterwards therefore produces **nothing, ever**, for the life of that logger. There is no key-reset API.
- **Why it matters:** This package has exactly one user-visible behavior. Under the ordering the architecture
  implies (build logger → launch → attach debug sink), that behavior is silently and irreversibly lost. The
  package's own README promises *"a friendly one-time `debug.warn(...)` when the feature is actually used"*
  (`README.md:10-14`) — a promise this path cannot keep.
- **Evidence:** Probe P2 (temporary test file, since removed; tree verified clean). `createLogger('warn')`
  with **no** handler → `createXhrInterceptorShim({runtime:'node',logger}).start()` → *then*
  `logger.addHandler(recorder)` → `stop()` → `start()`. Recorded sink calls: `[]`. The warning is gone even
  after the sink exists and even after a full deactivate/reactivate cycle.
- **Aggravating factor (why this is live-today rather than latent):** it is currently unreachable only because
  the whole chain is inert. `grep -rn "createLogger\|addHandler" packages/*/src/ --exclude='*.test.ts'`
  returns **only** `packages/logger/src/index.ts:27,56` — no platform ever constructs a logger or registers a
  sink. So today the answer to "does the warning reach a user" is *no, twice over*: no shim is built (SEV1 #1)
  and no logger exists to build one with. The moment #1 is fixed with the natural wiring order, this defect
  becomes the reason the fix appears to do nothing.

## SEV2

### 3. "Warns at most once" is not a property of this package — it is fully delegated to an injected dependency with no dedupe contract

- **Where:** `packages/integration-shims/src/index.ts:46-48` (`warnNoop`), called unconditionally from
  `:65-67` (`onStart`) and `:81-83` (`onActivate`); type declared at `:27`
  (`ShimLogger = Pick<Logger, 'warnOnce'>`). Claims: `README.md:31` ("at most once per integration per
  process"), `README.md:20` ("warns once"), `docs/PROGRESS.md:83` ("warns ONCE"), `index.ts:10-11`.
- **What:** The shims contain **no** once-ness of their own — no instance flag, no module-level set. They call
  `warnOnce` on *every* activation transition. `Pick<Logger,'warnOnce'>` is a one-method structural type that
  any object satisfies, including a hand-rolled `{ warnOnce: (k, m) => console.warn(m) }` that does not
  deduplicate at all. That is not hypothetical: `packages/vercel-edge/src/request-context-store.ts:19-21`
  already declares exactly such a hand-rolled `warnOnce` shape in this repo.
- **Why it matters:** With a non-deduping injected logger the shim spams on every provider stop→start cycle
  and on every listener-presence transition, in a long-lived Node/edge/worker process — the precise noise the
  "one-time" design was written to avoid. The type gives an implementer no signal that dedupe is required;
  the name `warnOnce` reads as if the once-ness is guaranteed by the call.
- **Evidence:** Probe P3 — `createNoopInterceptor` with a recording logger, `start(); start(); stop(); start()`
  → **2** `warnOnce` calls (`["shim:yy|…","shim:yy|…"]`). Probe P4 — two `onAny` subscriptions, both
  unsubscribed, then a third → **2** activations (`["shim:q","shim:q"]`). The package's own "at most once"
  tests (`index.test.ts:82-89`, `:119-126`) pass only because they inject the *real* `@bugsee/logger`, whose
  `warnedKeys` set does the deduping; the fake-logger tests (`:65-70`, `:99-109`) never assert call counts
  across cycles.

### 4. The premise the package is built on is unfounded: none of the three shimmed names is exported by any platform, including the browser

- **Where:** `docs/design/sdk-design.md:372` and `packages/integration-shims/README.md:10-14` /
  `src/index.ts:5` — *"user code that references e.g. `viewHierarchyProvider` still type-checks"*.
- **What:** No platform exports any of the three identifiers this package stands in for.
  - `viewHierarchyProvider`: the real browser export is `createViewtreeSnapshotSource` / `createDomSnapshot`
    (`packages/browser/src/index.ts:53-58`, impl `packages/browser/src/viewtree.ts:83`). The string
    `viewHierarchy` appears elsewhere only as the *option* identifier
    (`packages/protocol/src/options.ts:54`, `packages/browser/src/launch.ts:89,151,379`).
  - `breadcrumbsProvider`: **no implementation exists anywhere in the repo.** Grepping `breadcrumb` across
    `packages/*/src/*.ts` returns only the manual `addBreadcrumb` API surface
    (`packages/core/src/client.ts`, `packages/bugsee/src/index.ts`, `packages/node/src/launch.ts:99`) and this
    package. The shim stands in for an integration that was never built.
  - `xhrInterceptor`: the real one is `createXhrInterceptor`, exported from `@bugsee/capture`
    (`packages/capture/src/index.ts:81-84`) — a package that is **not** re-exported by `@bugsee/node`,
    `@bugsee/browser`, or the `@bugsee/bugsee` umbrella (grep for `@bugsee/capture` in those three index files
    → zero hits).
- **Why it matters:** The type-checking argument is the package's stated justification for existing as typed
  no-ops rather than as a plain warning at option-resolution time. Since a user cannot reference these names
  on *any* runtime, there is no cross-runtime source compatibility to preserve, and the design premise at
  `sdk-design.md:372` is not achievable without first *adding* those exports to the browser tier.

### 5. The crash this package prevents is already prevented upstream by self-noop, on the very runtimes that matter

- **Where:** `packages/capture/src/xhr-interceptor.ts:125-129` and `packages/browser/src/launch.ts:377-378`.
- **What:** The real XHR interceptor's `onActivate` reads the constructor and returns early when absent —
  *"no XMLHttpRequest in this runtime / target"* (`xhr-interceptor.ts:126-129`). And the DOM-less platforms
  **do** reach it: `installNetworkCapture` (which builds the `xhr` leaf at
  `packages/capture/src/install-network-capture.ts:79-83`) is called by `packages/node/src/launch.ts:605`,
  `packages/webworker/src/launch.ts:299` and `packages/vercel-edge/src/launch.ts:213`. Likewise
  `packages/browser/src/launch.ts:377-378` states the viewtree source *"self-noops where there is no DOM, so
  it is safe to register unconditionally when on."*
- **Why it matters:** For the one shimmed integration that actually exists (`xhrInterceptor`), the codebase
  chose self-skipping-in-place over swap-in-a-shim, and shipped it. So even if SEV1 #1 were fixed, wiring
  `createXhrInterceptorShim` on node/bun/deno/worker/edge would *replace* a working self-noop with a second,
  parallel no-op — pure duplication. This is the architectural reason nobody wired the package, and it means
  the answer to "does it prevent the failure it exists to prevent?" is: **the failure does not occur, but not
  because of this package.**
- **Evidence:** grep of `installNetworkCapture` call sites (above); `xhr-interceptor.ts:125-129` early return;
  `browser/src/launch.ts:377-378` comment.

## SEV3

### 6. A shim can throw into its host — the one thing a degradation shim must never do

- **Where:** `packages/integration-shims/src/index.ts:46-48` — `warnNoop` calls `logger.warnOnce(...)` with no
  `try`/`catch`; reached from `onStart:66` and `onActivate:82`.
- **What:** Because `ShimLogger` is an arbitrary injected object (`:27`), a faulty `warnOnce` propagates
  straight out of `provider.start(options)` and `interceptor.start()`.
- **Why it matters:** Bounded, but ironic: this package exists so a missing integration degrades quietly, and
  the single line it executes is the only line that can throw. Mitigations that exist: the real
  `@bugsee/logger` swallows handler exceptions (`packages/logger/src/index.ts:41-45`), and
  `packages/core/src/capture-coordinator.ts:10-11` documents that the Client wraps `start()` for the
  launch-never-throws guarantee. There is **no** equivalent wrapper on the interceptor path.
- **Evidence:** Probe P3 — injected `{ warnOnce: () => { throw new Error('sink blew up'); } }`:
  `interceptor.start()` threw `Error: sink blew up`; `provider.start(createOptionsContainer())` threw the same.

### 7. Blast radius of the core `InterceptorBase` `#active`-before-`onActivate` defect — verified bounded here, with one residue

- **Where:** `packages/core/src/interceptor-base.ts:46-49` (`this.#active = next;` **then** `this.onActivate()`)
  against `packages/integration-shims/src/index.ts:70`, `:81-83`.
- **What / verified not fatal:** For this package the defect's usual consequence — "one throwing hook install
  silently kills that source forever" — does not apply, because the shim installs no hook: after a throwing
  `onActivate`, `stop()` still flips `#active` back to `false` (`interceptor-base.ts:41-52`) and a later
  `start()` re-fires `onActivate`. Probe P3 confirmed 2 `onActivate` calls across `start/start/stop/start`.
  The **residue** is that when SEV3 #6 fires, `#active` is already `true` while the activation aborted, so the
  interceptor reports itself active with its (empty) activation half-completed. Harmless for a no-op; recorded
  because the shim is the pattern other interceptors are read against.
- **Evidence:** Probe P3 output `["shim:yy|yy is a no-op on node; ignored","shim:yy|yy is a no-op on node; ignored"]`.

### 8. Surviving mutation: `NoopInterceptor`'s name pass-through is never tested with a distinct name

- **Where:** `packages/integration-shims/src/index.ts:76` (`this.name = options.name;` in `NoopInterceptor`),
  tests `packages/integration-shims/src/index.test.ts:95`, `:101`, `:113`, `:121`, `:150`.
- **What:** Every interceptor test uses the name `'xhrInterceptor'`. Mutation **M8** — replacing
  `this.name = options.name` with `this.name = 'xhrInterceptor'` — passes **11/11**. The provider equivalent
  (M9, hardcoding `'X'`) is caught, so this is an asymmetry in the suite, not a systemic gap.
- **Why it matters:** `createNoopInterceptor` is a *generic* factory; its name plumbing is what makes it
  generic, and it is unverified. Fix: use a non-`xhrInterceptor` name in one `createNoopInterceptor` test.
- **Evidence:** M8 applied via scratchpad script, `pnpm --filter @bugsee/integration-shims exec vitest run` →
  `Tests 11 passed (11)`; reverted from a `cp` backup, `md5` re-verified against the original.

### 9. Surviving mutation: the file's only branch is covered but not behaviorally pinned

- **Where:** `packages/integration-shims/src/index.ts:59-61` (the `options.controllingOption !== undefined`
  guard); test `packages/integration-shims/src/index.test.ts:60-62`.
- **What:** Mutation **M10** — collapsing the guard to an unconditional
  `this.controllingOption = options.controllingOption` — passes **11/11**, because the test asserts the
  *value* is `undefined`, which holds either way. The only observable difference is property *presence*
  (`'controllingOption' in provider`). `tsconfig.base.json:11-12` enables `strict` +
  `noUncheckedIndexedAccess` but **not** `exactOptionalPropertyTypes`, so the compiler does not force the
  guard either.
- **Why it matters:** Low impact today — `packages/core/src/capture-coordinator.ts:41` gates on
  `=== undefined`, so presence is irrelevant to the consumer. Recorded because it is the file's sole branch
  and the 2/2 branch coverage overstates how well it is pinned.

### 10. Doc drift on the warn-once key

- **Where:** `packages/integration-shims/src/index.ts:31` ("The integration's public name … **also the
  warn-once key**") and `README.md:20` ("keyed by `name`"), versus the actual key `shim:${name}` at
  `packages/integration-shims/src/index.ts:47`.
- **What:** The key is namespaced with a `shim:` prefix; two doc sites say it is the bare name.
  `docs/PROGRESS.md:83` gets it right (`keyed shim:<name>`).
- **Why it matters:** Cosmetic, but the key is the exact string a future platform would need if it ever wanted
  to pre-seed or coordinate dedupe across shims.

### 11. No coordinator-level integration test — the `controllingOption` gate is unexercised

- **Where:** `packages/integration-shims/src/index.test.ts:34-41` (`buildInit` hand-builds a bare
  `CaptureProviderInit`) — `createCaptureCoordinator` is never imported.
- **What:** `controllingOption` exists so the shim *"only warns when the user enabled the feature"*
  (`index.ts:41`), but that gating lives in `packages/core/src/capture-coordinator.ts:40-45` and is never run
  in these tests. Per `docs/implementation-standards.md` §3, a cross-package boundary like this warrants an
  integration test.
- **Verified working anyway (probe P1, temporary file, since removed):** registering a shim with
  `controllingOption: 'com.bugsee.option.capture.view-hierarchy'` on a real `createCaptureCoordinator` →
  `start(options, () => false)` produced `WARNS: []`; `start(options, () => true)` twice (with a `stop()`
  between) produced exactly one warn; `createCaptureExporter(store).drain().size === 0`. So this is a test
  gap, not a defect.

## Does the warning ever reach a user?

**No — and it cannot today, for two independent reasons, either of which alone is sufficient.**

1. **No shim is ever constructed.** `grep -rn "@bugsee/integration-shims" packages/*/src/` → one hit, the
   package's own header comment (`packages/integration-shims/src/index.ts:1`). Not one platform composition
   root builds a shim, so `warnNoop` (`:46`) is never called outside tests.
2. **No logger exists to warn into.** `grep -rn "createLogger\|addHandler" packages/*/src/ --exclude='*.test.ts'`
   → only `packages/logger/src/index.ts:27` and `:56` (the definitions). No platform constructs a `Logger` and
   no platform registers a `LogHandler`. This independently confirms the `docs/review/logger.md` finding #4
   ("inert in production") from this side of the boundary: `docs/PROGRESS.md` claims platforms route `onError`
   to the logger; they do not.

**And if both were fixed, ordering would still destroy it.** The real `warnOnce`
(`packages/logger/src/index.ts:74-83`) burns its key whenever the *level* gate passes, regardless of sink
presence (`:46` `return true`). Probe P2 proved the end-to-end loss with the real logger: activate a shim
against `createLogger('warn')` with no handler, *then* attach the handler, then `stop()`/`start()` → the sink
records `[]`. So the natural wiring order (construct logger → `launch()` starts providers/interceptors →
attach the debug sink) silently and permanently swallows the package's only output. Only the reverse order
(attach sink **before** `launch()`) delivers it — and nothing in this package, its README, or `docs/PROGRESS.md`
documents that requirement.

Per-platform sink-registration order could not be tabulated because **no platform registers a sink at all** —
there is no ordering to compare.

## Shim wiring coverage

| DOM-less platform | shims wired? | reaches real DOM-only impl anywhere? | file:line |
|---|---|---|---|
| `node` | **No.** Dep declared, never imported. | Yes — `installNetworkCapture` builds the real `xhr` leaf, which self-skips. | dep `packages/node/package.json:32`; call `packages/node/src/launch.ts:605`; self-skip `packages/capture/src/xhr-interceptor.ts:125-129` |
| `bun` | **No.** Dep not even declared. | Yes, via the re-exported `@bugsee/node` composition. | `packages/bun/package.json` (no `integration-shims` entry) |
| `deno` | **No.** Dep not even declared. | Yes, via the re-exported `@bugsee/node` composition. | `packages/deno/package.json` (no entry) |
| `webworker` | **No.** Dep not even declared. | Yes — real `xhr` leaf via `installNetworkCapture`; viewtree explicitly excluded by design. | `packages/webworker/src/launch.ts:299`; `packages/webworker/src/launch.ts:62` ("NO DOM capture (input/viewtree)") |
| `cloudflare` | **No.** Dep not even declared. | n/a — no network-capture install found. | `packages/cloudflare/package.json` (no entry) |
| `vercel-edge` | **No.** Dep declared, never imported. | Yes — real `xhr` leaf via `installNetworkCapture`. | dep `packages/vercel-edge/package.json:30`; call `packages/vercel-edge/src/launch.ts:213` |
| *(control)* `browser` — has a DOM | **No**, but declares the dep anyway. | Real impls (`createViewtreeSnapshotSource`), correctly. | dep `packages/browser/package.json:30`; real wiring `packages/browser/src/launch.ts:381` |

No DOM-less platform crashes on a DOM-only integration — but that is because the **real** implementations
self-noop (`packages/capture/src/xhr-interceptor.ts:125-129`,
`packages/browser/src/launch.ts:377-378`), not because a shim replaced them. Nothing in the repo swaps a real
provider/interceptor for a shim on any runtime.

## Contract conformance

| shim | side-effect-free construction | warns once on activate | key format `shim:<name>` | message text | structurally valid |
|---|---|---|---|---|---|
| `createNoopCaptureProvider` | ✅ verified (M16 caught) | ⚠️ warns on **every** `start()`; once-ness is the injected logger's, not the shim's (SEV2 #3) | ✅ `index.ts:47` | ✅ exact match to `PROGRESS.md:83` | ✅ real `createCaptureCoordinator` add/gate/start/stop + real store drain = 0 (probe P1) |
| `createNoopInterceptor` | ✅ verified (M17 caught) | ⚠️ same; also re-warns on listener-presence churn (probe P4) | ✅ `index.ts:47` | ✅ exact match | ✅ `start`/`stop`/`onAny` all safe; no global touched |
| `createViewHierarchyProviderShim` | ✅ | ⚠️ as above | ✅ `shim:viewHierarchyProvider` | ✅ | ✅ (delegates to `createNoopCaptureProvider`) |
| `createBreadcrumbsProviderShim` | ✅ | ⚠️ as above | ✅ `shim:breadcrumbsProvider` | ✅ | ✅ — but stands in for an integration that **does not exist** (SEV2 #4) |
| `createXhrInterceptorShim` | ✅ | ⚠️ as above | ✅ `shim:xhrInterceptor` | ✅ | ✅ — but the real interceptor already self-skips (SEV2 #5) |

`stop()`/deactivate: idempotent and leak-free by construction — `NoopCaptureProvider` does not override
`onStop` and `NoopInterceptor` does not override `onDeactivate`, so both inherit the empty base bodies
(`packages/core/src/capture-provider-base.ts:57`, `packages/core/src/interceptor-base.ts:58`). There is no
retained state to leak. **Intended re-activation semantics:** the shim re-invokes `warnOnce` on every
activation (probe P3: 2 calls across `start/stop/start`) and relies on the logger's `warnedKeys` set for
"once" — matching `index.ts:10-11` ("at most once per integration name (Logger.warnOnce)"), but only for a
logger that actually deduplicates (SEV2 #3).

## Checked and found clean

- **Runtime portability — clean, and stricter than required.** `grep -nE "node:|window|document|process\.|globalThis|navigator|Deno|Bun"` over `packages/integration-shims/src/index.ts` → **zero** hits. The only two imports are `@bugsee/core` (value + type) and `@bugsee/logger` (type-only, `:24`, erased at compile time). The package never infers the runtime; `runtime` is a plain injected string (`:33`). It would run byte-identically on every target.
- **Construction really is side-effect-free.** Beyond the two existing tests (`index.test.ts:44-48`, `:93-97`), I verified by mutation: M16 (warn added to `NoopCaptureProvider`'s constructor) → 1 test failed; M17 (warn added to `NoopInterceptor`'s constructor) → 2 tests failed. `sideEffects: false` (`package.json:19`) is honest — the module body contains only declarations.
- **"Captures nothing" is a real assertion, not theater.** `index.test.ts:72-80` wires a real `createMemoryCaptureStore` + `createCaptureAggregator` + `createCaptureExporter` and asserts `drain().size === 0`. Mutation M11 (adding one `this.capture(...)` to `onStart`) failed it with `expected 1 to be +0` — the store/exporter round-trip genuinely detects a leaked entry.
- **The message and key strings match the documented contract exactly** — `shim:${name}` and `` `${name} is a no-op on ${runtime}; ignored` `` (`index.ts:47`) are byte-identical to `docs/PROGRESS.md:83`, and both are asserted verbatim in tests (`index.test.ts:69`, `:104-107`, `:142-145`, `:153-156`). Mutations M1 (hyphen removed), M2 (name/runtime swapped) and the control (key prefix `shim:`→`shimX:`) each failed 4-6 tests.
- **Both "at most once" tests use the REAL `@bugsee/logger`,** not a mock (`index.test.ts:23-32`, used at `:82-89` and `:119-126`) — so the dedupe path itself is genuinely exercised. The mock-logger tests (`fakeLogger`, `:19`) are used only for key/message-shape assertions, which is the correct use of a mock. This is *not* the theater pattern; the untested case is the no-sink ordering (SEV1 #2), not the dedupe.
- **Mutation audit: 17 mutations, 15 caught, 2 survived** (M8 §8, M10 §9), including a deliberate control (key prefix) that failed 4 tests, confirming the harness. Caught: key prefix, message hyphen, name/runtime swap, emptied `onActivate`, emptied `onStart`, wrong fixed name in the breadcrumbs shim, wrong fixed name in the xhr shim, `warnOnce`→`warn`, hardcoded provider name, entry emission, throwing `onDeactivate`, throwing `onStop`, shared-singleton interceptor factory, shared-singleton provider factory, constructor-side-effect ×2.
- **Coverage is real.** 17/17 statements, 2/2 branches, 10/10 functions, 17/17 lines; no `/* v8 ignore */` anywhere in the file. Thresholds in `packages/integration-shims/vitest.config.ts:12-17` match `docs/implementation-standards.md` §4.
- **`tsc --noEmit` exit 0; `biome check packages/integration-shims/src` clean (2 files, no fixes).**
- **`controllingOption` typing is sound.** The class declares `readonly controllingOption?: string` (`index.ts:52`) while the contract is `ControllingOption = keyof BugseeOptionTypes | (string & Record<never,never>)` (`packages/core/src/contracts.ts:196`) — deliberately open to any string, so the factory's `CaptureProvider` return type checks cleanly.
- **`replay` is correctly excluded**, as designed (`index.ts:14-16`, `README.md:33-38`, `docs/design/sdk-design.md:372`, `docs/design/replay.md:33,65`) — no `replay` shim export exists.
- **Read-only discipline honored.** Every mutation was applied from a `cp` backup in the scratchpad and restored from it (never `git checkout`); the two temporary probe test files were deleted. Final `git status --short packages/` is **empty** and `md5` of `packages/integration-shims/src/index.ts` matches the pre-review backup (`3008ed7b477029bcf014d2098b8c612d`).
