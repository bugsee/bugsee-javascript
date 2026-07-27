# Adversarial review — @bugsee/nestjs

**Reviewed:** 2026-07-27 · **Scope:** packages/nestjs (impl 570 lines across 6 files, tests 1379 lines across 6 files; 93 tests, all green, `tsc --noEmit` clean)
**Nest versions/platforms actually exercised:** NestJS **10.4.22** only (`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/platform-fastify` — the only versions present in `node_modules`), rxjs 7.8, Node **v24.15.0**. Real Nest apps booted on **both** `platform-express` and `platform-fastify`, bound to `127.0.0.1:0`, against an in-process recording transport (no network egress). Real `@nestjs/core` `ExecutionContextHost` used for the non-HTTP transport probes.
**Verdict:** The per-request isolation question — the one I was sent to break — comes back **clean**: I could not produce cross-request contamination on either platform, under concurrency, under HTTP/1.1 keep-alive on a single socket, or with `Scope.REQUEST` providers. The `enterWith` footgun is neutralised by the re-entrancy short-circuit at `middleware.ts:48`, and in the **default** configuration `enterWith` is never called at all (the `node:http` patch `run`-scopes first — measured `enterWith=0, run=1`). Re-entrancy is genuinely first-owner-wins: exactly **one** `http.server` transaction per request, correctly parameterized to `GET /users/:id`. The unit suite is strong (every mutation I injected was caught by it). But four SEV1s survive: the interceptor **throws a TypeError on every non-HTTP execution context** (microservices / WebSockets / GraphQL) and the guard meant to prevent that is tested against a scenario real Nest cannot produce; an unguarded `openSpan` call turns a failing context-store provider into a **500 on healthy requests** in the default mode; the opt-in global filter **silently either clobbers the app's own global filter or captures nothing**, depending purely on registration order; and the **raw query string with secrets ships in `manifest.json`** from this package's own `buildContext`. Separately, the real-Nest e2e's two headline claims (`both`-mode dedup, per-request context isolation) are **not load-bearing** — I removed the code each claims to prove and the e2e still passed.

## SEV1

### 1. `BugseeInterceptor.intercept` throws on every non-HTTP execution context (microservices / WebSockets / GraphQL)
- **Where:** `packages/nestjs/src/interceptor.ts:88` (unguarded `this.openSpan(...)`) → `interceptor.ts:137-138` → `packages/nestjs/src/shared.ts:50`, `shared.ts:56`. Guard that fails to guard: `interceptor.ts:78-84`. Installed globally by `packages/nestjs/src/setup.ts:48`.
- **What:** `setupNest` registers `BugseeInterceptor` as a **global** interceptor, which in Nest means it runs for *every* execution context, not just HTTP. The `try/catch` at `interceptor.ts:78-84` assumes `context.switchToHttp()` throws for a non-HTTP context. It does not: real Nest's `ExecutionContextHost.switchToHttp()` (`node_modules/@nestjs/core/helpers/execution-context-host.js:35-40`) unconditionally returns `{ getRequest: () => this.getArgByIndex(0), getResponse: () => this.getArgByIndex(1), ... }`. So for an RPC context `req` becomes the *message payload*, for WS the *socket*, for GraphQL the *root value* (`undefined`). Execution then falls into the **unguarded** `openSpan` at `interceptor.ts:88`, which dereferences `req.headers` at `interceptor.ts:138` → `shared.ts:50`.
- **Why it matters:** A hybrid app (`app.connectMicroservice(...)`), a WebSocket gateway, or a GraphQL resolver in the same Nest app as an HTTP server will throw inside the SDK on **every message/resolve**. This is the mandate's "a `setupNest` that assumes HTTP and breaks a microservice app" case. It is also **undocumented** — the only mention anywhere in the package or `docs/design/framework-adapters.md` is the comment at `interceptor.ts:83` asserting the opposite ("non-HTTP context (RPC/WS/GraphQL) → out of scope, pass through"). `README.md` says nothing about non-HTTP transports.
- **Evidence (measured, real `@nestjs/core` `ExecutionContextHost`):**
  ```
  [rpc]     new ExecutionContextHost([{orderId:1},{getData(){}}]); setType('rpc')
            → threw: TypeError: Cannot read properties of undefined (reading 'traceparent')
  [ws]      new ExecutionContextHost([socket,{msg:'hi'}]);         setType('ws')
            → threw: TypeError: Cannot read properties of undefined (reading 'traceparent')
  [graphql] new ExecutionContextHost([undefined,{id:'1'},{req},{info}]); setType('graphql')
            → threw: TypeError: Cannot read properties of undefined (reading 'route')
  ```
  (GraphQL trips one line earlier, at `matchedRoute(req)` — `interceptor.ts:137` → `shared.ts:56` — because `args[0]` is `undefined`.)

### 2. A failing context-store provider turns *successful* requests into 500s (default `errorCapture: 'interceptor'`)
- **Where:** `packages/nestjs/src/interceptor.ts:88` — `const span = this.openSpan(activeClient, req);` is the **only** call in the whole package's request path that is not wrapped in `try/catch`. It reaches `packages/nestjs/src/interceptor.ts:150` → `startServerSpan` → `packages/node/src/server-instrument.ts:279` (`const store = resolveStore(client);`, unguarded) → `getImmediate({ optional: true })`.
- **What / Why it matters:** This is the documented `@bugsee/service` SEV1 (`getImmediate({ optional: true })` rethrows on first access to a throwing factory) landing squarely on this adapter's **default** configuration. A request that would have returned `200 ok` returns `500 {"statusCode":500,"message":"Internal server error"}`. Every other seam in the package correctly defends against exactly this (`middleware.ts:40-53`, `interceptor.ts:67-71`, `interceptor.ts:78-84`, `interceptor.ts:97-105`, `interceptor.ts:109-117`, `filter.ts:42-54`, `filter.ts:87-95`) — `openSpan` is the single hole.
- **Evidence (real Nest, express + fastify, client whose `getServiceProvider(...).getImmediate()` throws):**
  ```
  errorCapture='interceptor' (default)  GET /ok → 500   {"statusCode":500,"message":"Internal server error"}
  errorCapture='both'                   GET /ok → 500   {"statusCode":500,"message":"Internal server error"}
  errorCapture='filter'                 GET /ok → 200   ok        ← isolates the throw site to the interceptor
  fastify platform, default             GET /ok → 500
  ```
  Also reproduced with only the `node-request-context-store` token throwing (the realistic shape of the service defect): `/ok → 500`, `/users/1 → 500`.

### 3. The opt-in global `ExceptionFilter` silently clobbers the app's own global filter — or silently reports nothing
- **Where:** `packages/nestjs/src/setup.ts:50-55` (`app.useGlobalFilters(new BugseeExceptionFilter(...))`).
- **What:** Nest resolves global filters last-registered-first. `setupNest` gives the user no control over that ordering and no warning. Both orderings are broken, in opposite directions:
  - App registers its own global filter **before** `setupNest` (the natural order, since `setup.ts:8` instructs "call it in main.ts after `NestFactory.create(...)`"): Bugsee's catch-all wins, delegates to `BaseExceptionFilter.super.catch` (`filter.ts:55`), and emits **Nest's default 500** — the customer's error contract is destroyed and their filter never runs.
  - App registers **after** `setupNest`: the app's filter wins; in `errorCapture:'filter'` mode Bugsee then reports **nothing at all** — the seam is silently inert.
- **Why it matters:** The mandate's explicit SEV1: "clobbering the customer's error handling". The collision is acknowledged only in a source comment (`filter.ts:16-18`, pointing at `BugseeExceptionCaptured`); `README.md` and `docs/design/framework-adapters.md` carry no warning, and `setupNest` emits none at runtime.
- **Evidence (real Nest 10 / express; app filter returns `418 {"mine":true}` and counts its hits):**
  | order | `errorCapture` | HTTP status | body | app filter ran | Bugsee reports |
  |---|---|---|---|---|---|
  | app filter **before** setupNest | `filter` | **500** | Nest default | **0×** | 1 |
  | app filter **after** setupNest | `filter` | 418 | `{"mine":true}` | 1× | **0** |
  | app filter **before** setupNest | `both` | **500** | Nest default | **0×** | 1 |
  | app filter **after** setupNest | `both` | 418 | `{"mine":true}` | 1× | 1 |

### 4. The raw query string (secrets included) is uploaded in `manifest.json`
- **Where:** `packages/nestjs/src/shared.ts:72` — `const url = req.originalUrl ?? req.url ?? '';` inside `buildContext` (`shared.ts:66-78`), consumed by `packages/nestjs/src/middleware.ts:49`. The context's `attributes` become the bundle manifest `attrs`.
- **What / Why it matters:** Query-string credentials, password-reset tokens, API keys land verbatim in every uploaded bundle. The sibling review root-caused an identical leak to the engine (`packages/node/src/server-instrument.ts:242-246`) — that is the source when `instrumentIncomingRequests` is on (the default) — but this package carries its **own independent copy** at `shared.ts:72`, which is what fires when a user opts out with `instrumentIncomingRequests: false`. Fixing only the engine will not close it here.
- **Evidence (real Nest, `GET /users/77?token=SUPERSECRET&pw=HUNTER2`, `Authorization: Bearer LEAKME`, `Cookie: sid=COOKIELEAK`), identical on express and fastify and with the auto-instrument both on and off:**
  ```
  manifest.json attrs = {"http.method":"GET",
                         "http.url":"/users/77?token=SUPERSECRET&pw=HUNTER2",
                         "http.route":"/users/:id"}
  SUPERSECRET=true  HUNTER2=true  LEAKME=false  COOKIELEAK=false
  ```
  Headers are **not** leaked (clean); only the URL is. `request.json` and `performance.json` are clean — the leak is manifest-only, which is why a `request.json`-shaped assertion would miss it.

## SEV2

### 5. An error with a throwing `getStatus()` replaces the app's error — the app's real error is lost
- **Where:** `packages/nestjs/src/interceptor.ts:96` — `outcome = isServerError(err) ? 'ERROR' : 'OK';` sits **outside** the `try` that begins at `interceptor.ts:97`. `isServerError` (`shared.ts:122-125`) → `httpExceptionStatus` (`shared.ts:99-106`) invokes `err.getStatus()` with no guard.
- **What / Why it matters:** Inside an RxJS `catchError` selector, a throw replaces the stream's error. The application's genuine error is then never reported, never reaches the app's own exception filters, and the client sees the SDK's internal error instead. The engine guards this exact case deliberately — `packages/node/src/server-instrument.ts:186-190`: *"Guarded as a whole: a hostile error with a throwing `getStatus()` … must not throw out of the exported `defaultShouldReport`"* — and the nestjs copy dropped that guard while duplicating the logic.
- **Evidence:** app throws `Error('APP ERROR')` carrying `getStatus: () => { throw new Error('SDK-INTERNAL from getStatus') }` →
  ```
  observableError = "SDK-INTERNAL from getStatus"   sameAsApp = false
  ```
- **Bounded:** requires an error object whose `getStatus` throws (or has side effects) — narrow, hence SEV2 rather than SEV1. Note the same unguarded call also fires from `defaultShouldReport` (`shared.ts:113-114`), though all of *those* call sites are inside guarded regions.

### 6. TEST THEATER — the real-Nest e2e's two headline claims are not load-bearing (proven by surviving mutations)
- **Where:** `packages/nestjs/src/nestjs-integration.test.ts:211-218` (`'both' … reports a handler error ONCE (dedup)`) and `nestjs-integration.test.ts:237-259` / `:307-330` (per-request context isolation, express + fastify).
- **What / Why it matters:** These are the two properties the mandate calls out as most valuable, and the e2e cannot detect their loss.
  - **Mutation A** — `setup.ts:46`: `const reported = errorCapture === 'both' ? new WeakSet<object>() : undefined;` → `const reported = undefined as WeakSet<object> | undefined;` (dedup disabled entirely). The e2e dedup test at `:211` **still passed**; only the mock-based `setup.test.ts:71` failed. Root cause: `@bugsee/core`'s `checkOrSetAlreadyCaught` (`packages/core/src/dedup.ts:12-31`) permanently tags the thrown instance, so the second seam is a no-op regardless of the adapter's WeakSet. The e2e therefore proves core behavior, not the adapter's dedup.
  - **Mutation B** — `shared.ts:74`: `contextId: newContextId()` → `contextId: 'CONSTANT-CTX-ID'` (per-request isolation destroyed in the adapter's own context builder). Both concurrency e2e tests (`:237`, `:307`) **still passed**; only `middleware.test.ts:60` and `shared.test.ts:93` failed. Root cause: see finding 7 — under the default config the adapter's `buildContext` is never called.
- **Control:** the same harness caught every other mutation I injected (see "Mutation results" below), so it is not a broken harness.

### 7. TEST THEATER — the middleware's `enterWith` path is dead in the default configuration, and the e2e that claims to prove it never executes it
- **Where:** `packages/nestjs/src/middleware.ts:48` (the `store.getCurrent() === undefined` short-circuit) vs `nestjs-integration.test.ts:262-263` and `:288`/`:303-304`.
- **What:** With `instrumentIncomingRequests` at its default `true`, `packages/node/src/http-server-interceptor.ts` `run`-scopes the context on the `'request'` emit, so `middleware.ts:48` short-circuits and `store.enterWith` (`middleware.ts:69`) is **never reached**. Measured with a probe wrapping the real `RequestContextStore`:
  ```
  [express / default]  enterWith=0  run=1
  [fastify / default]  enterWith=0  run=1
  [express / instrumentIncomingRequests:false]  enterWith=1  run=0
  [fastify / instrumentIncomingRequests:false]  enterWith=1  run=0
  ```
- **Why it matters:** `nestjs-integration.test.ts:262-263` states *"The Fastify platform is where `store.run(() => next())` would silently lose the ALS context … This proves the enterWith middleware keeps the correlation on Fastify"*, and `:303-304` calls the POST-with-body assertion "THE proof". It proves `store.run` inside the `node:http` patch. The entire `middleware.ts:62-68` design rationale (fastify/middie + body-parse ALS loss, nodejs/node#41285) is **unverified by any test in the repo**. The path is reachable only via `instrumentIncomingRequests: false` — which no test in this package sets.
- (I verified the `enterWith` path myself and it is correct — see the isolation verdict below. The finding is about test coverage, not about the code being wrong.)

### 8. TEST THEATER — the non-HTTP guard is verified against a scenario real Nest cannot produce
- **Where:** `packages/nestjs/src/interceptor.test.ts:116-128`.
- **What / Why it matters:** The test constructs `{ switchToHttp: () => { throw new Error('not an http context'); } }`. Real Nest `ExecutionContextHost.switchToHttp()` never throws (`node_modules/@nestjs/core/helpers/execution-context-host.js:35-40`). The test therefore green-lights a guard that does nothing for the case it is named after, and is the direct reason SEV1 #1 was not caught.

## SEV3

### 9. The `both`-mode dedup `WeakSet` is redundant, and process-lifetime
- **Where:** `packages/nestjs/src/setup.ts:46`, `packages/nestjs/src/shared.ts:146-151`.
- **What:** `@bugsee/core`'s `checkOrSetAlreadyCaught` (`packages/core/src/dedup.ts:12-31`) already makes a re-capture of the same instance a no-op, so the adapter's WeakSet has no observable effect (finding 6, mutation A). It also inherits the same limitation: an app that re-throws a module-level singleton `Error` is reported **once per process**. Measured — two sequential requests each throwing the same module-level instance, `errorCapture:'interceptor'` (no WeakSet in play): **1** report for 2 requests. Not adapter-caused, but worth knowing before anyone "fixes" the WeakSet.

### 10. The peer range `^9 || ^10 || ^11` is only ever exercised on Nest 10
- **Where:** `packages/nestjs/package.json:37-39` (peers) vs `package.json:43-49` (devDeps pin `^10.4.22`); `node_modules` contains 10.4.22 only.
- **What:** Nothing in the repo or CI runs the adapter against Nest 9 or Nest 11. The APIs used are narrow and stable (`app.use`, `useGlobalInterceptors`, `useGlobalFilters`, `getHttpAdapter`, `Catch`, `BaseExceptionFilter`, `ArgumentsHost`), so breakage is unlikely — but the declared range is an untested assertion, and there is no version probe or comprehensible degradation path on a mismatch.

### 11. The "framework-import-free default path" claim is false
- **Where:** `packages/nestjs/src/index.ts:10` eagerly re-exports `./filter`, which value-imports `Catch` from `@nestjs/common` (`filter.ts:2`) and `BaseExceptionFilter` from `@nestjs/core` (`filter.ts:3`), and executes `Catch()(BugseeExceptionFilter)` at module load (`filter.ts:58`).
- **What:** Contradicts `index.ts:3` ("no `@nestjs/core` import"), `shared.ts:8-9` ("the default (interceptor) path stays framework-import-free; only the opt-in filter pulls in `@nestjs/core`") and `filter.ts:16-17`. Importing anything from `@bugsee/nestjs` loads both peers. Low impact (a Nest app has both), but the comments should not claim otherwise, and a `./filter` subpath export would make the claim true.

## enterWith isolation verdict (the key question)

**No cross-request contamination found. I could not break it.**

**Every `enterWith` call site in the package:** exactly one — `packages/nestjs/src/middleware.ts:69`, inside the middleware returned by `createBugseeMiddleware`. It is gated by `middleware.ts:48` (`client !== undefined && store !== undefined && store.getCurrent() === undefined`), so it mutates the current async scope **only when no context is already active**. The scope it mutates is the one Nest's platform middleware phase runs in, which on both platforms is per-request (express: the `'request'` emit chain; fastify: the `@fastify/middie` pre-handler chain). The second `enterWith` in the request path lives in the engine (`packages/node/src/server-instrument.ts` `openServerContext`/`openServerRequest`) and is **not reached** by this adapter — the interceptor uses `startServerSpan`, which never opens a context (`interceptor.ts:150`).

Why the engine's confirmed cross-request user-bleed does not manifest here: in the default configuration the interceptor takes the **refining** path, and the refiner's user is written via `store.setUser` on the *already-`run`-scoped* context (`packages/node/src/server-instrument.ts:363`), not via a fresh `enterWith`. Measured per-request users were always correct.

**Measured results (real Nest 10, both platforms, in-process recording transport):**

| scenario | platform | `enterWith` calls | result |
|---|---|---|---|
| default launch (auto-instrument on), `GET /ok` | express | **0** (`run`=1) | context owned by the `node:http` patch |
| default launch, `GET /ok` | fastify | **0** (`run`=1) | same |
| `instrumentIncomingRequests:false`, `GET /ok` | express / fastify | 1 | adapter owns the context |
| **5 overlapping** `GET /work` (staggered 0/3/6/9/12 ms), distinct `x-user` each, auto-instrument **off** (pure `enterWith` path) | express | 5 | 5 bundles, **5 distinct `context_id`**, users `a..e@x.com` each on its own report — **no bleed** |
| same | fastify | 5 | 5 bundles, 5 distinct `context_id`, correct users — **no bleed** |
| **HTTP/1.1 keep-alive, `maxSockets:1`** — 3 sequential `GET /work` on ONE socket, auto-instrument **off** (the classic `enterWith` leak shape) | express | 3 | 3 distinct `context_id` (`0767ec8b…`, `e8a690da…`, `3291436c…`), users `k1/k2/k3` correct — **no bleed** |
| same | fastify | 3 | 3 distinct `context_id` (`dd575e70…`, `c95dcc1f…`, `2c787739…`), correct users — **no bleed** |
| keep-alive, same socket, **default** launch | express / fastify | 0 (`run`=3) | correct users `d1/d2/d3` — **no bleed** |
| **`Scope.REQUEST` provider**, 3 concurrent requests, provider logs twice across an `await` | express, auto-instrument **on** | 0 | each report's own-context logs carry only that request's provider id; **FOREIGN=0** |
| same | express, auto-instrument **off** (`enterWith`) | 3 | **FOREIGN=0** |
| POST-with-body (the fastify body-parse async boundary), auto-instrument off | fastify | 1 | correlated, correct user |

Request-scoped providers interact correctly with the context on both paths — the context is read at capture time from ALS, so a `Scope.REQUEST` instance's async work stays attributed to its own request.

**The residual risk is coverage, not behavior:** the correct `enterWith` path is only reachable via `instrumentIncomingRequests: false`, and no test in the repo sets that (finding 7). If the auto-instrument default ever flips, or a user opts out, this path becomes live with zero regression coverage.

## Error-seam matrix

Measured on a real Nest 10 app (express platform unless noted), `GET /handler-error` / `GET /guard-error` / `GET /not-found`, counting **actual uploaded bundles**, not mock calls.

| mode | reports once? | app's own filters preserved? | app error still delivered? | evidence |
|---|---|---|---|---|
| `interceptor` (default) | **Yes** — 2 genuine errors from 4 requests; guard-thrown error not seen (documented gap) | **Yes** — `catchError` re-throws untouched (`interceptor.ts:106`); app's own global filter received the **original** error and its `599 {"echoed":"boom …"}` response was delivered verbatim, express **and** fastify | **Yes** — `404` preserved for `NotFoundException`, `200 ok` unaffected | measured; mutation M3 (replace `throwError(() => err)` with `of(undefined)`) failed **7** tests incl. the e2e `preserves the original HTTP response` |
| `ExceptionFilter` | **Yes** — 1 bundle for a guard-thrown error (the coverage the interceptor cannot give) | **NO — SEV1 #3.** Registration-order dependent: app filter first → Bugsee wins, app filter runs 0×, Nest default 500 emitted; app filter last → app wins, Bugsee reports 0 | Yes when Bugsee's filter runs (delegates via `super.catch`, `filter.ts:55`) — but as *Nest's default* response, not the app's | measured both orderings; mutation M7 (drop `super.catch`) failed 11 tests, so the delegation itself is well covered |
| `both` | **Yes** — guard (filter only) + handler (both seams, deduped) = **2** bundles, not 3 | **NO** — same clobbering as `filter` mode when the app filter is registered first (500, 0 hits) | Yes | measured; **but** the dedup is not attributable to the adapter — with `setup.ts:46`'s WeakSet removed the count is still 2 (finding 6) |

`HttpException` handling is correct and well covered: 4xx **and** 5xx `HttpException`s are skipped by `defaultShouldReport` (`shared.ts:113-114`) while a 5xx still sets the transaction outcome to `ERROR` via `isServerError` (`shared.ts:122-125`); `ForbiddenException` thrown from a guard produced 0 reports in `both` mode; a custom `shouldReport` is honored end-to-end. Mutation M6 (`isServerError` → always `false`) failed 4 tests.

## Host-request safety

Every point SDK code runs in the request path, and what a throw there does — **measured** on real Nest, both platforms:

| seam | file:line | guarded? | forced-throw result |
|---|---|---|---|
| context middleware body | `middleware.ts:40-53` | yes (`catch` → pass-through) | `getClient` throws → `GET /ok` **200 ok** (express + fastify) |
| middleware `store.enterWith` + `next()` | `middleware.ts:69-70` | **no** (deliberate: outside the `try` so `next()` fires exactly once) | not reachable in practice — `AsyncLocalStorage.enterWith` does not throw |
| interceptor client resolution | `interceptor.ts:67-71` | yes | `getClient` throws → **200 ok** |
| interceptor http-context extraction | `interceptor.ts:78-84` | yes, but ineffective for the real case | see SEV1 #1 |
| **interceptor `openSpan`** | **`interceptor.ts:88`** | **NO** | **hostile container → `GET /ok` 500, both platforms — SEV1 #2** |
| interceptor `catchError` outcome | `interceptor.ts:96` | **NO** | throwing `getStatus()` → app's error **replaced** — SEV2 #5 |
| interceptor `catchError` reporting | `interceptor.ts:97-105` | yes | `shouldReport` throws → app's error still delivered; `/ok` still 200 |
| interceptor `finalize` | `interceptor.ts:109-117` | yes | mutation M-finalize covered by `interceptor.test.ts:276` |
| filter `catch` | `filter.ts:42-54` | yes | `shouldReport` throws → Nest response unchanged; `/ok` 200 |
| `BugseeExceptionCaptured` decorator | `filter.ts:87-95` | yes | original `catch` always invoked |

**Verdict:** no hang and no swallow found (the express/koa/hono 500-on-SDK-throw class does **not** reproduce here for the ordinary vectors — user getter, `getClient`, `shouldReport`, `logException` all degrade cleanly to a normal response). The two real breakages are the unguarded `openSpan` (SEV1 #2) and the unguarded `isServerError` (SEV2 #5).

Also checked clean: `setupExpress`'s "reports zero errors when the app has its own error middleware" analogue — here the app's own global filter and Bugsee's interceptor coexist correctly (`1` bundle **and** the app's `599` response). Elysia's "404 transactions never finish" analogue — the `finalize` at `interceptor.ts:108` fires on the stream terminal for 404s, aborts, and success alike; a client abort mid-request still produced a report and no dangling context (the next request got its own `context_id` and user).

## Non-HTTP transport support

| transport | works / no-ops / breaks | documented? | file:line |
|---|---|---|---|
| HTTP (express platform) | **works** | yes (README) | `setup.ts:38-56` |
| HTTP (fastify platform) | **works** | yes | `middleware.ts:62-68`, `shared.ts:19-20` |
| Microservices (RPC — TCP/Redis/NATS/gRPC/Kafka) | **BREAKS** — `TypeError` thrown out of `intercept()` on every message | **no** (comment at `interceptor.ts:83` claims the opposite) | `interceptor.ts:88` → `:138` → `shared.ts:50` |
| WebSockets (gateways) | **BREAKS** — same `TypeError` | **no** | same |
| GraphQL | **BREAKS** — `TypeError` on `matchedRoute` (`args[0]` is the root value) | **no** | `interceptor.ts:137` → `shared.ts:56` |
| Microservice-only app (`NestFactory.createMicroservice`) | **breaks at setup** — `app.use` / `app.getHttpAdapter` do not exist on a `INestMicroservice`; `setupNest` throws a `TypeError` at `setup.ts:42` | **no** | `setup.ts:30-36` (the `NestApp` interface requires `use`/`getHttpAdapter`, so TypeScript rejects it — a JS caller gets a runtime `TypeError`) |

The `ExceptionFilter` seam is HTTP-only in a subtler way: `filter.ts:45` calls `host.switchToHttp().getRequest()` unconditionally, but it is inside the `try` at `filter.ts:42`, so a non-HTTP exception degrades to "no report" and still delegates — **no crash there**. Only the interceptor breaks.

## Double-instrumentation check

**One transaction, not two — on both platforms.** With `instrumentIncomingRequests` at its default `true`, the `node:http` emit patch `run`-scopes the context and stashes the owner span; the adapter's `startServerSpan` (`interceptor.ts:150`) finds a refinable owner and returns a refining handle whose `finish()` is a no-op.

Measured against a live APM extension (`@bugsee/bugsee/node` umbrella so `client.ext('performance')` resolves), reading `performance.json` out of the uploaded bundle. Because a transaction finishes *after* the report it belongs to is snapshotted, I fired request A then request B and read A's transaction from B's bundle:

```
[express] bundle#0 txns=["app.start:app.start"]
[express] bundle#1 txns=["app.start:app.start","http.server:GET /users/:id"]   ← exactly ONE http.server
[fastify] bundle#1 txns=["app.start:app.start","http.server:GET /users/:id"]   ← exactly ONE
[control: plain node:http, no Nest]
          bundle#1 txns=["app.start:app.start","http.server:GET /users/1"]     ← raw path, no route
```
The control proves the parameterization to `/users/:id` is the adapter's `span.setRoute` refinement at `interceptor.ts:112` doing real work (mutation M5 — replacing it with `void route` — failed `interceptor.test.ts:370`). The middleware's re-entrancy short-circuit is likewise load-bearing: mutation M4 (`store.getCurrent() === undefined` → `true`) failed `middleware.test.ts:95`.

## Mutation results (harness validation)

All mutations applied to a `cp` backup and restored from it (verified by `md5`); no `git checkout` used.

| # | mutation | file:line | caught by | e2e caught it? |
|---|---|---|---|---|
| M1 | `both`-mode dedup WeakSet → `undefined` | `setup.ts:46` | `setup.test.ts:71` only | **NO** (finding 6) |
| M2 | `contextId: newContextId()` → constant | `shared.ts:74` | `middleware.test.ts:60`, `shared.test.ts:93` | **NO** (finding 6) |
| M3 | `catchError` swallows instead of re-throwing | `interceptor.ts:106` | 7 tests | yes (`:228`) |
| M4 | re-entrancy short-circuit removed | `middleware.ts:48` | `middleware.test.ts:95` | no |
| M5 | `span.setRoute(route)` dropped | `interceptor.ts:112` | `interceptor.test.ts:370` | no |
| M6 | `isServerError` → always `false` | `shared.ts:124` | 4 tests | no |
| M7 | filter never delegates to `super.catch` | `filter.ts:55` | 11 tests incl. 4 e2e | yes |

Baseline before/after: **93 tests passed**, `tsc --noEmit` clean, `git status --short packages/` **empty**.

## Checked and found clean

- **Per-request isolation under `enterWith`** — no contamination reproducible on either platform, under concurrency, keep-alive-on-one-socket, or `Scope.REQUEST` providers (full table above). This was the highest-priority question and it comes back clean.
- **First-owner-wins re-entrancy** — exactly one context and one `http.server` transaction per request, express and fastify, verified on the wire.
- **Route extraction** — `matchedRoute` (`shared.ts:55-56`) correctly reads express `route.path` and fastify `routeOptions.url`; the uploaded transaction name and `http.route` attr are the parameterized `/users/:id`, never the raw `/users/77`.
- **Header privacy** — `Authorization` and `Cookie` values never reach the bundle (only the `traceparent` header is read, `interceptor.ts:138`).
- **The app's error is always delivered** in `interceptor` mode — `catchError` reports then re-throws untouched (`interceptor.ts:106`), verified end-to-end with an app-owned global filter that echoes the original error message and returns `599`; also with `HttpException` → correct `404`.
- **`HttpException` is not misreported as a crash** — 4xx and 5xx `HttpException`s skipped, guard-thrown `ForbiddenException` skipped in `both` mode, custom `shouldReport` honored.
- **Umbrella subpath** — `index.ts:9` correctly re-exports from `@bugsee/bugsee/node` (not the browser-resolving default), matching the umbrella SEV1 requirement.
- **`@bugsee/core` `runFilter` falsy-return defect** — no exposure: this package never registers a core filter.
- **`@bugsee/service` `getImmediate` rethrow** — guarded at `middleware.ts:40-53`, `filter.ts:42-54`, `filter.ts:87-95`, and at every `reportErrorOnce` call site (`shared.ts:153`); the **only** unguarded path is `interceptor.ts:88` (SEV1 #2).
- **Report completeness under load** — 10 sequential and 10 concurrent erroring requests each produced exactly 10 issues and 10 uploaded bundles; no loss. (An earlier apparent 3-of-5 shortfall was my harness flushing too early, not a defect.)
- **Integration-test stability** — `nestjs-integration.test.ts` ran 3× consecutively, 9/9 green each time; not flaky.
- **Client abort / never-responding handler** — abort still produced its report; the subsequent request received its own `context_id` and user (no stale context). Unfinished transactions are not accumulated in a store (`packages/performance/src/transaction-store.ts:3-17` buffers only finished ones, bounded FIFO), so no leak found there.
- **`sideEffects` hygiene** — deliberately omitted from `package.json` with a documented rationale (`package.json:19`), correctly protecting the load-time `Catch()(BugseeExceptionFilter)` at `filter.ts:58` from tree-shaking.
