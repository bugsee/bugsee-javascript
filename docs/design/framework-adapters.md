# Framework adapters + the per-request context foundation

**Status:** Design approved 2026-06-15 (pre-implementation). Author dialogue + decision log below.
Build order: the portable foundation first, then **Express** as its first consumer; every later backend
adapter (fastify / nestjs / next-server) is a thin re-binding of the same foundation.

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
- Add `contextId?: string` and `trace?: { traceId, spanId }` to the **capture entry** wire and
  `contextId?` to the **report** (request.json). Wire names follow existing snake_case
  (`context_id`/`trace_id`/`span_id`). Coordinate names here; flag for **Android cross-SDK parity** (a
  JS-originated concept).
- User → existing `environment.user`; attributes → the report's existing `custom`/`labels` surface
  (no new report field needed — verify `custom` shape in S1).

### S2 · Core seam (`@bugsee/core`)
- `RequestContext` (portable): `{ readonly contextId: string; user?: string; attributes?: Record<string,
  string|number|boolean>; trace?: { traceId: string; spanId: string } }`.
- `ContextProvider` (`getCurrent(): RequestContext | undefined`), injected via the DI container
  (`ContextProviderToken`).
- **Stamp site (one):** `CaptureAggregator.addEntry` reads `getCurrent()` and stamps
  `contextId`/`trace` onto the entry. `contextId`/`trace` become first-class optional fields on
  `CaptureDataEntry` (alongside `timestamp`), serialized into each entry's wire JSON via
  `CaptureDataEntryBase`. An entry carries the context active **when it was added** (not the report's).
- **Merge site:** report assembly reads `getCurrent()` and sets `report.contextId`, merges
  `user` (context over global env) and `attributes` (global then context). No provider → no stamp, no
  merge.

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
  a guard, `client.logException(err, { mechanism: 'unhandled' })` — runs inside the request's ALS chain,
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
