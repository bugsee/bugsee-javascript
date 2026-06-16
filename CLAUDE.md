# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

This repository is the new **Bugsee JavaScript SDK**. It is intended to be a single SDK that targets every JavaScript runtime: browsers (web), Node.js, Bun, Electron, and any other environment where JS executes.

Design implication: runtime-portable code is the default. Anything runtime-specific (DOM APIs, `process`, `window`, `fs`, Electron's `app`/`BrowserWindow`, Bun-only APIs, etc.) belongs behind a runtime adapter or a conditional entry point — never imported unconditionally from shared code.

## Current state

Runnable **Node, Browser, Bun, and Deno** SDKs exist. Implementation is tracked in **`docs/PROGRESS.md`** (the hand-off doc — read it first); architecture spec is `docs/design/sdk-design.md` (Draft v3); toolchain + commands are `docs/dev-environment.md`.

**Implemented (test-first, reviewed, on `master`):**
- Tier-0: `@bugsee/types`, `@bugsee/util`, `@bugsee/logger`, `@bugsee/protocol`, `@bugsee/service`.
- Kernel: `@bugsee/core` (Client, capture aggregator/store/exporter, coordinators, trigger/upload pipelines, durable bundle queue + capture recovery, interceptor/emitter base, options resolver, internal DI ServiceContainer).
- Shared capture: `@bugsee/capture` (console→log; fetch/xhr/ws/sse/webtransport → network umbrella; system traces/events providers).
- Node platform: `@bugsee/node-utils` (httpRequest transport, fs storage + bundle store) and `@bugsee/node` (`launch()`, node:http interceptor, env builder, detection providers, system metrics). Plus opt-in **node diagnostics**: rolling V8 CPU profiling (`profile.json`) + ANR/event-loop-hang detection (worker-thread watchdog → `AppHang` reports).
- Browser platform: `@bugsee/browser-utils` (fetch transport, IndexedDB storage + bundle store) and `@bugsee/browser` (`launch()`, global error/network capture, IndexedDB-persisted capture).
- Bun + Deno platforms: `@bugsee/bun` / `@bugsee/deno` — re-export the `@bugsee/node` composition and override only the runtime identity probe (+ a shared guarded `perf_hooks` sampler); **full Node feature parity incl. profiling + ANR**.
- Extensions / umbrella: `@bugsee/performance` (APM — web-vitals + metric catalog, on-by-default via the umbrella) and `@bugsee/bugsee` (umbrella, with per-runtime browser/node `exports` conditions).
- E2E: `@bugsee/instrumentation-tests` — boots the REAL SDK in real node/bun/deno processes against a mock collector and asserts the uploaded bundle (`pnpm test:e2e`; not in `pnpm test`).
- Framework adapters: the **per-request context foundation** (portable `RequestContext` + `ContextProvider` in core; `AsyncLocalStorage` binding in node, with `run` + `enterWith`; **correlation-by-tagging** — entries stamped with `contextId`/trace, reports merge the active context) + **`@bugsee/express`** (`requestHandler`/`errorHandler`/`setupExpress`) + **`@bugsee/fastify`** (hook-based `setupFastify`) + **`@bugsee/nestjs`** (`setupNest`: `enterWith` context middleware + a configurable error seam — default non-intrusive interceptor, opt-in global ExceptionFilter or `both` deduped; real-Nest e2e on express+fastify) + **`@bugsee/hono`/`elysia`/`hapi`/`koa`** (each structural-peer, per-framework error-capture probed before building; real-framework e2e) are built. (Restify was built then dropped — unmaintained, doesn't import on Node ≥18.) Plus **incoming-server auto-instrumentation** (`docs/design/incoming-server-instrumentation.md`): a **shared server-instrument core in `@bugsee/node`** (`server-instrument.ts` — plain values → `ServerRequestSpan`; `runServerRequest`/`openServerRequest`/split `openServerContext`+`startServerSpan`/`getActiveServerSpan`; **first-owner-wins re-entrancy** = one context + one `http.server` txn even when the http layer AND an adapter both run; only a `run`-scoped owner is refinable) auto-instruments incoming requests via the **`node:http` `Server.prototype.emit` patch** + native **`Bun.serve`/`Deno.serve`** wraps, **ON BY DEFAULT** (`instrumentIncomingRequests`, default `true`; `false` opts out). **All 7 adapters were refactored onto this core** (each keeps its own `shouldReport`/route extraction). `@bugsee/server-adapters` was **retired** (engine absorbed; `openBugsee*`→`server*`). See `docs/design/framework-adapters.md` + `docs/design/incoming-server-instrumentation.md` (`generic-server-adapter.md` is superseded).
- `launch(appToken, options)` returns the started client (every platform).

**Scaffold only (1-file stubs, no impl yet):** `electron`, `webworker`, `replay`/`replay-canvas`, the remaining framework adapters (`react`, `vue`, `svelte`, `angular`, `nextjs`, … — the BUILT backend adapters are `express`, `fastify`, `nestjs`, `hono`, `elysia`, `hapi`, `koa`), and `integration-shims` (minimal — one impl file, deferred to follow-up).

**Commands:** pnpm + turbo. `pnpm test` (all), `pnpm typecheck`, `pnpm lint` / `lint:fix`, `pnpm check:cycles`, `pnpm test:coverage`. Single file: `pnpm --filter @bugsee/<pkg> exec vitest run src/<file>.test.ts`. Single-package typecheck: `pnpm --filter @bugsee/<pkg> exec tsc --noEmit` (vitest does NOT typecheck — run tsc before committing). Full reference in `docs/dev-environment.md`.

**Module strategy:** packages `exports` map `.` → `./src/index.ts` (source consumed directly inside the monorepo; no build step for dev). tsconfig `module: ESNext`, `moduleResolution: Bundler`, `verbatimModuleSyntax`. Per-runtime `exports` conditions (browser/node): the `@bugsee/bugsee` umbrella now HAS them; the platform packages (`@bugsee/browser`/`node`) are still single-entry (split when their runtimes branch) — design §6/§12.2. Coverage gate per package: **100% line/fn/stmt, ≥90% branch** (vitest v8).

**Runtime-adapter pattern:** shared tiers (`core`/`capture`/`protocol`/`util`) are runtime-portable — they reach runtime globals only via `globalThis as unknown as {…}` casts and **never** import `node:*`/DOM. Runtime-specific code lives in platform packages (`@bugsee/node` imports `node:process`/`node:http`/`node:fs`; `@bugsee/node-utils` owns the fs/http primitives). Platforms inject specifics through seams: `HttpTransport` (node:http vs fetch), `FileStorageAdapter` + `BundleStore` (fs vs IndexedDB), `CaptureStore` (in-memory shared / file via adapter), capture sources via `installNetworkCapture({ additionalSources })`, and injectable `Clock`/`Scheduler`/`SystemProbe`/`process`. Cross-runtime capture interceptors self-skip when their global is absent.

## Design (must-follow)

- **Android-canonical.** The Bugsee Android SDK (`/Users/alexeykarimov/Projects/Bugsee/android/sdk`) is the API **and** architecture parity target. Sentry/Firebase are studied as internal design references only — **never** migration sources; do not add migration guides/aliases for them.
- **Thin kernel + pub/sub event flow** (Android-derived): sources (interceptors/adapters) → capture/detection providers → capture aggregator → capture store (ring/parts) → bundle. NOTE: the design-doc "event hubs" layer was **removed** during implementation — interceptors are themselves listenable (extend the core multi-key emitter / `InterceptorBase`) and providers subscribe to them directly (subscriber-presence drives activation). Features are **pluggable extensions**; **do not pierce the core** (e.g. APM is the opt-in `@bugsee/performance` extension, not core code). Full contract in design §16 (read alongside `docs/PROGRESS.md` for the as-built deltas).
- **Runtime-portable by default.** Anything runtime-specific (DOM, `process`, `window`, `fs`, Electron, Bun/Deno APIs) lives behind a runtime adapter or conditional entry point — never imported unconditionally from shared code.

## Implementation standards (binding — full methodology in `docs/implementation-standards.md`)

Mandatory for all code:

1. **Test-first (TDD).** No implementation without a failing test first. Every file, every method/getter/setter, and every line must be covered by one or more tests that **comprehensively validate** behavior (assert outcomes), not merely execute it.
2. **Mutator loop, per testable entity.** When creating/changing a method/getter/setter:
   1. Write the test → 2. add the implementation → 3. run it, confirm pass →
   4. **Mutator loop:** inject a bug into the new/changed entity, run the test, confirm it **fails** (catches the bug); repeat with different mutations while any mutation survives undetected — **hard limit: 10 iterations**. If a mutation survives, strengthen the test before continuing.
   5. **Roll back every injected mutation**, leaving the clean, valid implementation. Never commit a mutation.
3. **Integration tests.** Any class that interacts with other classes, or any cross-module/cross-package import/export boundary, gets integration tests following the same mutator discipline (#2).
4. **Coverage gate (CI, per-runtime):** **100% line, ≥90% branch.** Coverage runs per target runtime (browser/node/bun/deno/…). Unreachable or platform-guarded code may be excluded only via an explicit `/* v8 ignore … */` annotation **with a one-line justification**.
5. **Mutation testing (Stryker): opt-in**, not a blocking gate — run on demand/nightly to audit test strength. The per-entity mutator loop (#2) is the always-on primary discipline.
6. **Multi-agent code review (per feature) — convergent gate.** Once a feature's implementation and tests are complete and gates (#2/#4) pass, run a review with **multiple specialized agents in parallel** validating **both the implementation and the tests**. Agents are **read-only** and must **make no assumptions, not hallucinate, take no shortcuts, and re-check when unsure** — every finding cites a concrete `file:line`. Triage findings (record dismissals), fix real ones **test-first**, then start a **fresh** multi-agent review. Repeat until a full round yields **zero new real findings**. Full process in `docs/implementation-standards.md` §7.
7. **Tooling:** Vitest (unit + integration, `--typecheck` for type tests), Playwright (browser e2e), per-runtime smoke harnesses. See design §12.1/§13.
