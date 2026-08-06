# Adversarial review — @bugsee/node, Pass B (http interception / server instrumentation / context)

**Reviewed:** 2026-07-26 · **Scope:** `packages/node/src/server-instrument.ts` (486 impl / 835 test), `http-interceptor.ts` (433 / 577), `http-server-interceptor.ts` (195 / 473), `fetch-server-wrap.ts` (111 / 330), `request-context-store.ts` (68 / 98), `trace-propagation.ts` (53 / 62). Read-only. Upstream read to verify wiring only: `@bugsee/service` (`getImmediate`), `@bugsee/capture` (`traceparent.ts`, `network-provider.ts`), `@bugsee/protocol` (`sanitize.ts`, `sensitive.ts`), `@bugsee/performance` (`controller.ts`, `http-spans.ts`, `wire-performance.ts`), `packages/bugsee/src/wire.ts`, the 7 backend adapters, `launch.ts` (wiring lines only — composition is Pass A).

**Verdict:** The central design claim of this pass — *one context and one `http.server` transaction per request, isolated under concurrency* — **holds, and I could not break it in the default configuration.** I ran the real SDK against a real `node:http` server on Node 18.20.6, 22.13.1 and 24.15.0 with heavily overlapping concurrent requests plus keep-alive socket reuse: 35/35 context observations were correct at five different points in the request lifecycle, including inside `req.on('end')` and `res.on('finish')` listeners. The span-lifecycle matrix is genuinely watertight — client abort, socket reset, handler throw, response never ended, double `res.end()`, long-lived SSE and pipelined keep-alive all close **exactly once**, no leaks, no double-finish. The `runScoped` re-entrancy rule is not decoration: `openServerRequest` self-heals against a stale `enterWith` context and I verified it stays correct across 4 multiplexed HTTP/2 streams. The test suite is strong — 15 of 16 targeted mutations were caught, control included. What is wrong is concentrated in three places, and each is serious. First, the file whose own header promises "nothing throws into the request pipeline" has **five unguarded `resolveStore` call sites**; I drove a throwing service factory through the real `emit` patch and the host request **hung forever** — no response, no error, socket leaked. Second, `openServerContext` uses a bail-on-any-active-context guard that its sibling `openServerRequest` deliberately does not; on Node 18 and Node 22 (the current LTS) I reproduced **two of three keep-alive requests being tagged with a previous user's identity and URL**. Third, outgoing request URLs reach disk verbatim — I recovered a plaintext `api_key` **and a URL-userinfo password** from the SDK's own on-disk capture, while headers and bodies were correctly redacted around them. Test quality has one structural blind spot that explains all three: every `http-server-interceptor` test drives a hand-written `FakeEmitter`, so the real `emit` patch semantics are never executed, and outside `request-context-store.test.ts` there is **not one concurrent-request test in the entire pass**.

---

## SEV1

### 1. Five unguarded `resolveStore` calls let an SDK-internal throw escape into `Server.prototype.emit` and hang the host request permanently

- **Where:** `packages/node/src/server-instrument.ts:279` (`startServerSpan`), `:300` (`getActiveServerSpan`), `:313` (`openServerRequest`), `:341` (`runServerRequest`), `:388` (`makeSpan`) — each calls `resolveStore(client)` (`:121-122`) outside any `try`. Also `packages/node/src/http-server-interceptor.ts:133`, where the user-supplied `isInternal(req.headers)` is invoked unguarded. Upstream trigger: `packages/service/src/index.ts:170`.
- **What / Why it matters:** `server-instrument.ts:13-15` states the contract in the file header — *"is fully defensive (no client → safe no-op; nothing throws into the request pipeline beyond a fire-and-forget report)"*. It is not. `resolveStore` is `client.getServiceProvider(RequestContextStoreToken).getImmediate({ optional: true })`, and **`getImmediate({optional:true}) rethrows`**: `packages/service/src/index.ts:170` ends with a bare `return instantiate();` that the `optional` short-circuits at `:153`, `:159` and `:165` never reach. So a factory that throws on first access, or a `getServiceProvider` that throws on a disposed container, propagates straight out. Because `runServerRequest` is called from inside `patchedEmit`, the throw unwinds through `http.Server.prototype.emit` → node's `parserOnIncoming`, and the request is never dispatched to the host handler. The prompt's premise that **six backend adapters rely on `getImmediate` not throwing inside host request paths** is correct, and that reliance runs through exactly these five lines: `express/src/middleware.ts:101`, `hono/src/middleware.ts:91` and `koa/src/middleware.ts:99` (`runServerRequest`), `fastify/src/hooks.ts:99`, `hapi/src/hooks.ts:121` and `elysia/src/hooks.ts:137` (`openServerRequest`), `nestjs/src/interceptor.ts:150` (`startServerSpan`). Note `openServerContext` (`:258-266`) *is* wrapped in `try/catch` — the guard was written once and not applied to its four siblings.
- **Evidence:** Direct API surface, with a client whose provider rethrows (scratchpad only; source restored, `git status --short packages/` empty):
  ```
  [getImmediate throws]      openServerContext    -> ok
  [getImmediate throws]      openServerRequest    -> THREW: factory blew up
  [getImmediate throws]      startServerSpan      -> THREW: factory blew up
  [getImmediate throws]      getActiveServerSpan  -> THREW: factory blew up
  [getImmediate throws]      runServerRequest     -> THREW: factory blew up
  [getServiceProvider throws] openServerRequest   -> THREW: container disposed
  [getServiceProvider throws] startServerSpan     -> THREW: container disposed
  [getServiceProvider throws] getActiveServerSpan -> THREW: container disposed
  [getServiceProvider throws] runServerRequest    -> THREW: container disposed
  ```
  Through the **real** `createHttpServerInterceptor` patched onto the **real** `http.Server.prototype.emit`, against a real server + real client:
  ```
  !! uncaughtException: factory blew up
  >>> HOST REQUEST HUNG — the store-factory throw broke emit
  ```
  The same hang reproduces via the `isInternal` hook (`http-server-interceptor.ts:133`):
  ```
  !! uncaughtException escaped to process: hostile isInternal
  >>> HOST REQUEST HUNG (no response, no error) — SDK throw broke emit
  ```
  This is worse than a crash, and worse in production than in my harness: Pass A established (`node-A-launch.md`, SEV1 #1) that the SDK installs its own default `uncaughtException` / `unhandledRejection` handlers, so the process does **not** die loudly — it silently stops answering that connection while every subsequent affected request leaks another socket. The failure is invisible to the operator.

### 2. `openServerContext` reuses a **stale** request context — cross-request user/URL contamination on Node 18 and Node 22

- **Where:** `packages/node/src/server-instrument.ts:260` — `if (store === undefined || store.getCurrent() !== undefined) { return; }`, then `:263` `store.enterWith(...)`. Compare `openServerRequest` at `:314`, which gates on `refinableSpan(...)` (`:112-115`) instead.
- **What / Why it matters:** `enterWith` on Node's legacy async_hooks `AsyncLocalStorage` (Node ≤ 23) stamps the **execution async resource**, which for a keep-alive HTTP connection is the socket. The context therefore survives into the *next* request on that socket. The author knew this — `:88-92` documents it precisely (*"an enterWith adapter's context can linger across concurrent requests that share an async context … and must not be mistaken for THIS request's owner"*) — and `refinableSpan`'s `runScoped === true` check implements the defence for `openServerRequest`. But `openServerContext` bails on **any** active context, stale or not, so it never opens a context for request #2 and request #2 is silently tagged with request #1's `contextId`, `http.url` **and `user`**. Under correlation-by-tagging that means capture entries and any report raised during request #2 are attributed to request #1's end user. `packages/nestjs/src/middleware.ts:48` uses the identical non-self-healing guard (`store.getCurrent() === undefined`). Reachability: no run-scoped owner exists when `instrumentIncomingRequests: false` (a documented option, `launch.ts:277`/`:784`), on HTTP/2 servers (SEV2 #5 — proven uncovered), or for any direct consumer of the exported `openServerContext` (`packages/node/src/index.ts:84`).
- **Evidence:** The **real** `openServerContext` vs the **real** `openServerRequest`, three keep-alive requests on one socket, distinct `x-user` per request, no emit patch installed:
  ```
  v18.20.6  openServerContext  keep-alive 1 socket -> CONTAMINATED 2/3
      {"req":"/alice/account","ctxUrl":"/alice/account","ctxUser":"alice@example.com","ok":true}
      {"req":"/bob/account",  "ctxUrl":"/alice/account","ctxUser":"alice@example.com","ok":false}
      {"req":"/carol/account","ctxUrl":"/alice/account","ctxUser":"alice@example.com","ok":false}
  v18.20.6  openServerRequest  keep-alive 1 socket -> CONTAMINATED 0/3
  v22.13.1  openServerContext  keep-alive 1 socket -> CONTAMINATED 2/3
  v22.13.1  openServerRequest  keep-alive 1 socket -> CONTAMINATED 0/3
  v24.15.0  openServerContext  keep-alive 1 socket -> CONTAMINATED 0/3   (AsyncContextFrame)
  ```
  Node 18 and 22 are both inside the declared `engines: node >= 18`; 22 is the current LTS. Node 24 is immune because `AsyncLocalStorage` switched to `AsyncContextFrame`, which does not write through to the socket resource — so this defect **disappears on the newest runtime and is fully live on the ones most deployments run**, the worst possible shape for catching it in CI.
- **Fix shape:** make `openServerContext` mirror `openServerRequest` — gate on `refinableSpan(store.getCurrent())`, not on `getCurrent() !== undefined`.

### 3. Outgoing request URLs are persisted verbatim — URL-userinfo credentials and query-string secrets reach disk in the clear

- **Where:** emitted at `packages/node/src/http-interceptor.ts:267` (`before`), `:285` (`complete`), `:305` (`error`), `:337` (body amendment); built by `resolveRequest` `:107-112` and `buildUrl` `:69-80`. Never scrubbed: `packages/capture/src/network-provider.ts:36-44` sanitizes `custom.headers` and `custom.body` only — `event.url` is not touched on any path.
- **What / Why it matters:** `node:http` accepts `http.request('http://user:pass@host/path')` and `URL.href` preserves the userinfo, so a **plaintext password** is captured verbatim. This is a node-exclusive aggravation of the class already reported for the browser sibling — browsers strip/reject URL userinfo, `node:http` fully supports it and it is routine for private registries, proxies and internal service-to-service calls. `packages/protocol/src/sanitize.ts:23` exports `sanitizeParams` and `packages/protocol/src/sensitive.ts:7` exports `REDACTED_URL_ENCODED` — built for exactly this — and both have **zero production callers** (verified by grep across `packages/`, excluding `node_modules`/`dist`/tests).
- **Evidence:** End-to-end against the **real** `launch()` with a real peer server, flushed, then the SDK's own `dataDir` read back off disk (scratchpad dir, removed after):
  ```
  marker                       leaked-to-disk?
    HEADER_AUTH                no (redacted/absent)
    HEADER_COOKIE              no (redacted/absent)
    QUERY_APIKEY               YES  <== LEAKED
    QUERY_PLAIN                YES  <== LEAKED
    URL_USERINFO               YES  <== LEAKED
    REQ_BODY_PW                no (redacted/absent)
    RESP_COOKIE                no (redacted/absent)
    RESP_BODY                  no (redacted/absent)

  "<redacted>" occurrences in persisted capture: 11
  captured URLs on disk:
     http://127.0.0.1:50730/api?api_key=QUERYAPIKEYSECRET&plain=QUERYPLAINVALUE
     http://alice:URLUSERINFOSECRET@127.0.0.1:50730/secure
  ```
  The header and body sanitizers work correctly and demonstrably (11 `<redacted>` tokens in the same artifact) — the URL simply has no sanitizer wired, so secrets sail past a pipeline that is otherwise doing its job. The query-string half is the same root cause already owned by `docs/review/capture.md`; the **userinfo half is node-specific and new**.

---

## SEV2

### 4. `uninstall()` never checks it still owns `emit` — it deletes a co-installed APM's patch, and a second instance leaves an unremovable orphan

- **Where:** `packages/node/src/http-server-interceptor.ts:183-192`; the `delete` branch is `:189`.
- **What / Why it matters:** `install()` records `hadOwn` and `original` (`:172-174`) but `uninstall()` restores unconditionally without verifying `proto.emit` is still the wrapper it installed. Since `http.Server.prototype.emit` is normally **inherited** from `EventEmitter.prototype`, `hadOwn` is `false` and uninstall takes `delete proto.emit` — which removes whatever own-property is there *now*, including another library's. Any APM that patches `Server.prototype.emit` after Bugsee (Datadog, New Relic, OpenTelemetry's `http` instrumentation, `elastic-apm-node`) is silently disabled the moment Bugsee stops. The file's comment at `:187-188` shows the author reasoned carefully about restoring the *pristine prototype shape* but not about a third party owning the slot.
- **Evidence:** Against the real `http.Server.prototype`:
  ```
  [B] foreign APM patches AFTER bugsee, then bugsee uninstalls
     after bugsee.uninstall, emit === foreign APM wrapper? false
     after bugsee.uninstall, emit === pristine?           true
     >>> foreign APM SURVIVED uninstall: false

  [E2] two bugsee instances, FIFO uninstall (c then d)
     after FIFO uninstall emit === pristine: false | own: true      <== orphan wrapper left installed
  ```
  The `[E2]` case leaves an own-property wrapper on the prototype that no `uninstall()` can ever remove — instrumentation that outlives `stop()`. The reverse order (`[C]`: foreign patches *first*, Bugsee on top) restores correctly, and `[A]`/`[D]`/`[E]` (idempotent install, double uninstall, uninstall-before-install, LIFO) are all clean.
- **Fix shape:** capture the installed wrapper and restore only when `proto.emit === ourWrapper`; otherwise leave the foreign patch alone.

### 5. HTTP/2 servers get **zero** incoming instrumentation, though `instrumentIncomingRequests` defaults to `true`

- **Where:** `packages/node/src/http-server-interceptor.ts:170` patches only `target.http.Server` and `target.https.Server`; `:110` defaults the target to `{ http, https }`.
- **What / Why it matters:** `http2.Http2Server` extends `net.Server`, **not** `http.Server`, so it never sees the patched `emit`. An HTTP/2 server using the compatibility API (`http2.createServer((req,res)=>…)`, and Fastify's `http2: true`) emits `'request'` on a prototype the patch never touched. The user opts into nothing and gets nothing — no per-request context, no `http.server` transaction — while the option's documentation and `CLAUDE.md` both say it is on by default. This also removes the run-scoped owner that protects SEV1 #2.
- **Evidence:** 4 multiplexed streams on one h2 connection, real interceptor installed, counting real `startTransaction` calls:
  ```
  v18.20.6 / v22.13.1 / v24.15.0 (all three identical)
    http.server transactions opened by the EMIT PATCH for 4 h2 requests: 0 (patch coverage: NONE)
    spans opened by the ADAPTER (openServerRequest): 4
    context isolation across multiplexed h2 streams: 4/4 correct
  ```
  Also verified structurally: `http2.createServer() instanceof http.Server === false`, and `Http2SecureServer`'s chain does not contain `http.Server.prototype`. The good news in the same run: adapter-opened contexts stay correctly isolated across multiplexed streams — `openServerRequest`'s self-healing replace is doing real work.

### 6. `@bugsee/performance`'s single-slot `getActiveSpan` misattributes outgoing `http.client` spans across concurrent server requests

- **Where:** wired unconditionally at `packages/bugsee/src/wire.ts:214` (`networkSource: internals.network.interceptor`) — note `pageload`, `navigationSource` and `interactionSource` on the neighbouring lines *are* platform-gated, this one is not. Consumed at `packages/performance/src/wire-performance.ts:80-85` → `packages/performance/src/http-spans.ts:106` (`const active = deps.getActiveSpan()`). The slot is `packages/performance/src/controller.ts:117` (`active = transaction`) / `:120-122` (`getActiveSpan() { return active; }`), cleared at `:113`. Every incoming request overwrites it via `packages/node/src/server-instrument.ts:396`.
- **What / Why it matters:** on a server, `startTransaction` fires once per **incoming** request, so the single global slot always holds the most recently *started* request. An outgoing HTTP call made by request A is therefore attributed to whichever request started last. The per-transaction `MAX_HTTP_SPANS` cap (`http-spans.ts:108-110`, keyed by the active transaction) is applied to the wrong transaction for the same reason. The author was explicitly aware of this hazard in the sibling file — `packages/node/src/trace-propagation.ts:5-6` says the propagation decorator reads the per-request context and **"NOT the performance extension's single-slot `getActiveSpan` (which is wrong under server concurrency)"** — so trace propagation is correctly protected while `http.client` span attribution was not given the same treatment.
- **Evidence:** three overlapping `runServerRequest` calls with the real controller semantics reproduced exactly (`active = t` on start, `if (active === t) active = undefined` on finish):
  ```
  REQ-B outgoing http.client attributed to => GET /REQ-C   <== MISATTRIBUTED
  REQ-C outgoing http.client attributed to => GET /REQ-C
  REQ-A outgoing http.client attributed to => undefined    <== MISATTRIBUTED (dropped at http-spans.ts:107)
  ```
  Two of three wrong; the longest-running request loses its client spans entirely. Root cause is owned by `docs/review/performance.md`; this is the Node blast radius the prompt asked me to characterise. A one-line Node-side fix exists in-repo already — read the trace from `RequestContextStoreToken.getCurrent()?.trace`, exactly as `trace-propagation.ts:38-47` does.

---

## SEV3

### 7. A host handler that throws is recorded as `CANCELLED`, indistinguishable from a client abort
`packages/node/src/http-server-interceptor.ts:152-157`. When the handler throws, node destroys the socket without finishing the response, so `res.writableFinished` is `false` and the span takes the `span.cancel()` branch. Measured: `handler THROWS synchronously → CANCELLED/0`. An operator reading APM sees "client went away" for what was a server-side crash. `:21-22` justifies capturing no error here on the grounds that "a framework swallows them before node:http" — true for the 7 adapters, false for a bare `http.createServer` handler.

### 8. Self-isolation misses an internal header set via `req.setHeader()`
`packages/node/src/http-interceptor.ts:257` resolves headers only from the options object (`resolveRequest` → `normalizeHeaders(options?.headers)`, `:111`), so `isInternal` (`:116-117`) cannot see a header applied after construction. Measured: `options.headers` path → 0 events (isolated); `req.setHeader('x-bugsee-internal','1')` path → 3 events (captured). **Not currently live** — I verified the real uploader is safe: `@bugsee/node-utils`'s `httpRequest`, called through `launch.ts:350`, passes the header in `options.headers` and produced 0 captured events. Latent hazard only, but it is the sole thing standing between the SDK and a self-capture feedback loop.

### 9. `patchedEmit` renames the prototype method
`packages/node/src/http-server-interceptor.ts:127`. Measured: `emit.length` 1 → 1 (preserved), `emit.name` `'emit'` → `'patchedEmit'`. Arity, `this` and the return value are all preserved correctly; only the name changes. Harmless for node itself, visible to anything that fingerprints prototypes.

### 10. Surviving mutation: `startServerSpan`'s `runScoped: false` is unpinned by any test
`packages/node/src/server-instrument.ts:284`. Flipping `makeSpan(client, info, options, false)` → `true` leaves the whole suite green. That constant is precisely the anti-collapse invariant documented at `:88-92`: with it flipped, a lingering `enterWith` context becomes "refinable", and two requests sharing that context collapse into one transaction with one user. The sibling line at `:323` (`openServerRequest`) **is** covered — flipping it fails 1 test. 15 of 16 mutations were caught overall (control included), so this is a single precise gap, not a weak suite.

### 11. Test theater: the emit patch is never executed against real `node:http`
All 22 tests in `http-server-interceptor.test.ts` drive `FakeEmitter` (`:33-46`) with a hand-written `makeRes` whose `fire('close')` (`:76`) is called by the test itself. Real `emit` dispatch, real `res` `'close'` timing, real `writableFinished`, keep-alive, pipelining and aborts are never exercised — which is exactly why SEV1 #1 (throw escaping `emit`), SEV2 #4 (foreign-patch clobber) and SEV2 #5 (HTTP/2 uncovered) are all invisible to it. Relatedly, **no concurrent-request test exists anywhere in this pass** outside `request-context-store.test.ts:52`/`:85` — `server-instrument.test.ts`, `http-server-interceptor.test.ts` and `http-interceptor.test.ts` contain zero occurrences of `concurren|parallel|keep-alive|Promise.all|interleav|overlap`. For a package whose entire purpose is per-request isolation on a server, that is the single most valuable missing test.

### 12. `server-instrument.ts:21-22` documents a URL-scrubbing pipeline that does not exist
The `url` field's doc comment reads *"raw; the redaction pipeline scrubs query secrets"*. It does not — see SEV1 #3; `sanitizeParams` has zero callers. The comment actively invites a future caller to place secrets in `http.url` believing they are protected. (I attempted to demonstrate the inbound `http.url` attribute reaching disk via a report raised inside the request and **could not reproduce it** in my probe, so I am not claiming an inbound leak — only that the stated guarantee is false and the outbound leak is proven.)

### 13. `wrapFetchHandler` has no lifecycle fallback and converts sync handlers to async
`packages/node/src/fetch-server-wrap.ts:95-108`. The span is finished only from the returned promise's settlement; there is no abort-signal, timeout or close hook, so a handler whose promise never settles leaks its transaction with no bound (contrast the `node:http` path, which always finishes via `res.once('close')`). Separately, `:95` wraps every result in `Promise.resolve(...).then(...)`, so a synchronous handler that returned a `Response` now returns a `Promise` and its response is deferred by a microtask — accepted by Bun/Deno, but it is an observable behaviour change under a binding "interceptors must not alter app behavior" rule. Code-verified; not empirically reproduced.

---

## Concurrency / isolation analysis

**Every `enterWith` call site in scope**, and its contamination risk:

| # | Call site | Guard before it | Contamination risk | Verdict |
|---|---|---|---|---|
| 1 | `request-context-store.ts:44` | none (primitive) | n/a — raw binding, correctly documented at `:19-23` | clean |
| 2 | `server-instrument.ts:263` (`openServerContext`) | `:260` `getCurrent() !== undefined` → **bail** | **stale context reused** → wrong user/URL on the next keep-alive request | **SEV1 #2, reproduced 2/3 on Node 18 + 22** |
| 3 | `server-instrument.ts:319` (`openServerRequest`) | `:314` `refinableSpan(...)` → replace unless a **run-scoped** owner exists | self-healing: unconditionally replaces a lingering non-run-scoped context | clean, verified 0/3 contaminated on 18/22/24 and 4/4 correct across multiplexed h2 streams |

Out of scope but on the same engine: `packages/nestjs/src/middleware.ts:69`, guarded at `:48` with the same bail-on-any-active-context shape as #2.

**The `run`-scoped path is correct.** `runServerRequest` (`server-instrument.ts:350`) uses `store.run`, whose context is popped on exit and cannot leak to the next request on the socket. This is what makes the default configuration safe.

**Concurrent-request verdict — empirical.** Real SDK, real `node:http` server, four heavily overlapping requests (staggered 5/10/35/60 ms so all four are in flight simultaneously) followed by three keep-alive requests on a single socket, sampling the active context at five lifecycle points:

```
                          Node 18.20.6 / 22.13.1 / 24.15.0 — identical
OBSERVATIONS 35, MISMATCHED 0
  sync-handler-entry:   ok=7 bad=0 noContext=0
  after-await:          ok=7 bad=0 noContext=0
  after-setImmediate:   ok=7 bad=0 noContext=0
  req-end-listener:     ok=7 bad=0 noContext=0
  res-finish-listener:  ok=7 bad=0 noContext=0
```

No cross-request contamination and no context loss, including in listeners that fire from the socket after `emit` has returned. **First-owner-wins holds:** a second opener inside the emit patch's run scope receives a refining handle whose `finish`/`cancel` are no-ops (`:373-374`), so an adapter finishing before the http layer cannot orphan the owner's span — the owner still finishes on `res.once('close')`. Verified by mutation: M2 (`refinableSpan` accepting any owner) and M5b (`openServerRequest` stashing `runScoped: true`) are both caught. The one unpinned constant is `startServerSpan`'s (SEV3 #10).

---

## Span-lifecycle completeness matrix

Real `createHttpServerInterceptor` patched onto real `http.Server.prototype.emit`, driven by raw sockets so aborts and pipelining are genuine. Counting real `startTransaction` vs `finish`:

| scenario | span closes? | leak? | double-close? | recorded outcome | file:line |
|---|---|---|---|---|---|
| normal 200 | yes | no | no | `OK/200` | `http-server-interceptor.ts:152-157` |
| host sets 500 | yes | no | no | `ERROR/500` | `server-instrument.ts:453` |
| handler throws synchronously | yes | no | no | `CANCELLED/0` — misattributed, **SEV3 #7** | `http-server-interceptor.ts:155` |
| response never ended, client gives up | yes | no | no | `CANCELLED/0` | `http-server-interceptor.ts:155` |
| `res.end()` called twice | yes | no | no | `OK/200` | `server-instrument.ts:423` (`isFinished` guard) |
| SSE long-lived, client aborts | yes | no | no | `CANCELLED/0` | `http-server-interceptor.ts:152` |
| client aborts mid-request (socket destroy) | yes | no | no | `CANCELLED/0` | `http-server-interceptor.ts:155` |
| socket reset right after request line | yes | no | no | `CANCELLED/0` | `http-server-interceptor.ts:155` |
| `upgrade` (WebSocket) | n/a — never instrumented | no | no | none | `http-server-interceptor.ts:128` (only `'request'`) |
| pipelined ×3 on one socket | yes ×3 | no | no | `OK/200 ×3` | — |

**No unbounded accumulation on the `node:http` path.** `res.once('close')` always fires, so every span closes exactly once; `finishWith`'s `transaction.isFinished()` check (`server-instrument.ts:423`) makes double-finish impossible. The only unbounded shape found is `fetch-server-wrap.ts` (SEV3 #13), which has no equivalent fallback.

---

## Monkey-patch safety

| property | `Server.prototype.emit` patch | outgoing `http-interceptor` | `Bun.serve`/`Deno.serve` wrap |
|---|---|---|---|
| idempotent install | **yes** — `installed` flag `:166-169`; verified double-install does not double-wrap | yes — `InterceptorBase` activation gating | n/a (wraps a handler value) |
| uninstall-before-install | **yes**, safe no-op `:179-181` (also answers Pass A's hand-off question) | yes | n/a |
| double uninstall | **yes** | yes | n/a |
| restores pristine shape | **yes** — `delete` for inherited, reassign for own (`:185-190`); verified `emit === pristine` and own-property gone | yes `:247-252` | n/a |
| **safe alongside another APM** | **NO — SEV2 #4**: deletes a wrapper installed after ours | not verified (same `original`-reassign pattern at `:249`, so the same class likely applies) | n/a |
| two SDK instances, FIFO uninstall | **NO — SEV2 #4**: leaves an unremovable orphan | not tested | n/a |
| preserves return value / `this` / arity | **yes** — `emit.length` 1→1, `this` forwarded via `original.call(this, …)`, boolean returned verbatim (a `false` "no listeners" result survives, pinned by `http-server-interceptor.test.ts:412`) | yes — `original(...args)` first at `:256`, result returned untouched | yes |
| preserves method name | no — `'emit'` → `'patchedEmit'` (SEV3 #9) | yes | yes |
| a throw reaches the host handler | **YES — SEV1 #1** | no (call-through happens first at `:256`) | re-throws deliberately after capture `:93`/`:107` — correct |
| covers HTTP/2 | **NO — SEV2 #5** | n/a | n/a |

**Outgoing interceptor transparency, measured:** response body byte-identical instrumented vs not; keep-alive agent still reuses its socket (1 free socket after 2 requests) so **agent pooling is unaffected**; `get` is not double-captured (node's `get` calls its lexically-scoped `request`, as `:12-13` claims). The `'error'` re-raise at `:311-317` correctly preserves node's "unhandled `'error'` throws" semantics — the SDK's own listener is added before the app's, so `listenerCount('error') <= 1` is true only when the app really installed none. Mutation M11 (removing the re-raise) is caught.

---

## Privacy audit

| data | redacted? | where | evidence |
|---|---|---|---|
| request headers (`authorization`, `cookie`) | **yes** | `capture/src/network-provider.ts:36` → `protocol/src/sanitize.ts:17` → `SENSITIVE_HEADERS` (`sensitive.ts:10-38`, 28 entries incl. proxy/AWS/GCP/Vault/Clerk/Supabase) | markers absent from disk; 11 `<redacted>` tokens present |
| response headers (`set-cookie`) | **yes** | same | marker absent from disk |
| request body (JSON `password`) | **yes** | `network-provider.ts:37-40` → `sanitizeBody` + `SENSITIVE_KEY_SUBSTRINGS` | marker absent from disk |
| response body (`access_token`) | **yes** | same | marker absent from disk |
| **URL query string** | **NO** | nothing scrubs `event.url` | `?api_key=QUERYAPIKEYSECRET` recovered from disk |
| **URL userinfo (`user:pass@`)** | **NO** | nothing scrubs `event.url` | `http://alice:URLUSERINFOSECRET@…` recovered from disk |
| body size cap | yes, 20480 B default | `http-interceptor.ts:228`, `:161-172`; over-cap drops the whole body → `size_too_large` | mutation M12 caught |
| `Content-Encoding` bodies | yes — `cant_read_data`, never captured as garbage | `http-interceptor.ts:404-408` | — |

**Bypass paths checked:** redaction is applied by the provider on the single subscription (`network-provider.ts:88-96`), and the Node source is folded into that same umbrella via `installNetworkCapture({ additionalSources: [nodeHttp] })` (`launch.ts:605-606`) — so there is **no emit path that skips it**, including the `override: true` body amendments (`http-interceptor.ts:333`), which re-carry headers precisely so the Content-Type gate still applies. The gap is not a bypass; it is a field nobody wired a sanitizer for. `sanitizeParams` (`protocol/src/sanitize.ts:23`) and `REDACTED_URL_ENCODED` (`sensitive.ts:7`) already exist and are exported from `protocol/src/index.ts:37`/`:43` with zero callers.

**Server-side capture posture is good:** the emit patch deliberately captures no headers and no bodies from inbound requests (`http-server-interceptor.ts:21-22`) — context + APM only.

---

## Trace-propagation robustness

`parseTraceparent` (`capture/src/traceparent.ts:71-92`, consumed at `server-instrument.ts:395`) is **correct and defensive**, returning `undefined` — i.e. degrading to a new trace — for every hostile input class: non-string, bad hex version (`HEX2_RE`), the forbidden version `ff`, wrong-length or non-hex trace/span ids (`TRACE_ID_RE` / `SPAN_ID_RE`), and the all-zero trace id and span id (`ZERO_TRACE_ID` / `ZERO_SPAN_ID`, per spec). It tolerates surrounding whitespace, uppercase hex, and future versions with extra fields (destructures the first four segments). No throw path exists, and `makeSpan` wraps the call in `try/catch` anyway (`:392-419`), so a malformed inbound header can neither throw into the request nor propagate garbage. The sampled flag is taken from the low bit and adopted as the continuation's sampling decision (`:401-408`), correctly honouring the upstream.

Outbound (`trace-propagation.ts`): allowlist-driven with **no same-origin fallback on Node** (`:8-10`), so a backend never leaks its trace topology to third-party APIs by default — mutation M13 (propagate to every target) and M14 (ignore `propagateTrace: false`) are both caught. `createTraceparentDecorator` refuses to override an existing upstream `traceparent` (`traceparent.ts:142-144`). Reading the trace from the **per-request context** rather than the single-slot `getActiveSpan` (`:38-47`) is the correct choice and is the reason propagation is not affected by SEV2 #6.

Not verified: `tracestate` size limits / duplicate `bugsee=` entry handling live in `capture/src/tracestate.ts`, outside this pass — flagged for whoever owns `capture`, not claimed here.

---

## For Pass C

- Nothing found in this pass is rooted in the diagnostics / multi-instance files.
- Pass A's hand-off question is **answered**: `HttpServerInterceptor.uninstall()` **is** idempotent from the never-installed state (`http-server-interceptor.ts:179-181`, verified empirically), so the `launch.ts:784-805` failed-install → later-`stop()` double-uninstall sequence is safe for this installable. It is *not* safe against a foreign patch or a second instance — SEV2 #4.
- Worth a look in Pass C: `launch.ts:792` appends user-supplied `serverInstrumentations` to the same array, so third-party installables inherit the rollback path Pass A flagged.

---

## Checked and found clean

- **Per-request isolation under real concurrency in the default configuration** — 35/35 correct across three Node majors, five lifecycle points, overlapping requests and keep-alive reuse.
- **First-owner-wins re-entrancy** — one context, one transaction; refiner `finish`/`cancel` are no-ops; a refiner finishing early cannot orphan the owner; "only a `run`-scoped owner is refinable" genuinely holds for `openServerRequest` (verified across multiplexed HTTP/2 streams).
- **Span lifecycle** — 9 adversarial scenarios, every span closes exactly once, zero leaks, zero double-closes; `isFinished` guard at `server-instrument.ts:423` is real.
- **Self-capture** — the real uploader is isolated end-to-end (0 captured events for a real `@bugsee/node-utils` `httpRequest`); inbound `x-bugsee-internal` is honoured (`http-server-interceptor.ts:93-94`); mutations M7 and M10 both caught. No feedback loop.
- **Header and body redaction** — proven end-to-end on disk for request/response headers and bodies.
- **Outgoing-request transparency** — identical response bytes, agent pooling intact, no double-capture of `get`, `'error'` re-raise preserves node semantics, response body observed passively via `push` without forcing flowing mode (`http-interceptor.ts:390-395`).
- **`traceparent` parsing** — robust against every malformed/hostile class tested.
- **`request-context-store.ts`** — thin, correct `AsyncLocalStorage` binding; the only file in the pass with genuine concurrency tests (`:52`, `:85`); mutation M3 caught by 3 tests.
- **Install/uninstall idempotency** — double install, double uninstall, uninstall-before-install, LIFO two-instance, and the own-vs-inherited restore distinction are all correct.
- **Test suite strength overall** — 15/16 targeted mutations caught, control mutation caught, no false-green harness.
- **Read-only discipline** — `git status --short packages/` empty; all six files `cmp`-identical to their pre-review backups.
