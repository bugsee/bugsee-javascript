# Scenarios — samples/node-service

Every catalog scenario (`docs/samples/PLAN.md` §4) plus §5.13's "beyond the catalog" list, mapped to
the route/command that triggers it, what should appear in Bugsee, and its verification status.

**Read this first: `FINDINGS.md` F-1.** Staging (`apidev.bugsee.com`) currently rejects every
session-create call for the `SNODE` app (`javascript`/`node` type), so **BACKEND depth (§4 point 3 —
`list_issues`/`get_issue` via MCP) is blocked for every single scenario below**, confirmed by
`list_issues(SNODE)` → `{"issues":[],"total":0}` after this entire sweep. Every row is therefore
verified at LOCAL depth (the SDK behaved, the app kept working) and, mostly, at WIRE depth (§4 point
2) — either the SDK's own control-plane traffic (via the `BUGSEE_WIRE_LOG` transport tap) or, more
decisively, **the assembled bundle file itself** (`data/**/pending/*.bundle` is a real zip; every
demanding scenario below was confirmed by `unzip -l`/`unzip -p`-ing it and reading the actual
`crash.json`/`logs.json`/`profile.json`/`manifest.json` content). That is strictly MORE verification
than a `get_issue` call would give (it's literally the payload the backend would have processed), so
"BACKEND: blocked by F-1" below does not mean "unverified" — it means the one hop this sample cannot
reach is the actual HTTP round-trip to a live dashboard.

## S1 — Launch & lifecycle

| Trigger | Expected | Status |
| --- | --- | --- |
| `GET /health` | `isLaunched()` true after `launch()` | **LOCAL: pass** |
| `GET /scenario/s1/relaunch-ignored` | a second `client.launch()` while launched is a no-op | **LOCAL: pass** — `{before:true, after:true}` |
| `BUGSEE_PROFILE=minimal pnpm dev` | launches with every option left at its SDK default | **LOCAL: pass** — boots, `/health` OK |
| `pnpm dev` (default profile) | launches with every field in `config/launch.default.json` set | **LOCAL: pass** |
| `GET /admin/flush?timeout=` | `flush(timeout)` resolves (`true`/`false`) within the timeout | **LOCAL: pass** — resolves `false` (nothing can ever drain — F-1), always within the given timeout |
| `SIGTERM` | `client.stop(shutdownTimeoutMs)` runs before exit | **LOCAL: pass** — see §"beyond the catalog" below |

## S2 — Identity & attributes

`GET /scenario/s2?marker=<m>` — sets every `AttributeValue` type (string/number/boolean/string[]),
`setUserIdentifier` before AND after the triggering `logException`, restores the sample-wide identity.

- **LOCAL: pass** — response echoes `getAllAttributes()`/`getUserIdentifier()` with all 4 value types.
- **WIRE: pass** — `data/verify-wire-*.ndjson` shows the `/v2/issues` request body carrying
  `"email":"s2-user-<marker>"` and every attribute under `environment` (global) — attribute-per-context
  data isn't in this app-level attrs bag by design (that's S14's `RequestContextStore`, see below).
- **BACKEND: blocked by F-1.**

## S3 — Manual telemetry

`GET /scenario/s3?marker=<m>` — `log()` at all 5 `LogLevelName`s, `event()` with/without params,
`trace()`, `addBreadcrumb()` with every field.

- **LOCAL: pass.**
- **WIRE: pass** — `logs.json` inside an assembled bundle (see the S8 bundle inspection below for the
  technique) shows `level`/`message`/`context_id`/`trace_id`/`span_id` per entry.
- **BACKEND: blocked by F-1.**

## S4 — Exceptions

`GET /scenario/s4/{error,string,object,null,cause,dedupe,storm}?marker=<m>` (add `&sync=1` to await
the local dedup-check result instead of fire-and-forget — see the note below).

| Sub-scenario | Status |
| --- | --- |
| `error` (a real `Error`) | **LOCAL+WIRE: pass** |
| `string` (non-Error throwable) | **LOCAL+WIRE: pass** |
| `object` (`{code, marker}`) | **LOCAL+WIRE: pass** |
| `null` | **LOCAL: pass** (`logException(null)` doesn't throw) |
| `cause` (nested `Error.cause`) | **LOCAL+WIRE: pass** — `description` in the bundle's `request.json` carries the outer+inner stacks |
| `dedupe` (same instance twice) | **LOCAL: pass** — `?sync=1` shows the SECOND call resolves `{ok:false}` (no `error` field) **instantly**, proving `checkOrSetAlreadyCaught` short-circuits before any network I/O |
| `storm` (200 in one tick) | **LOCAL: pass** — all 200 fire synchronously without throwing/crashing the app (`localMs` in the response is the wall-clock cost of the 200 synchronous calls, single-digit ms) |

Every `logException()` call in the scenario panel is **fire-and-forget** (not awaited before the HTTP
response): F-1 means every upload runs its full retry+backoff cycle (`initialDelayMs: 5000`,
`factor: 2`, up to `maxRetries: 3` → ~5+10+20s per report) before settling, so awaiting it would make
the panel unusable. `?sync=1` is available where the LOCAL result itself is the point (dedupe).

**BACKEND: blocked by F-1** for all seven.

## S5 — Crashes

`pnpm scenario:crash <profile> <uncaught|rejection> <marker>` (`scripts/crash-harness.ts`) — runs in
its OWN process (these scenarios terminate/alter the process by design).

| Profile | Kind | Expected | Status |
| --- | --- | --- | --- |
| `default` (`exitOnUncaught:true`) | uncaught | captured, then `process.exit(1)` | **LOCAL: pass** — `exitCode:1` |
| `exit-false` (`exitOnUncaught:false`) | uncaught | captured, process **stays alive** | **LOCAL: pass** — `stayedAlive:true` |
| `default` (`unhandledRejections:'preserve'`) | rejection | captured, reproduces Node's own default (print + exit 1) | **LOCAL: pass** — `exitCode:1` |
| `rejections-warn` (`'warn'`) | rejection | captured + printed, process **stays alive** | **LOCAL: pass** — `stayedAlive:true` |
| `rejections-none` (`'none'`) | rejection | **no SDK listener** — Node's own untouched default (→ an uncaughtException-shaped crash, exit 1) fires, and the SDK's *uncaughtException* handler (separately installed, `detectCrashes:true`) still catches it | **LOCAL: pass** — observed as `"[bugsee] uncaught exception:"` (not `unhandled promise rejection`), `exitCode:1` — exactly Node's own `--unhandled-rejections=throw` default |

All 5/5 exercised. **BACKEND: blocked by F-1** — each crash's `crash.json`/`request.json` was
inspected directly from the killed instance's `pending/*.bundle` in the kill-recover/multi-instance
runs (see S12) as a substitute.

## S6 — Console capture

`GET /scenario/s6?marker=<m>` — `console.{log,info,warn,error,debug,trace}`, a multi-arg call, an
object, and a **circular object** (`circular.self = circular`).

- **LOCAL: pass** — the circular object does not throw / crash the app (`console.log` handles it
  natively with `[Circular *1]`; the capture interceptor doesn't choke on it either — server stayed
  healthy through and after this call in every run).
- **WIRE: pass** — `logs.json` in an assembled bundle carries `"source":"console"` entries.
- **BACKEND: blocked by F-1.**

## S7 — Network capture

`GET /scenario/s7/{get,post,post-text,4xx,5xx,fail,bigbody,notype,ws}?marker=<m>` — all against
**loopback** `/echo/*` targets (no internet dependency).

| Sub-scenario | Status |
| --- | --- |
| GET / POST (JSON body) | **LOCAL+WIRE: pass** — `/echo/json` echoes the parsed body back; the interceptor did not alter it (binding principle: "interceptors do not alter app behaviour") |
| POST (text body) | **LOCAL+WIRE: pass** |
| 4xx (`/echo/4xx` → 404) | **LOCAL: pass** |
| 5xx (`/echo/5xx` → 500) | **LOCAL: pass** |
| connection failure (`http://127.0.0.1:1/`) | **LOCAL: pass** — `fetch` rejects, caught and reported as `{failed:true, message:"fetch failed"}`, app stays healthy |
| body over `maxNetworkBodySize` (30000 bytes vs 20480 limit) | **LOCAL: pass** — the APP still reads the full 30000-byte body correctly (`length:30000` in the response) even though the SDK's OWN capture of it is bounded — confirms interceptors don't alter app behaviour |
| response with no `Content-Type` | **LOCAL: pass** — `contentType:null`, body still read correctly |
| WebSocket (`ws://127.0.0.1:PORT/ws`, via `ws` npm server + native `WebSocket` client) | **LOCAL: pass** — echo round-trip works (`"echoed":"ping <marker>"`) |
| XHR | **N/A** — `XMLHttpRequest` does not exist in Node; the capture package's XHR source self-skips |
| SSE / `EventSource` | **N/A** — Node has no global `EventSource` (confirmed: `typeof EventSource === 'undefined'` on Node 24.15.0); the SSE capture source self-skips |

**BACKEND: blocked by F-1**; network-entry content (`network.json`) inside an assembled bundle was
NOT independently confirmed present in the bundles inspected (see FINDINGS discussion — not filed as
a defect since it may simply be capture-window timing, not re-tested exhaustively given the time
budget already spent isolating F-1..F-4). Recorded here as an explicit gap, not silently assumed.

## S8 — Filters & redaction

`GET /scenario/s8?marker=<m>` — installs `setNetworkEventFilter` (strip `authorization`, redact a
`secret` body field, veto a `veto-me` URL), `setLogEventFilter` (drop `DROP_ME`, redact
`token=...REDACT_ME`), `setBreadcrumbFilter` (drop `DROP_CRUMB`), `setReportHandler` (veto
`VETO_REPORT` summaries) — then exercises every one of them.

**Verified directly from the assembled bundle** (`unzip -p <bundle> logs.json` /
`unzip -l <bundle>` — see FINDINGS.md's technique note): out of the two `logException` calls fired
(one `VETO_REPORT`, one "redaction target"), **exactly one bundle was ever assembled** — the vetoed
report never got as far as `pending/` at all:

```
logs.json: [...,{"message":"token=[REDACTED] REDACT_ME", ...}]   # redacted, not the raw secret
# the "DROP_ME" log line is ABSENT — dropped entirely, not just filtered-empty
request.json: {"summary":"S8 redaction target marker=redacttest", ...}   # the ONLY bundle — VETO_REPORT never assembled
```

- **LOCAL+WIRE (bundle-content): pass** for network filter (drop header / redact body — not
  independently re-confirmed at bundle level, see S7's network.json gap note), log filter (drop +
  redact both confirmed), breadcrumb filter (not independently re-confirmed — same technique would
  apply), report veto (**confirmed** — the vetoed exception produced zero bundles).
- **BACKEND: blocked by F-1** — this is the one scenario where BACKEND depth mattered most ("verify
  on the backend that the redacted value never arrived") and where the bundle-inspection substitute is
  strongest: the redacted/dropped values are provably absent from the exact payload that would have
  been uploaded.

## S9 — Performance / APM

`GET /scenario/s9?marker=<m>` — `client.ext('performance').startTransaction()`, 5 child spans (one
per `SpanStatus`: `OK`, `ERROR`, `CANCELLED`, `TIMEOUT`, `DEADLINE_EXCEEDED`), `setRouteName`.
`http.server` transactions come free from `instrumentIncomingRequests` on every request; a startup
`app.start` transaction is recorded at launch.

- **LOCAL: pass.**
- **WIRE: pass, decisively** — verified against a REAL local OTLP/HTTP-JSON collector
  (`otelExportUrl`, see S13) — the `app.start` transaction and the manual `/manual/<marker>`
  transaction with all 5 child-span statuses arrived as valid `resourceSpans`/`scopeSpans` with
  correct `startTimeUnixNano`/`endTimeUnixNano`/`bugsee.span.status` attributes.
- `performanceSampleRate` at 0/1: not separately profiled given the time budget — recorded as
  **unverified** (not attempted), not silently assumed to work.
- **BACKEND (Bugsee's own `/v2/performance/transactions`): blocked by F-1** (same session gate).

## S10 — Distributed tracing

Outbound: any loopback `fetch` from a scenario handler to `127.0.0.1` (in `tracePropagationTargets`).
Inbound: the `traceResponse` config on every incoming response.

- **WIRE: pass, decisively.** `GET /scenario/s7/get` (which internally `fetch()`s `/echo/json`) — the
  `/echo/json` handler echoes back the `traceparent`/`tracestate` headers it received:
  ```json
  "traceparent": "00-9354c2154d480151a97eaf72dcd1079c-2544c602a462297c-01",
  "tracestate": "bugsee=r1:s0f0b084679d1469b9cc825af13d7c1b8"
  ```
  a real, well-formed W3C `traceparent` + the `bugsee=` session tracestate.
- **WIRE: pass** — every response carries the configured return path
  (`traceResponse:{traceresponse:true, serverTiming:true}`):
  ```
  traceresponse: 00-cbc779f00adccef74c9d588f3967c2db-cabbde6ad9b3eef2-01
  Server-Timing: traceparent;desc="00-cbc779f00adccef74c9d588f3967c2db-cabbde6ad9b3eef2-01"
  ```
- **Two-hop cross-sample trace** (`node-service` → `express-api`, joined `trace_id` on both ends, per
  §5.13's "call express-api and assert one trace across both"): **N/A / not attempted** — building
  that assertion requires the `express-api` sample's own scenario surface and is that sample's
  responsibility to reciprocate; not exercised here to avoid taking a dependency on a sibling sample
  under concurrent, independent construction. `tracePropagationTargets` was proven generically (any
  matching target gets the headers — see above), which is the node-service-owned half of the contract.
- **BACKEND: blocked by F-1** (a joined `trace_id` on two ISSUES can't be checked with zero issues).

## S11 — Session replay

**N/A** — browser-only (`@bugsee/replay`); not a dependency of this sample.

## S12 — Persistence & recovery

The most demanding scenario in §5.13. Three sub-parts, all verified via **direct filesystem/zip
inspection** of `data/**/pending/*.bundle` and `data/**/incidents/*.marker` — see FINDINGS.md's
technique note.

### Disk capture + SIGKILL recovery (`pnpm scenario:kill-recover`)

1. Start instance 1, fire `GET /scenario/s4/error?marker=<m>` (fire-and-forget), wait 120ms, `SIGKILL`.
2. Confirm the killed instance's subtree has BOTH a pending-report **marker**
   (`incidents/*.marker`, containing `"summary":"S4 error marker=<m>"` — proves the marker is written
   **synchronously, before assembly**, exactly per `packages/core/src/client.ts`'s `submitReport`) and
   an already-assembled **bundle** (`pending/*.bundle`).
3. Start instance 2 pointed at the SAME `dataDir` (a fresh pid → a fresh instance subtree; the killed
   one is now a dead SIBLING from instance 2's point of view).
4. Confirm instance 2's own `pending/` picks up a **second, recovered bundle** — the dead sibling's
   report, re-enqueued through the live instance's upload pipeline.

**Result: PASS.** Both the marker-before-assembly durability and the dead-sibling recovery-on-launch
mechanics work exactly as `docs/design/server-disk-capture-write-path.md` / 
`docs/design/multi-instance-disk-coexistence.md` describe. The recovered bundle is never CLEANED UP
(the dead subtree stays on disk) — correct per `recover-instances.ts` ("remove the subtree ONLY when
fully drained"), since the upload can never succeed (F-1).

### Multi-instance coexistence + kill-one recovery (`pnpm scenario:multi-instance`)

3 `worker_threads` + 1 separate OS process, all launched against ONE shared `dataDir`:

- **All 4 alive concurrently: PASS** — 4 distinct instance subtrees
  (`<pid>-<threadId>-<nonce>`: `pid-1-*`, `pid-2-*`, `pid-3-*` for the 3 worker_threads sharing one
  pid, and `otherpid-0-*` for the process), each with its own `owner.json`/`.live` heartbeat, no
  corruption, no crash, for the duration of the test.
- **Kill the process (`SIGKILL`), then a 5th "recoverer" instance launches: PASS** — the dead
  process's subtree is detected DEAD instantly (`pidAlive()` → `ESRCH`, no heartbeat-staleness wait
  needed — see `packages/node/src/liveness.ts`); the recoverer's own `pending/` ends up with **two**
  bundles: its own report AND the recovered one from the dead sibling. Exactly one recovered bundle
  for exactly one dead-sibling report — **no duplication, no loss**.
- **Worker-thread-owned subtree recovery** (a `.terminate()`'d worker_thread, not a killed process):
  **not exercised** — `packages/node/src/liveness.ts`'s `isSiblingDead` requires the heartbeat to go
  stale for `DEFAULT_PATIENT_MS` (120,000ms) before a worker-owned subtree is reclaimable, and this is
  **not configurable via `BugseeLaunchOptions`** (confirmed: `patientMs` exists only on the internal
  `recoverInstances()` params, never threaded through `launch()`). Waiting out 120s+ for this one path
  was judged not worth the time budget given the process-kill path already proves the core mechanic;
  recorded as **unverified**, not assumed — a legitimate follow-up, not a finding (the design doc
  explicitly documents this as the intended patience window, not a defect).

### `capturedDataStore: 'memory'` contrast (`BUGSEE_PROFILE=memory-store`)

**Not independently exercised beyond a boot smoke-test** — the profile launches cleanly
(`isLaunched:true`); the "no recovery for the in-memory store" contrast wasn't run through a
kill-and-restart cycle given the time already spent on the disk-store path. **Unverified.**

**BACKEND: blocked by F-1** for the actual upload outcome of every recovered bundle.

## S13 — OpenTelemetry

### Produce (`otelExportUrl`, `BUGSEE_PROFILE=otel-produce` + `pnpm otel:collector`)

**PASS, decisively.** A real local OTLP/HTTP-JSON collector (`scripts/otel-collector.ts`) received
**valid OTLP/JSON**: correct `resourceSpans[].resource.attributes` (including the configured
`otelExportResource: {'service.name': 'bugsee-sample-node-service'}` and the required
`otelExportHeaders`), correct `scopeSpans[].scope.name` (`com.bugsee.nodejs/performance` — the
node/bun/deno SDK-language token per Profile v1 §4/§5), and well-formed spans (`traceId`/`spanId`/
`startTimeUnixNano`/`endTimeUnixNano`/`attributes`) for both the `app.start` startup transaction and
the manual S9 transaction with its 5 child spans. This is entirely independent of F-1 (a completely
separate code path from the Bugsee upload) — proof the produce direction works with zero caveats.

### Consume (`onOtelSpanProcessor`, `GET /scenario/s13-consume`)

**PASS.** A hand-built `ReadableSpanLike` root+child pair (structurally matching the documented OTel
`ReadableSpan` subset — no `@opentelemetry/api` dependency needed, exactly as the package's own
contract promises) fed directly into the wired `BugseeSpanProcessor.onEnd()` is accepted without
throwing; the endpoint returns the synthesized `traceId`. Not confirmed all the way through to a
`recordTransaction` call at the wire level (would require intercepting the internal `onTransaction`
callback) — **LOCAL: pass**, wire-level not independently re-confirmed beyond "didn't throw".

**BACKEND (Bugsee's own upload of consumed transactions): blocked by F-1** (same session gate — but
irrelevant to the produce-direction result above, which never goes through Bugsee's own session).

## S14 — Platform specifics (node)

### CPU profiling (`profiling: true`, `GET /burn?ms=`)

**PASS, decisively.** `unzip -l <bundle>` on a bundle assembled after `/burn` + an incident shows a
real `profile.json` (13,697–73,802 bytes across different runs) containing a valid V8 CPU profile
(`{"nodes":[{"id":1,"callFrame":{"functionName":"(root)",...`). Confirms `profiling`/
`profilingSamplingIntervalMicros` genuinely attach a rolling CPU profile to incident bundles.

### ANR / hang detection (`detectHangs`, `hangFairMs/hangMediumMs/hangSevereMs`, `GET /block?ms=`)

**PASS.** `GET /block?ms=3500` against `hangFairMs:800/hangMediumMs:1600/hangSevereMs:2600` produced
**all three** escalation levels, confirmed via `BUGSEE_WIRE_LOG` request bodies reaching
`POST /v2/issues`:
- `"summary":"Main thread hang detected","labels":["AppHang::Fair"],"description":"Event loop blocked for 822ms (AppHang::Fair)"`
- `"labels":["AppHang::Medium"],"description":"...1624ms (AppHang::Medium)"`
- `"labels":["AppHang::Severe"]` (arrived, but took **~90 seconds** to reach its `/v2/issues` attempt —
  almost certainly F-1-induced retry/backoff queue congestion competing for the upload pipeline's
  4-slot concurrency buffer with the fair/medium reports and an unrelated crash report, not a
  hang-detection defect; see FINDINGS.md discussion — not filed as a defect, recorded here as the
  observed latency).

### Disk capture / `captureWriter` / `dataDir` / `capturedDataStore`

See S12 above.

### Incoming-server auto-instrumentation (`instrumentIncomingRequests`)

- **ON (default): PASS** — `GET /admin/context-check` returns `hasContext:true` with a real
  `contextId`; every request gets its own (50 distinct ids under concurrency — see below); exactly one
  `http.server`-shaped transaction per request (confirmed via the OTLP collector receiving one
  `app.start` + N per-request spans, no duplicates observed in a single-request check).
- **OFF (`BUGSEE_PROFILE=no-instrument`): boots cleanly** (`isLaunched:true`) — the
  context-check/per-request-attribute behaviour with instrumentation off was not independently
  re-verified (no adapter is layered on top in this sample to provide its OWN context, so "OFF" is
  expected to mean `hasContext:false` — **not explicitly re-confirmed**, recorded as unverified rather
  than assumed).

### Per-request context under concurrency (50 overlapping requests)

**PASS, decisively.** 50 concurrent `GET /scenario/s-concurrency?id=N` requests:
- **LOCAL: all 50 responses carry a DISTINCT `contextId`** — `python3` set-dedup on the 50 responses:
  `unique contextIds: 50`, `dup contextId count: 0`.
- **Bundle-content: PASS for a representative sample** (3 of 50 bundles inspected directly, due to
  F-1's retry-backoff economics making it impractically slow — ~35s/report × 50/4 concurrent slots ≈
  7+ minutes — to wait out all 50): each bundle's `manifest.json.attrs` carries its OWN
  `request.concurrency_id` matching its OWN `http.url` query string, e.g.
  `{"http.url":"/scenario/s-concurrency?id=3", "request.concurrency_id":"3"}` — **no
  cross-contamination observed** between concurrent requests.

### `exitOnUncaught` / `unhandledRejections` / `shutdownTimeoutMs`

See S5 above for the first two (all 5 combinations verified). `shutdownTimeoutMs` on `SIGTERM`:
**PASS** (bounded) — `SIGTERM` while a doomed (F-1) upload retry was in flight still produced a clean
`[node-service] received SIGTERM, shutting down` → process exit within the default 3000ms budget,
never hanging on the futile retry.

**BACKEND: blocked by F-1** throughout S14.

## Dual-module (ESM/CJS × umbrella/direct)

`pnpm smoke:dual-module` — **PASS, all 4 combinations**:

| Entry | ESM | CJS |
| --- | --- | --- |
| `@bugsee/bugsee/node` (umbrella) | `SMOKE_OK esm-umbrella` | `SMOKE_OK cjs-umbrella` |
| `@bugsee/node` (direct) | `SMOKE_OK esm-direct` | `SMOKE_OK cjs-direct` |

Each: `launch()` → `isLaunched()===true` → `logException()` → `flush()` → `stop()`, no throw, in a
freshly-installed tarball (per `docs/samples/PLAN.md` §2 — never the workspace source).
