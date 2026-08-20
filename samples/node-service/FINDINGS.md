# Findings — samples/node-service

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

## Open

### F-1 · Staging rejects every session for this app's `javascript` type — blocks ALL backend delivery

- **Severity:** blocker
- **Component:** staging appserver (`apidev.bugsee.com`), `POST /v2/sessions` — not a `packages/*` file
  in this repo, but the round-trip defect this whole exercise exists to catch (PLAN.md §0)
- **Scenario:** every scenario that ends in a report/transaction upload (S1–S13, i.e. the entire
  catalog) — this is the ONE finding that determines the "BACKEND: unverified" status recorded for
  every scenario in `scenarios.md`
- **Expected:** `POST https://apidev.bugsee.com/v2/sessions` with `app_token` = the `SNODE` app's
  token and `sdk.type: "javascript"` returns a session; the subsequent issue lands on the `SNODE`
  app and `list_issues`/`get_issue` show it.
- **Observed:** every session-create call is rejected at the HTTP-200 application-error level (never
  a transport failure):
  - with the SDK's default `sdkVersion` (the package version, `"0.0.0"`):
    `{"ok":false,"error":{"type":"UnsupportedSdkError","message":"SDK version is no longer supported.
    Please update to the latest version","code":99098}}`
  - with any plausible real-looking `sdkVersion` override (tried `1.0.0`, `3.5.0`):
    `{"ok":false,"error":{"type":"ApplicationTypeMismatchError","message":"Application type does not
    match the expected type","code":11004}}`
  - Reproduced against **both** the real `SNODE` app (`type=javascript, subtype=node` — an EXACT
    match with the environment payload's `sdk.type:"javascript"` / `platform.type:"node"`) and a
    throwaway diagnostic app `SDIAGWEB` (`type=javascript, subtype=browser`, temporary, safe to
    delete) — the mismatch persists regardless of subtype, which rules out a simple
    subtype-vs-platform mismatch and points at the `javascript` **type** itself not yet being fully
    recognized by the staging session-validation path. Consistent with the still-in-progress JS
    backend-support project (worker-side JS-crash routing is done; the appserver-side `javascript`
    app-type surface is explicitly listed as remaining work).
  - Net effect: **zero** issues ever reach `SNODE` — confirmed via `list_issues` after dozens of
    triggered `logException`/hang/crash/performance calls across this sample's whole build-and-test
    session: `{"issues":[],"total":0}`.
- **Reproduce:**
  ```
  cd samples/node-service
  node --env-file=.env scripts/repro-session-rejected.mjs          # sdkVersion 0.0.0 -> UnsupportedSdkError
  node --env-file=.env scripts/repro-session-rejected.mjs 1.0.0    # any other version -> ApplicationTypeMismatchError
  ```
- **Evidence:** `list_issues(SNODE)` → `{"issues":[],"total":0}` after the full `pnpm verify` sweep
  (24/24 scenarios triggered, all with distinct markers) plus every scenario documented in
  `scenarios.md`; raw request/response pairs captured via `BUGSEE_WIRE_LOG` (see
  `data/verify-wire-*.ndjson`, or run the repro script above for a live capture).
- **Impact on this sample:** every scenario is verified at LOCAL and, where the SDK's own wire
  traffic could be tapped, WIRE depth (§4). BACKEND depth (§4 point 3, the MCP `get_issue` check) is
  blocked for the whole sample and is recorded as "unverified — blocked by F-1" throughout
  `scenarios.md`, not silently skipped.
- **This is very likely cross-cutting** (affects every `javascript`-type sample, not just
  `node-service` — the same `@bugsee/core` session/upload code runs on every platform). Mirrored in
  `samples/FINDINGS.md`.

### F-2 · `x-client-type` is hardcoded to `'web'` for every runtime

- **Severity:** major
- **Package:** `@bugsee/core` (`packages/core/src/bugsee-api.ts:38`)
- **Scenario:** any launch on a non-browser platform (this sample: node; also bun/deno/electron-main)
- **Expected:** the control-plane headers identify the actual runtime the SDK is running on
  (`environment.platform.type` already does this correctly — `"node"` for this sample), so a backend
  that discriminates by client type sees a consistent signal.
- **Observed:** `packages/core/src/bugsee-api.ts:38` sets `'x-client-type': 'web'` unconditionally,
  for every platform:
  ```ts
  const baseHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    accept: '*/*',
    'x-client-type': 'web',                 // <-- always 'web', even from @bugsee/node
    'user-agent': `BugseeJS/${sdkVersion}`,
    'x-bugsee-internal': '1',
    'x-app-token': appToken,
  });
  ```
  Confirmed via a request-logging `transport` override (`scripts/repro-session-rejected.mjs`): every
  `POST /v2/sessions` from this **node** sample carries `"x-client-type":"web"`, while the SAME
  request's own JSON body correctly reports `"platform":{"type":"node",...}`. The header and the body
  disagree about what platform is calling.
- **Not confirmed as the root cause of F-1** — a diagnostic app created with `subtype=browser` (so
  `x-client-type:'web'` would nominally match) hit the identical `ApplicationTypeMismatchError`, so
  F-1 is more likely an appserver-side gap unrelated to this header. Recorded on its own merits: this
  is an objectively wrong, platform-blind constant in shared code that any FUTURE backend-side
  client-type check would immediately trip on for every non-browser SDK.
- **Reproduce:** `node --env-file=.env scripts/repro-session-rejected.mjs` and inspect the printed
  request headers.
- **Fix direction (not applied):** derive `x-client-type` from the injected `EnvironmentEnvelope` /
  platform probe instead of a literal, or accept it as a constructor option supplied by each platform
  package.

### F-3 · `ensureSession` treats an HTTP-200 application-level error as a successful session

- **Severity:** major
- **Package:** `@bugsee/core` (`packages/core/src/bugsee-api.ts:70-74`)
- **Scenario:** any report upload when the backend returns `HTTP 200` with a body-level
  `{"ok":false,"error":{...}}` envelope (exactly what staging returns for F-1)
- **Expected:** a body-level `ok:false` is treated as a failure — either `ensureSession` rejects, or
  the resulting `UploadResult.error` carries the backend's actual error message/type/code so the
  caller (and `onError`) can diagnose it.
- **Observed:**
  ```ts
  // packages/core/src/bugsee-api.ts:70-74
  if (!isOk(response.status)) {                 // status-code check ONLY
    throw new BugseeError(`session create failed (status ${response.status})`, response.status);
  }
  accessToken = (decode(response.body) as { access_token: string }).access_token as AccessToken;
  return accessToken;                            // returns undefined — no check that this succeeded
  ```
  `isOk(200)` is `true`, so the throw never happens. `decode(response.body).access_token` on an
  `{"ok":false,"error":{...}}` body is `undefined`, silently assigned to `accessToken`. Every
  subsequent call in this session (`createIssue`/`renewUpload`) then sends
  `authorization: Bearer undefined` and gets a **second**, DIFFERENT, unrelated-looking backend error
  (`SessionNotFoundError`, code 14002) instead of the original, actionable one
  (`UnsupportedSdkError`/`ApplicationTypeMismatchError`). The `UploadResult.error` the caller
  eventually sees (`client.logException(...)` → `result.error.message`) is a generic
  `"bundle upload failed (status 0)"` from a much later, unrelated failure (the signed PUT to a
  `undefined` endpoint) — three real errors deep from the one that actually explains the failure.
  Diagnosing this took a purpose-built request-logging `transport` override; `onError` alone never
  surfaces enough to find the real cause (see `scripts/repro-session-rejected.mjs`, which prints
  BOTH the true backend error and the final client-visible one side by side).
- **Reproduce:** `node --env-file=.env scripts/repro-session-rejected.mjs 1.0.0` — compare the printed
  `>>> POST /v2/sessions` response body against the final `result.error?.message`.
- **Fix direction (not applied):** check a body-level `ok`/`access_token` presence in addition to the
  HTTP status; surface the original error (type/message/code) on the thrown `BugseeError`'s `cause`
  so it isn't lost on the second, unrelated failure.

### F-4 · `bundle-uploader.ts` discards the underlying transport error on a PUT failure

- **Severity:** minor
- **Package:** `@bugsee/core` (`packages/core/src/bundle-uploader.ts:30-32`)
- **Scenario:** any signed-PUT failure caused by a thrown transport error (e.g. an invalid/`undefined`
  URL, as produced downstream of F-3; or a genuine network failure)
- **Expected:** the caught error is attached (e.g. as `BugseeError.cause`) so `onError`/the returned
  `UploadResult.error` can show what actually went wrong.
- **Observed:**
  ```ts
  } catch {                                              // packages/core/src/bundle-uploader.ts:30
    return { ok: false, status: 0, retryable: true };    // the caught error is discarded entirely
  }
  ```
  Compare `upload-pipeline.ts`'s OWN catches around the same call, which DO thread `{ cause: err }`
  onto the `BugseeError` they construct — this one path is the odd one out.
- **Reproduce:** trigger any report while `dataDir`/network conditions force a PUT-phase transport
  throw (this sample hits it on every report, downstream of F-1/F-3); the final
  `"bundle upload failed (status 0)"` message carries no `cause`.
- **Fix direction (not applied):** `catch (error) { return { ok: false, status: 0, retryable: true,
  cause: error }; }` (widen `PutResult`'s failure arm to carry an optional `cause`).

## Resolved
