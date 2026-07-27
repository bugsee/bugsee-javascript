# Adversarial package review — tracker

Serial, **one Opus 5 sub-agent per package**, walking the internal dependency graph **bottom-up**
(foundations first, dependents later, tooling/e2e harnesses last). Each agent writes its findings to
`docs/review/<package>.md` and returns only a short summary; this file is the resumable checkpoint.

The order below is the **actual topological order** computed from the `@bugsee/*` dependency edges in every
`packages/*/package.json` (dependencies + devDependencies + peerDependencies). The graph is **acyclic**.
Level N depends only on levels < N.

Status: `[ ]` pending · `[~]` in progress · `[x]` done. Update after each package.

## Order (53 packages, 10 dependency levels)

### Level 0 — no internal deps
- [x] 1. `@bugsee/types` — impl 92
- [x] 2. `@bugsee/util` — impl 360
- [x] 3. `@bugsee/logger` — impl 86
- [x] 4. `@bugsee/rrweb` — impl 37 (fork wrapper)
- [x] 5. `@bugsee/bundler-plugin-core` — impl 390
- [x] 6. `@bugsee/babel-plugin-component-annotate` — impl 101
- [x] 7. `@bugsee/svelte-plugin-component-annotate` — impl 221

### Level 1
- [x] 8. `@bugsee/protocol` — impl 1097 · deps types, util
- [x] 9. `@bugsee/service` — impl 249 · deps util
- [x] 10. `@bugsee/vite-plugin` — impl 15 · deps bundler-plugin-core
- [x] 11. `@bugsee/webpack-plugin` — impl 15 · deps bundler-plugin-core

### Level 2 — the kernel
- [x] 12. `@bugsee/core` — impl 5449 · deps protocol, service, types, util

### Level 3 — shared capture / storage / extensions
- [x] 13. `@bugsee/capture` — impl 2256
- [x] 14. `@bugsee/node-utils` — impl 1412
- [x] 15. `@bugsee/browser-utils` — impl 1209
- [x] 16. `@bugsee/performance` — impl 2291
- [x] 17. `@bugsee/replay` — impl 333 · deps core, rrweb
- [x] 18. `@bugsee/adapter-kit` — impl 98
- [x] 19. `@bugsee/integration-shims` — impl 114

### Level 4
- [x] 20. `@bugsee/node` — impl 4005
- [x] 21. `@bugsee/vercel-edge` — impl 706
- [x] 22. `@bugsee/opentelemetry` — impl 689
- [x] 23. `@bugsee/replay-canvas` — impl 70

### Level 5
- [x] 24. `@bugsee/browser` — impl 1897
- [x] 25. `@bugsee/bun` — impl 169
- [x] 26. `@bugsee/deno` — impl 175
- [x] 27. `@bugsee/cloudflare` — impl 530 · deps vercel-edge

### Level 6
- [x] 28. `@bugsee/bugsee` — impl 390 (umbrella)
- [x] 29. `@bugsee/electron` — impl 1207
- [x] 30. `@bugsee/webview` — impl 1460
- [x] 31. `@bugsee/webworker` — impl 525
- [x] 32. `@bugsee/web-adapter` — impl 142

### Level 7 — frontend + backend adapters
- [x] 33. `@bugsee/react` — impl 381
- [x] 34. `@bugsee/vue` — impl 293
- [x] 35. `@bugsee/angular` — impl 203
- [x] 36. `@bugsee/svelte` — impl 153
- [x] 37. `@bugsee/solid` — impl 91
- [x] 38. `@bugsee/express` — impl 246
- [x] 39. `@bugsee/fastify` — impl 183
- [x] 40. `@bugsee/nestjs` — impl 566
- [x] 41. `@bugsee/hono` — impl 138
- [x] 42. `@bugsee/koa` — impl 147
- [x] 43. `@bugsee/hapi` — impl 184
- [x] 44. `@bugsee/elysia` — impl 198
- [x] 45. `@bugsee/astro` — impl 327

### Level 8 — meta-frameworks
- [x] 46. `@bugsee/nextjs` — impl 521
- [x] 47. `@bugsee/nuxt` — impl 387
- [x] 48. `@bugsee/remix` — impl 254
- [x] 49. `@bugsee/sveltekit` — impl 292

### Level 9 — test harnesses (lowest priority)
- [x] 50. `@bugsee/instrumentation-tests`
- [x] 51. `@bugsee/astro-e2e`
- [x] 52. `@bugsee/nuxt-e2e`
- [x] 53. `@bugsee/sveltekit-e2e`

## Review contract (per package)

Each sub-agent runs on **Opus 5**, is **READ-ONLY** (no edits, no commits), and must:

- Adversarially audit **implementation AND tests**: correctness bugs, race/lifecycle hazards, error handling,
  resource leaks, wire-protocol/contract conformance, runtime-portability violations (no unguarded DOM/`node:*`
  in the shared tiers), API/design-doc drift, missing or weak test coverage, and **test theater** (tests that
  execute code but do not assert outcomes).
- Cite a concrete `file:line` for **every** finding. Make **no assumptions**, do not hallucinate, take no
  shortcuts, and re-check when unsure. If a finding cannot be verified against the actual source, **drop it**.
- Rank findings **SEV1** (correctness/security/data-loss), **SEV2** (real but bounded), **SEV3** (hygiene).
- Write the full findings to `docs/review/<package>.md`; return only counts + a one-line headline.

## Budget protocol

Before each package the orchestrator runs the 5-hour usage meter (`scratchpad/budget.mjs`, which reads
`~/.claude/projects/**/*.jsonl` and models the same 5h-block semantics as `ccusage`). If usage reaches **85%**
of the observed 5-hour ceiling, the next package is **suspended** until the block resets, then the run
continues from the first `[ ]` entry above.

## Log

| # | Package | SEV1 | SEV2 | SEV3 | Headline |
|---|---------|------|------|------|----------|
| 1 | `@bugsee/types` | 0 | 3 | 4 | interface→type mutation survives typecheck tests; 3 dead exports (AppToken, NameHookMapping, NameHubMapping) |
| 2 | `@bugsee/util` | 0 | 3 | 8 | impl correct, but 15/24 exports dead + 100% coverage hides 4 verified surviving mutations |
| 3 | `@bugsee/logger` | 0 | 4 | 5 | warnOnce burns dedupe key with no sink registered; shallow Object.freeze lets handlers mutate caller args; package inert in prod vs PROGRESS claim |
| 4 | `@bugsee/rrweb` | 0 | 3 | 6 | supply-chain pin OK (SHA+integrity); built .d.ts exports enum EventType that dist/index.js lacks (verified throws); coverage gate passes vacuously 0/0 |
| 5 | `@bugsee/bundler-plugin-core` | 3 | 3 | 5 | SEV1: relative output.file recursively unlinks every *.map under CWD incl node_modules; every CLI failure (incl dryRun, exit 11) aborts user build with no escape hatch; spawn security itself solid |
| 6 | `@bugsee/babel-plugin-component-annotate` | 0 | 1 | 10 | transform correct across 31 JSX constructs + contract matches browser byte-for-byte; pre() wipes shared component stack under nested transformSync; 5/5 targeted mutations survived, zero .tsx coverage |
| 7 | `@bugsee/svelte-plugin-component-annotate` | 1 | 2 | 6 | SEV1: bare catch silently disables annotation for TS-on-Svelte-4 + SCSS everywhere; no preprocessor source maps breaks symbolication under renderSpans; transform itself sound + re-entrancy-safe |
| 8 | `@bugsee/protocol` | 3 | 1 | 12 | SEV1 wire bugs: logLevelToWire never called (logs.json ships string level vs viewer numeric map); NetworkStage dropped Android websocket+event encoding (outbound WS renders as incoming); environment.sdk.type unreadable by worker JS-crash routing |
| 9 | `@bugsee/service` | 1 | 2 | 10 | package is a DI container (not lifecycle); SEV1: getImmediate({optional:true}) rethrows on first access to a throwing factory — 6 backend adapters rely on it not throwing in host request paths |
| 10 | `@bugsee/vite-plugin` | 1 | 4 | 5 | (joint report w/ webpack-plugin) unplugin re-exports; engine unlink SEV1 unreachable; NEW SEV1: Vite build.sourcemap defaults false + neither wrapper enables it → documented setup fails build (bugsee-cli exit 10, repro'd Vite 6.4.3+7.3.6) |
| 11 | `@bugsee/webpack-plugin` | 1 | 4 | 5 | see joint report docs/review/vite-plugin+webpack-plugin.md |
| 12a | `@bugsee/core (A: client/lifecycle/API)` | 2 | 7 | 6 | unguarded onError seam crashes host from timer callback + promise handler; stop() halts evictor but not manual capture → unbounded never-rotated part; consent/pause API documented but absent (doc fixed) |
| 12b | `@bugsee/core (B: capture pipeline)` | 2 | 4 | 6 | runFilter never normalizes falsy filter return → TypeError escapes public addBreadcrumb()/log() into host + annihilates log/network stream; InterceptorBase sets #active before onActivate() → one throwing hook silently kills that capture source forever |
| 12c | `@bugsee/core (C: storage/chunks/ring)` | 0 | 2 | 10 | durability rule HOLDS (core buffers nothing); file backend stream() provably non-chronological vs CaptureSnapshot contract + memory backend; doc's zero-loss-on-SIGTERM guarantee not delivered (process.on('exit') doesn't run on SIGTERM) |
| 12d | `@bugsee/core (D: bundle/upload/recovery)` | 3 | 4 | 4 | delete-after-confirm ordering correct + 64/68 mutations died; torn profile record makes recovered bundle declare profile.json while zip holds only profile.json/; durable queue has NO retention bound (permanent poison retry + persisted overflow drops); no wire idempotency key |
| 13 | `@bugsee/capture` | 6 | 6 | 7 | real-Response clone() tee makes await reader.cancel() never settle (leaks suspended read frame per over-cap body, never emits size_too_large); throwing decorators/console-formatters break host fetch/send/console.log; URL query strings + form-urlencoded bodies ship credentials in clear; one frozen global kills all network capture |
| 14 | `@bugsee/node-utils` | 1 | 7 | 11 | Phase-2 ring producer corrupts HEAD on empty ring (~1.9GiB overshoot → permanently silent capture loss, opt-in path); DEFAULT batched writer answers ENOSPC with unbounded memory growth + one failing syscall per entry, not back-pressure |
| 15 | `@bugsee/browser-utils` | 3 | 5 | 7 | IDB port dropped core's torn-record tolerance (one bad record permanently kills a generation); write queue has zero back-pressure (20k entries accepted, 1 write in flight, ~200MB retained); orphaned capture never reclaimed without Web Locks; documented pagehide flush does not exist |
| 16 | `@bugsee/performance` | 2 | 4 | 8 | core boundary clean + strongest tests yet (69/70 mutations killed); browser single-slot getActiveSpan LEAKS into Node via one unconditional networkSource line → cross-request http.client misattribution; pageload txn anchored at SDK-launch not timeOrigin → children pre-date parent |
| 17 | `@bugsee/replay` | 3 | 9 | 9 | PRIVACY: .bugsee-unmask defeats the 'password ALWAYS masked' hard floor (raw passwords/card numbers serialized); attribute masking is an 11-entry denylist so data-user-email leaks at defaults; one typo in blockSelector silently disables ALL blocking page-wide; registerReplay discards every caller masking option undetected |
| 18 | `@bugsee/adapter-kit` | 0 | 1 | 7 | no module-level state → SSR/HMR + cross-request contamination structurally absent; traceMetaTag unescaped raw-HTML sink asserts a hex invariant it never enforces (reachable via supported injection seams); DI test theater (wrong token still passes) |
| 19 | `@bugsee/integration-shims` | 2 | 3 | 6 | ENTIRE PACKAGE IS DEAD CODE — no platform imports any shim (3 manifests declare dep unused, 4 DOM-less platforms don't declare it); the crash it prevents is already prevented by self-noop in real impls; its only output provably destroyed by logger key-burn |
| 20a | `@bugsee/node (A: launch/composition)` | 4 | 3 | 8 | default unhandledRejection listener converts host crashes into exit 0 with NO opt-out (untested — deleting its registration passes all 109); flush bound to 'exit' which never fires on SIGTERM/SIGINT/SIGHUP; 3 eager fs writes outside degrade-to-memory guard (launch() throws EEXIST into host, onError never called) |
| 20b | `@bugsee/node (B: http/server-instrument)` | 3 | 3 | 7 | isolation design holds under real concurrency (35/35, 15/16 mutations caught) BUT unguarded resolveStore lets an SDK throw hang the host request forever; openServerContext hands request #2 request #1's user (Node 18/22); outgoing URL query strings + user:pass@ credentials reach disk in plaintext |
| 20c | `@bugsee/node (C: diagnostics/multi-instance)` | 2 | 7 | 10 | default launch() PERMANENTLY PINS the host process (watchdog worker MessagePort re-refs after unref, proven node/bun/deno); live-but-stalled instance has its capture subtree DELETED by sibling coordinator (proven via SIGSTOP); profile.json torn-record NOT produced here |
| 23 | `@bugsee/replay-canvas` | 3 | 5 | 7 | config DOES reach rrweb (no silent drop); O2 .bugsee-show opt-in is DEAD on canvas-recording path (fork never passes unblockSelector); .bugsee-ignore/.bugsee-mask protect no canvas pixels at all; one typo in replay.blockSelector leaks every canvas incl .bugsee-block ones AND throws into host getContext() |
| 21 | `@bugsee/vercel-edge` | 1 | 8 | 3 | isolation core sound (no module-level mutable state, run()-only ALS verified under real concurrency); throwing host waitUntil propagates out of unguarded finally and DESTROYS the user's Response or masks their real error; flush never time-bounded; mutation dropping the flush promise survives all 17 tests despite 100% coverage |
| 22 | `@bugsee/opentelemetry` | 3 | 6 | 7 | root span ids FABRICATED as traceId.slice(0,16) → every service in one distributed trace emits identical root span id; continued root's parent points at a span nobody exports; unguarded throw in onEnd escapes into host span.end() (all confirmed vs real OTel sdk-trace-base 2.7.1) |
| 24 | `@bugsee/browser` | 2 | 3 | 14 | masking survives 100% to rrweb — replay review's 'registerReplay drops options' claim DISPROVEN (measured) → CONTRADICTION TO RESOLVE; real holes: 5 throw-paths escape the unguarded window error/rejection listeners; ZERO page-lifecycle flush (pagehide→0 uploads, no keepalive/sendBeacon anywhere) |

## Adjudicated contradictions

| Dispute | Verdict | Corrected finding |
|---|---|---|
| `registerReplay` "discards every caller masking option" (`replay.md`) vs "masking survives 100%, DISPROVEN" (`browser.md`) | **Both partly right** — see `ADJUDICATION-registerReplay-masking.md` | **NOT a privacy defect.** All 8 masking options reach rrweb intact on the sole production path. The real issue is **SEV3 test-strength**: the mutation `register.ts:48 → resolveReplayMaskingOptions({})` is undetectable across browser 208/208, replay-canvas 12/12 *and* the RP6 e2e, because `browser` mocks `@bugsee/replay` while `replay` mocks `record` — a mutual-mocking blind spot. `browser.md`'s "DISPROVEN" rebuttal was invalid (its control mutation was in a different file/package/suite). |
| 25 | `@bugsee/bun` | 4 | 4 | 4 | (joint report bun+deno, tested on REAL bun 1.3.14 / deno 2.8.3) umbrella has NO bun/deno exports condition → both packages BYPASSED on the documented install path (wire says platform.type:node, no native serve wrap); Deno launch() hard-throws NotCapable without --allow-env; pidAlive reports every live process dead without --allow-run; event-loop metrics fabricated (0.004ms reported after real 600ms stall) |
| 26 | `@bugsee/deno` | 4 | 4 | 4 | see joint report docs/review/bun+deno.md |
| `@bugsee/node` Pass C: "watchdog pins host process — proven on node, bun AND deno" vs `bun+deno.md`: "does NOT reproduce on bun/deno" | **bun+deno correct for bun/deno** (tested on real bun 1.3.14 / deno 2.8.3) | The process-pinning defect is **Node-only**. Pass C's "proven on node/bun/deno" overstated its scope — treat the SEV1 as scoped to Node. |
| 27 | `@bugsee/cloudflare` | 6 | 4 | 5 | FIRST-EVER real workerd run (miniflare 4 / workerd 1.20260722.1): instrumentRpcMethods makes DO/WorkerEntrypoint RPC methods UNCALLABLE; different tenants' Durable Objects SHARE ONE CAPTURE RING (tenant C's uploaded bundle contained A's and B's secrets); globalThis.AsyncLocalStorage never exists on workerd under any flag → per-request isolation permanently inert + README remedy is wrong |
| 28 | `@bugsee/bugsee (umbrella)` | 3 | 4 | 5 | ships only browser/node/default conditions (spec prescribes 7) → Bun/Deno/workerd/edge-light/worker ALL silently resolve to the wrong platform; a mutation re-pointing the node condition at the browser entry survived every test AND typecheck; wire.ts leak fix + dual-package carrier verified genuinely clean |
| 29 | `@bugsee/electron` | 5 | 9 | 7 | SECURITY: renderer-controlled wire 'type' reaches path.join in main — PROVEN arbitrary-path/arbitrary-content file write from any renderer (XSS in loaded content = file write); renderer incidents NEVER converge (empty-capture bundle under a foreign session id, renderer crashes undetected) |
| 30 | `@bugsee/webview` | 4 | 9 | 8 | D10 obscuring FAIL-OPEN three ways (cap declared before it works; no try/catch; native rect-pull throws) → sensitive areas recorded unobscured; both bridge globals unauthenticated + page-replaceable and the JS→native sink is re-resolved per post, so any later-loading script taps the whole UN-REDACTED capture stream |
| 31 | `@bugsee/webworker` | 5 | 5 | 5 | NO Service-Worker detection — platformType defaults to 'web-worker' so SW silently runs MEMORY-ONLY and loses everything on every idle termination (contradicts PROGRESS 'SW FULLY DONE + durable'), while isServiceWorker() already exists in @bugsee/util; 3 surviving mutations prove the waitUntil flush guarantee is untested; launch() emits an unhandled rejection when onError omitted, which the SDK's own listener reports as a CUSTOMER crash |
| 32 | `@bugsee/web-adapter` | 1 | 4 | 4 | ZERO error containment: reportError/setRouteName/recordRenderSpan all propagate throws into host lifecycles (proven reachable via real core .stack/frozen-error paths) → React componentDidCatch can UNMOUNT the customer app; sibling adapter-kit guards the identical operation with an explicit 'never throws' contract |
| 33 | `@bugsee/react` | 3 | 7 | 6 | PROVEN with real react-dom 18 (dev AND prod): an SDK throw in componentDidCatch UNMOUNTS the customer's whole app, loses the report entirely, and skips their onError; separately <BugseeProfiler> records ZERO spans in every production React build |
| 34 | `@bugsee/vue` | 2 | 4 | 6 | (joint report frontend-adapters-vue-angular-svelte-solid.md, real renders) SDK throw in each framework's error seam turns a survivable error into app-mount failure (Vue: empty DOM), discarded ErrorBoundary fallback (Solid), dead SvelteKit error page — and skips the customer's own handler in all four; Angular's documented useClass wiring SILENTLY DELETES the app's ErrorHandler |
| 35 | `@bugsee/angular` | 2 | 4 | 6 | (joint report frontend-adapters-vue-angular-svelte-solid.md, real renders) SDK throw in each framework's error seam turns a survivable error into app-mount failure (Vue: empty DOM), discarded ErrorBoundary fallback (Solid), dead SvelteKit error page — and skips the customer's own handler in all four; Angular's documented useClass wiring SILENTLY DELETES the app's ErrorHandler |
| 36 | `@bugsee/svelte` | 2 | 4 | 6 | (joint report frontend-adapters-vue-angular-svelte-solid.md, real renders) SDK throw in each framework's error seam turns a survivable error into app-mount failure (Vue: empty DOM), discarded ErrorBoundary fallback (Solid), dead SvelteKit error page — and skips the customer's own handler in all four; Angular's documented useClass wiring SILENTLY DELETES the app's ErrorHandler |
| 37 | `@bugsee/solid` | 2 | 4 | 6 | (joint report frontend-adapters-vue-angular-svelte-solid.md, real renders) SDK throw in each framework's error seam turns a survivable error into app-mount failure (Vue: empty DOM), discarded ErrorBoundary fallback (Solid), dead SvelteKit error page — and skips the customer's own handler in all four; Angular's documented useClass wiring SILENTLY DELETES the app's ErrorHandler |
| 38 | `@bugsee/express` | 2 | 5 | 6 | (joint report backend-express-fastify-koa.md, real frameworks) SDK-internal throw 500s the host request on express+koa (fastify immune — it guards, they don't); all three upload the raw query string UNREDACTED; setupExpress's default reports ZERO errors when the app has its own error middleware; re-entrancy/concurrency verified correct on all three |
| 39 | `@bugsee/fastify` | 2 | 5 | 6 | (joint report backend-express-fastify-koa.md, real frameworks) SDK-internal throw 500s the host request on express+koa (fastify immune — it guards, they don't); all three upload the raw query string UNREDACTED; setupExpress's default reports ZERO errors when the app has its own error middleware; re-entrancy/concurrency verified correct on all three |
| 42 | `@bugsee/koa` | 2 | 5 | 6 | (joint report backend-express-fastify-koa.md, real frameworks) SDK-internal throw 500s the host request on express+koa (fastify immune — it guards, they don't); all three upload the raw query string UNREDACTED; setupExpress's default reports ZERO errors when the app has its own error middleware; re-entrancy/concurrency verified correct on all three |
| 41 | `@bugsee/hono` | 3 | 3 | 4 | (joint report backend-hono-hapi-elysia.md) hono 500s the host request (unguarded user extractor + unguarded runServerRequest, contradicting its own 'never breaks the app' README) and is UNIMPORTABLE on Cloudflare/Vercel Edge; all three leak the raw query string via the default node:http owner (adapters themselves clean — root cause is the engine); hapi clean; elysia never finishes 404 transactions |
| 43 | `@bugsee/hapi` | 3 | 3 | 4 | (joint report backend-hono-hapi-elysia.md) hono 500s the host request (unguarded user extractor + unguarded runServerRequest, contradicting its own 'never breaks the app' README) and is UNIMPORTABLE on Cloudflare/Vercel Edge; all three leak the raw query string via the default node:http owner (adapters themselves clean — root cause is the engine); hapi clean; elysia never finishes 404 transactions |
| 44 | `@bugsee/elysia` | 3 | 3 | 4 | (joint report backend-hono-hapi-elysia.md) hono 500s the host request (unguarded user extractor + unguarded runServerRequest, contradicting its own 'never breaks the app' README) and is UNIMPORTABLE on Cloudflare/Vercel Edge; all three leak the raw query string via the default node:http owner (adapters themselves clean — root cause is the engine); hapi clean; elysia never finishes 404 transactions |
| 40 | `@bugsee/nestjs` | 4 | 4 | 3 | enterWith isolation is CLEAN (unbreakable across concurrency/keep-alive/Scope.REQUEST, both platforms — engine defect does NOT propagate); but global interceptor TypeErrors on EVERY non-HTTP context (microservices/WS/GraphQL); unguarded openSpan 500s healthy requests; opt-in filter silently clobbers the app's own filter or reports nothing depending on registration order; secrets leak via manifest.json http.url; both e2e headline claims survived mutation |
| 46 | `@bugsee/nextjs` | 2 | 5 | 2 | EDGE BUILD CANNOT COMPILE — register()'s literal dynamic import drags all of @bugsee/node into the edge graph (42 resolution errors proven vs 1 counterfactual / 0 control); umbrella condition gap does NOT bite here; tunnel + next.config wrapper (slice N6) are DESIGNED BUT UNBUILT so no SSRF surface exists; next installed nowhere in monorepo → zero real Next semantics exercised; 12/12 mutations caught within scope |
| 45 | `@bugsee/astro` | 2 | 5 | 8 | (joint report meta-frameworks-nuxt-remix-sveltekit-astro.md, real framework boots) Astro turns a 304/204 HTML response into a 500 (proven on real Astro boot); Nuxt ships the Node SDK into a Cloudflare Workers bundle on the auto-detected preset path (proven by real nuxi build); the nextjs edge-import SEV1 does NOT reproduce in any of the four; 15/15 mutations caught |
| 47 | `@bugsee/nuxt` | 2 | 5 | 8 | (joint report meta-frameworks-nuxt-remix-sveltekit-astro.md, real framework boots) Astro turns a 304/204 HTML response into a 500 (proven on real Astro boot); Nuxt ships the Node SDK into a Cloudflare Workers bundle on the auto-detected preset path (proven by real nuxi build); the nextjs edge-import SEV1 does NOT reproduce in any of the four; 15/15 mutations caught |
| 48 | `@bugsee/remix` | 2 | 5 | 8 | (joint report meta-frameworks-nuxt-remix-sveltekit-astro.md, real framework boots) Astro turns a 304/204 HTML response into a 500 (proven on real Astro boot); Nuxt ships the Node SDK into a Cloudflare Workers bundle on the auto-detected preset path (proven by real nuxi build); the nextjs edge-import SEV1 does NOT reproduce in any of the four; 15/15 mutations caught |
| 49 | `@bugsee/sveltekit` | 2 | 5 | 8 | (joint report meta-frameworks-nuxt-remix-sveltekit-astro.md, real framework boots) Astro turns a 304/204 HTML response into a 500 (proven on real Astro boot); Nuxt ships the Node SDK into a Cloudflare Workers bundle on the auto-detected preset path (proven by real nuxi build); the nextjs edge-import SEV1 does NOT reproduce in any of the four; 15/15 mutations caught |
| 50 | `@bugsee/instrumentation-tests` | 6 | 9 | 6 | (joint report e2e-harnesses.md) NO e2e suite runs in CI AT ALL (turbo run test:coverage → <NONEXISTENT> for all four); harnesses never import the @bugsee/bugsee umbrella, never unzip an edge bundle, never issue concurrent requests — root-causes the bun/deno, umbrella-condition and Cloudflare cross-tenant misses |
| 51 | `@bugsee/astro-e2e` | 6 | 9 | 6 | (joint report e2e-harnesses.md) NO e2e suite runs in CI AT ALL (turbo run test:coverage → <NONEXISTENT> for all four); harnesses never import the @bugsee/bugsee umbrella, never unzip an edge bundle, never issue concurrent requests — root-causes the bun/deno, umbrella-condition and Cloudflare cross-tenant misses |
| 52 | `@bugsee/nuxt-e2e` | 6 | 9 | 6 | (joint report e2e-harnesses.md) NO e2e suite runs in CI AT ALL (turbo run test:coverage → <NONEXISTENT> for all four); harnesses never import the @bugsee/bugsee umbrella, never unzip an edge bundle, never issue concurrent requests — root-causes the bun/deno, umbrella-condition and Cloudflare cross-tenant misses |
| 53 | `@bugsee/sveltekit-e2e` | 6 | 9 | 6 | (joint report e2e-harnesses.md) NO e2e suite runs in CI AT ALL (turbo run test:coverage → <NONEXISTENT> for all four); harnesses never import the @bugsee/bugsee umbrella, never unzip an edge bundle, never issue concurrent requests — root-causes the bun/deno, umbrella-condition and Cloudflare cross-tenant misses |
