# Framework adapters + the per-request context foundation

**Status:** Foundation (S1–S5) + **Express (S6) + e2e (S7) + Fastify + NestJS BUILT** on `master`
(2026-06-15). Design approved 2026-06-15; author dialogue + decision log below. Build order: the portable
foundation first, then **Express** as its first consumer; every later backend adapter (fastify / nestjs /
next-server) is a thin re-binding of the same foundation. (As-built deltas reconciled into S1/S2/S6 below;
the **NestJS** adapter — with the empirically-grounded seam decision — is documented in §N.)

Related: `docs/design/sdk-design.md` §5/§16, `docs/design/opentelemetry-integration.md` (trace
propagation — the *outbound* half; this adds the *inbound* continuation), `docs/PROGRESS.md`.

---

## 1. Purpose & scope (understanding summary)

Make the (already deep) backend SDK **adoptable and correct under concurrency** on real frameworks,
starting with Express, at **full Sentry-parity**. One Node process runs one global SDK instance serving
**concurrent** requests; anything attached to global SDK state cannot tell request A (user *alice*) from
request B (*bob*). The foundation gives each request its own transient context so an error reported
mid-request carries *that* request's identity — never a concurrent request's.

- **Who:** Node backend developers — Express first.
- **What we add:** a portable per-request **context foundation** + an Express binding.
- **Non-goals (v1):** browser-framework adapters (react/vue/svelte/angular), non-Express backend
  adapters, physical breadcrumb isolation, auto user extraction, the dashboard filter (separate backend
  workstream), non-Node context bindings (edge).

## 2. Decision log

1. **Adapter scope = full Sentry-parity** (error capture + request APM + per-request isolation + trace
   continuation + route parametrization).
2. **Shared foundation first**, then Express as a thin consumer.
3. **Correlation by tagging, NOT physical isolation.** We do not partition capture per request. Every
   stored entry is stamped with the context it occurred in; the report records its context; the dashboard
   filters ("show only contextual data") while the full recording stays available. This fits Bugsee's
   record-everything ethos and sidesteps rebuilding the global capture-stream model.
4. **User + attributes are merged at report time** (they are report-envelope fields, not capture
   entries) from the active context over the global `Environment`.
5. **Correlation id = a dedicated `contextId` (always present while a context is open) + the request's
   W3C `traceId`/`spanId` stamped when a trace exists.** The dedicated id is decoupled from perf; the
   trace ids additionally unlock trace↔log↔network correlation later.
6. **User extraction is off by default**; opt in with an explicit `user: (req) => …` getter
   (privacy-safe — nothing PII-bearing is read unless the app asks).

## 3. Assumptions

- The adapter obtains the **process-singleton client from the carrier** (Android-style), not threaded by
  the user. With no client launched, every adapter operation is a safe no-op (`next()` / `next(err)`).
- The `RequestContext` concept is **portable**; the `AsyncLocalStorage` binding is **Node-only**.
- The core seam is **off unless a context provider is registered** → today's behavior is byte-identical
  for non-adapter users (regression-guarded).
- Perf is optional: with the performance extension unwired the adapter **degrades to error+context only**
  (no server transaction).
- The adapter is **fully defensive** — it never throws into the route pipeline and always calls
  `next`/`next(err)`; internal failures go to the `onError` sink.

## 4. Architecture — six layers (built bottom-up)

### S1 · Protocol (`@bugsee/protocol`) — the only new wire
- Add `context_id?: string` to the **report** wire (`RequestJson`). The per-**entry** correlation ids
  (`context_id` / `trace_id` / `span_id`, snake_case) ride inside each entry's `data` payload (see S2) —
  not as a new protocol interface, matching the existing convention (per-entry wire fields live in the
  providers' payloads, not in `@bugsee/protocol` constants). Flag the names for **Android cross-SDK
  parity** (a JS-originated concept).
- User → existing `environment.user` (wire `email`); attributes → the manifest `attrs` surface
  (`Record<string, AttributeValue>`). No new report field beyond `context_id`.

### S2 · Core seam (`@bugsee/core`)
- `RequestContext` (portable): `{ readonly contextId: string; user?: string; attributes?: Record<string,
  AttributeValue>; trace?: { readonly traceId: string; readonly spanId: string } }` — `attributes` uses
  the same `AttributeValue` (`string | number | boolean | string[]`) as the global attribute surface it
  merges into.
- `ContextProvider` (`getCurrent(): RequestContext | undefined`), injected via the DI container
  (`ContextProviderToken`).
- **Stamp site (one):** `CaptureAggregator.addEntry` reads `getCurrent()` and stamps `context_id` (+
  `trace_id`/`span_id` when a trace is active) onto the entry. **As-built:** the ids are written into the
  entry's `data` payload — onto a **shallow copy** (`entry.data = { ...data, context_id, … }`), never the
  caller's object, since a provider may hand the aggregator the very object a source emitter broadcast to
  other subscribers / app code (the correlation stamp must not leak onto it). Only plain-object payloads
  are stamped; arrays / primitives / null pass through uncorrelated (today's capture streams are all
  objects). An entry carries the context active **when it was added** (not the report's).
- **Merge site:** the report is assembled detached/queued, so the active context is **captured at report
  submit time** (synchronously, in the originating async context) into a `WeakMap` keyed by the report
  request, and read at assembly. It sets `request.json.context_id` and merges `user` (context over global,
  empty → global) and `attributes` (global then context, per-key). Trace ids stay on **entries only** —
  the report carries `context_id` as the join key. No provider → no stamp, no merge (byte-identical).

### S3 · Node binding (`@bugsee/node`)
- `createNodeRequestContextStore()` over `AsyncLocalStorage<RequestContext>` (node:async_hooks):
  `getCurrent()`, `run(ctx, fn)`, and mutators `setUser` / `setAttribute` / `setTrace` (enrich the
  current context from anywhere in the request's async chain). Registered as the core `ContextProvider`
  in `launch()` **by default** (cheap; `getCurrent()` returns `undefined` until a context is opened).

### S4 · Perf incoming transaction (`@bugsee/performance`)
- A server transaction for an incoming request, reusing the existing API:
  `createTransaction({ name, parentSpanId: inbound?.spanId, … }, { newTraceId: () => inbound?.traceId
  ?? fresh, … })` — adopts the inbound trace on continuation, else starts fresh. Published as the active
  transaction; finished on response with status + route. The **adapter** reads the new transaction's
  `traceId`/`spanId` and calls `store.setTrace(...)` (perf stays decoupled from the context store).

### S5 · Express adapter (`@bugsee/express`)
- `requestHandler(options?)` → middleware: get client from carrier (else `next()`); mint `contextId`;
  parse inbound `traceparent`; build `attributes` (`http.method`/`http.url`; **`http.route` set at
  finish**, since the matched route is only known post-routing); `user = options.user?.(req)`;
  `store.run(ctx, () => { start server transaction; setTrace; res.on('finish', finish-with-status+route);
  next() })`.
- `errorHandler(options?)` → error middleware `(err, req, res, next)`: get client (else `next(err)`); in
  a guard, `client.logException(err, { mechanism: 'http-error' })` — runs inside the request's ALS chain,
  so the report gets `contextId` + merged user/attributes; finish the transaction with error status;
  **always `next(err)`**.

### S6 · e2e (`@bugsee/instrumentation-tests`)
- A real Express app: an ok route (sets user via getter + an outgoing fetch → an `http.client` child
  span) and an error route. Fire **concurrent** requests with different users and assert: the error
  report's `contextId`+user = the erroring request's; capture entries during that request carry the same
  `contextId`; the transaction records route+status; an inbound `traceparent` links the trace. (Node
  first; bun/deno are node-compat and can follow.)

## 5. Request lifecycle (end to end)
```
request in → requestHandler:
  ctx = { contextId: mint(), trace: parse(traceparent), user: user?.(req), attributes:{method,url} }
  ALS.run(ctx):
     txn = perf.startServerTransaction(name, continuation=ctx.trace)
     ctx.trace = { txn.traceId, txn.spanId };  res.on('finish', () => txn.finish(status, route))
     next()  ──► route handlers run INSIDE ctx (any logException/addBreadcrumb auto-attributed)
                 every capture entry added is stamped contextId+trace by the aggregator
  on route error → errorHandler: logException(err)  [report carries ctx.contextId + ctx.user]
                                 txn.finish(error);  next(err)
response out → ALS context ends; untagged global capture resumes
```

## 6. Security & safety
- **Trace continuation** trusts the inbound `traceparent` (standard server-side behavior); parse
  defensively — malformed → no continuation, fresh trace (fail-open to a new trace, never throw).
- **User extraction** is app-provided; the SDK reads nothing identity-bearing by default.
- **No app-behavior change**: middleware is opt-in; every adapter step is guarded; `next`/`next(err)` is
  always called; an internal failure surfaces via `onError`, never the route. Consistent with
  [[interceptors-must-not-alter-app-behavior]] (the adapter is an opt-in middleware, not a silent
  interceptor).

## 7. Risks
- **Route timing** — the matched route is known only post-routing → set `http.route` at finish.
- **Process-level escapes** — a true `uncaughtException`/`unhandledRejection` that unwinds past the
  request chain loses the ALS context (no `contextId`). Route errors via `errorHandler` keep it; accepted.
- **Wire value realized later** — `contextId` is forward-compatible; the dashboard "contextual" filter is
  a separate backend workstream. SDK ships independently.
- **ALS correctness** — the crux; covered by the concurrent-request e2e (interleaved A/B).
- **Attribute surface** — confirm the report `custom` shape carries key-values in S1; expand only if absent.

## 8. Deferred / non-goals (v1)
Browser-framework adapters; fastify/nestjs/next-server (same foundation, later); full physical breadcrumb
isolation; auto user extraction; the dashboard filter; non-Node (edge) context bindings.

## 9. Reuse for later adapters
S1–S4 are framework-agnostic. Each later backend adapter is an S5-shaped binding: open a context from its
own request hook, start the server transaction, continue the inbound trace, capture handler errors. The
"iterate one by one" cadence is: foundation once, then a small binding per framework.

## §N. NestJS adapter (`@bugsee/nestjs`) — BUILT 2026-06-15

NestJS is more than a thin binding because, unlike Express/Fastify, it has **two** places to catch errors
with **different coverage**, and it runs on **two** platforms (express / fastify). The seam choice was made
**empirically**: a throwaway probe registered a global interceptor AND a global filter on a real Nest app
and threw in every lifecycle phase (`Middleware → Guards → Interceptors → Pipes → Handler → Filters`). Result:

| Error thrown in | Interceptor `catchError` | Global filter |
| --- | --- | --- |
| Middleware | ✗ | ✗ (escapes to the platform default) |
| **Guard** | ✗ (runs before the interceptor subscribes) | ✓ |
| Pipe / Handler / Service / HttpException | ✓ | ✓ |

So the filter is a strict superset (it adds guards), which is **why Sentry uses a global filter** — but its
filter `extends BaseExceptionFilter` (imports `@nestjs/core`) and, being catch-all, collides with a user's
own global filter (Sentry ships a `@SentryExceptionCaptured` decorator escape hatch for exactly that).

**Decision (user-driven): configurable, interceptor by default.**
- **Context** opens in an `app.use` middleware via **`enterWith`** (not `run`): on the Fastify platform a
  `run()`-wrapped `next()` can lose the ALS context across the body-parse async boundary (nodejs/node#41285);
  `enterWith` is uniformly safe and matches the `@bugsee/fastify` hook. Proven by a real Nest+Fastify
  POST-with-body e2e.
- **Default `errorCapture: 'interceptor'`** — `catchError` → report → **re-throw untouched** (Nest's own
  filters still format the response; no `@nestjs/core` import; no filter conflict). Covers handler/service/pipe
  = all real unhandled bugs; the guard gap is acceptable (guard throws are nearly always expected 4xx, skipped).
- **Opt-in `'filter'` / `'both'`** — a global `ExceptionFilter extends BaseExceptionFilter` (`Catch()` applied
  *functionally* so the source needs no decorator transform) that reports then `super.catch()` (response
  unchanged). `setupNest` passes `app.getHttpAdapter()` to the constructor — REQUIRED, because a non-DI
  `useGlobalFilters(new …)` filter has no injected `httpAdapterHost`, so `super.catch()` would otherwise throw.
  `'both'` shares a per-request `WeakSet` → an error seen by both seams reports once. `@BugseeExceptionCaptured()`
  decorates a user's own filter as the collision escape hatch.
- **Report policy** — skip Nest `HttpException`s (4xx AND 5xx; control flow), report genuine errors;
  `shouldReport` overrides. **Transaction OK/ERROR** comes from the **thrown error's** status (4xx → OK,
  5xx/non-Http → ERROR), not `res.statusCode` (unreliable at the rxjs terminal) — matching express/fastify's
  `status >= 500` intent.
- **Packaging** — `@nestjs/common`/`@nestjs/core`/`rxjs` are PEERs; `sideEffects` is omitted (the filter
  applies `Catch()` metadata at module load — a `false` hint would let a consumer's bundler tree-shake it away).

Built test-first (unit per seam + a real-Nest e2e on **both** platforms: the coverage matrix, 4xx-skip, dedup,
response preservation, concurrency isolation), multi-agent reviewed (2 MAJORs fixed: the Fastify `enterWith`
and the thrown-error-status transaction outcome).
