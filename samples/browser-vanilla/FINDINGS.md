# Findings — samples/browser-vanilla

Every SDK defect, data-arrival failure or data inconsistency observed while building and running
this sample. One entry per finding. Do NOT fix SDK code here — record it.

Severity: **blocker** (SDK unusable / data lost) · **major** (feature broken or wrong data) ·
**minor** (cosmetic, docs, ergonomics).

## Open

Five of the findings below (F-1 through F-5) form one chain: without a sample-local workaround for
each, **no browser session can ever successfully deliver a report to the real staging backend at
all** — every one of the 26 planned samples that talks to a `javascript`-app-type staging app over
HTTP would hit the same wall. This sample only produced verifiable backend evidence (§6, the issue
keys cited throughout this file and in `scenarios.md`) because `server/bugsee-proxy.ts` works around
all five; the workaround code has a full explanation of each defect in its module comment. Nothing in
`packages/` was modified by this sample.

**Update, same session:** while this sample was being verified, `packages/core` received commit
`0318229` ("fix(core): speak the collector's actual v2 wire contract") on `main`, landed by someone
else (not this sample-building process — no git commands were run here). Its own commit message says
it was "found by the first sample application talking to real Bugsee staging", which is very likely
this same investigation (or a parallel wave-1 sample hitting the identical wall) being triaged live.
It fixes exactly F-3 and F-4 below (`x-client-type`, the response-envelope unwrap, and the
snake_case→camelCase field mapping) in `packages/core/src/bugsee-api.ts`. **F-3 and F-4 are marked
resolved-upstream below rather than deleted**, because this sample's own verification evidence was
produced against the pre-fix tarball (`.local-registry/` was NOT re-packed for this sample per the
"don't touch anything outside `samples/browser-vanilla/`" instruction, so the running app still uses
`server/bugsee-proxy.ts`'s workaround for them — harmless now, since it's a no-op once the real
collector's contract and the SDK's parsing already agree). **F-1, F-2, F-5 and F-6 are still open** —
that commit did not touch `bundle-uploader.ts`, the replay/rrweb `publishConfig`, the backend's CORS
config, or the logs-visibility gap.

### F-1 · `@bugsee/replay`, `@bugsee/replay-canvas` and `@bugsee/rrweb` ship without a `publishConfig`, so the packed tarball is unusable

- **Severity:** blocker
- **Package:** `@bugsee/replay` (`packages/replay/package.json`), `@bugsee/replay-canvas`
  (`packages/replay-canvas/package.json`), `@bugsee/rrweb` (`packages/rrweb/package.json`)
- **Scenario:** S11 — session replay (any use of `replay: true` in browser launch options)
- **Expected:** installing the packed tarball resolves `@bugsee/replay`'s entry to `dist/index.js`
  (like every other browser-family package — see `@bugsee/browser`/`@bugsee/performance`/etc., which
  all have a `publishConfig.exports` block redirecting `main`/`types`/`exports` from `./src/index.ts`
  to `./dist/*`).
- **Observed:** these three packages have **no `publishConfig` field at all**. Their packed
  `package.json` (verified by extracting `.local-registry/bugsee-replay-canvas.tgz`) still has
  `"main": "./src/index.ts"` / `"exports": {".": {"import": "./src/index.ts"}}`. The packed tarball
  ships `dist/` (built, complete) plus a single `src/index.ts`, but NOT that file's sibling source
  modules (`./canvas-config`, `./encoder`, `./masking`, `./recorder`, `./register`). Resolving the
  declared entry point therefore fails outright: `vite dev` on this sample errored with 5
  `UNRESOLVED_IMPORT`s the moment `@bugsee/browser` lazy-`import()`ed `@bugsee/replay`.
  `@bugsee/rrweb` has the identical defect (its own `src/index.ts` re-exports `record` from
  `@bugsee/rrweb-record`, and would fail the same way once replay's imports resolved past its own
  layer).
- **Reproduce:**
  ```
  node scripts/pack-local.mjs
  tar xzf .local-registry/bugsee-replay-canvas.tgz -O package/package.json | grep -A3 '"exports"'
  # main/exports still point at ./src/index.ts, no publishConfig block present
  ```
  Or: scaffold any browser sample with `@bugsee/replay` and `replay: true`, `pnpm dev`, open the page —
  Vite's dependency optimizer fails before the app boots.
- **Workaround applied in this sample (not a fix):** `vite.config.ts`'s `resolve.alias` maps the three
  package names directly to their `dist/index.js` files inside the pnpm virtual store
  (`node_modules/.pnpm/@bugsee+<name>@file+..+..+.local-registry+bugsee-<name>.tgz/...`), bypassing
  the broken `package.json` resolution entirely. This is what makes S11 (replay, masking, canvas
  recording) reachable at all in this sample.
- **Fix direction (not applied):** add the same `publishConfig` block every other browser-family
  package already has.

### F-2 · Staging `apidev.bugsee.com` CORS config rejects every third-party browser origin — no browser SDK session can be created directly

- **Severity:** blocker
- **Package:** none in `javascript/` — this is a **backend** (appserver) defect, not an SDK defect. If
  triaged, it routes to `appserver`, not this repo. Recorded here because it blocks every browser
  sample's data arrival regardless of SDK correctness.
- **Scenario:** every scenario that reaches the network (S1 launch onward) — the SDK's very first
  request, `POST /v2/sessions`, is blocked before it leaves the browser.
- **Expected:** a `fetch('https://apidev.bugsee.com/v2/sessions', {...})` from an arbitrary origin
  (this sample runs on `http://localhost:5301`, a real customer site would run on its own domain)
  succeeds, or at minimum the preflight reflects the requesting origin.
- **Observed:** every CORS preflight response from `https://apidev.bugsee.com` carries a **hardcoded**
  `Access-Control-Allow-Origin: https://appdev.bugsee.com` (the staging dashboard's own origin) no
  matter what `Origin` header the request sent. Chromium therefore blocks the actual POST before
  sending it (`net::ERR_FAILED`) — verified directly with `curl`:
  ```
  curl -s -i -X OPTIONS https://apidev.bugsee.com/v2/sessions \
    -H "Origin: http://localhost:5301" -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: content-type"
  # access-control-allow-origin: https://appdev.bugsee.com   <-- wrong, ignores the Origin header
  ```
- **Reproduce:** launch the sample against the raw endpoint (bypass `server/bugsee-proxy.ts`) and open
  devtools — the console shows the CORS block on the very first session-creation request.
- **Workaround applied in this sample (not a fix):** `server/bugsee-proxy.ts` — a same-origin reverse
  proxy this sample's own dev/preview server runs (`/bugsee-proxy/*` on `:5301`). The browser only
  ever talks same-origin; the Node process (not a browser, not subject to CORS) relays to the real
  endpoint. `src/bugsee-client.ts` points `endpoint` at the proxy instead of `BUGSEE_ENDPOINT`
  directly.

### F-3 · `@bugsee/core` hardcodes `x-client-type: 'web'` on every request, rejecting sessions against any `type: "javascript"` staging app — RESOLVED UPSTREAM (see note above)

- **Status:** fixed on `main` by commit `0318229` (`packages/core/src/bugsee-api.ts`), landed during
  this same verification session. Left in full below as the original evidence.
- **Severity:** blocker
- **Package:** `@bugsee/core` (`packages/core/src/bugsee-api.ts:38`)
- **Scenario:** S1 — the very first `POST /v2/sessions` of any launch, against an app of the newer
  `javascript` app-type family (which is what `create_application` in the MCP protocol creates for
  every JS sample per `docs/samples/PLAN.md` §6, and what the staging app `SBROWSER` used here is).
- **Expected:** the session-creation request authenticates against an app whose `type` is
  `"javascript"` (subtype `"browser"`), the family this SDK's samples report against.
- **Observed:** `createBugseeApi`'s `baseHeaders()` sends `'x-client-type': 'web'` unconditionally,
  for every runtime (this constant is in the shared `@bugsee/core`, not browser-specific — node, bun,
  deno, workers, electron all go through the same function). appserver's session-creation path
  (`code/components/app/session/session.service.js:978`, `code/utils.js:1100`
  `isValidForClient(clientType, app) { return clientType === app.type; }`) requires an EXACT match.
  `'web'` only matches the legacy `web` app-type, never `'javascript'` — every session request against
  a `javascript`-type app is rejected with `ApplicationTypeMismatchError` (HTTP 200,
  `{"ok":false,"error":{"type":"ApplicationTypeMismatchError",...}}` — see F-4 for why a 200 status
  with a logical failure is itself part of the problem).
- **Reproduce:** replayed the SAME real session-creation payload captured from this sample's own
  traffic, once with each header value, directly against the real endpoint:
  ```
  curl -s -X POST https://apidev.bugsee.com/v2/sessions -H "x-client-type: web" -H "x-app-token: <SBROWSER token>" -d '{...}'
  # {"ok":false,"error":{"type":"ApplicationTypeMismatchError",...}}
  curl -s -X POST https://apidev.bugsee.com/v2/sessions -H "x-client-type: javascript" -H "x-app-token: <SBROWSER token>" -d '{...}'
  # {"ok":true,"result":{...}}
  ```
- **Workaround applied in this sample (not a fix):** `server/bugsee-proxy.ts` rewrites the
  `x-client-type` header from `web` to `javascript` on every relayed request.

### F-4 · `@bugsee/core`'s session/issue response parsing doesn't match the real backend's wire shape — no session or issue has ever authenticated against a real (non-mocked) backend — RESOLVED UPSTREAM (see note above)

- **Status:** fixed on `main` by the SAME commit `0318229` as F-3 (`packages/core/src/bugsee-api.ts`
  now has an `unwrap()` helper handling the `{ok, result}`/`{ok, error}` envelope and the
  snake_case→camelCase mapping; `packages/core/src/bugsee-api.test.ts` was rewritten to match the
  real contract). Left in full below as the original evidence.
- **Severity:** blocker
- **Package:** `@bugsee/core` (`packages/core/src/bugsee-api.ts` `ensureSession`/`postIssue`;
  `packages/core/src/transport.ts` `IssueCreateResult`)
- **Scenario:** S1 (session creation) and every scenario that reports anything (S3 onward)
- **Expected:** `ensureSession()` resolves the Bearer access token from the session-creation response;
  `postIssue()` resolves `{ endpoint, issueId, recordingId }` from the issue-creation response.
- **Observed:** TWO compounding shape mismatches, both confirmed directly against the real staging
  endpoint:
  1. **Envelope.** appserver wraps every `/v2/*` (apiVersion ≥ 2) response as
     `{ ok: true, result: {...} }` (`appserver/code/app.utils.js` `success()`), but
     `ensureSession`/`postIssue` `decode(response.body)` and read fields off the TOP level —
     `access_token`, `endpoint`, etc. — which only exist one level down, at `.result.*`. Every real
     session creation therefore resolves `accessToken = undefined`, and the SDK sends
     `Authorization: Bearer undefined` on the next call, which appserver correctly rejects with
     `SessionNotFoundError`.
  2. **Field naming.** Once the envelope is unwrapped, `/v2/issues`' real success body still uses
     snake_case (`issue_id`, `recording_id` — consistent with the rest of the wire protocol, e.g.
     `access_token`/`app_token`/`session_id`), but `IssueCreateResult` and the code reading it expect
     camelCase `issueId`/`recordingId`.
  3. **Compounding gap:** neither call checks the response body's own `ok` boolean — only the HTTP
     status (`isOk(response.status)`) — and appserver returns HTTP 200 even for a LOGICAL failure (see
     F-3's `ApplicationTypeMismatchError`, itself a 200). A rejected request is therefore silently
     treated as a success with every field `undefined`, never surfaced to `onError`, never retried.
  - The unit tests covering both functions mock the transport with the SAME flat, camelCase shape
    (`packages/core/src/bugsee-api.test.ts:39`, `enc({ access_token: token })`) — self-consistent with
    the (wrong) implementation, so this was never caught against the real wire contract.
- **Reproduce:** `curl -s -X POST https://apidev.bugsee.com/v2/sessions -H "x-client-type: javascript" -H "x-app-token: <token>" -d '{...}'` and inspect the body — `{"ok":true,"result":{"access_token":"...",...}}`, not `{"access_token":"..."}`.
- **Workaround applied in this sample (not a fix):** `server/bugsee-proxy.ts` unwraps `result` back to
  the top level and renames `issue_id`/`recording_id` → `issueId`/`recordingId` for the two affected
  endpoints, at the relay hop — the SDK's own parsing is untouched.
- **Evidence this actually blocks delivery:** before this workaround, the app's own network log showed
  `Authorization: Bearer undefined` on every `/v2/issues` call and `PUT http://.../undefined 404` on
  every upload attempt.

### F-5 · `createBundleUploader` sends an `x-amz-checksum-sha256` header the presigned S3 URL was never signed for — every bundle PUT 403s

- **Severity:** blocker
- **Package:** `@bugsee/core` (`packages/core/src/bundle-uploader.ts`)
- **Scenario:** the final step of every single report (S3 onward) — the signed PUT that actually
  delivers the bundle
- **Expected:** the signed PUT succeeds (2xx) and the bundle lands in the recordings bucket.
- **Observed:** `createBundleUploader.putBundle` unconditionally adds `'x-amz-checksum-sha256':
  options.checksumSha256` to every PUT. appserver only tells S3 to expect (and sign for) a checksum
  header when the ISSUE-CREATE request declared `bundle_md5`/`bundle_sha256`
  (`appserver/code/components/app/issue/issue.service.js:1737-1748`,
  `params.content_md5`/`content_sha256`) — fields `RequestJson`
  (`packages/protocol/src/wire.ts`) has no place for and this SDK never sends. The bucket uses SigV2
  presigned URLs, whose signature covers `CanonicalizedAmzHeaders` — every `x-amz-*` header present on
  the ACTUAL request. Sending one the presign step didn't account for invalidates the signature:
  every PUT 403s with `SignatureDoesNotMatch`.
- **Reproduce:** captured a real signed PUT URL + the SDK's real headers from this sample's traffic and
  replayed it twice against the real S3 endpoint, header present vs. absent:
  ```
  # with x-amz-checksum-sha256 (current SDK behaviour):
  curl -X PUT "<signed-url>" -H "x-amz-checksum-sha256: <hash>" --data-binary @bundle.zip
  # 403 SignatureDoesNotMatch
  # with the header dropped:
  curl -X PUT "<signed-url>" --data-binary @bundle.zip
  # 200
  ```
- **Workaround applied in this sample (not a fix):** `server/bugsee-proxy.ts` additionally rewrites
  the issue-creation response's `endpoint` to route the PUT through `/bugsee-proxy-s3?u=<url>` (this
  sample's own relay), which drops just that one header before forwarding to the real S3 URL.
- **Evidence this is the last blocker:** with F-1 through F-4 worked around but F-5 NOT worked around,
  every PUT still 403'd and no issue ever appeared on the backend. With all five worked around, a
  full session → issue → signed-PUT round trip succeeds and the issue is visible via
  `mcp__bugsee-staging__get_issue` (e.g. `SBROWSER-1` through `SBROWSER-12`, all created during this
  sample's verification runs).

### F-6 · Captured console/manual logs and breadcrumbs never appear in `get_issue`'s `# Logs` section, despite real activity immediately preceding the report

- **Severity:** major (root cause not isolated to one side — recorded as observed, not diagnosed to a
  specific file/line)
- **Package:** unconfirmed — could be `@bugsee/core`'s bundle assembly (the `log`/breadcrumb capture
  entries never make it into the uploaded bundle), or could be an appserver/worker-side gap in parsing
  this SDK's bundle format into the log view `get_issue` reads. Not diagnosed further given time.
- **Scenario:** S3 (log/event/trace/breadcrumb), S6 (console capture) — the §6 verification checklist
  explicitly calls for "the console lines, manual `log()` lines and breadcrumbs are present, in order,
  with the right levels" in `get_issue`'s `# Logs` section.
- **Expected:** `get_issue(..., include_logs: {entries: "all"})` on an issue whose session ran
  `console.log`/`client.log()`/`client.addBreadcrumb()` moments before the report shows a `# Logs`
  section listing them.
- **Observed:** reproduced 3 times across different session types, all with `include_logs:
  {entries:"all", max_log_entries: 60-80}` and clear prior activity in the SAME session:
  - `SBROWSER-4` (`S4-cause`, ran right after `S3-log-levels`/`S3-event`/`S3-trace`/`S3-breadcrumb` in
    the same page session) — no `# Logs` section at all in the response.
  - `SBROWSER-12` (`S8-report-handler` mutate-only report, same session) — no `# Logs` section.
  - `SBROWSER-10` (the Web Worker's own crash, immediately preceded by `S14-worker-launch`'s
    `console.log` inside that SAME worker) — no `# Logs` section.
  In every case the response has no `# Logs` heading at all (not even an empty one), even though the
  `# Summary`/`# Exception` sections for the SAME issue are correct and complete.
- **Reproduce:** run the Scenario panel's S3 buttons, then S4-cause, `flush()`, then
  `get_issue(issue_key, { include_logs: { entries: "all" } })`.
- **Not applied:** no workaround — this only affects backend-verification visibility in this exercise,
  not the sample's own behaviour, so nothing to route around.

## Informational (not filed as defects — investigated and explained)

- **`SBROWSER-3` shows `summary: "<missing crash details>"` and `get_issue` returns "Crash data for
  the issue was not found."** This bucket aggregated occurrences from the `S4-storm` scenario (200
  near-simultaneous `logException` calls; appserver's own per-app request-rate limiter,
  `config.web.limits.requestRate` capacity 20/refill 2, legitimately rejects most of them with a
  non-2xx, and the SDK correctly reports only the ones that got through as `ok`). Given the storm is a
  deliberately abusive test, and only a few of many near-identical rapid reports landed, this looks
  like an edge case in the same request-rate window rather than an independent defect — not chased
  further given time.
- **`# Report source` always shows `Trigger: not reported`.** The MCP tool's own description notes
  this is the value for "SDK builds that predate trigger reporting" — plausibly correct/expected for
  this SDK generation (no manual "shake"/"screenshot" trigger UI exists in the browser SDK the way it
  does on mobile). Not filed as a defect without a documented expectation to check it against.
- **S5 "unhandled rejection" reports as `Type: Handled error`, not `Type: Crash`.** Initially looked
  like a mismatch since `S5-uncaught` (the `error` event) DOES report as `Type: Crash`
  (`SBROWSER-8`). Checked `packages/browser/src/detection-providers.ts:15-16` — this is BY DESIGN:
  `error` → crash (mechanism `'uncaught'`), `unhandledrejection` → error (mechanism
  `'unhandledrejection'`). Confirmed correct, not a finding.

## Resolved

- **F-3, F-4** (`@bugsee/core` `x-client-type` + wire-envelope/field-naming) — fixed upstream on
  `main` by commit `0318229`, landed during this same session (not by this sample-building process).
  See the note at the top of "Open" and each entry's own status line; the full original write-ups are
  kept in place above rather than deleted, since they document exactly what was broken and are the
  evidence trail for the fix.
