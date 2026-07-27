# Adversarial review — @bugsee/hono + hapi + elysia

**Reviewed:** 2026-07-27 · **Scope:** `packages/hono` (impl 135 / tests 349), `packages/hapi` (impl 182 / tests 386), `packages/elysia` (impl 196 / tests 397)
**Frameworks/runtimes actually exercised:** hono 4.12.25, @hapi/hapi 21.x, elysia 1.4.28 — all real, never mocked. Node 24.15.0 (vitest, plus real `node:http` sockets and a real Hapi socket server), **Bun 1.3.14 (real `Bun.serve` via `app.listen`, incl. a real WebSocket upgrade)**, **Deno 2.8.3 (real `Deno.serve`)**. Edge reach settled by bundling the adapter with esbuild 0.25.12 under `workerd`/`worker`/`edge-light` conditions (no deployment to any real edge platform).

**Verdict:** Hapi is the strongest of the three and I found no host-request-safety defect in it at all. Elysia is close behind — it survives every throw I could inject, and it is genuinely correct on real Bun (per-request isolation, WebSocket upgrade, `Bun.serve`). **Hono is the outlier and falls on the same side as express+koa: it is the only one of the three with unguarded SDK work in the request path, and I turned a healthy `200` into a `500` two different ways, one of which needs nothing more than a user-supplied `user` extractor that throws.** Both its source header and its README claim the opposite. Separately, the raw-query-string leak flagged in the sibling group **is real and reaches the wire for all three** — but not because these adapters leak: all three correctly strip the query, and the leak is injected by the default `node:http` owner whose context wins under first-owner-wins, discarding the adapter's clean value. Finally, `@bugsee/hono` cannot be imported at all on Cloudflare Workers or Vercel Edge — the runtimes Hono is best known for. First-owner-wins itself is sound: I measured exactly one context and one transaction with the real emit patch active.

## SEV1

### 1. Hono: an SDK-internal throw — or a throwing `user` extractor — turns a 200 into a 500
- **Package(s):** hono
- **Where:** `packages/hono/src/middleware.ts:82`, `:83`, `:91`, `:95-100`
- **What:** `bugseeHono` is the only one of the three adapters that runs SDK code in the request path **without a `try/catch`**. Four unguarded call sites: `c.req.header('traceparent')` (:82), `options.user?.(c)` (:83), `runServerRequest(...)` (:91), and the whole `finally` body `span.setRoute / span.captureError / span.finish` (:95-100). Hono's `compose` catches whatever the middleware throws, assigns it to `c.error` and routes it to `app.onError` — so an SDK fault is laundered into an application error and returned to the client as `500 Internal Server Error`.
- **Why it matters:** the request path must be inert. Two of the four sites are reachable without any SDK bug at all: `options.user` is an **application-supplied callback** (`user: (c) => c.req.header('authorization').split(' ')[1]` throws a `TypeError` on every unauthenticated request), and `runServerRequest` → `resolveStore` (`packages/node/src/server-instrument.ts:341`) is unguarded, so the confirmed `@bugsee/service` behaviour — `getImmediate({ optional: true })` **rethrows** the factory error on first access (`packages/service/src/index.ts:170` falls through to `instantiate()`, which rethrows at `:108-112`; only the *second* call returns `null` via the `failure` branch at `:152-155`) — propagates straight into the response. Its two structural peers guard exactly these operations: `packages/hapi/src/hooks.ts:110-137` and `:142-162`, `packages/elysia/src/hooks.ts:127-140`, `:144-162`, `:166-179`.
- **Evidence:** real Hono 4.12.25 app, `getClient` returning a client whose `getImmediate` throws:
  - `P1` — route returning `APP-OK`, no SDK fault in the app itself → **`status=500 body="Internal Server Error"`** (uninstrumented control: `200 APP-OK`).
  - `P3` — `getClient: () => undefined` (no SDK at all) + a `user` extractor that throws → **`status=500`**. The pass-through path is not a pass-through.
  - `P2` — app installs its own `app.onError`; the SDK throws at `:91`, i.e. **before `next()`** → `onError saw= [ 'SDK-INTERNAL-BOOM' ]` and body `APP-ONERROR`. The application handler **never ran**, and the app's error handler was handed the SDK's internal error.
  - Same three probes against hapi (`H1`) and elysia (`E1`), with the identical throwing client **and** a throwing `user` extractor: both returned **`200 APP-OK`**.
- **Also:** `packages/hono/src/middleware.ts:15` states *"Fully defensive: never throws into the request"* and `packages/hono/README.md:43` states *"**Never breaks the app** — every step is guarded"*. Both are false as written. The equivalent Hapi claim (`packages/hapi/README.md:42`) I verified to be true.

### 2. The raw query string reaches the wire unredacted — for all three, on the default install path
- **Package(s):** hono, hapi, elysia
- **Where:** root cause `packages/node/src/http-server-interceptor.ts:141` + `packages/node/src/server-instrument.ts:244`; the adapters' clean values that get discarded are `packages/hono/src/middleware.ts:86`, `packages/hapi/src/hooks.ts:116`, `packages/elysia/src/hooks.ts:132`; the discard happens at `packages/node/src/server-instrument.ts:313-317`.
- **What:** all three adapters are, on their own, **privacy-clean** — each deliberately passes a query-free path (`c.req.path`, `request.path`, `new URL(...).pathname`). But `instrumentIncomingRequests` defaults to `true` (`packages/node/src/launch.ts:784`), so on Node the `node:http` emit patch opens the context **first** with `url: req.url ?? ''` — the raw request target. Under first-owner-wins the adapter becomes a *refiner* (`server-instrument.ts:313-317`) and its clean `info.url` is **never used**; the owner's context is the one stamped onto entries and merged into the manifest (`packages/core/src/bundle-assembler.ts:177-181`).
- **Why it matters:** this is the systemic leak confirmed in the express/fastify/koa group, and it is *not* fixed by an adapter doing the right thing. Query strings routinely carry `token`, `api_key`, `password`, `email`, signed-URL signatures and OAuth codes.
- **Evidence:** real `launch()` (defaults, `instrumentIncomingRequests` untouched) behind a real `node:http` server, one request to `/users/42?token=SUPERSECRET&email=victim%40example.com&password=hunter2`, uploaded bundle inspected:
  - **Hono** — `manifest.json` → `"attrs":{"http.method":"GET","http.url":"/users/42?token=SUPERSECRET&email=victim%40example.com&password=hunter2","http.route":"/users/:id"}`
  - **Hapi** (real socket server, not `inject`) — `"attrs":{...,"http.url":"/users/42?token=SUPERSECRET&email=victim%40example.com&password=hunter2","http.route":"/users/{id}"}`
  - Note `http.route` is correctly parameterized in both — the adapter's route refinement *does* land; only its clean URL is dropped.
  - **Not present on Bun or Deno**: neither native `serve` wrap is installed on this install path, so the adapter owns the context and its clean path-only URL survives. Measured `http.url = "/work"` on Deno for a request carrying `?d=2&token=SECRET`, and no leak on Bun. The leak is specific to the `node:http`-hosted case — which is the default for Hapi and for Hono-on-Node.
  - Mutation control: forcing each adapter to send the raw URL (`H-M6`, `E-M7`) is **caught** by the existing suites, so the adapters' own intent is properly pinned.

### 3. `@bugsee/hono` cannot be imported on Cloudflare Workers or Vercel Edge
- **Package(s):** hono
- **Where:** `packages/hono/src/index.ts:7` (`export * from '@bugsee/bugsee/node'`) + `packages/hono/package.json` `exports` (only `"."`, no `worker`/`workerd`/`edge-light`/`browser` condition and no adapter-only subpath)
- **What:** the single-install re-export hard-wires the **Node** umbrella entry. The `./node` subpath of `@bugsee/bugsee` is unconditional, so there is no condition an edge bundler can select to get anything else. Bundling the documented usage — `import { launch, setupHono } from '@bugsee/hono'` — statically requires:
  `node:async_hooks node:buffer node:crypto node:fs node:http node:https node:inspector node:os node:path node:perf_hooks node:process node:worker_threads node:zlib`
  …**identically** under `['workerd','worker','browser','import']`, `['worker','import']`, and `['edge-light','worker','import']` (Vercel). `node:inspector` and `node:worker_threads` are not provided by workerd's `nodejs_compat` under any flag, and `node:fs`/`node:http` are at best partial — these are static ESM imports, so the worker fails at module evaluation, not lazily.
- **Why it matters:** Hono's identity *is* edge — Workers and Vercel Edge are its flagship targets. `packages/hono/README.md:6` waves at this (*"edge/Workers follow the edge platform packages"*) but there is no import path that delivers it: `@bugsee/hono` gives you the Node SDK, and the README's own `import { launch } from '@bugsee/bugsee'` resolves `.` → the **browser** condition on an edge bundler, not `@bugsee/cloudflare`/`@bugsee/vercel-edge`. So a Hono-on-Workers user has no working documented install.
- **Evidence:** esbuild 0.25.12, `platform:'neutral'`, `external:['node:*']`, three condition sets — output above. Honest nuance: importing **only** `setupHono` (no `launch`) does tree-shake the Node SDK away (`sideEffects:false`) and needs just `node:async_hooks`, which workerd does provide — but that yields an adapter with no way to start the SDK.

## SEV2

### 4. Elysia: an unmatched route never finishes its `http.server` transaction
- **Package(s):** elysia
- **Where:** `packages/elysia/src/hooks.ts:165-180` (`mapResponse`) vs `:126-141` (`onRequest`)
- **What:** `onRequest` always opens the context + transaction, but Elysia short-circuits a `NOT_FOUND` before `mapResponse`, so `state.span.finish(...)` is never reached. Every 404 leaves an unfinished transaction.
- **Why it matters:** consequences are real but **bounded — I want to be explicit that this is *not* the unbounded memory leak it looks like.** The perf controller holds a **single** `active` slot (`packages/performance/src/controller.ts:78, 112-113`) and `states` is a `WeakMap` keyed by the `Request` (`hooks.ts:124`), so nothing accumulates on the heap. What actually breaks: (a) 404s produce **no APM transaction at all** — never finished means never serialized or uploaded, so 404 traffic is invisible in APM; (b) the single `active` slot is left pointing at a dead request until the next `startTransaction`, so any span created in that window attaches to a transaction that will never be finished and is silently dropped.
- **Evidence:** real `Bun.serve` (`app.listen`), Bun 1.3.14: `after 25x 200 -> started=25 unfinished=0`, then `after +25x 404 -> started=50 unfinished=25`. Reproduced on Node via `app.handle` (50 × 404 → 50 unfinished). Every other path is clean — `/ok`, JSON return, a raw `Response`, a thrown error, a 302 redirect, and a **WebSocket upgrade on real Bun** all finish. Hapi and Hono both finish their 404s correctly (`GET /{p*}` status 404, `GET /*` status 404, 0 unfinished).

### 5. `setupHapi(server)` and `setupElysia(app)` do not typecheck against the real framework
- **Package(s):** hapi, elysia
- **Where:** `packages/hapi/src/hooks.ts:50-52` (`HapiServerLike.ext`), `packages/elysia/src/hooks.ts:46-50` (`ElysiaAppLike`); broken doc at `packages/hapi/README.md:16`
- **What:** passing a real instance fails `tsc`:
  - hapi — `TS2345: Argument of type 'Server<ServerApplicationState>' is not assignable to parameter of type 'HapiServerLike'. Types of property 'ext' are incompatible … Type 'string' is not assignable to type 'ServerExtEventsRequestObject | …'` (hapi's `ext` is an overload set; the structural single-signature type does not unify).
  - elysia — `TS2345: Argument of type 'Elysia<"", {...}>' is not assignable to parameter of type 'ElysiaAppLike'`.
  Both need `as unknown as …` — a **double** cast, which disables all checking of the seam.
- **Why it matters:** `packages/hapi/README.md:16` shows `setupHapi(server, { user: (req) => req.headers['x-user'] })` with **no cast — that quick-start does not compile.** The Elysia README (`:16-18`) does document the cast, so it is honest, but for a framework whose entire value proposition is type inference, a mandatory double cast is a real DX defect. `setupHono(app)` typechecks cleanly against a real `Hono` — so this is not inherent to the structural-peer pattern.
- **Evidence:** `pnpm --filter @bugsee/<pkg> exec tsc --noEmit` on a 4-line file constructing the real instance and calling `setup*` with no cast; hono OK, hapi + elysia error. Each package's own suite typechecks clean at baseline.

### 6. Elysia records `http.status_code: 200` for non-200 responses
- **Package(s):** elysia
- **Where:** `packages/elysia/src/hooks.ts:175`
- **What:** `typeof c.set.status === 'number' ? c.set.status : (state.status ?? 200)`. When the handler returns a raw `Response` or uses Elysia's `status()` helper, `c.set.status` is not a number and no error `code` was classified, so it falls through to the literal `200`.
- **Evidence:** handler returning `new Response('raw', { status: 201 })` → `["txn.attr","http.status_code",200]`; handler returning `status(404,'nope')` → `["txn.attr","http.status_code",200]`. Explicit `set.status = 302` is recorded correctly (302), as is the error-code-derived 500. Hapi reads the real response object (`responseStatus`, `hooks.ts:77-83`) and got 200/500/302/404 all correct; Hono reads `c.res.status` and got 200/500/302/404 all correct.

## SEV3

### 7. Surviving mutant (elysia): no test pins the route-parameterized transaction name
- **Where:** `packages/elysia/src/hooks.ts:172`
- Deleting `state.span.setRoute(nameRoute(c))` **survives the entire 30-test Elysia suite** (the only survivor in a 25-mutation battery). It is not behaviour-neutral: with the mutation the finished transaction is named **`GET /users/42`**, without it **`GET /users/:id`**. That is the cardinality *and* PII control for span names — an id, email or token in a path segment would land in the transaction name unnoticed. The equivalent hono (`H-M3`) and hapi (`P-M3`) mutations are both caught.

### 8. Hapi: a client-aborted request is named with the pre-routing catch-all
- **Where:** `packages/hapi/src/hooks.ts:112` (comment says `route` is "usually undefined at onRequest" — empirically it is `/{p*}`, i.e. truthy) and `:157` (the refinement that never runs on abort)
- On a client disconnect, `onPreResponse` is skipped, so `setRoute` never runs and the CANCELLED transaction is named from `info.route`. Measured on a real socket server with a real `AbortController`: request to `/slow` → `["txn.setName","GET /{p*}"]`, `["txn.FINISH","CANCELLED"]`. The cancel itself is correct and leak-free — only the name is wrong, so aborted requests are unattributable to a route.

### 9. Hono: a streaming/SSE response finishes its span at the headers, not at end-of-stream
- **Where:** `packages/hono/src/middleware.ts:100`
- `span.finish(...)` runs in the `finally` right after `next()` resolves, which for a `ReadableStream` body is before a single byte is written. Measured ordering: `txn.FINISH OK` → *"response returned to client"* → *"stream still writing"* → *"stream fully consumed"*. No leak, but streaming/SSE durations are under-measured. (The `node:http` owner does not have this problem — it finishes on `res 'close'`, `http-server-interceptor.ts:151-157` — so under the default re-entrant setup the owner's timing is correct and only the standalone-adapter case under-measures.)

### 10. Test theater: none of the three suites exercise the default `node:http` re-entrancy path
- **Where:** `packages/hono/src/hono-integration.test.ts:101` (`app.request`), `packages/hapi/src/hapi-integration.test.ts:109` (`server.inject`), `packages/elysia/src/elysia-integration.test.ts:102` (`app.handle`)
- Credit first: these are **real** frameworks, not mocks, and the concurrency tests are genuine — three overlapping requests with staggered delays and per-request assertions that would catch contamination. That is well above the bar. But all three drive the framework **in-process**, bypassing the socket layer, so with `instrumentIncomingRequests` defaulting to `true` the adapter is always the *owner* in tests and **never the refiner** — the actual production topology. That is why both SEV1 #2 (owner's raw URL wins) and the whole first-owner-wins interaction are untested here; I had to build the `node:http` harness myself to see either.
- Additionally: **the entire Elysia suite runs under Node**, for a **Bun-first** framework. `elysia-integration.test.ts:7` acknowledges this. It proves little about real deployment — I ran the same scenarios under real Bun 1.3.14 and they did pass, but that is a fact the suite does not establish.
- Minor harness note for whoever extends these: Elysia's URL fast-path needs a realistic host — `new Request('http://x/ok')` 404s on a correctly-registered route while `http://localhost/ok` works. The existing tests use `http://localhost`, so they are fine.

## Per-package summary

| package | SEV1 | SEV2 | SEV3 | headline |
|---|---|---|---|---|
| `@bugsee/hono` | 3 (#1, #2, #3) | 0 | 3 (#9, #10, + #2 blast) | Only adapter that 500s the host request; unusable on the edge runtimes Hono is famous for |
| `@bugsee/hapi` | 1 (#2) | 1 (#5) | 2 (#8, #10) | Cleanest of the three — no host-request defect found; README quick-start does not compile |
| `@bugsee/elysia` | 1 (#2) | 3 (#4, #5, #6) | 2 (#7, #10) | Correct on real Bun incl. WebSockets; 404s never finish their transaction |

## Host-request safety matrix

| package | SDK throw 500s request? | hangs it? | swallows app error? | clobbers app `onError`? | evidence |
|---|---|---|---|---|---|
| `@bugsee/hono` | **YES** | No | **YES** — throw at `middleware.ts:91` pre-empts `next()`, so the handler never runs and `app.onError` receives the SDK's error | **No** — `setup.ts:14` only calls `app.use`; verified `app.onError` still runs and still owns the response | P1 `500 "Internal Server Error"`; P2 `onError saw=['SDK-INTERNAL-BOOM']`; P3 throwing `user` → `500`; P5 `appOnErrorRan=true`, HTTPException still `404` |
| `@bugsee/hapi` | No — `200 APP-OK` | No | No | N/A (extensions are additive; both return `h.continue`) | H1 with throwing store **and** throwing `user` → `200 APP-OK`; H3 response byte-identical to uninstrumented (`203`, body `B`, `x-a: 1`) |
| `@bugsee/elysia` | No — `200 APP-OK` | No | No | **No** — `onError` is additive in Elysia; the app's handler still runs | E1 with throwing store **and** throwing `user` → `200 APP-OK`; E4 chaining still resolves `/b` |

Hono therefore lands on the **express+koa** side; hapi and elysia land on the **fastify** side.

## Runtime reach verdict

| package | Node | Bun | Deno | Cloudflare/workerd | Vercel Edge | context isolation works? |
|---|---|---|---|---|---|---|
| `@bugsee/hono` | ✅ verified (real `node:http`) | ✅ (shares the Elysia-proven path) | ✅ **verified on real `Deno.serve`**, Deno 2.8.3 | ❌ **cannot import** (SEV1 #3) | ❌ **cannot import** (SEV1 #3) | ✅ Node + Deno verified with 3 concurrent distinct identities |
| `@bugsee/hapi` | ✅ verified (real socket server) | n/a (Hapi is Node-only) | n/a | n/a | n/a | ✅ verified, 3 concurrent |
| `@bugsee/elysia` | ✅ verified (`app.handle`) | ✅ **verified on real `Bun.serve` + real WebSocket upgrade**, Bun 1.3.14 | ✅ (same `@bugsee/node` path) | ❌ same import blocker as hono | ❌ same import blocker as hono | ✅ **verified on real Bun** — `enterWith` works, 3 concurrent all correct |

Two priors I must correct against the code:
- **`AsyncLocalStorage.enterWith` works on Bun.** Measured `true`, and three overlapping requests were attributed correctly end-to-end through real `Bun.serve`. Elysia's per-request context is **not** inert on Bun.
- **No native `serve` wrap is installed on either Bun or Deno** via this install path (`packages/bun/src/launch.ts:28` injects it, but the adapters re-export `@bugsee/bugsee/node` → `@bugsee/node`'s `launch`, which installs only the `node:http` patch at `packages/node/src/launch.ts:784`). Verified: `Bun.serve` reports as native/unwrapped. The practical effect is **benign and even favourable** — the adapter becomes the sole owner, so there is no double instrumentation and its privacy-clean URL survives (no SEV1 #2 leak on Bun/Deno).

The workerd/inert-ALS prior is moot for these adapters: they cannot be loaded on workerd at all.

## Concurrency verdict

Real overlapping requests, three distinct identities, staggered delays so completion order is the reverse of dispatch order, asserting that each report's `context_id` correlates only its **own** log line:

- **hono** — Node in-process: 3 distinct `context_id`, emails `{alice,bob,carol}`, each report's own log = `processing <its own email>`. **Real Deno + `Deno.serve` over real sockets: `ATTRIB_OK=true` ×3.** No bleed.
- **hapi** — real Hapi lifecycle across `onRequest` → handler → `onPreResponse`: 3 distinct `context_id`, correct emails, correct own-logs. `enterWith` correlates across extensions as designed. No bleed.
- **elysia** — Node `app.handle`: correct. **Real Bun 1.3.14 + real `Bun.serve` over real sockets: `ATTRIB_OK=true` ×3, three distinct contexts.** No bleed.

Harness validity control: I substituted a naive non-ALS store (`getCurrent` returning a plain module-level variable) into the same Elysia concurrency scenario and got `[{want:carol,got:carol},{want:bob,got:carol},{want:alice,got:carol}]` — i.e. the harness *does* detect cross-request contamination when it exists. **No cross-request contamination found in any of the three.**

## Double-instrumentation check

Empirical, with the **real** `createHttpServerInterceptor` installed (the default) plus the adapter, sharing one recording client:

- **hono** over a real `node:http` server → **1 transaction started, 0 unfinished**. Trace: `RUN /users/7?q=1` (the patch run-scopes the context) → `txn.START open=1` → `setUser u1` (the refiner propagates its user via `refiningHandle`, `server-instrument.ts:362-364`) → `txn.setName "GET /users/:id"` (the adapter's route refinement lands on the owner's span) → `txn.FINISH OK open=0`. **First-owner-wins works exactly as designed** — one context, one transaction, adapter data merged in.
- **hapi** over its own real socket server → one bundle, one context; the manifest carries the patch's `http.url` **and** the adapter's `http.route: /users/{id}`, which is only possible if the adapter refined a single shared owner rather than opening a second.
- **elysia on Bun** → the adapter is the sole owner (no `Bun.serve` wrap installed), so the question does not arise; 25 requests → 25 transactions, 0 duplicated, 0 unfinished.

No double transactions or double contexts anywhere. The one consequence of the refiner path is SEV1 #2 (the owner's raw URL wins over the adapter's clean one).

## Route extraction + privacy

| package | parameterized? | raw query string leaked? | file:line |
|---|---|---|---|
| `@bugsee/hono` | ✅ `GET /users/:id` (404 → `GET /*`) | **Adapter: NO** (`c.req.path`) · **On the wire under the default Node install: YES** | `packages/hono/src/middleware.ts:86`, `:63`, `:95` · leak via `packages/node/src/http-server-interceptor.ts:141` |
| `@bugsee/hapi` | ✅ `GET /users/{id}` (404 → `GET /{p*}`) | **Adapter: NO** (`request.path`) · **On the wire under the default install: YES** | `packages/hapi/src/hooks.ts:116`, `:71`, `:157` · same root cause |
| `@bugsee/elysia` | ✅ `GET /users/:id` | **Adapter: NO** (`new URL(...).pathname`) · **Bun/Deno: NO leak** (adapter owns) | `packages/elysia/src/hooks.ts:132`, `:88-96`, `:172` |

`shouldReport` verified per framework against the real error objects: Hono skips `HTTPException` (duck-typed `getResponse`) and reports plain `Error` — a `404` HTTPException stays `404` and produces no report; Hapi reports 5xx Boom (`isServer`) and skips the 404 client Boom; Elysia reports `UNKNOWN`/5xx codes and skips `NOT_FOUND`/`VALIDATION`. All three inversions are caught by their suites (`H-M5`, `P-M4`, `E-M4`). No header redaction is performed by any adapter — none of them reads headers beyond `traceparent` and the opt-in `user` getter, which is the right default.

## Checked and found clean

- **Hono does not clobber `app.onError`** — `setup.ts:13-15` only calls `app.use`; verified the app's own `onError` still runs, still owns the response, and an `HTTPException` still yields `404`. The `c.error`-observation design (rather than wrapping `onError`) is correct and correctly documented.
- **Hapi does not alter the response** — byte-for-byte identical status/body/headers vs an uninstrumented server (`203` / `B` / `x-a: 1`); both extensions return `h.continue` on every path incl. the catch branches (`hooks.ts:138`, `:163`).
- **Hapi client-abort handling is correct and leak-free** — real socket + real `AbortController`: `txn.FINISH CANCELLED`, 0 unfinished (`hooks.ts:124-134`).
- **Hapi lifecycle completeness** — success, thrown `Error` → 5xx Boom, 302 redirect, and 404 all finish; 0 unfinished across the matrix.
- **Hono lifecycle completeness** — success, thrown error, redirect, 404, and streaming all finish; 0 unfinished.
- **Elysia on real Bun: WebSocket upgrade finishes its span cleanly** — `txn.START` → `setName GET /ws` → `txn.FINISH OK`, 0 unfinished after upgrade and after close. No WS-related leak.
- **Elysia runtime chaining is not broken** — routes registered after `setupElysia` still resolve (the type-level problem is SEV2 #5; there is no runtime problem).
- **Elysia never breaks the app's error handling** — `onError` is additive, all three hooks are individually guarded, `logException` is fire-and-forget (`hooks.ts:158`).
- **First-owner-wins re-entrancy** — verified empirically, one context + one transaction (see above).
- **Mutation battery: 24 of 25 killed**, both deliberate controls killed (`H-CTRL` 4 failures, `P-CTRL` 4, `E-CTRL` 6), including every high-priority mutation the mandate called for: never-open-context (`H-M7` 17 failures, `P-M7` 8, `E-M6` 9), never-report (`H-M2` 7, `P-M5` 6, `E-M3` 7), inverted report policy (`H-M5` 10, `P-M4` 8, `E-M4` 2), dropped `await next()` (`H-M1`), dropped disconnect-cancel (`P-M2`), never-store-span (`P-M1` 5), wrong status (`H-M4`, `P-M6`, `E-M5`), and both privacy mutations (`H-M6`, `E-M7`). Only `E-M2` survived (SEV3 #7).
- **Baseline health** — hono 27/27, hapi 28/28, elysia 30/30 tests pass; all three `tsc --noEmit` clean.
- **Structural-peer discipline holds** — none of the three imports its framework at the value level; `hono` / `@hapi/hapi` / `elysia` are devDependencies only.

---

*All source modifications made during this review (temporary probe files and injected mutations) were reverted from `cp` backups; `git status --short packages/` is empty. No network requests to Bugsee infrastructure, no real credentials, no edge deployments; every server bound to `127.0.0.1` on an ephemeral port.*
