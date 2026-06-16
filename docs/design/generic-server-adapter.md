# Generic framework-agnostic server adapter — DESIGN (SUPERSEDED / HISTORICAL)

**Status:** **SUPERSEDED — the `@bugsee/server-adapters` package is RETIRED.** Its engine was **absorbed
into `@bugsee/node`** (`packages/node/src/server-instrument.ts`, `openBugsee*` → `server*`) and **extended**
with a `run`-scoped entry (`runServerRequest`), `getActiveServerSpan`, and first-owner-wins **re-entrancy**.
The current, authoritative design is **`docs/design/incoming-server-instrumentation.md`** (which also drives
the node:http emit patch + native Bun.serve/Deno.serve wraps + the default-on flip). This file is kept for
the §4 framework-mapping history only.

> **History (reversed).** The package originally shipped (commit `5f667ae`) as a *purely additive* engine and
> the DRY refactor of the 7 adapters onto it was deliberately DROPPED. That call was **later reversed** (user
> decision): all 7 adapters (express/fastify/nestjs/hono/elysia/hapi/koa) were refactored onto the shared
> core in `@bugsee/node`, the engine was rehomed there, and the standalone `@bugsee/server-adapters` package
> was deleted (no external consumers — unreleased SDK; no facade/aliases needed). The helper duplication the
> additive approach accepted is gone — the core is now the single substrate.

## 1. Understanding / goal

Today the per-request context **foundation** is exported and framework-agnostic (`RequestContextStore` +
`RequestContextStoreToken` from `@bugsee/node`; `getCarrierClient`/`RequestContext` from `@bugsee/core`;
`parseTraceparent`; `client.ext('performance')`; `client.logException`; automatic `context_id` stamping at
`CaptureAggregator.addEntry`). But there is **no ergonomic generic API** — instrumenting an unsupported
framework means hand-assembling ~80 lines of boilerplate, and the 7 built adapters each duplicate ~70% of
that boilerplate (`resolveStore`/`tryGetPerf`/`defaultGetClient`/`startTransaction`/`finishTransaction` are
byte-identical across them).

**Goal:** a small framework-agnostic engine taking **plain values** (no framework objects) that (a) lets a
user instrument ANY backend framework / raw `http.Server` in a few lines, and (b) is the single substrate
the 7 adapters delegate to — each shrinking to "read the framework's request into plain values + supply its
framework-specific `shouldReport` + wire to the framework's hooks."

**Non-goals:** changing wire/report semantics; a universal *middleware signature* (impossible — express
`(req,res,next)` vs koa `(ctx,next)` vs hooks differ); browser/edge runtimes.

## 2. Decision log (proposed — confirm)

1. **Plain-value boundary.** The engine never sees a framework object. The adapter (or user) extracts
   `{ method, url, route?, traceparent?, user? }` and passes those. This is what makes it universal.
2. **`enterWith`, not `run`, as the single context primitive.** It is the uniformly-safe choice (already
   validated across fastify/hapi/elysia and re-confirmed for nest); a `run`-wrapped `next()` can lose the
   ALS context on some platforms. Consequence: the express/hono/koa adapters (which currently use `run`)
   switch to `enterWith` in the refactor — a low-risk behavior change (each is re-tested).
3. **The adapter resolves the final status; the engine maps it.** `finish(status)` → `OK` if `<500` else
   `ERROR`; `cancel()` → `CANCELLED`. This cleanly absorbs every per-framework variation (status-from-
   response for hono/hapi; status-from-the-thrown-error for koa/nest; abort for fastify/hapi) WITHOUT the
   engine knowing the framework — the adapter computes the number.
4. **`shouldReport` is injectable, with a robust generic default.** Default duck-types the common HTTP-error
   shapes — `getStatus()` (Nest), `status`/`statusCode` (Koa/http-errors/restify), `output.statusCode` +
   `isServer` (Boom) — and reports unless it's a `<500` "expected" error. Adapters override only where their
   convention isn't status-shaped (hono `HTTPException` via `getResponse`; elysia via its string `code`).
5. **Two layers of API** (§3): a high-level `openBugseeRequest()` (context + span together — covers the
   single-hook adapters and most users) AND decoupled `openBugseeContext()` / `startBugseeServerSpan()` (for
   adapters whose context-open and txn-start live in different hooks — NestJS opens context in middleware but
   starts the txn in the interceptor).
6. **New package `@bugsee/server`** (name TBD), node-tier, deps `@bugsee/core`/`node`/`capture`/
   `performance`. Alternative: fold into `@bugsee/node`. (Open question — see §6.)

## 3. API surface (proposed)

```ts
interface BugseeServerOptions {
  getClient?: () => Bugsee | undefined;     // default: carrier client
  newContextId?: () => string;              // default: crypto.randomUUID
  shouldReport?: (err: unknown) => boolean; // default: robust status-based duck-typer (decision 4)
}

interface BugseeRequestInfo {
  method: string;
  url: string;          // → http.url
  route?: string;       // matched route pattern → http.route + txn name (refine later via setRoute)
  traceparent?: string; // inbound W3C header value
  user?: string;        // resolved end-user identity (privacy-safe: only what the caller passes)
}

interface BugseeRequestSpan {
  setRoute(route: string): void;
  // reports iff shouldReport(err); returns whether it reported (lets callers dedup across seams).
  captureError(err: unknown, opts?: { shouldReport?: (e: unknown) => boolean }): boolean;
  finish(status: number): void; // OK if <500 else ERROR; stamps http.method/http.status_code + route name
  cancel(): void;               // finish as CANCELLED (client abort)
}

// High-level: open the context (enterWith) + start the http.server transaction + continue the trace.
function openBugseeRequest(info: BugseeRequestInfo, options?: BugseeServerOptions): BugseeRequestSpan;

// Decoupled (for split-hook frameworks like NestJS):
function openBugseeContext(info: Omit<BugseeRequestInfo,'route'|'traceparent'>, options?): void; // enterWith only
function startBugseeServerSpan(info: BugseeRequestInfo, options?): BugseeRequestSpan;            // txn only, in the active context
```

Usage from ANY framework (the long tail — Sails / Adonis / h3-Nitro / Polka / raw http.Server):

```ts
const span = openBugseeRequest({ method, url, route, traceparent, user });
try { await runHandler(); }
catch (err) { span.captureError(err); throw err; }
finally { span.setRoute(matchedRoute); span.finish(res.statusCode); }
```

## 4. Refactor mapping — does the engine express all 7? (validation)

| adapter | open | capture | finish | engine-expressible? |
| --- | --- | --- | --- | --- |
| **express** | `requestHandler`: `openBugseeRequest`, stash span on `req` | `errorHandler`: `req`-span `.captureError` | `res.on('finish')` → `.finish(res.statusCode)` | ✓ (express needs a per-req stash — minor) |
| **fastify** | onRequest: `openBugseeRequest`, WeakMap by req | onError: `.captureError` | onResponse: `.finish(reply.statusCode)`; onRequestAbort: `.cancel()` | ✓ |
| **hono** | 1 mw: `openBugseeRequest` | after next: `.captureError(c.error)` | `.finish(c.res.status)` | ✓ |
| **elysia** | onRequest: `openBugseeRequest`, WeakMap | onError: `.captureError(err,{shouldReport: code-based})` | mapResponse: `.finish(status from code)` | ✓ (elysia keeps its `code` classifier as the per-call `shouldReport`) |
| **hapi** | onRequest: `openBugseeRequest`, WeakMap | onPreResponse: `.captureError(boom)` | onPreResponse `.finish(status)`; disconnect → `.cancel()` | ✓ |
| **koa** | 1 mw: `openBugseeRequest` | catch: `.captureError(err)`; re-throw | `.finish(errorStatus ?? ctx.status)` | ✓ |
| **nestjs** | middleware: `openBugseeContext`; interceptor: `startBugseeServerSpan` | interceptor `catchError` / filter: `.captureError`; `'both'` dedup via the `captureError` return + a WeakSet | interceptor `finalize`: `.finish` | ✓ (the split-hook case the decoupled API exists for) |

Every quirk maps: `cancel()` covers abort; the adapter passing a computed status covers error-derived vs
response-derived outcome; a per-call `shouldReport` covers elysia's code classifier and nest's policy; the
decoupled primitives cover nest's middleware-vs-interceptor split. The `captureError` boolean return lets
nest's `'both'` mode dedup. **No adapter needs logic the engine can't express.**

## 5. Risks

- **Re-touching 7 reviewed packages** — each refactor is re-tested (its existing 100%-coverage suite + real-
  framework e2e must stay green) and re-reviewed. The e2es are the safety net (behavior is pinned).
- **`run`→`enterWith` for express/hono/koa** — a real (if low-risk) behavior change; the concurrency-
  isolation e2es will catch any regression.
- **API completeness** — if a future framework needs something the engine can't express, it falls back to
  the decoupled primitives + the raw foundation (always available).

## 6. Open questions (need sign-off)

1. **Package name** — `@bugsee/server`? (alts: `@bugsee/http`, `@bugsee/node-server`, or fold into
   `@bugsee/node`).
2. **Confirm decisions 2 (`enterWith` universal) + 5 (two-layer API).**
3. **Refactor cadence** — one PR per adapter (7 small, individually-reviewed commits) after the engine lands,
   or the engine + all 7 in one sweep? (Recommend: engine first + its own tests/review, then one
   adapter-refactor commit each.)

## 7. Plan — as-built

1. ~~Build `@bugsee/server-adapters` engine test-first (unit, per-entity mutator loop, 100% line/fn/branch,
   + a raw-`http.Server` e2e proving the long-tail path) → multi-agent review → commit.~~ **DONE (`5f667ae`).**
2. ~~Refactor each of the 7 adapters onto it.~~ **DROPPED** — leave the validated adapters intact (see the
   status note above). The engine stands alone as the generic / long-tail path.
3. Update PROGRESS/CLAUDE/design-doc + memory — **DONE.**
