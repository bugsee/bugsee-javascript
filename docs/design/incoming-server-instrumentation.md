# Incoming-server auto-instrumentation (`node:http` + native `Bun.serve`/`Deno.serve`) — DESIGN

**Status:** DESIGN — revised after **multi-agent review rounds 1 & 2** (round 1: 5 agents; round 2: 2
agents — convergence check). Findings tracked in §11 (round 1) and §12 (round 2). Decisions D1–D12 in §2.
Build-ready: slice plan in §3.1. Not yet built. Supersedes & absorbs
`docs/design/generic-server-adapter.md` (the `@bugsee/server-adapters` engine is rehomed into
`@bugsee/node`; the package is retired — §9).

**Driver:** "Why don't we auto-instrument the raw `http.Server`? Others (Sentry, …) do." Today the
per-request context **foundation** exists and 7 framework adapters wire it explicitly, but there is no
*automatic* incoming-request instrumentation — a framework without a dedicated adapter (or a raw
`http.Server` / `Bun.serve` / `Deno.serve`) gets no context + no APM transaction unless hand-wired.

---

## 1. Goal & non-goals

**Goal.** With an opt-in flag (v1; default-on is a follow-up — §10), every incoming request on Node, Bun, and Deno gets
(1) a **per-request context** (`contextId` + trace stamped on every capture entry — the correlation-by-
tagging foundation) and (2) an **`http.server` APM transaction** (name / method / status / duration,
continuing an inbound W3C `traceparent`), for **any** `node:http` framework (Express, Koa, Fastify, Hapi,
raw `http.Server`) **and** idiomatic native servers (`Bun.serve({fetch})`, `Deno.serve(handler)`).

**Not in scope / explicit non-goals:**
- **Handled-error capture on the `node:http` path.** A framework that catches a throw → 500 swallows it
  before `node:http`, so the emit patch cannot see it. Handled errors still come from `logException` / a
  dedicated adapter; unhandled from crash detection. (The **native-fetch path differs** — §5.3.)
- **Low-cardinality route names at entry.** Only the raw URL is known (`/users/123`); a dedicated adapter
  refines via `setRoute` (§4/§5.4). See D5.
- **Bun `routes`/websocket, `Deno.serve` non-handler options (`onListen`…), `server.reload()` survival,
  HTTP/2 (`node:http2`), WebSocket `upgrade`, browser/edge.** Documented known gaps / follow-ups
  (D9, §10). v1 native coverage is the common `fetch`/handler form, scoped by the slice-4 spikes (§8.0).

---

## 2. Decision log

| # | Decision | Rationale / review note |
|---|---|---|
| **D1** | **Home = `@bugsee/node`.** Shared core + `node:http` installer + launch flag in `@bugsee/node`; `@bugsee/bun`/`@bugsee/deno` inject native `serve` wraps via the `launchCore` option seam they already use for `systemProbe`. | node **cannot** import `server-adapters` (cycle); all 7 adapters + bun + deno already dep `@bugsee/node` + `@bugsee/performance`. Verified (agent 1). |
| **D2** | **Two interception mechanisms:** (a) `http(s).Server.prototype.emit('request')` patch (node:http, all 3 runtimes — gated by spike §8.0); (b) native `Bun.serve({fetch})` / `Deno.serve(handler)` wraps. | Idiomatic Bun/Deno apps never touch node:http; Express-on-Bun does. |
| **D3** | **Opt-in (default-OFF) for v1**, via `instrumentIncomingRequests` (default `false`). Flip to default-on in a follow-up once the mechanism is proven on all 3 runtimes + all mitigations (D11/D12) land. | **Revised** from default-on after review round 1 (agent 5): default-on would self-instrument the SDK's own in-process control-plane server, change ~50 existing tests, risk teardown leaks, and capture `http.url` query PII universally. Default-off keeps the existing suite untouched and makes those mitigations correctness-when-opted-in rather than ship blockers. |
| **D4** | **`run`-scoped context** for the emit patch + native wraps; `enterWith` variant retained for hook adapters. | **Rationale corrected** (agent 2, empirical Node v24): `run()` deterministically *reverts* the context when the synchronous dispatch returns (no residual context on the socket's post-dispatch async work); `enterWith` persists until overwritten. (The earlier "enterWith leaks across keep-alive" claim was NOT reproducible — Node dispatches each `emit('request')` in a fresh async context. `run` is still the correct, scoped choice.) `enterWith` stays where the hook returns before the handler (Fastify/Hapi/Elysia/Nest). |
| **D5** | **Span name = raw path (query stripped) + optional `spanName(method,url)` hook.** Default `GET /users/123`. A dedicated adapter refines to `/users/:id` via `setRoute`. | OTel-aligned; cardinality caveat documented. |
| **D6** | **Re-entrancy = guarded refine.** First opener (http layer) **owns** context + txn and stashes its span on the context; a later opener (adapter) gets a **refining** handle (no second context/txn). | Core mechanics SOUND (agent 2, empirical). When the flag is OFF, `getCurrent()===undefined` → adapters open exactly as today. |
| **D7** | **One shared core in `@bugsee/node`; refactor all 7 adapters onto it.** | **Reworded** (agent 4): the shared core is the **context/txn mechanics**; each adapter keeps its **own `shouldReport` and route extraction** (those are genuinely per-framework, not byte-identical). |
| **D8** | **Absorb `@bugsee/server-adapters` into `@bugsee/node`; retire the package** (rename `openBugsee*`→`server*`). | Unreleased SDK, no external consumers (verified, agent 1/4) → no facade. |
| **D9** | **Native surface = spike-first, common forms.** Slice 4 begins with gating real-runtime spikes (§8.0); v1 covers `Bun.serve({fetch})` + `Deno.serve` handler/overloads; `routes`/websocket/`reload` documented as gaps. Pin min Bun/Deno versions from the spikes. | Review (agent 3): the native surface is wider than `fetch` and `server.reload()` defeats a naive wrap. |
| **D10** | **`finish(status, outcome?)` — explicit outcome.** Default outcome `status>=500?ERROR:OK`; callers may pass an explicit outcome. | Review (agent 4): nestjs + elysia derive outcome from the thrown error / `code` **independently** of the recorded status; single-arg finish would flip ERROR→OK. |
| **D11** | **Incoming self-isolation.** Skip instrumenting any inbound request carrying `x-bugsee-internal`. `http.url` keeps the **raw** URL (current adapter behavior); query secrets are scrubbed by the existing **redaction-filter pipeline** like all captured data, and the span **name** already strips the query (low cardinality). | Review (agent 5) flagged `http.url` query (`/reset?token=…`) as a PII vector under default-on. **Round 2** (both agents) showed a default `http.url` strip would break the adapters' pinned behavior (`express/middleware.test.ts:94` asserts `/pay?x=1`; koa/fastify/nestjs also store query-bearing `http.url`). With D3 now default-OFF + the redaction pipeline, keep `http.url` raw (behavior-preserving); an opt-in strip is deferred (§10). |
| **D12** | **Mechanism = a dedicated carrier slot with explicit `install()`/`uninstall()`**, NOT a subscriber-gated `InterceptorBase` and NOT the `getOrCreateInterceptor` interceptor map. `emit` is **restored by `delete`** when the original was inherited (it is — `http.Server.prototype` has no own `emit`). | Review (agent 5): §5.2/§6 contradicted each other (interceptor vs `ServerInstallable`); a server patch has no "subscriber"; reassigning `emit` leaves a residual own-property that alters the prototype shape ("interceptors must not alter app behavior"). |

---

## 3. Architecture

```
@bugsee/node
  server-instrument.ts        ← THE shared core (absorbs server-adapters' engine)
  http-server-interceptor.ts  ← patches http(s).Server.prototype.emit('request')  (req/res; install/uninstall)
  launch.ts                   ← `instrumentIncomingRequests` flag (default FALSE) + `serverInstrumentations`
                                seam; installs node:http interceptor when on; uninstalls in stop()

@bugsee/bun   → injects a Bun.serve({fetch}) installer  ┐ via launchCore({ serverInstrumentations: [...] }),
@bugsee/deno  → injects a Deno.serve(handler) installer ┘ like systemProbe/systemMetricsSampler

7 adapters → refactored onto the shared core's context/txn mechanics (re-entrancy for free; behavior-
             identical when the flag is off — own shouldReport + route extraction retained)

@bugsee/server-adapters → REMOVED (API rehomed in @bugsee/node)
```

Dependency direction stays acyclic (everything points down to `@bugsee/node` → core/capture/performance).
**Migration must add `@bugsee/performance` to `packages/node/package.json`** (type-only edge; runtime
acquisition stays `client.ext('performance')`, so no value-level coupling — §9).

## 3.1 Slice plan (build order)

Each slice: **plan → red test → green → per-entity mutator loop → multi-agent code review (to convergence)
→ commit + push**. Per-slice gate = the named §8 tests green + `pnpm typecheck && test && lint &&
check:cycles`.

| # | Slice | Scope | Gate |
|---|---|---|---|
| **1** | **Shared core** | Move `server-adapters/src/server.ts` → `@bugsee/node/src/server-instrument.ts`; rename `openBugsee*`→`server*`; add `runServerRequest` + owner/refiner re-entrancy + `Symbol.for` span-stash + `finish(status, outcome?)` (D10); add `@bugsee/performance` to `node/package.json`. | §8.1 |
| **2** | **`node:http` interceptor** | `http-server-interceptor.ts`: emit patch (http + https), `install()`/`uninstall()` (restore by `delete`, D12), inbound `x-bugsee-internal` skip (D11), `res.once` + `writableFinished` guard. | §8.2 |
| **3** | **Launch wiring** | `instrumentIncomingRequests` (default **false**, D3) + the **concatenating** `serverInstrumentations` seam + the dedicated `carrier.serverPatch` slot (D12) + `stop()` uninstall + no-leak teardown. | §8.5 |
| **4** | **Bun/Deno** | **START with the §8.0 gating spikes** on real bun/deno; then native `Bun.serve`/`Deno.serve` installers injected via the seam; pin min versions; document `routes`/websocket/`reload` gaps (D9). | §8.0 → §8.3 → §8.6 |
| **5** | **Adapter refactor** | Refactor the 7 adapters onto the shared core (one commit each), keeping each adapter's own `shouldReport` + route extraction (D7); add per-adapter coexistence test. | §8.4 (existing suites + coexistence) |
| **6** | **Retire `server-adapters`** | Delete the package + workspace/lockfile; update docs/memory. Can land **right after slice 1** (nothing imports it — verified). | `check:cycles` + full build green |
| **7** | **Docs/memory** | `PROGRESS.md`, `CLAUDE.md`, supersede `generic-server-adapter.md`, refresh memory. | — |

Ordering constraints: slice 1 precedes everything (the core); the `@bugsee/performance` dep add is part of
slice 1; the §8.0 spikes gate slice 4's native wraps but **not** the build graph (the core ships without
them — if a runtime fails a spike, that runtime's node:http frameworks document-fall-back to the dedicated
adapter, §5.2). Slice 5 depends on slice 1 (the core) but is independent of slice 4.

---

## 4. Shared core — public API (`@bugsee/node`)

```ts
export interface ServerRequestInfo {
  method: string;
  url: string;            // → http.url (raw; redaction pipeline scrubs query secrets); query-stripped path is the name fallback (D11)
  route?: string;         // matched pattern → http.route + span name; refine via setRoute
  traceparent?: string;   // inbound W3C header value
  user?: string;          // resolved end-user identity (privacy-safe — only what the caller passes; default none)
}

export interface ServerInstrumentOptions {
  getClient?: () => Bugsee | undefined;       // default: process-singleton carrier client
  newContextId?: () => string;                // default: crypto.randomUUID
  shouldReport?: (err: unknown) => boolean;   // default: defaultShouldReport; adapters inject their own (D7)
  spanName?: (method: string, url: string) => string;  // default `${method} ${urlPathNoQuery(url)}` (D5)
}

export interface ServerRequestSpan {
  setRoute(route: string): void;
  captureError(err: unknown, opts?: { shouldReport?: (e: unknown) => boolean }): boolean; // reports iff shouldReport; bool = did-report (cross-seam dedup)
  finish(status: number, outcome?: 'OK' | 'ERROR' | 'CANCELLED'): void; // D10: default outcome status>=500?ERROR:OK
  cancel(): void;                                                        // CANCELLED  (no-op on a refining handle)
}

// run-scoped (http emit, native fetch, express, koa): owns-or-refines, runs `dispatch` in context, returns its result.
export function runServerRequest<T>(info: ServerRequestInfo, options: ServerInstrumentOptions, dispatch: (span: ServerRequestSpan) => T): T;
// enterWith variants (hook adapters whose hook returns before the handler):
export function openServerRequest(info: ServerRequestInfo, options?: ServerInstrumentOptions): ServerRequestSpan; // enterWith + own/refine + txn
export function openServerContext(info: ServerRequestInfo, options?: ServerInstrumentOptions): void;              // enterWith context only (Nest middleware)
export function startServerSpan(info: ServerRequestInfo, options?: ServerInstrumentOptions): ServerRequestSpan;   // txn only, in active context (Nest interceptor)
export const defaultShouldReport: (err: unknown) => boolean; // status≥500/no-status → report; getStatus()/status/statusCode/Boom; hostile-getter guarded
```

Replaces `server-adapters`' `openBugsee*` 1:1 under `server*` names; the engine's proven robustness (frozen
no-op span, hostile-getter status duck-typer, "never throws into the request") carries over. **`finish`
gains the `outcome` param (D10).** `http.url` is stored query-stripped (D11); `http.method` and
`http.status_code` unchanged.

---

## 5. Re-entrancy & the three mechanisms

### 5.1 Ownership model (D6) — invariants

- **No active context** → **owner**: mint a `RequestContext`, open via `run`/`enterWith`, start the
  `http.server` txn, `setTrace` onto the context, and **stash the `ServerRequestSpan` on the context**
  under `Symbol.for('bugsee.server.span')` (realm-global key → survives duplicate ESM/CJS copies; set
  non-enumerable). `finish`/`cancel` are real and **closure-based — they do NOT read `getCurrent()`**, so
  the `res 'finish'/'close'` listeners work regardless of the active context (verified, agent 2).
- **Active context already carries a stashed span** → **refiner**: return a handle whose `setRoute` /
  `captureError` act on the **owner's** span; `finish`/`cancel` are **no-ops**. No second context/txn.

**Documented invariants (agent 2):**
1. *Refiner mutators (`setRoute`/`captureError`) are valid only while the owner's context is the active
   store.* This holds for all 7 adapters because their hooks run synchronously inside the owner's
   run-scope; it would break only for an error seam that defers reporting to a detached async context.
2. *The owner finishes once; re-named at finish.* `finish` re-reads the (possibly refiner-updated) `route`
   closure → a refiner's `setRoute` is reflected. The adapter must call `setRoute(<framework route>)` at
   finish time (route extraction is per-adapter, §5.4).
3. *Error dedup is by thrown-object identity (`logException` tags the object); the first `logException`
   wins the report + its policy.* Matters only on the native-fetch path where both the wrap and an adapter
   might see the same throw (§5.3).
4. *Owner & refiner share one `RequestContext` object* because there is one `RequestContextStore` service
   per carrier-singleton client (`launch.ts:390`). A test pins that the store rides the carrier (not a
   per-module-copy instance), else a duplicate copy would mint a second context.
5. *Nested in-process servers are independent **owners**, not refiners* (corrected, agent 2): a cross-socket
   in-process call severs ALS, so the inner `emit` sees `getCurrent()===undefined`. Desired behavior; no
   child-span workaround needed. Refiner collapse is scoped to a single synchronous `emit` dispatch.

### 5.2 `node:http` emit patch (`http-server-interceptor.ts`)

Patch `http.Server.prototype.emit` and `https.Server.prototype.emit` separately — `https.Server` inherits
`EventEmitter.prototype.emit` via the `tls.Server`→`net.Server` chain, **not** via `http.Server.prototype`,
so patching `http.Server.prototype` alone misses HTTPS. (The outbound interceptor patches the `http`/`https`
**module functions** `request`/`get` separately, `http-interceptor.ts:231-244` — note **no
`Server.prototype.emit` patch exists in the repo yet; this mechanism is new**.) For `emit('request', req, res)`:

```
if (event !== 'request') return originalEmit.apply(this, args);   // all other events pass straight through
if (hasInternalHeader(req.headers)) return originalEmit.apply(this, args);   // D11 incoming self-isolation
return runServerRequest({ method: req.method, url: req.url, traceparent: req.headers.traceparent }, opts, (span) => {
  res.once('finish', () => { span.setRoute(adapterRoute?); span.finish(res.statusCode); }); // once + idempotent
  res.once('close',  () => { if (!res.writableFinished) span.cancel(); });                   // explicit guard
  return originalEmit.apply(this, args);   // synchronous dispatch, inside store.run(context); preserves emit's boolean return
});
```

- **Prototype patch** covers servers created any way; must run before traffic flows — `launch()` at startup
  satisfies it (no `--import` preload, unlike outbound patching / Sentry).
- **Restore by `delete`** (D12): capture `Object.prototype.hasOwnProperty.call(proto,'emit')` at install
  (false on a pristine prototype) → on uninstall, `delete proto.emit` rather than reassign, so the
  prototype returns to inheriting `EventEmitter.prototype.emit` (no residual own-property).
- **Dedicated carrier slot** (D12): one patch per process across duplicate module copies, via a NEW named
  `BugseeCarrier` field (e.g. `carrier.serverPatch`) distinct from `carrier.interceptors` — **not** via
  `getOrCreateInterceptor` (which would drag in `InterceptorBase` subscriber-gating). Explicit
  `install()`/`uninstall()` driven by `launch()`/`stop()`. Does **not** change the
  `getOrCreateInterceptor` registry size.
- `emit`'s boolean return (`hadListeners`), listener `this`, and arg arity are preserved.
- **Bun/Deno:** Express/etc. run through `node:http` compat, so this installer flows to them via the
  re-exported `node` composition. **That `'request'` actually dispatches through `Server.prototype.emit` on
  Bun's and Deno's compat is a GATING spike (§8.0).** If a runtime does NOT route through it, node:http
  frameworks on that runtime are **not auto-instrumented in v1** — the documented fallback is the
  **dedicated framework adapter** (which hooks the framework, not `node:http`, so it works on any runtime);
  the native wrap (§5.3) covers idiomatic native apps. (The earlier "rely on the native wrap instead"
  fallback was unsound — native wraps don't fire for Express-on-Bun. Corrected, agent 3.)

### 5.3 Native `Bun.serve` / `Deno.serve` wraps (`@bugsee/bun` / `@bugsee/deno`)

`Request → Response`. Wrap the user's handler and `run`-scope it:

```
runServerRequest({ method: request.method, url: request.url, traceparent: request.headers.get('traceparent') ?? undefined }, opts, async (span) => {
  try { const res = await originalHandler(request, info); span.finish(res.status); return res; }
  catch (err) { span.captureError(err); span.finish(500, 'ERROR'); throw err; }
});
```

- **Replace the global** (`Bun.serve` / `Deno.serve`): both are writable (Deno namespace reassignable since
  v1.12; Bun interceptable — Sentry uses a call-Proxy). **Wrap the handler/options, NOT the returned
  `Server`** (Bun does internal `instanceof` checks that fail on a wrapped instance). Each installer
  self-skips when its global is absent.
- **Handler forms (D9, spike-scoped):** v1 wraps `Bun.serve({ fetch })` and all `Deno.serve` overloads
  (handler-first, options-first, `{ handler, onError }`). **`Bun.serve({ routes })`, websocket, and
  `server.reload()`-survival are KNOWN GAPS** (documented; `reload` rebinding is a follow-up — Sentry had to
  special-case it).
- **Error-capture asymmetry (hedged, agent 3):** a throw escaping the handler round-trips through our wrap
  → we *can* `captureError` it (unlike the node:http path). **Verified for Deno bare-handler; for Bun this
  is conditional on the user's first-class `error` callback** (it may intercept the throw before our wrap).
  Policy: if the user supplies `error`/`onError`, defer to it (don't double-report) — pinned by the §8.0
  spike.
- **Injected** via `launchCore({ serverInstrumentations: [bunServeInstaller] })`; bun/deno installers stay
  on **plain-value types** (no `@bugsee/performance` types) so they need no new dep.

### 5.4 The 7 adapters on the shared core (D7)

Each adapter delegates context/txn mechanics to the core, keeping its **own `shouldReport` + route
extraction**, and at finish calls `span.setRoute(<its route field>)` (route fields differ per adapter:
express `req.route?.path`, fastify `routeOptions?.url`, koa `_matchedRoute`, hapi `route?.path`, elysia
`route`, hono `routePath`, nest `route?.path ?? routeOptions?.url`):

| adapter | open | finish | error / shouldReport |
|---|---|---|---|
| express | `runServerRequest` in `requestHandler` | `res 'finish'/'close'` → `finish(res.statusCode)` | `errorHandler` → `captureError` |
| koa | `runServerRequest` (wraps `next`) | `finish(errorStatus ?? ctx.status)`, `errorStatus = httpErrorStatus(err) ?? 500` | catch → `captureError`; re-throw |
| fastify | `openServerRequest` (enterWith) onRequest | onResponse → `finish`; onRequestAbort → `cancel` | onError → `captureError` |
| hapi | `openServerRequest` onRequest | onPreResponse → `finish`; disconnect → `cancel` | onPreResponse(boom) → `captureError`; **`isServer`-only `shouldReport`** |
| elysia | `openServerRequest` onRequest | mapResponse → **`finish(status, codeOutcome)`** (D10) | onError → `captureError({shouldReport: code-based})` |
| hono | `runServerRequest` (1 mw) | `finish(c.res.status)` | after next → `captureError(c.error)` (`getResponse` duck-type) |
| nestjs | `openServerContext` (mw) + `startServerSpan` (interceptor) | interceptor finalize → **`finish(status, errOutcome)`** (D10) | interceptor/filter → `captureError`; `'both'` dedup via bool return; **5xx-HttpException policy** |

With the flag **on**, the adapter's open becomes a **refiner**; **off**, it is the **owner** = identical to
today. Both exercised by the coexistence tests (§8). **D10's outcome param is load-bearing for nestjs +
elysia**; the other 5 use the default outcome.

---

## 6. Launch wiring (`@bugsee/node` `launch.ts`)

- `instrumentIncomingRequests?: boolean` — **default `false`** (D3). When true: build + `install()` the
  `node:http` interceptor (dedicated carrier slot, D12) + `install()` each injected `serverInstrumentations`.
- `serverInstrumentations?: ServerInstallable[]` — each `{ install(deps): void; uninstall(): void }`,
  self-skipping when its runtime global is absent. node always adds its own `node:http` installer when the
  flag is on, and **concatenates** platform-injected + caller-supplied ones
  (`[...platformInstallers, ...(options.serverInstrumentations ?? [])]`) — bun/deno inject their native
  `serve` installer this way, so a user passing their own array does NOT drop the platform's (a naive
  spread-replace would).
- `incomingRequestSpanName?: (method, url) => string` — forwarded to the core (D5 hook).
- `stop()` calls `uninstall()` on every server instrumentation (restore `emit` via `delete`, restore
  `Bun.serve`/`Deno.serve`), then clears the carrier slot — mirroring the existing interceptor teardown.
  Because the installer is install-driven (not subscriber-gated), tests that `launch()` without `stop()`
  must not leak the patch: the unit suite either always `stop()`s, or the installer is auto-restored on the
  carrier-slot delete (decided in slice 3).
- **Privacy (D11):** no end-user identity unless a `user` getter is supplied (default OFF); no request
  headers/bodies captured; `http.url` is raw (query secrets scrubbed by the redaction pipeline); inbound
  `x-bugsee-internal` skipped.

---

## 7. Non-functional

- **Overhead:** one prototype-method patch per process (negligible); per request one context alloc + one
  `http.server` txn — exactly what the adapters already do; re-entrancy adds a `getCurrent()` check + a
  symbol read/write. Transitional note (agent 5): until an adapter is refactored, an opted-in app running
  that adapter has the adapter's `res.once` finalizers **and** the emit patch's `res.once` listeners (two
  sets); the refiner attaches none, so post-refactor it collapses to one.
- **Safety:** nothing throws into the request pipeline — every branch try-guarded, degrades to
  pass-through / context-only; missing performance ext → context-only; no client → inert no-op.
- **Reliability:** keep-alive correctness via `run`-scoping (D4); `res 'close'` is per-request (not
  per-socket) so keep-alive reuse does not spuriously cancel (verified, agent 2); client-abort → CANCELLED.

---

## 8. Testing (test-first, per-entity mutator loop, 100% line/fn ≥90% branch, multi-agent review to convergence)

**8.0 Gating empirical spikes FIRST (slice 4, real Bun + real Deno via the instrumentation-tests harness),
before the native wraps / adapter refactor depend on them:**
1. Does `'request'` fire through `(http|https).Server.prototype.emit` on Bun and Deno compat? (If not → that
   runtime's node:http frameworks are documented-unsupported in v1; native wrap + adapters remain.)
2. Does `run`-scoped ALS isolate **concurrent + keep-alive** requests inside native `Bun.serve`/`Deno.serve`
   handlers? (Sentry needed a dedicated `Deno.serve` integration for scope separation — this is the most
   load-bearing assumption.)
3. Does a handler throw reach our wrap **with and without** a user `error`/`onError` callback?
   Pin minimum Bun/Deno versions from the outcomes.

**8.1 Shared core** — both primitives; owner & refiner paths; frozen no-op span; hostile-getter
`defaultShouldReport`; `finish(status, outcome)` honors explicit outcome (D10); span stashed/read across
**simulated duplicate module copies** + a **double-patch test** (one `emit` patch only); `http.url`
query-stripped; **`RequestContext` is writable** (the symbol stash won't throw — core does not freeze it).

**8.2 `node:http` interceptor** — fake module + real `http.Server`: context active during the handler; txn
finishes on response; `close`-before-finish → cancel; `x-bugsee-internal` inbound skipped; two concurrent
requests isolated; keep-alive sequential no-leak + no spurious cancel; **uninstall via `delete` returns the
prototype to no-own-`emit`**; `emit` boolean return preserved.

**8.3 Native wraps** — bun/deno unit (fake global) + real-runtime e2e (per 8.0): native handler
instrumented, error captured (per the resolved policy), overloads covered.

**8.4 The 7 adapters** — existing 100%-coverage unit + real-framework e2e suites stay green post-refactor
(behavior pinned; `shouldReport`/route extraction + raw `http.url` unchanged — D11 keeps `http.url` raw, so
no existing assertion changes). Per-adapter **coexistence** test: flag ON + adapter → exactly one context,
one txn, route refined. For nestjs + elysia, pin the **cross-handle** path: the refiner passes the
error/code-derived outcome and the **owner's** `finish` honors it (D10).

**8.5 launch** — default-off installs nothing (existing suite untouched); `instrumentIncomingRequests:true`
installs; `stop()` uninstalls all; repeat launch after stop re-patches cleanly.

**8.6 e2e harness** — add an **incoming-server scenario** (raw `http.Server` + native `Bun.serve`/
`Deno.serve` in the app process) asserting the uploaded bundle carries the `http.server` txn + a
context-tagged entry. (Today the harness exercises only outbound fetch.)

---

## 9. Migration: retire `@bugsee/server-adapters` (D8)

- Move `server.ts` logic into `@bugsee/node` `server-instrument.ts` (rename `openBugsee*`→`server*`; add
  `run` variant, re-entrancy/refine, `finish` outcome, query-strip).
- **Add `@bugsee/performance` to `packages/node/package.json`** (type-only; runtime stays `client.ext`).
- Delete `packages/server-adapters`; regenerate `pnpm-lock.yaml`; `pnpm-workspace.yaml` `packages/*` glob
  auto-drops it.
- Update `docs/PROGRESS.md`, `CLAUDE.md`, `docs/design/generic-server-adapter.md` (mark superseded), and
  memory (`generic-server-adapter` → folded into a new `incoming-server-instrumentation` memory).

---

## 10. Risks & deferred

- **Refactoring 7 reviewed packages** — behavior-identical when the flag is off; per-adapter e2es are the
  net; one adapter per commit, re-reviewed.
- **Bun/Deno `node:http` emit interception + native-handler ALS isolation** — GATING spikes (§8.0); design
  degrades to "node:http frameworks on that runtime use the dedicated adapter" if emit-patching fails.
- **Span-stash on the context** — relies on context object identity (validated by isolation + carrier-
  singleton tests); `RequestContext` must not be frozen (checked).
- **Deferred:** flip D3 to **default-on** (follow-up, once proven + mitigated — **note the flip is NOT
  test-neutral**: it re-baselines the launch suite, which today relies on default-off-installs-nothing, and
  turns every adapter test into the refiner path; budget that test migration into the follow-up); an opt-in
  `http.url` query-strip; Bun `routes`/websocket + `server.reload()` survival; full `Deno.serve` options;
  HTTP/2 + WS `upgrade`; a per-path `shouldInstrumentRequest` predicate; portable extraction of the core
  (move the `RequestContextStore` interface/token to `@bugsee/core`) if an edge/Workers adapter needs it.

---

## 11. Review round 1 — findings resolution

| Finding (agent) | Severity | Resolution |
|---|---|---|
| `finish(status)` can't express nest/elysia outcome (4) | MAJOR | **D10** explicit outcome param |
| Default-on blast radius: self-instrument, test breakage, teardown leak, PII (5) | MAJOR×5 | **D3** → default-off v1; **D11** self-isolation + query-strip; **D12** clean install/uninstall |
| Interceptor vs `ServerInstallable` contradiction (5) | MAJOR | **D12** dedicated carrier slot, explicit install/uninstall |
| `emit` restore leaves residual own-prop (5) | MAJOR | **D12** restore by `delete` |
| Native surface > `fetch`; `reload` defeats wrap (3) | MAJOR | **D9** spike-first common forms; gaps documented |
| "fallback to native wrap" unsound (3) | MAJOR | §5.2 corrected: fallback is the dedicated adapter; spike-gated |
| Native-handler ALS scope separation unflagged (3) | MAJOR | §8.0 gating spike; §10 risk |
| Asymmetry "(verified)" overstated (Bun `error`) (3) | MAJOR→hedged | §5.3 policy + §8.0 spike |
| D7 "byte-identical" overstated for shouldReport (4) | MAJOR→reworded | **D7** = shared mechanics; per-adapter shouldReport/route |
| node `@bugsee/performance` dep missing from checklist (1) | MINOR | §9 adds it |
| D4 "enterWith leaks" not reproducible (2) | doc | **D4** rationale corrected |
| Nested-server framing inverted (2) | doc | §5.1 invariant 5 corrected (independent owners) |
| `close→cancel` guard / `once` / `isFinished` (2,5) | MINOR | §5.2 explicit guard + `once` |
| refiner-invariant, dedup-first-wins, store-carrier-singleton (2) | doc | §5.1 invariants 1,3,4 |
| double-patch / RequestContext-not-frozen (1) | MINOR | §8.1 tests |
| publishConfig/exports, tsconfig `types` non-issues (1) | dismissed | no change (inherited; type imports resolve via package, not ambient) |
| nested-server "child span" workaround (2 prompt premise) | dismissed | non-bug; §5.1 invariant 5 |

---

## 12. Review round 2 — findings resolution (convergence check)

Round 2 (2 agents) verified the round-1 fixes against the code and hunted for revision-introduced issues.
**Confirmed correct:** D10 (engine already has `finishWith(status, outcome)`), D12 delete-restore +
dedicated carrier slot, D3 default-off propagation, the store-carrier-singleton invariant, span-stash
won't leak into the bundle (`bundle-assembler`/`capture-aggregator` read only named fields), the
transitional double-listener is harmless (≤4 `res` listeners < Node's 10), no perf-dep cycle, D8 zero
fan-out. Real findings (all small, now folded in):

| Finding (both agents unless noted) | Severity | Resolution |
|---|---|---|
| D11 `http.url` query-strip breaks adapters' pinned behavior (`express/middleware.test.ts:94`) | MAJOR | **D11 reworked**: keep `http.url` raw; redaction pipeline scrubs query; name still strips. §4/§6/§8.4 updated. Opt-in strip deferred (§10). |
| No enumerated slice plan (slices referenced, never defined) | BLOCKER | **§3.1 slice plan added** (1–7, gates, ordering). |
| D3 "flip to default-on later" is not test-neutral | MAJOR (1-line) | §10 note added (re-baselines launch suite + adapter→refiner). |
| `serverInstrumentations` spread-replace drops the platform's native installer | MINOR | §6: **concatenate** platform + caller arrays. |
| D12 carrier field under-named | MINOR | §5.2: named `carrier.serverPatch`. |
| §5.2 cites `http-interceptor.ts:235` implying a `Server.prototype` precedent | MINOR | §5.2: reworded — outbound patches module fns; no prototype-emit patch exists; this is new. |
| Goal line "later default-on" reads as present-tense | cosmetic | reworded "(a follow-up)". |

**Verdict (both agents):** with these doc fixes, the design is **build-ready — start slice 1.**
</content>
