# Findings — samples/fastify-api

Every SDK defect, data-arrival failure or data inconsistency observed while building and running
this sample. One entry per finding. Do NOT fix SDK code here — record it.

Severity: **blocker** (SDK unusable / data lost) · **major** (feature broken or wrong data) ·
**minor** (cosmetic, docs, ergonomics).

All findings below were reproduced against the **packed pre-publish tarball** this sample installs
(`.local-registry/bugsee-fastify.tgz` etc., built by `node scripts/pack-local.mjs` from `packages/*`),
talking to the real `apidev.bugsee.com` staging collector — never production, never the monorepo
source. This sample was built AFTER `samples/express-api` isolated (and `@bugsee/core` fixed) the
wire-contract defects that once blocked every JS report from reaching staging (`samples/FINDINGS.md`
F-X2/F-X6/F-X10/F-X17), so it never carried any workaround for them; `src/bugsee-transport.ts` rewrites
no request the SDK makes.

**Sample-side correction (2026-08-26).** "Rewrites nothing" was previously stated as if it also meant
"behaves like the transport it replaces". It did not. The tee stands in for `@bugsee/node-utils`'
`httpRequest` (`packages/node/src/launch.ts:415-417` wires `options.transport ?? httpRequest`), and it was
guarding its timeout behind `if (options.timeoutMs !== undefined)` — dead code, because core declares
`timeoutMs` on `HttpRequestOptions` (`packages/core/src/transport.ts:27`) but never passes it at any
call site (`bundle-uploader.ts:21-34`, `bugsee-api.ts:81-85`/`:108-112`); the real transport supplies
the default itself (`http-request.ts:12,31,72-74`). Every SDK upload in this sample was therefore
UNBOUNDED, so a hung request would never abort, never convert into a retryable failure for the durable
bundle queue, and would hold an `inFlight` slot in the upload pipeline forever — a behaviour change
introduced by the sample's own interception. The tee also unzipped and JSON-parsed each bundle
*before* resolving the SDK's request, charging the SDK's own upload for work no real transport does.
Both are fixed, and the parity contract (plus one documented residual difference: a total-request
deadline where node uses an idle-socket timeout) is spelled out in the file.

**Same-class follow-up (2026-08-26, third fix round).** The timeout *normalization* was then found to
cover only half the request: the try/catch that re-throws node's exact `request to <url> timed out
after <ms>ms` message wrapped only `await fetch(url, init)`, not the `await res.arrayBuffer()` body
read that follows it. Reproduced against a purpose-built server that sends headers and then stalls the
body: the tee surfaced `TimeoutError: The operation was aborted due to timeout` where `httpRequest`
surfaced `request to <url> timed out after 1500ms` (`http-request.ts:72-74`'s `req.destroy(err)`
reaching the caller via `req.on('error', fail)`, `:71`). Harmless in practice — core inspects no error
message, only whether the promise rejected — but the file's own claim ("a caller cannot tell the two
transports apart") admits no exception, so both awaited stages now sit inside the normalization, and
the same reproduction now shows identical messages from both transports. Separately, the residual
idle-vs-total-timeout difference was justified in the file on the ground that "bundles here are
kilobytes" — never measured, and in fact wrong-headed, since `profiling: true` (`src/bugsee.ts:59`)
attaches a `profile.json` to every incident bundle. Restated on the ground that actually holds and was
observed: the sweep drained 101 bundles through this transport, its 5s polling ticks advancing 6-9
bundles each, i.e. ~0.6s per upload against a 30s bound.

These are defects in the SAMPLE, not in the SDK — recorded here because a peer sample copied this file
as a template, and because the earlier "converged" declaration rested on the over-broad claim.

**What this preamble does and does not record (2026-08-27, criterion corrected in round 5).**
"Sample-side, not SDK-side" is NOT the criterion that keeps a tee defect out of this file — both
entries above are sample-side defects, and they are recorded here. Round 4 said the criterion was
REPRODUCTION and called both entries "OBSERVED, each against a purpose-built reproduction". That is
false of the first one: the unbounded upload was established by pure call-site analysis
(`packages/core/src/transport.ts:27` declares `timeoutMs`; `bundle-uploader.ts:21-34` and
`bugsee-api.ts:81-85`/`:108-112` never pass it), and no upload in any sweep has ever hung — there is no
reproduction behind it. Under a reproduction criterion it would have to be excluded exactly like the
redirect precaution below, which is the round-3 mistake ("the exclusion was right; that stated reason
was not the one doing the work") repeated one round later.

The criterion that actually separates the three is whether the DIVERGENCE FROM `httpRequest` WAS SHOWN
TO OCCUR — by either of the only two routes available:

1. **The divergent branch executes on every call**, which call-site analysis alone settles: there is
   nothing conditional left to trigger, so a reproduction would add no information. The unbounded
   upload is this one. The `if (options.timeoutMs !== undefined)` guard was false on EVERY upload of
   every sweep, because no core call site passes the field, so every upload this sample made was
   unbounded where the real transport's would have been bounded.
2. **The divergent branch is conditional, and was actually TAKEN** under a purpose-built reproduction.
   The half-covered timeout normalization is this one: it diverges only when the deadline expires
   during the body read, so a server that sends headers and then stalls the body was built and both
   transports were run against it (tee: `TimeoutError: The operation was aborted due to timeout`;
   `httpRequest`: `request to <url> timed out after 1500ms`).

A third parity gap — `fetch` follows a 3xx where `http.request` does not, closed by pinning
`redirect: 'manual'` — meets NEITHER route: its branch is conditional on a hop answering 3xx, and none
ever has in any sweep (`src/bugsee-transport.ts:210-212` says so in as many words), so the divergence
was never shown to occur at all. It is a pinned precaution, and it is documented where precautions
belong — in the transport file itself and in `README.md`'s transport-parity paragraph
(`README.md:50-58`) — rather than filed as an observed finding.

Re-checked against every entry in the ledger below, the corrected criterion changes no status: F-1,
F-3 and F-7 rest on route 2 (each was taken on a real request in a real sweep — the 4xx that minted an
issue, the `setErrorHandler` interaction, the `email` present on the wire while every `SFASTIFY` issue
shows `users_count: 0`), and F-4, F-5 and F-6 rest on route 1 (an unconditional `transaction.setName()` on
every finished request; two exports absent from a shipped package surface, which no run can make
present). The only thing that changes is the reason given for excluding the redirect precaution.

## Open

### F-1 · `@bugsee/fastify` reports a genuine Fastify SCHEMA VALIDATION 4xx exactly like a thrown 5xx

- **Severity:** major
- **Package:** `@bugsee/fastify` (`packages/fastify/src/hooks.ts`, the `onError` hook, ~line 118-134)
- **Scenario:** the shared catalog's own "a 4xx that must NOT be reported" contract (§4/§5.14-20),
  exercised on the REAL app: `POST /api/v1/metrics` with a body missing the required `value` field
- **Expected:** per the catalog (and per this sample's own `express-api`-established convention: a 4xx
  that the app itself decides is a normal client error should not create a Bugsee incident), a routine
  Fastify JSON-schema validation failure — the single most common way a Fastify app produces a 400 —
  should not unconditionally create an issue.
- **Observed:** Fastify's own Ajv-based schema validation raises an internal error object
  (`FST_ERR_VALIDATION`, `statusCode: 400`) that flows through Fastify's `onError` lifecycle hook
  exactly like an application-thrown error. `@bugsee/fastify`'s `onError` handler
  (`packages/fastify/src/hooks.ts`) calls `client.logException(error, {mechanism:'http-error'})`
  **unconditionally** — there is no status-based filtering and no `shouldReport` option (see F-3). The
  result: EVERY schema-invalid request an ordinary Fastify app rejects with a plain 400 becomes a
  Bugsee issue. In a real deployment where clients routinely send malformed input (a very common
  occurrence — missing/mistyped fields, out-of-range values), this would flood the issue list with
  what is normal input validation, not a defect.
- **Reproduce:** `pnpm dev`, then
  `curl -X POST localhost:5404/api/v1/metrics -H 'authorization: Bearer metrics-api-dev-token' -H 'content-type: application/json' -d '{"name":"x"}'`
  (omits `value`) → `400 {"error":"body must have required property 'value'"}`. That shape is
  `src/server.ts`'s own `app.setErrorHandler` normalizing the response (see its comment: it MUST be
  installed BEFORE `app.register(...)`, so it is snapshotted onto every route including this one) — it
  replies with the error's `statusCode`/`message` in a flattened envelope, not Fastify's own raw
  `FST_ERR_VALIDATION` shape (`{"statusCode":400,"code":"FST_ERR_VALIDATION","error":"Bad Request","message":"…"}`).
  Bugsee's `onError` hook runs on the underlying Fastify error regardless of how the app's own error
  handler later re-shapes the HTTP response — the raw `FST_ERR_VALIDATION` error, `statusCode: 400`
  included, is what reaches `@bugsee/fastify`'s `onError`, and is what F-1 is actually about; the
  client-visible envelope above is this sample's own normalization, not evidence for or against F-1.
  `pnpm verify`'s `api.validation-4xx` check hits exactly this, and a separate `wireCheck` (`F-1: a
  schema-validation 400 …`) now asserts a bundle was actually produced for it — previously this was only
  a printed `[observed]` line outside the pass/fail gate. That check is written to assert TODAY's
  (buggy) behaviour, so it will FLIP TO FAIL the day `@bugsee/fastify` gains the `shouldReport` seam this
  finding recommends — that flip is the intended regression signal, not a bug in the check.
- **Evidence:** `SFASTIFY-1` — `## Reason/message: body must have required property 'value'`,
  `Mechanism: http-error`, `Attributes: http.route: /api/v1/metrics`. Confirmed via
  `mcp__bugsee-staging__get_issue`.
- **Contrast with `@bugsee/express`:** in Express (`samples/express-api`), a 4xx returned via
  `res.status(400).json(...)` (never thrown) simply never reaches `errorHandler` at all — the app's
  own validation code controls whether a report happens by choosing to throw or not. In Fastify, the
  FRAMEWORK ITSELF turns a declarative schema mismatch into a thrown-shaped error before the app ever
  gets a say, and `@bugsee/fastify` reports it exactly as if the app had thrown. This is a materially
  different, and materially worse, default for a framework whose signature feature is declarative
  request validation.
- **Fix direction (not applied):** apply `defaultShouldReport` (already built and exported by
  `@bugsee/node`'s shared `server-instrument.ts`, and already used by `@bugsee/koa`/`@bugsee/hapi`) in
  `@bugsee/fastify`'s `onError` hook via `span.captureError(err, {shouldReport})` instead of an
  unconditional `client.logException`, and expose a `shouldReport` option on `FastifyAdapterOptions`
  (see F-3). `defaultShouldReport` duck-types `statusCode`, which Fastify's own validation errors
  already carry — the fix would filter this case out with no additional wiring.

### F-3 · `@bugsee/fastify` has no `shouldReport` customisation at all — every unhandled route/hook/validation error is always reported (illustrated by the `setErrorHandler` interaction)

- **Severity:** major
- **Package:** `@bugsee/fastify` (`packages/fastify/src/hooks.ts`, `FastifyAdapterOptions` +
  `onError()`)
- **Scenario:** §5.14-20's own catalog line: "`shouldReport` customisation" — every backend sample is
  expected to cover it. Also illustrates §5.14-20's "Fastify's `setErrorHandler` interaction with the
  hook" line.
- **Expected:** like `@bugsee/koa` (`packages/koa/src/middleware.ts:40,88,116`, `shouldReport` +
  `captureError`) and `@bugsee/hapi` (`packages/hapi/src/hooks.ts:63,126,169`, same pattern), the
  Fastify adapter should let the app decide whether a given error is worth reporting, with a sensible
  status-based default.
- **Observed:** `FastifyAdapterOptions` (`packages/fastify/src/hooks.ts`) has fields for `user`,
  `getClient`, `newContextId` and `onError` — no `shouldReport`. The `onError` hook calls
  `client.logException(error, {mechanism:'http-error'})` directly; it never calls
  `span.captureError()` — the shared `@bugsee/node` `ServerRequestSpan` method
  (`packages/node/src/server-instrument.ts:75`) that DOES support a `shouldReport` gate and the shared
  `defaultShouldReport` (status ≥ 500 → report, else skip). This is the root cause: there is no seam to
  opt any category of error out of reporting.
- **Illustration (was filed separately as F-2; folded in here — same root cause, not a separate defect,
  and F-1's status-based fix would NOT change this case, since the thrown error below carries no
  `statusCode`):** a Fastify `setErrorHandler` that rewrites the response to 200 does not suppress
  Bugsee's report. A route was registered inside a nested plugin with its own `setErrorHandler` that
  catches a thrown error and replies `200 {handledByCustomErrorHandler:true, message}` — the
  client-visible HTTP response is a normal success. Bugsee nonetheless reported the underlying error
  via `onError`, unconditionally, exactly as it would for an unhandled 500. **Mechanism, verified
  against the actual installed dependency (not Fastify's own docs):**
  `node_modules/.pnpm/fastify@5.12.1/node_modules/fastify/lib/reply.js:952-962`'s `onErrorHook()` runs
  the `onError` hook chain (which `@bugsee/fastify` listens on) FIRST, and only calls `handleError()`
  (which invokes `setErrorHandler`/the custom error handler) as ITS callback afterward. Fastify's own
  documentation describes the opposite ordering ("`setErrorHandler` runs first; the hook only fires if
  `setErrorHandler` re-throws or otherwise sends the error back") — that description does not hold for
  v5.12.1, at least not for a plugin-scoped `setErrorHandler` on a nested encapsulated context; the
  installed source is definitive here.
  - **Reproduce:** `pnpm dev`, `GET /scenarios/s14/custom-handler/throw` (`src/routes/scenarios.ts`,
    registers a nested plugin with `custom.setErrorHandler(...)` returning 200, and a route that
    `throw`s) → HTTP response is `200 {"handledByCustomErrorHandler":true,"message":"s14-custom-handler-throw-<marker>"}`.
  - **Evidence:** `SFASTIFY-56` (`src/routes/scenarios.ts:524`) — `## Reason/message:
    s14-custom-handler-throw-<marker>`, `Mechanism: http-error`. The response was a clean 200; the
    issue exists anyway. (Re-derived 2026-08-26, twice: this scenario's throw moved `:492`→`:518`→`:524` across two
    successive rounds of edits, each minting a fresh issue at the new fingerprint — `SFASTIFY-3`
    (`:492`) and `SFASTIFY-47` (`:518`) are the now-stale predecessors; see scenarios.md's "issue keys
    are fingerprinted on file:line" note.)
    `pnpm verify`'s own wireCheck gate now asserts this directly (see F-1's own automation note — the same discipline
    applies here).
  - **Why this matters:** an app that deliberately installs a custom error handler to gracefully
    degrade a known failure mode (e.g. a feature-flagged fallback, a retried operation that succeeded
    on a second path) has NO way to tell Bugsee "this was handled, don't report it" — there is no
    `shouldReport` and no seam that lets `setErrorHandler` communicate its outcome to the `onError`
    hook.
- **This is the same class of gap `samples/express-api` found for `@bugsee/express`** — but that gap is
  now CLOSED: `@bugsee/express` has `shouldReport` (`packages/express/src/middleware.ts:64,105,155,159`).
  So do koa, hapi, hono, elysia and nestjs. **`@bugsee/fastify` is the SOLE OUTLIER among all seven
  backend adapters** — every sibling adapter lets the app opt an error class out of reporting; Fastify
  cannot, at all, for any error. That materially changes this finding's triage: it is not "the same
  known gap `express-api` already flagged", it is the one remaining adapter where the gap was never
  closed.
- **Reproduce:** read `packages/fastify/src/hooks.ts` — no `shouldReport` field, no `captureError` call.
- **Fix direction (not applied):** add `shouldReport?: (err: unknown) => boolean` to
  `FastifyAdapterOptions`, default `defaultShouldReport` (already exported by `@bugsee/node`), and
  route the `onError` hook's report through `span.captureError(err, {shouldReport})` instead of a
  direct unconditional `logException` — mirroring `@bugsee/koa`/`@bugsee/hapi` exactly.

### F-4 · `setRouteName()` has no observable effect — two independent SDK-side mechanisms clobber it

- **Severity:** major
- **Package:** `@bugsee/node` (`packages/node/src/server-instrument.ts:471`, `finishWith()`) +
  `@bugsee/performance` (`packages/performance/src/controller.ts:120-131`, `setRouteName`)
- **Scenario:** §4 S9's own catalog line: "`setRouteName`"
- **Expected:** `client.ext('performance').setRouteName(name)` called during a request renames the
  active `http.server` transaction; the rename survives to the transaction Bugsee finally sends.
- **Observed:** the call does not throw and the route returns 200, which is all `scripts/verify.ts`
  previously asserted (`scenarios.md` recorded it as "Local — verified (200 OK)", overstating what that
  actually proves). Two independent mechanisms make the rename inert:
  1. `packages/node/src/server-instrument.ts`'s `finishWith()` unconditionally calls
     `transaction.setName(spanName(info, route))` when the request finishes — this OVERWRITES whatever
     `setRouteName()` set earlier in the same request, every time, with no check for a prior manual
     rename.
  2. `packages/performance/src/controller.ts`'s `setRouteName` mutates `active`, a single
     PROCESS-GLOBAL transaction slot (not a per-request handle) — under concurrent requests, a call
     intended for request A can rename whatever transaction happens to be `active` at that moment,
     which may be request B's.
- **Reproduce:** `POST /scenarios/s9/route-name` calls `setRouteName('/scenarios/s9/named/<marker>')`;
  the http.server transaction that Bugsee actually sends for that request is named from the matched
  Fastify route pattern (`finishWith`'s `spanName(info, route)`), not the manually-set name.
- **Corrected `scenarios.md`:** this sample's S9 `setRouteName` row previously read "Local — verified
  (200 OK)" with no caveat; corrected to record the no-op explicitly and point here.
- **Fix direction (not applied, SDK-side):** `finishWith()` should skip its own `setName()` call when a
  manual rename already happened this request (e.g. a flag set by `setRouteName`/
  `setActiveTransactionName`), and/or the performance controller's active-transaction tracking should be
  per-request (keyed off the request context) rather than a single process-global slot.

### F-5 · `RequestContextStoreToken` is not re-exported from `@bugsee/fastify` or the umbrella

- **Severity:** minor (ergonomics / contract violation, not data loss)
- **Package:** `@bugsee/fastify` / `@bugsee/bugsee` (the single-install re-export contract)
- **Scenario:** the per-request-attribute concurrency scenario (S2 + the framework-adapter concurrency
  contract) needs `RequestContextStoreToken` to call `store.setAttribute()` directly from app code.
- **Observed:** `@bugsee/fastify`'s `index.ts` does not re-export `RequestContextStoreToken` (or
  `RequestContextStore`), even though its own `hooks.ts` imports and uses it internally
  (`resolveStore`). This sample was forced to add `@bugsee/node` as a DIRECT dependency
  (`samples/fastify-api/package.json`) purely to reach the token, and to reach into the client's
  internal DI container (`client.getServiceProvider(RequestContextStoreToken)`,
  `samples/fastify-api/src/bugsee.ts:106-110`) — exactly the kind of internal-DI reach-in the
  single-install re-export contract exists to avoid.
- **Cross-cutting:** `samples/express-api/src/bugsee.ts:4-6` already does the same workaround, so this
  is not fastify-specific — it affects every framework adapter that needs the per-request store from
  app code. Filing it here since this sample independently hit it; the orchestrator aggregates
  cross-sample findings.
- **Fix direction (not applied):** re-export `RequestContextStoreToken`/`RequestContextStore` (and
  ideally a stable public accessor, so app code doesn't need `getServiceProvider` at all) from
  `@bugsee/fastify` (and the other backend adapters) and/or the `@bugsee/bugsee` umbrella's node entry.

### F-6 · `HttpTransport` is not exported from the umbrella's node entry, forcing an unsafe cast to wire a custom transport

- **Severity:** minor (ergonomics / type-safety gap, not data loss)
- **Package:** `@bugsee/bugsee` (node entry) / `@bugsee/node`
- **Scenario:** this sample's tee transport (`src/bugsee-transport.ts`, the wire-verification
  mechanism every scenario in `scenarios.md` at Wire depth depends on) is passed as the `transport`
  launch option.
- **Observed:** `@bugsee/fastify`'s re-exported `launch()` types its `transport` option against an
  internal shape that is not exposed publicly, so `src/bugsee.ts:94` has to write
  `transport: createTeeTransport() as never` to satisfy the type checker — an unsafe cast a customer
  building a custom transport (a proxy, a queueing shim, a test double) would also be forced into.
- **Cross-cutting:** same family as F-5 — a public seam (`HttpTransport`) that exists and is used
  internally, but is not re-exported where app code needs to reference its type.
- **Fix direction (not applied):** export the `HttpTransport` type (and its request/response option
  shapes) from `@bugsee/node`'s and the umbrella's public surface so a custom transport can be typed
  without a cast.

### F-7 · The SDK's `user:` identity never renders on the backend — ingestion vs. MCP-render gap unresolved

- **Severity:** unresolved / unclear — recorded as a question, not a defect, per the instruction not to
  guess which side the gap is on
- **Package:** unclear — could be `@bugsee/fastify`/`@bugsee/node` (not sending the identity), the
  collector (not persisting it), or the staging MCP surface (not rendering it)
- **Observed:** `src/bugsee.ts` calls `client.setUserIdentifier(SAMPLE_USER)` with
  `sample-user@bugsee.dev`, and `request.json` (confirmed via this sample's own tee transport) DOES
  carry `email: "sample-user@bugsee.dev"` on outgoing bundles. Yet `mcp__bugsee-staging__get_issue`
  renders no user section on ANY `SFASTIFY` issue in this sweep — every one shows `users_count: 0`.
  (The size of that list is deliberately not restated here: it lives in the issue-count home in
  `scenarios.md`'s fingerprinting note, which also explains why it includes stale pre-edit duplicates.
  This was one of six places carrying the number before the sixth fix round.) As of the seventh fix
  round the SDK-side half is asserted from a THIRD angle too: `pnpm verify` reads
  `client.getUserIdentifier()` back through `/scenarios/s2/identity-attributes` and gets
  `sample-user@bugsee.dev`. That narrows the gap rather than closing it — the identity is now confirmed
  present in the client's own state, present in the `request.json` the tee sees, and absent from every
  MCP-rendered issue, so whatever loses it is downstream of the SDK.
- **Not established:** whether the collector persists the identity from `request.json` into whatever
  store backs `users_count`/the issue's user section, or whether it does and `get_issue`'s renderer
  simply doesn't surface it (the same shape of gap F-X4 found for logs). This sample cannot tell the
  two apart from the outside — stated here as unresolved rather than attributed.
- **Related, also unresolved:** `src/server.ts`'s `setupFastify({ user: ... })` option (a PER-REQUEST
  identity getter, distinct from the global `setUserIdentifier` above) is configured but never asserted
  by any scenario or `pnpm verify` check — nothing in this sweep confirms it actually reaches a report.
  Still true after the seventh fix round: the new `S2.user-identifier` check covers the GLOBAL
  `setUserIdentifier`/`getUserIdentifier`/`clearUserIdentifier` trio, which is a different surface.
  Likewise `newContextId` (a `FastifyAdapterOptions` field) is never exercised by any scenario here.
- **Fix direction:** none proposed — needs backend/MCP-side investigation to localize before a fix
  direction is meaningful.

## Corroborating an existing cross-cutting finding

### Re: `samples/FINDINGS.md` F-X4 — "Captured logs never reach the issue"

This sample independently reproduces F-X4 (`get_issue` with `include_logs` shows no `# Logs` section
on any issue, even when the scenario provably logged first — see `SFASTIFY-28` (S3 telemetry),
`SFASTIFY-41` (S6 console), both tried with `entries:"all"`) and adds the evidence F-X4 itself asked
for next: **this sample's own tee transport (`src/bugsee-transport.ts`) unzips every uploaded bundle
and confirms `logs.json` IS present and correctly populated** — e.g. the `SFASTIFY-41` (console-capture)
bundle carried all 6 console lines plus the circular-object line; an isolated re-run of the
breadcrumb-drop scenario showed the uploaded bundle's `breadcrumbs` array containing exactly the
surviving (`kept`) breadcrumb.
(Re-derived 2026-08-26 — these keys were `SFASTIFY-7`/`SFASTIFY-18` before a prior edit shifted
`src/routes/scenarios.ts`'s line numbers and re-minted fresh issues at the new fingerprints; see
scenarios.md's "issue keys are fingerprinted on file:line" note.)
**The SDK sends the data correctly.** The gap is therefore on the backend/MCP side (either the
collector does not persist `logs.json`'s contents into whatever store `get_issue` reads from, or
`get_issue`'s renderer does not read it) — not an SDK defect. This narrows F-X4's own "next step" and
should let it move from "not yet isolated" to "backend/MCP-side, not SDK-side" in
`samples/FINDINGS.md` (not edited here — the orchestrator aggregates).

## Resolved

_(none — findings above are SDK-side; this sample's own bugs, found and fixed during the build, are
worth a pointer for reviewers: the `adapter-alone` check in `scripts/adapter-alone-child.ts` initially
read the tee-captured performance transactions after a fixed 500ms sleep past `client.flush()`, which
is unrelated to the performance extension's own independent batch timer — it read 0 transactions on
the first run. Fixed by polling for evidence (10s cap) instead of a fixed sleep, per the timing
discipline this exercise requires; the underlying SDK behaviour was correct all along — see the
scenario's own comment.)_
