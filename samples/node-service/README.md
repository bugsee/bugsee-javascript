# node-service — the Bugsee Node SDK reference sample

A "Link shortener" running on **plain `node:http`** — no framework — so `@bugsee/node` (and the
`@bugsee/bugsee` umbrella's `./node` entry) is the thing under test, not a framework adapter. This is
the reference sample every other server sample in `samples/` copies conventions from.

## Run it

```bash
# from the monorepo root, once:
node scripts/pack-local.mjs
node scripts/new-sample.mjs node-service "@bugsee/bugsee" "@bugsee/node" "@bugsee/opentelemetry"

cd samples/node-service
pnpm install
cp .env.example .env   # already filled in below for staging; never commit .env
pnpm dev                # http://127.0.0.1:5305
```

Requires **Node ≥ 24** (uses native TypeScript execution — `node --env-file=.env src/server.ts`, no
build step, no `tsx`/`ts-node`). On Node 18–23 the sample would need `tsx`; this repo declares
`engines.node >=18` for the *SDK*, but this particular sample's dev ergonomics assume 24+.

- `pnpm dev` / `pnpm start` — run the service (port `5305` by default; override with `PORT=`)
- `pnpm verify` — the scripted scenario sweep (§below)
- `pnpm scenario:crash <profile> <uncaught|rejection> <marker>` — S5 crash harness (own process)
- `pnpm scenario:kill-recover` — SIGKILL + disk-capture recovery (S12)
- `pnpm scenario:multi-instance` — 3 worker_threads + a second process sharing one `dataDir` (S12)
- `pnpm otel:collector` — a tiny local OTLP/HTTP-JSON collector for the produce-direction scenario
- `pnpm smoke:dual-module` — ESM + CJS × umbrella + direct `@bugsee/node` import smoke tests

## Staging app

| | |
| --- | --- |
| App key | `SNODE` |
| App id | `6a86d8f3990cb94c0b8e8f0a` |
| Type / subtype | `javascript` / `node` |
| Endpoint | `https://apidev.bugsee.com` (staging — never production) |

**Read `FINDINGS.md` first — F-1.** As of this build, staging rejects every session-create call for
this app (`ApplicationTypeMismatchError` / `UnsupportedSdkError`), so **no data from this sample
currently reaches the Bugsee dashboard**. Every scenario below was still driven and verified at the
LOCAL and WIRE depths (§4 of `docs/samples/PLAN.md`) — HTTP responses, the SDK's own request/response
traffic (via an injectable `transport` wire-tap), and the assembled bundle **files themselves**
(`data/**/pending/*.bundle` are real zip archives containing `crash.json`, `profile.json`,
`performance.json`, etc. — inspect them with `unzip -l`/`unzip -p`).

## What it does

A genuinely working link shortener:

| Method | Path | What |
| --- | --- | --- |
| GET | `/` | dashboard (create a link, see stats + the link list) |
| GET | `/api/links` | list all links (JSON) |
| POST | `/api/links` | create a link — `{ "url": "...", "ttlMs": 60000 }` |
| GET | `/api/stats` | `{ total, active, expired, totalHits }` |
| GET | `/:code` | 302 redirect to the shortened URL (404 if missing/expired) |
| GET | `/health` | liveness + `isLaunched()` |

Links are stored in `data/links.json` (a flat JSON file — no database, on purpose: the point of this
sample is `@bugsee/node`, not a storage engine). A background job (`src/expire-job.ts`) sweeps expired
links every 5s and emits a `client.trace()` + breadcrumb per sweep.

## The scenario panel

Every scenario in `docs/samples/PLAN.md` §4/§5.13 is a route, not a UI (server-sample convention):
`/scenario/<id>[/<sub>]?marker=<id>`, plus the demanding ones get dedicated routes/scripts:

- `/burn?ms=` — CPU-bound spin (CPU profiling, `profile.json`)
- `/block?ms=` — synchronous event-loop block (ANR / `detectHangs`)
- `/admin/flush?timeout=`, `/admin/context-check` — lifecycle + per-request-context introspection
- `/echo/*` — loopback targets for S7 (no internet access needed)

Full id → route → expected-result mapping, plus verified/unverified status and evidence, is in
[`scenarios.md`](./scenarios.md).

## Config-file-driven launch options

`src/bugsee-client.ts` builds `BugseeLaunchOptions` from `config/launch.<profile>.json` (select with
`BUGSEE_PROFILE=<name>`), covering the **full option surface** of `packages/node/src/launch.ts`:

| Profile | Exercises |
| --- | --- |
| `default` | the full option set at sample-friendly values (disk capture, hangs at 800/1600/2600ms, profiling on, OTel consume on) |
| `minimal` | every option left at its SDK default (S1 "minimum options") |
| `no-instrument` | `instrumentIncomingRequests: false` (the adapter-less escape hatch) |
| `rejections-warn` / `rejections-none` | each `unhandledRejections` mode |
| `exit-false` | `exitOnUncaught: false` |
| `memory-store` | `capturedDataStore: 'memory'` (contrast case for S12) |
| `worker-writer` | `captureWriter: 'worker'` |
| `otel-produce` | `otelExportUrl` pointed at the local collector |

`BUGSEE_DATA_DIR` / `BUGSEE_INSTRUMENT_INCOMING` / `BUGSEE_WIRE_LOG` env vars steer individual fields
without a new profile file (used by the multi-instance / kill-recover / verify scripts).

## Dual-module verification

Both the umbrella (`@bugsee/bugsee/node`) and the direct (`@bugsee/node`) entries were verified under
**both** ESM and CJS (`scripts/smoke/{esm,cjs}-{umbrella,direct}.{mjs,cjs}`, run via
`pnpm smoke:dual-module`) — all four launch, capture, and tear down cleanly.

## Scenario coverage summary

See `scenarios.md` for the full table. Headline:

- **24/24** HTTP-triggerable scenarios pass at LOCAL depth (`pnpm verify`).
- CPU profiling, ANR/hang escalation (fair→medium→severe), disk-capture SIGKILL recovery,
  multi-instance coexistence + dead-sibling recovery, per-request-context isolation under 50-way
  concurrency, and W3C trace propagation (outbound `traceparent` + inbound `traceresponse`/
  `Server-Timing`) are all verified directly against the **assembled bundle files** and the SDK's own
  wire traffic — see `scenarios.md` for the evidence.
- OTel **produce** (`otelExportUrl`) verified end-to-end against a real local OTLP/HTTP-JSON collector
  — valid `resourceSpans`/`scopeSpans` received. OTel **consume** (`onOtelSpanProcessor`) verified by
  feeding a structurally-valid external `ReadableSpanLike` root+child pair into the wired processor.
- Backend (MCP) confirmation is blocked for the **entire sample** by `FINDINGS.md` F-1 (staging
  `javascript` app-type session rejection) — every scenario that depends on it is marked
  "unverified — blocked by F-1", not silently skipped.

## Findings

[`FINDINGS.md`](./FINDINGS.md) — 4 open findings (1 blocker, 2 major, 1 minor), all in `@bugsee/core`
or the staging backend, with reproduction scripts. `samples/FINDINGS.md` carries the cross-cutting
summary of F-1.
