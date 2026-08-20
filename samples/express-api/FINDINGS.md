# Findings — samples/express-api

> **Status update (after the wave-1 fix round).** The wire-contract defects this sample found —
> `x-client-type: web`, the unparsed `{ok, result}` response envelope with its snake_case ids, the
> HTTP-200 rejection read as success, and the `x-amz-checksum-sha256` header on the signed S3 PUT —
> are FIXED in `@bugsee/core` (`0318229`, `84976f7`). The missing `publishConfig` on
> `@bugsee/replay`/`replay-canvas`/`rrweb` and friends is fixed in `3921760`, and the `0.0.0` SDK
> version the collector rejected is fixed in `6d63ba8`. The workarounds this sample carried for those
> have been removed, and it was re-verified against real staging with the SDK as a customer gets it.
>
> What remains open here is tracked in `samples/FINDINGS.md`: the collector's CORS policy (which no
> browser sample can work around honestly), and the upload pipeline deferring bursts of more than four
> concurrent reports to the next process start (F-X8) — which is what several remaining "wire" checks
> in this sample are actually measuring.



Every SDK defect, data-arrival failure or data inconsistency observed while building and running
this sample. One entry per finding. Do NOT fix SDK code here — record it.

Severity: **blocker** (SDK unusable / data lost) · **major** (feature broken or wrong data) ·
**minor** (cosmetic, docs, ergonomics).

All findings below were reproduced against the **packed pre-publish tarball** this sample installs
(`.local-registry/bugsee-*.tgz`, built by `node scripts/pack-local.mjs` from `packages/*`), talking to
the real `apidev.bugsee.com` staging collector — never production, never the monorepo source. F-1 and
F-2 were independently corroborated by another concurrent sample build (`node-service`, evidenced by
its `SDIAGWEB` diagnostic app visible in `list_applications`), and — as of this writing — appear to
already be fixed in the **live** `packages/core/src/bugsee-api.ts` working tree (uncommitted). That fix
is **not** in the tarball this sample tested against; `pack-local.mjs` needs a re-run for it to reach
any sample. F-3 is still present in the live source as of this writing.

## Open

### F-1 · `x-client-type` hardcoded to `'web'` breaks every non-browser SDK platform

- **Severity:** blocker
- **Package:** `@bugsee/core` (`packages/core/src/bugsee-api.ts`, `baseHeaders()`)
- **Scenario:** any report on any Node/Bun/Deno/Electron-main/edge platform (not just express) —
  reached via every `S4`/`S5`/`S7`/`S8`/etc. scenario in this sample
- **Expected:** a `type: "javascript"` staging application accepts a session handshake from the Node
  SDK.
- **Observed:** `createBugseeApi`'s `baseHeaders()` sends the literal string `'web'` for
  `x-client-type` regardless of the actual runtime. Once the SDK version clears the separate version
  gate (see F-4's downstream note below, and `samples/FINDINGS.md` F-X2 for the root `0.0.0` cause),
  the collector rejects the session with HTTP 200 and body `{"ok":false,"error":{"type":
  "ApplicationTypeMismatchError","message":"Application type does not match the expected type",
  "code":11004}}`. Confirmed by isolation: rewriting only this one header to `'javascript'` on the wire
  (nothing else changed) makes the exact same request succeed.
- **Reproduce:** launch for real against staging, trigger any scenario that logs an exception, inspect
  the raw `/v2/sessions` response body — or see `src/bugsee-transport.ts`'s `CLIENT_TYPE_WORKAROUND`,
  the workaround this sample applies purely so the REST of its verification can reach the backend.
- **Evidence:** reproduced live via a standalone probe script against `apidev.bugsee.com` for app
  `SEXPRESS` (`6a86d8ef49f15abdb072ea95`); response body captured verbatim above.
- **Status:** appears fixed in the live (uncommitted) `packages/core/src/bugsee-api.ts` — not yet in
  the packed tarball.

### F-2 · Session/issue responses are decoded as the raw DTO; the real backend wraps them in `{ok, result|error}`

- **Severity:** blocker (compounds with F-1; independently fatal even if F-1 is fixed)
- **Package:** `@bugsee/core` (`packages/core/src/bugsee-api.ts`, `ensureSession()` + `postIssue()`)
- **Scenario:** every report, on every platform
- **Expected:** a successful `/v2/sessions` call yields a usable `access_token`; a rejected
  `/v2/issues`/`/v2/sessions` call is treated as a failure (retried / session invalidated).
- **Observed:** the real collector wraps every `/v2/*` response as `{"ok":true,"result":{...}}` on
  success or `{"ok":false,"error":{...}}` on a REJECTED request — which still arrives as **HTTP 200**.
  `ensureSession()` reads `access_token` off the TOP level of the decoded body
  (`(decode(response.body) as {access_token:string}).access_token`), which is `undefined` for both the
  success shape (the real token is one level down, under `result`) and the failure shape. Because
  `accessToken` becomes the literal value `undefined` (not `null`), the memoization guard
  `if (accessToken !== null) return accessToken;` treats it as "already authenticated" **forever** —
  every subsequent request for the life of the process sends `Authorization: Bearer undefined`, is
  rejected with `SessionNotFoundError` (code 14002, again HTTP 200), and `postIssue()`'s
  `!isOk(response.status)` check never fires (status is 200), so it never throws, so
  `api.invalidateSession()` (in `upload-pipeline.ts`'s retry logic) never runs either. `issue.endpoint`
  ends up `undefined`, and the subsequent signed PUT throws `TypeError: Failed to parse URL from
  undefined`. **Net effect: once triggered (which happens on the FIRST report after launch), no
  further report EVER uploads its bundle for the rest of the process's life, with zero error surfaced
  to the app** — `onError` is not wired to upload outcomes.
- **Reproduce:** launch with a real endpoint, log one exception, inspect the raw `/v2/sessions`
  response body (see evidence) vs. what `ensureSession()` reads.
- **Evidence:** captured a real successful `/v2/sessions` response:
  `{"ok":true,"result":{"version":1,"access_token":"f638f2e4-d417-4d2e-a79a-fac6154b1a00","anonymous":true,"config":{...}}}`
  — followed by the SDK sending `Authorization: Bearer undefined` on the next call, rejected with
  `{"ok":false,"error":{"type":"SessionNotFoundError","message":"Session not found or has expired","code":14002}}`.
- **Status:** appears fixed in the live (uncommitted) `packages/core/src/bugsee-api.ts` (adds an
  `unwrap()` helper + throws a `BugseeError` on `ok:false`, and also fixes a related snake_case
  (`issue_id`/`recording_id`) vs camelCase (`issueId`/`recordingId`) field-name mismatch in the issue
  response) — not yet in the packed tarball.

### F-3 · The signed S3 bundle PUT always fails with `403 SignatureDoesNotMatch`

- **Severity:** blocker — **still open** (not touched by the F-1/F-2 fix above)
- **Package:** `@bugsee/core` (`packages/core/src/bundle-uploader.ts:21-27`, `createBundleUploader`)
- **Scenario:** every bundle upload, on every platform — this is the LAST step of every report; it is
  what actually delivers the recording/logs/crash data, as opposed to just the issue metadata.
- **Expected:** the signed PUT to the S3 endpoint returned by `/v2/issues` succeeds.
- **Observed:** `putBundle()` sends `Content-Length`, `x-amz-checksum-sha256` and `fileName` as request
  headers on the PUT. Because `x-amz-checksum-sha256` matches AWS's `x-amz-*` prefix, S3's SigV2
  signature verification folds it into the canonicalized-headers portion of the string-to-sign — but
  the collector's presigned `Signature` query parameter was computed WITHOUT that header (it cannot
  know the client-computed checksum in advance), so S3 rejects the PUT with `403
  SignatureDoesNotMatch — "The request signature we calculated does not match the signature you
  provided."` **Every single bundle upload fails this way, unconditionally.** Isolated by dropping only
  this one header (kept `Content-Length` and `fileName`, which is not an `x-amz-*` name and is
  therefore harmless/unsigned): the identical PUT to the identical signed URL then returns `200`.
- **Reproduce:** launch for real, trigger `logException`, inspect the PUT request/response — or see
  `src/bugsee-transport.ts`'s F-3 workaround (strips the header before the request leaves the process).
- **Evidence:** captured the S3 error body verbatim, including its own `StringToSign` echo (confirms
  `x-amz-checksum-sha256` was folded into the canonicalized headers); a same-URL PUT with the header
  removed returned `200`. Multiple real issues on `SEXPRESS` (`SEXPRESS-2` through `SEXPRESS-11`) exist
  ONLY because this sample's transport strips the header — without the workaround, `list_issues` for
  `SEXPRESS` stays at `total: 0` no matter how many exceptions are logged.
- **Fix direction (not applied):** either stop sending `x-amz-checksum-sha256` as a header (validate the
  checksum server-side after upload instead, e.g. via `Content-MD5`, which IS a standard signed header),
  or have the collector fold the client's checksum into the presigned URL's own signature computation.

### F-4 · `http.route` loses every `app.use()` mount prefix for nested Express routers

- **Severity:** major
- **Package:** `@bugsee/express` (`packages/express/src/middleware.ts:69`, `routeOf()`)
- **Scenario:** route naming (§4 S9 / §5.14-20) — the PLAN's own example is
  `/projects/:id/tasks/:taskId`, which is exactly this app's real task routes
- **Expected:** `http.route` (the `http.server` transaction name / the refined span route) is the FULL
  matched pattern, e.g. `/projects/:id/tasks/:taskId`.
- **Observed:** `routeOf = (req) => req.route?.path` reads only the innermost `Router()`'s own local
  pattern, ignoring `req.baseUrl` (the accumulated mount-path prefix from every `app.use('/prefix',
  router)` it passed through). This is not a two-levels-deep-only bug — it drops the prefix at ANY
  nesting depth, including a single `app.use('/scenarios', scenariosRouter)`. Reproduced on this app's
  own real routes (captured on the wire via the `/v2/performance/transactions` upload):
  - `POST /projects/:id/tasks` (task creation, nested under `buildTasksRouter`) → recorded as
    **`POST /`** (the router's OWN root pattern, with zero indication it was ever
    `/projects/:id/tasks`).
  - `GET /projects/:id/tasks/:taskId` (task fetch) → recorded as **`GET /:taskId`**.
  - `GET /alt/status` (mounted via `app.use('/alt', altRouter)` in the adapter-alone secondary app) →
    recorded as **`GET /status`**.
  This is Express's single most common routing idiom (organizing resources into per-collection
  `Router()`s) — any real Express app that does this gets systematically wrong/misleading route names
  in every `http.server` transaction and in `errorHandler`'s `http.route` attribute.
- **Reproduce:** `pnpm dev`, `POST /projects/:id/tasks`, inspect the `http.server` transaction name sent
  to `/v2/performance/transactions` (MCP does not expose performance data — this is wire-only, captured
  via this sample's tee transport at `/scenarios/_debug/transactions`).
- **Fix direction (not applied):** `routeOf` should return `req.baseUrl + (req.route?.path ?? '')`
  (Express's own documented pattern for reconstructing the full route), collapsing a trailing `/` for
  the root-mounted case.

### F-5 · `@bugsee/express` has no `shouldReport` customisation — every unhandled route error is always reported

- **Severity:** major
- **Package:** `@bugsee/express` (`packages/express/src/middleware.ts`, `errorHandler()` /
  `ExpressAdapterOptions`)
- **Scenario:** §5.14-20's own catalog line: "`shouldReport` customisation" — every backend sample is
  expected to cover it.
- **Expected:** like its sibling adapters, express should let the app decide whether a given error is
  worth reporting (e.g. skip a deliberately-thrown 4xx `HttpError` used for control flow).
- **Observed:** `ExpressAdapterOptions` has no `shouldReport` field at all. `errorHandler()` calls
  `client.logException(err, {mechanism:'http-error'})` UNCONDITIONALLY for every error that reaches it —
  it never calls `span.captureError()` (the shared `@bugsee/node` `ServerRequestSpan` method that DOES
  support a `shouldReport` gate + the shared status-based `defaultShouldReport`), unlike `@bugsee/koa`
  (`packages/koa/src/middleware.ts:40,88,116`) and `@bugsee/hapi` (`packages/hapi/src/hooks.ts:63,126,169`),
  which both expose `shouldReport` and route through `captureError`. The `middleware.ts` comment even
  documents this as deliberate policy ("Express reports EVERY unhandled route error"), but that leaves
  express as the only backend adapter in the sweep unable to filter a thrown error by status/type — a
  genuine capability gap relative to its siblings, since the PLAN explicitly expects this scenario to
  be exercisable for every backend sample.
- **Reproduce:** `throw new Error(...)` with a custom `.status = 400` from a route handler; it is always
  reported, with no option to suppress it (unlike koa/hapi's `shouldReport: () => false`).
- **Workaround in this sample:** the "4xx not reported / 5xx reported" contract is instead demonstrated
  the only way express allows it — a 4xx returned via `res.status(400).json(...)` (never thrown) simply
  never reaches `errorHandler` at all (see `/scenarios/status/4xx` vs `/scenarios/status/5xx-thrown`).

### F-6 · `get_issue` (MCP) never surfaces custom attributes, labels, or the report mechanism

- **Severity:** minor (tooling/verification-surface gap, not a data-loss bug — the data genuinely
  reaches the backend, see wire evidence)
- **Package:** N/A (Bugsee staging MCP server / viewer surface, not an SDK package)
- **Scenario:** S2 (attributes), S4 `options` (labels/severity/mechanism), S8 `report-mutate` (label
  added by a `ReportHandler.before`)
- **Expected:** per PLAN §6 step 4, `get_issue` should let us confirm "attributes, labels and the user
  identifier set in S2 are present."
- **Observed:** across every `get_issue` response inspected (`SEXPRESS-1` through `SEXPRESS-11`), the
  markdown has no "Attributes" or "Labels" section at any depth — custom attributes (`setAttribute`)
  only ever appear in the bundle's `manifest.json` `attrs` field (confirmed present and correct there
  via this sample's wire tee — see `src/bugsee-transport.ts`'s `parseBundle`), never in anything
  `get_issue` exposes. Likewise "# Report source" always renders `Trigger: not reported` regardless of
  the actual `source.mechanism` sent (`programmatic`, `uncaught`, `http-error`, …, all verified correct
  on the wire in `request.json`). There is no dedicated "Labels" section to confirm the
  `s8-report-mutate` `ReportHandler` actually appended `'mutated-by-report-handler'` either (confirmed
  on the wire instead, not via MCP).
- **Evidence:** compare any `get_issue` output in this run against the corresponding `manifest.json`
  `attrs` captured via `/scenarios/_debug/bundles`.
- This is the gap the PLAN itself anticipates (§6 step 6: "what the MCP surface does not expose ... is
  verified at level 2 (wire) instead") — recorded here because attributes specifically are not called
  out in that list, and the step-4 checklist implies they should be checkable.

### F-7 · A merged issue can display one event's message with a DIFFERENT event's stack trace

- **Severity:** major (data-integrity concern in the issue detail view) — **low confidence**, single
  observation, not independently re-isolated before time ran out; flagged for the backend/viewer team
  to investigate rather than asserted as a root-caused defect
- **Package:** N/A (backend issue grouping/fingerprinting, not an SDK package)
- **Scenario:** the 50-concurrent-request scenario (§4 / §5.14-20's concurrency-correlation contract)
- **Expected:** each concurrent request's report is either its own issue, or, if fingerprint-grouped
  with others, the displayed stack trace and the displayed message belong to the SAME event.
- **Observed:** `SEXPRESS-3` (`events_count: 2`) shows `# Summary` /
  `## Reason/message: s5-unhandled-rejection-run-mt1fkx7t` (an S5 scenario's message) paired with
  `## Stack trace` whose top frame is `scenarios.ts:197:25` — the concurrency handler's `throw new
  Error('concurrency-...')` line, an unrelated scenario. Two structurally different throws (different
  source location, different message) appear to have been fingerprint-grouped into one issue, and the
  rendered detail mixes fields from different events.
- **Reproduce:** not independently reproduced in isolation (discovered while investigating the
  concurrency scenario's partial delivery, see below); revisit with a smaller, more controlled
  concurrent-throw pair.

## Backend-verification limitations observed (not necessarily defects)

- **Bulk delivery throughput.** The `S4.storm` (200 rapid `logException` calls) and the 50-concurrent
  request scenario are, per §4/§5.14-20, expected to all eventually reach the backend. In practice,
  against the shared `apidev.bugsee.com` staging collector (concurrently under load from at least one
  other sample build in this same exercise — `node-service` was observed running against the same
  collector at the same time), only a small fraction of a 200/50-item burst was confirmed delivered
  within a realistic test window (tens of issues out of hundreds attempted across the whole sweep);
  `client.flush(15000)` itself reported `flushed:false` for the full sweep. This may be
  `UploadPipeline`'s `bufferSize: 4` concurrency cap simply being slow against real network latency at
  this volume, real collector-side rate limiting, or contention from a concurrently-running sibling
  sample — it was not isolated further given time constraints. The MECHANISM itself (dedup, per-request
  isolation, redaction, report/route correlation) IS verified, both on the wire and against the real
  backend, at smaller scale (see `scenarios.md`). Local behavior (the app not crashing, correct
  per-request HTTP responses under the full 200/50 load) is fully verified at full volume.
- **`SEXPRESS-1`** is an artifact of an early diagnostic probe script used to isolate F-1/F-2/F-3 (not a
  scenario route) — left as-is rather than manufacturing a way to "delete" it (no delete tool is
  exposed via MCP); noted here for anyone auditing the app's issue list.

## Resolved

_(none — findings above are SDK-side; this sample's own bugs, found and fixed during the build, are not
tracked here per the template's intent. One is worth a pointer for reviewers: `src/routes/scenarios.ts`'s
`s2/identity-attributes` handler originally cleared `after_attr` immediately after responding, which
raced the async bundle assembly of the fire-and-forget `s2-after` report and usually won — fixed by not
clearing it there at all; `/scenarios/s2/clear-attributes` is the dedicated scenario for
`clearAttribute`/`clearAllAttributes` instead.)_
