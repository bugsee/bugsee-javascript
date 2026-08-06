# Adversarial review — @bugsee/express + fastify + koa

**Reviewed:** 2026-07-27 · **Scope:** three backend adapters as structural peers over the shared
server-instrument core in `@bugsee/node`.

| package | impl LOC | test LOC | files |
|---|---|---|---|
| `@bugsee/express` | 243 (`middleware.ts` 141, `setup.ts` 80, `index.ts` 22) | 781 | 4 test files, 38 tests |
| `@bugsee/fastify` | 181 (`hooks.ts` 167, `index.ts` 14) | 611 | 3 test files, 29 tests |
| `@bugsee/koa` | 144 (`middleware.ts` 115, `setup.ts` 14, `index.ts` 15) | 495 | 4 test files, 26 tests |

**Frameworks actually exercised:** express **5.2.1**, fastify **5.8.5**, koa **2.16.4** on Node **v24.15.0** —
real servers bound to `127.0.0.1:0`, plus the REAL `@bugsee/bugsee/node` umbrella `launch()` with a mock
transport (no network to Bugsee infrastructure). ~20 probe scenarios per package. All three package test
suites were run green at baseline (38 / 29 / 26) and a 31-mutation battery was applied and fully reverted.

**Verdict:** The prior is **confirmed on every structural claim** — all three sit on the shared
`server-instrument.ts` core, first-owner-wins re-entrancy genuinely works (**exactly one `http.server`
transaction per request** with `instrumentIncomingRequests` at its default `true`, verified empirically on
all three), per-request attribution is correct under 12 overlapping interleaved requests with zero user
bleed on all three, none of them hard-imports its framework, and all three import `@bugsee/bugsee/node`
(not the default condition). The error seams are also correct: express **does** call `next(err)`, koa
**does** re-throw, and fastify uses `addHook('onError')` and therefore does **not** clobber the app's
`setErrorHandler`. Where they diverge sharply is **defensiveness**: `@bugsee/fastify` wraps every hook body
in try/catch and is empirically immune to an SDK-internal throw, while `@bugsee/express` and `@bugsee/koa`
call the *unguarded* engine entry (`runServerRequest` → unguarded `resolveStore`) with `next()` living
*inside* the dispatch callback — so the confirmed `@bugsee/service` `getImmediate({optional:true})` rethrow
**500s the customer's request and the route never runs** (proven on real servers). Two further issues are
serious in practice: all three upload the raw request URL **including the query string** verbatim to
`manifest.json` (secrets/PII), and `setupExpress`'s default auto-installed error handler reports **zero**
errors for the single most common production Express shape (an app that has its own error-response
middleware). Test suites are strong overall — 28 of 31 mutations were caught — but three survived, and the
one express test whose *title* claims the missing safety property only exercises the one path that is
already guarded.

---

## SEV1

### 1. An SDK-internal throw inside the request middleware 500s the customer's request — express + koa

- **Package(s):** express, koa (fastify is **immune**)
- **Where:**
  - `packages/express/src/middleware.ts:101` — `runServerRequest(info, opts, (span) => { … next(); })`, no try/catch
  - `packages/koa/src/middleware.ts:99` — `await runServerRequest(info, opts, async (span) => { … await next(); })`, no try/catch
  - engine sink: `packages/node/src/server-instrument.ts:341` (`const store = resolveStore(client);` — unguarded) and `:350` (`store.run(...)`), reaching `packages/node/src/server-instrument.ts:122` → `packages/service/src/index.ts:170` / `:149-151`, where `getImmediate({ optional: true })` **rethrows** on the first access to a throwing factory and on a self-cycle
  - contrast (safe): `packages/fastify/src/hooks.ts:88-104` — whole body in try/catch, `done()` always called

- **What / Why it matters:** `next()` (express) and `await next()` (koa) live *inside* the dispatch
  callback. If the engine throws before invoking dispatch, the callback never runs, so the route handler
  never executes and the SDK's own error becomes the request's outcome. This is the exact blast radius the
  `@bugsee/service` SEV1 warned about, and it is a customer-visible 500 on a request that would otherwise
  have succeeded. It also **pollutes the app's own error handling**: the customer's error middleware
  receives a Bugsee-internal `Error` as if it were their bug.

- **Evidence** (real servers, real frameworks, scratchpad probes `ex/p1.ts`, `ko/p1.ts`, `fa/p1.ts`):

  | scenario | express | koa | fastify |
  |---|---|---|---|
  | control (no SDK) | 200 `OK` | 200 `OK` | 200 `OK` |
  | `resolveStore` throws | **500** (route never ran) | **500** | 200 `OK` |
  | `store.run` / `enterWith` throws | **500** | **500** | 200 `OK` |
  | + app has its own error middleware | **503 "APP-HANDLER saw: BOOM: service factory threw"** | **503 "APP-MW saw: BOOM: service factory threw"** | n/a |
  | via `setupExpress` / `setupKoa` / `setupFastify` | **500** | **500** | 200 `OK` |

  Stack, verbatim: `at resolveStore (packages/node/src/server-instrument.ts:122:55)` → `at runServerRequest
  (packages/node/src/server-instrument.ts:341:17)` → `at <anonymous> (packages/express/src/middleware.ts:101:5)`.
  Neither adapter *hangs* (express's `Layer.handleRequest` converts the sync throw to `next(err)`; koa's
  promise rejection reaches `ctx.onerror`) — the failure mode is a 500, not a hang.

- **Same defect, second trigger — a throwing `user` getter:**
  `packages/express/src/middleware.ts:93` and `packages/koa/src/middleware.ts:91` call
  `options.user?.(req|ctx)` outside any guard → a customer getter that throws (e.g. it touches
  `req.user.email` on an unauthenticated request) **500s that request**. Fastify guards it at
  `packages/fastify/src/hooks.ts:91` (inside the try). Measured: express `[B1] status=500`,
  koa `[K9] status=500`, fastify `[F3] status=200 OK`.

- **Fix shape:** mirror fastify — wrap the whole open in try/catch and call `next()` / `await next()` on
  the failure path too (express) / bypass to `await next()` (koa). Guarding only the engine is not enough
  for the `user` getter.

### 2. The incoming request URL — full query string — is uploaded verbatim and unredacted (all three)

- **Package(s):** express, fastify, koa
- **Where:**
  - `packages/express/src/middleware.ts:68` (`req.originalUrl ?? req.url`) used at `:96`
  - `packages/fastify/src/hooks.ts:63` (`req.url`) used at `:94`
  - `packages/koa/src/middleware.ts:93` (`url: ctx.url`)
  - sink: `packages/node/src/server-instrument.ts:244` (`attributes: { 'http.method', 'http.url': info.url }`)
    → `packages/core/src/bundle-assembler.ts:179-185` writes it into `manifest.json.attrs`
- **What / Why it matters:** the source comment at `packages/node/src/server-instrument.ts:21-22` claims
  "raw; the redaction pipeline scrubs query secrets" — **it does not**. `packages/core/src/filters.ts:14-19`
  only exposes network / log / breadcrumb / report filters; manifest attributes pass through untouched.
  Access tokens, emails, national IDs and any other query parameter land in the uploaded bundle in
  plaintext, on every reported incident, with no option to disable it.
- **Evidence** (probe `ex/p6.ts`, a real express request through the real SDK, bundle unzipped):
  ```
  manifest.attrs = {"http.method":"GET",
    "http.url":"/api/users/7?access_token=SECRET123&email=victim%40example.com&ssn=111-22-3333",
    "http.route":"/api/users/:id"}
  whole-bundle contains SECRET123 ? [ 'manifest.json' ]
  ```
  Headers are clean — `authorization: Bearer TOPSECRET` and `cookie: session=abc123` appear **nowhere** in
  the bundle (`whole-bundle contains TOPSECRET ? []`). The leak is query-string-only, and it is the
  adapters that choose to hand the query-bearing URL down: each already computes/has access to a
  query-stripped path (koa has `ctx.path`; express/fastify would need one `indexOf('?')` split).

---

## SEV2

### 3. express: `setupExpress`'s default auto error handler reports NOTHING when the app has its own error middleware

- **Package(s):** express
- **Where:** `packages/express/src/setup.ts:44-49` (`installErrorHandler` → `app.use(errorHandler(adapter))`),
  installed from `:52-58` (the `app.listen` wrapper) or `:61-65` (the first-request fallback)
- **What / Why it matters:** both install paths **append** Bugsee's handler at the *end* of the middleware
  stack. Any app that registered its own error-response middleware before `listen()` — the standard
  production shape — responds and stops the walk, so Bugsee's handler is never reached and **every route
  error is silently lost**. The adapter appears installed, `setupExpress` returns without complaint, and
  the customer gets zero error reports. The doc comment at `setup.ts:16-18` mentions
  `{ autoErrorHandler: false }`, but frames it as an ergonomic choice ("If you have your OWN
  error-response middleware…"), not as *"otherwise you capture nothing"*.
- **Evidence** (probe `ex/p5.ts`, real express + real SDK, one thrown route error each):

  | scenario | http status | Bugsee reports |
  |---|---|---|
  | S1 `setupExpress(app)`, no app error middleware | 500 | **1** |
  | S2 `setupExpress(app)` + app error-response middleware | 500 | **0** |
  | S3 documented workaround (`autoErrorHandler:false` + explicit `setupExpressErrorHandler`) | 500 | **1** |
  | S4 app error middleware that forwards `next(err)` | 500 | **1** |

  With `instrumentIncomingRequests` at its default there is no fallback capture either: express handles the
  error itself, so nothing propagates out to the `node:http` patch.

### 4. express: the router mount prefix is dropped from the route name

- **Package(s):** express
- **Where:** `packages/express/src/middleware.ts:67` — `routeOf = (req) => req.route?.path`; `req.baseUrl`
  is never read. Used at `:96` and `:103-106`.
- **What / Why it matters:** for `app.use('/api/v2', router)` + `router.get('/users/:id')`, the transaction
  is named `GET /users/:id`. Every mount that reuses the same sub-path (`/api/v1` vs `/api/v2`, a
  multi-tenant mount, a versioned API) collapses into a single transaction, making latency/error rates
  per-version unreadable. The correct pattern is `req.baseUrl + req.route.path`.
- **Evidence** (probes `ex/p2.ts` B2 and `ex/p3.ts` Q1, real mounted router):
  `GET /api/v2/users/12345` → transaction opened `GET /api/v2/users/1`, **finished as `GET /users/:id`** —
  the refinement actively *removes* the prefix the raw URL had. Fastify keeps the full pattern
  (`routeOptions.url` → `GET /users/:id` for a root-mounted route; fastify prefixes are included by fastify).

### 5. Raw URLs (with ids) become transaction names — express 404s, koa without `@koa/router`

- **Package(s):** express, koa
- **Where:**
  - koa: `packages/koa/src/middleware.ts:48` — `matchedRoute = (ctx) => ctx._matchedRoute || ctx.path`
  - express: `packages/express/src/middleware.ts:103-106` — when `req.route` is undefined nothing is
    refined, so the engine fallback `packages/node/src/server-instrument.ts:142` (`urlPath(info.url)`) stands
- **What / Why it matters:** unbounded transaction-name cardinality (each id/slug is its own "route") plus a
  second-order privacy exposure when the path itself carries an identifier (`/users/alice@x.com/...`).
  Koa is the worse case: `@koa/router` sets `ctx._matchedRoute`, but a plain Koa app (or one using
  `koa-route`, `koa-tree-router`, or hand-rolled routing) gets the raw path for **every request**, not just
  404s.
- **Evidence:** express `[B2] GET /no/such/route/999` (404, id in the name); koa `[Q1] GET /users/12345`
  with no router vs `[Q1b] GET /users/:id` once `_matchedRoute` is set. This is a real gap, not a
  hypothetical: `@koa/router` is not a dependency or devDependency of `@bugsee/koa`, and the fallback is
  documented only in a type comment (`packages/koa/src/middleware.ts:21-22`).

### 6. Expected client 4xx are reported as issues, with no way to opt out — express + fastify

- **Package(s):** express, fastify (koa is **correct**)
- **Where:**
  - express: `packages/express/src/middleware.ts:121-141` — reports unconditionally at `:134`
    (`client.logException(err, …)`), bypassing the engine's `defaultShouldReport`;
    `ExpressAdapterOptions` (`:47-57`) has no `shouldReport`; `toOptions` (`:75-80`) never forwards one
  - fastify: `packages/fastify/src/hooks.ts:107-129` — same shape, reports at `:123`;
    `FastifyAdapterOptions` (`:42-52`) has no `shouldReport`; `toOptions` (`:69-74`) never forwards one
  - koa (correct peer): `packages/koa/src/middleware.ts:35` (option), `:65-68` (`defaultShouldReport`),
    `:80` (forwarded), `:105` (`span.captureError`, which honours it)
- **What / Why it matters:** ordinary client mistakes become paid Bugsee issues. On fastify this fires for
  **JSON-schema validation failures** — any public API with request schemas emits an issue on every
  malformed client request. On express it fires for the idiomatic `next(createError(404))`. The engine
  already ships `defaultShouldReport` (`packages/node/src/server-instrument.ts:182-185`, skip <500) and koa
  uses it; express and fastify route around it. Users cannot even override it — the option does not exist
  on either type.
- **Evidence:**
  - express (`ex/p7.ts`): a 404-shaped, a 400-shaped and a genuine error → **3 reports** (expected 1)
  - fastify (`fa/p5.ts`): schema-validation 400, `httpErrors.notFound()` 404, genuine 500, plus a
    routing 404 → statuses `400,404,500,404` → **3 reports** (expected 1)
- **Note:** `docs/design/framework-adapters.md:217` states express/fastify's policy is "always report", so
  this is a *decided* behaviour — but it is inconsistent with the koa peer, un-overridable, and empirically
  noisy on the two most common backend frameworks.

### 7. express: a client abort is recorded as a *successful* transaction

- **Package(s):** express
- **Where:** `packages/express/src/middleware.ts:102-110` — one `finalize` bound to both `'finish'` and
  `'close'`, always ending in `span.finish(res.statusCode ?? 0)`; there is no `span.cancel()` path anywhere
  in the adapter (contrast `packages/fastify/src/hooks.ts:150-161`)
- **What / Why it matters:** on an abort `'close'` fires with `res.statusCode` still at its default 200, so
  a request the client gave up on is recorded as `OK` / 200 — silently inflating success rates and hiding
  the timeout/abort class of failure.
- **Evidence** (probe `ex/p4.ts` E4-1, real abort at 60 ms against a 400 ms handler, adapter owning the
  request via `instrumentIncomingRequests: false`): `[{"fin":"GET /slow","oc":"OK"}]`. Fastify:
  `oc: "CANCELLED"` (`fa/p3.ts` Q4 and `fa/p4.ts`), koa via the engine owner: `oc: "CANCELLED"`
  (`ko/p3.ts` Q3).
- **Bounded because:** with `instrumentIncomingRequests` at its default the `node:http` owner cancels
  correctly and express's `finish` is a no-op refiner. It bites only when the adapter owns — the documented
  `instrumentIncomingRequests: false` opt-out, or express behind a non-`node:http` server.

---

## SEV3

### 8. Test theater: express's "never breaks the request when the adapter setup throws" tests only the path that is already guarded

- **Where:** `packages/express/src/middleware.test.ts:211-220`
- The test makes **`getClient` itself** throw — and `safeGetClient`
  (`packages/node/src/server-instrument.ts:234-240`) already swallows exactly that. The *unguarded* paths
  (`resolveStore` at `:341`, `store.run` at `:350`) are never exercised, because the shared fake client
  (`middleware.test.ts:46-63`) returns a working `getServiceProvider` in every test. The test's title
  asserts a property SEV1 #1 proves the code does not have.

### 9. Surviving mutation — fastify's `onRequest` guard is untested

- **Where:** `packages/fastify/src/hooks.ts:88-102`
- Replacing the `try { … } catch { }` with `try { … } finally { }` leaves **29/29 tests green**. That guard
  is the *only* reason fastify is immune to SEV1 #1; it is one refactor away from silently regressing into
  the express/koa failure mode with no test to stop it. (The nearest test,
  `packages/fastify/src/hooks.test.ts:194`, again only throws from `getClient`.)

### 10. Surviving mutation — koa has no test that per-request context ids are distinct

- **Where:** `packages/koa/src/middleware.ts:78-79` (`newContextId: newRandomId`)
- Pinning it to a constant leaves **26/26 green**. The koa e2e assertion
  `expect(new Set(parsed.map((p) => p.request.context_id)).size).toBe(3)`
  (`packages/koa/src/koa-integration.test.ts:142`) is satisfied by the **`node:http` layer patch**, not the
  adapter: with `instrumentIncomingRequests` at its default the koa adapter's `newContextId` is invoked
  **zero** times. Measured (`ko/p7.ts`): `patch=true → 0 invocations`, `patch=false → 2`. The same mutation
  is CAUGHT on express (`middleware.ts` `toOptions`) and fastify via their unit tests — koa lacks the
  equivalent.

### 11. Surviving mutation — fastify `spans.delete(req)` in `onResponse`

- **Where:** `packages/fastify/src/hooks.ts:135` — commenting it out leaves 29/29 green. Bounded (the
  WeakMap entry dies with the request and `transaction.isFinished()` makes a repeat finish a no-op), but the
  comment at that line explicitly claims a behaviour nothing verifies.

### 12. No e2e can observe transactions at all — the double-instrumentation risk is untested in-repo

- **Where:** `packages/express/src/express-integration.test.ts:2`,
  `packages/fastify/src/fastify-integration.test.ts:2`, `packages/koa/src/koa-integration.test.ts:2` — all
  three import `launch` from `@bugsee/node`, and `packages/node/src/launch.ts:853-855` is
  `launchCore(appToken, options).client` — **no performance extension is wired**. Real users get the
  umbrella `launch` (`packages/bugsee/src/node.ts:17-26`), which does wire it.
- Consequence: no e2e asserts transaction *count*, route *name*, or *outcome*, so a regression that emitted
  two `http.server` transactions per request (a data-quality **and** quota problem) would pass CI. I
  verified the behaviour separately with the real umbrella launch — see the double-instrumentation section
  — but nothing in the repo guards it.

### 13. Structural-peer hygiene

- Doc comments declare a peer that the manifests do not: `packages/express/src/middleware.ts:21`
  ("express is a PEER, not a dependency"), `packages/fastify/src/hooks.ts:24`,
  `packages/koa/src/middleware.ts:6` — yet none of `packages/express/package.json`,
  `packages/fastify/package.json`, `packages/koa/package.json` declares `peerDependencies` (contrast
  `packages/nestjs/package.json:36`). The frameworks are devDependencies only. Defensible for pure
  structural typing, but the comments and the manifests disagree, and there is no declared supported range
  (all three were only ever exercised against v5/v5/v2 respectively).
- `packages/koa/src/middleware.ts:3` imports `randomId` from `@bugsee/util` at **runtime**, while
  `packages/koa/package.json:37` declares `@bugsee/util` under `devDependencies`. `tsup.config.base.ts:4-6`
  states the intent that "`@bugsee/*` + declared deps are EXTERNAL … no duplication" — which only holds for
  packages listed under `dependencies`/`peerDependencies`. Note `@bugsee/node` has the same shape, so this
  is a repo-wide convention question rather than a koa-only defect; flagged, not asserted.

---

## Per-package summary

| package | SEV1 | SEV2 | SEV3 | headline |
|---|---|---|---|---|
| `@bugsee/express` | 2 (#1, #2) | 5 (#3, #4, #5, #6, #7) | 4 (#8, #12, #13) | An SDK throw 500s the request, **and** the default `setupExpress` reports nothing when the app has its own error middleware. |
| `@bugsee/fastify` | 1 (#2) | 1 (#6) | 4 (#9, #11, #12, #13) | The only host-safe adapter of the three — but reports schema-validation 400s as issues, and the guard that makes it safe is untested. |
| `@bugsee/koa` | 2 (#1, #2) | 1 (#5) | 3 (#10, #12, #13) | An SDK throw 500s the request; without `@koa/router` every transaction is named after the raw path. |

---

## Host-request safety matrix

*(real servers, SDK forced to throw at each entry point; probes `ex/p1.ts`, `ex/p2.ts`, `ko/p1.ts`, `fa/p1.ts`)*

| package | SDK throw 500s request? | hangs it? | swallows app error? | evidence |
|---|---|---|---|---|
| express | **YES** — `resolveStore`, `store.run`, and a throwing `user` getter all 500 | No (express `Layer.handleRequest` → `next(err)`) | **No** — `next(err)` at `middleware.ts:139`; verified with `logException` throwing (`[A5] 503 "APP-HANDLER saw: route blew up"`) and by mutation (dropping `next(err)` → 4 tests fail) | `[A1][A2][A4] 500`, `[A3] 503 bugsee-internal error reached the app handler`, `[B1] 500` |
| fastify | **No** — every probe returned 200 `OK` | No | **No** — uses `addHook('onError')`, never `setErrorHandler`; a custom `setErrorHandler` still formats the response (`[F4][F5] 503 appHandler:true`) | `[F1][F2][F3] 200 OK` |
| koa | **YES** — `resolveStore`, `store.run`, and a throwing `user` getter all 500 | No (rejection → `ctx.onerror`) | **No** — re-throws untouched at `middleware.ts:107`; `ctx.throw(404)` stays 404, streaming + `ctx.respond=false` intact; mutation dropping the re-throw → 8 tests fail | `[K1][K2] 500`, `[K3] 503 bugsee-internal error reached the app mw`, `[K9] 500`; clean: `[K4]500 [K5]404 [K6]503 [K7]200 stream [K8]201 raw` |

---

## Concurrency verdict

**All three are correct** under real overlapping load. 12 concurrent requests per adapter, distinct
`x-user` per request, staggered delays so they complete out of order, real SDK, real
`AsyncLocalStorage`, reading `store.getCurrent()` from inside each handler after the await:

| package | requests | user mismatches | distinct contextIds | `http.server` txns |
|---|---|---|---|---|
| express | 12 | **0** | **12** | 12 |
| fastify | 12 | **0** | **12** | 12 |
| koa | 12 | **0** | **12** | 12 |

The confirmed engine-level cross-request user bleed in `openServerContext` does **not** reach these three:
express and koa go through `runServerRequest` (`store.run`, physically scoped), and fastify's
`openServerRequest` (`enterWith`) is superseded by the `node:http` owner at the default setting. Fastify was
additionally stressed on the `enterWith` path directly (`instrumentIncomingRequests: false`,
probe `fa/p4.ts`): 12 concurrent → 0 mismatches / 12 distinct contexts; **4 sequential keep-alive requests
on ONE socket** → each saw its own user (`k0..k3` correct, the classic `enterWith`-leaks-across-a-shared-
socket hazard did not materialise); and no ambient context survived after the requests drained
(`store.getCurrent()` → `undefined`).

---

## Double-instrumentation check

With `instrumentIncomingRequests` at its **default `true`** (so the `node:http` `Server.prototype.emit`
patch AND the adapter both run), real umbrella `launch()`, transactions counted by wrapping
`PerformanceApi.startTransaction`:

| package | txns for 1 request | txns for 12 requests | name at open → at finish |
|---|---|---|---|
| express | **1** | 12 | `GET /api/v2/users/1` → `GET /users/:id` |
| fastify | **1** | 12 | `GET /users/12345` → `GET /users/:id` |
| koa | **1** | 12 | `GET /users/12345` → `GET /users/12345` (no router) / `GET /users/:id` (with `_matchedRoute`) |

**First-owner-wins is real and works.** No duplicated transactions, no duplicated contexts, no billing or
quota exposure. The adapter takes the refining path (its `newContextId` is invoked 0 times — measured), so
what reaches the wire is the http-layer owner's transaction refined with the adapter's route. The one
side-effect worth noting is SEV2 #4: express's refinement *replaces* the owner's prefixed raw path with an
unprefixed pattern, losing `/api/v2`.

---

## Route extraction + privacy

| package | parameterized? | raw URL leak risk | file:line |
|---|---|---|---|
| express | Partly — `req.route.path` only; **mount prefix dropped**; 404/unmatched fall back to the raw path | Query string **always** uploaded (`http.url`); raw path in the txn name on unmatched routes | `packages/express/src/middleware.ts:67`, `:68`, `:103-106` |
| fastify | **Yes** — `routeOptions.url` is the full registered pattern including plugin prefixes | Query string **always** uploaded (`http.url`); route name itself is clean | `packages/fastify/src/hooks.ts:62`, `:63`, `:136-139` |
| koa | Only with `@koa/router` (`ctx._matchedRoute`); otherwise the **raw path** for every request | Query string **always** uploaded (`http.url`); raw path with ids in the txn name whenever no router sets `_matchedRoute` | `packages/koa/src/middleware.ts:48`, `:93`, `:104`/`:109` |

`shouldReport` semantics: koa has the option and skips 4xx by default; express and fastify have neither
(SEV2 #6). Health-check/noise filtering is therefore only reachable on koa. Request **headers** are not
captured by any of the three — verified absent from the bundle.

---

## Umbrella subpath check

| package | imports `@bugsee/bugsee/node`? | file:line |
|---|---|---|
| express | **Yes** | `packages/express/src/index.ts:6` |
| fastify | **Yes** | `packages/fastify/src/index.ts:6` |
| koa | **Yes** | `packages/koa/src/index.ts:7` |

None uses the default condition, so no browser code is pulled into a server. Each has a re-export identity
test (`reexport.test.ts` in all three) asserting `adapter.launch === umbrella.launch`. `tsc --noEmit`
passes cleanly on all three packages.

---

## Checked and found clean

- **express calls `next(err)`** (`middleware.ts:139`) — verified empirically (`[A5]` the app's handler ran
  with the *original* route error even while `logException` threw) and by two mutations: `next(err)→next()`
  → 4 failures; removing `next` entirely → 7 failures.
- **koa re-throws untouched** (`middleware.ts:107`) — mutation dropping the re-throw → 8 failures.
  Response preservation verified on real servers: `ctx.throw(404)` → 404 `"nope"`; streaming `Readable`
  body → 200, both chunks delivered; `ctx.respond = false` + raw `ctx.res.end()` → 201 `"RAW"`; a
  reporting failure inside `captureError` left the response identical.
- **fastify does not clobber `setErrorHandler`** — it registers `onRequest`/`onError`/`onResponse`/
  `onRequestAbort` only (`hooks.ts:163-166`); a custom `setErrorHandler` still formats the response
  (`[F4][F5] 503 {"appHandler":true}`).
- **fastify encapsulation** — hooks registered on the ROOT instance cover routes inside a child plugin
  (`app.register(...)`): `[F6] contexts opened: ["ctx:/child/42"]`, response 200 `CHILD`.
- **fastify lifecycle** — `onRequestAbort` fires on a real client abort and finishes the transaction
  `CANCELLED`, both with the http patch on and off.
- **express lifecycle** — a handler that never responds does **not** leak the transaction: it stays open
  while the socket is open and is finished when `'close'` fires (`[B4]` unfinished → finished after socket
  close). Double-finish across `'finish'` + `'close'` is idempotent (`transaction.isFinished()` guard).
- **Express 5 async rejections** reach the error chain (`[A6] 503 "APP-HANDLER saw: async boom"`), so the
  adapter is not misleading users on Express 5 (`package.json` pins `express: ^5.0.0`).
- **`setupExpress` install-once + ordering** — the `app.listen` wrapper, the `http.createServer(app)`
  first-request fallback, and the shared install-once flag are each covered: removing any of them fails
  1–5 tests, and calling `setupExpress` twice produced no duplicate reports.
- **Structural-peer discipline** — no adapter imports its framework at runtime; verified by grep across all
  `src/*.ts` (framework imports appear only in `*-integration.test.ts`).
- **Real frameworks in the integration tests** — `express-integration.test.ts:4`,
  `fastify-integration.test.ts:4`, `koa-integration.test.ts:5` genuinely import and boot the real
  frameworks against the real SDK; the design's "probed against the real framework" claim holds.
- **Mutation strength** — 28 of 31 injected mutations were caught (3 controls all caught), including every
  error-seam, user-attribution, lifecycle, route-refinement and setup-ordering mutation. Survivors are
  SEV3 #9, #10, #11.
- **Repository left untouched** — `git status --short packages/` is empty; all mutated files were restored
  from `cp` backups (never `git checkout`), and baseline suites re-verified at 38 / 29 / 26 passing.
