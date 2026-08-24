# Widget Shop — the Bugsee browser reference sample

A genuinely working, no-framework web shop (Vite + TypeScript + plain DOM) that exercises the Bugsee
browser SDK end to end: `@bugsee/bugsee` (browser entry), `@bugsee/browser`, `@bugsee/replay`,
`@bugsee/replay-canvas`, `@bugsee/performance`, `@bugsee/opentelemetry`, `@bugsee/webworker`. This is
the **reference sample** for every other web sample in `samples/` — see `docs/samples/PLAN.md`.

## Run it

```bash
cd samples/browser-vanilla
cp .env.example .env      # already pre-filled for this exercise; see "Staging app" below
pnpm install
pnpm dev                  # http://localhost:5301
```

Production build:

```bash
pnpm build
pnpm preview               # http://localhost:5301
```

Scripted scenario sweep (Playwright, headless):

```bash
pnpm verify
```

There is no separate API server to start — the local Widget Shop API, the SSE order-status feed, the
WebSocket chat, and (see "Known backend defect" below) a same-origin reverse proxy to the real Bugsee
staging endpoint are all mounted as Vite middleware on the SAME port (`5301`), in both `pnpm dev` and
`pnpm build && pnpm preview`.

## What the app does

A small but real shop:

- **Product grid** (`/`) — fetched from a local JSON API (`server/api-plugin.ts`, backed by
  `data/products.json`).
- **Product detail** (`/#/product/:id`) — description, stock, a hand-rolled `<canvas>` price-history
  sparkline (the session-replay canvas-recording target), and an image gallery.
- **Cart** (`/#/cart`) — persisted in `localStorage`; a "compute bundle discount" button runs real
  arithmetic in a **Web Worker** (`src/worker/price-worker.ts`) and reports the result back over
  `postMessage`.
- **Checkout** (`/#/checkout`) — a real form with an **email**, a **credit-card number**, and a
  **password** field (the session-replay masking targets), plus a button to simulate a `500` from the
  checkout endpoint.
- **Order status** (`/#/orders/:id`) — a live feed over **Server-Sent Events**.
- **Support chat** (`/#/chat`) — a real **WebSocket** round trip (the local API echoes back).
- **Settings** (`/#/settings`) — every `BugseeLaunchOptions` field, individually toggleable, with an
  "Apply & relaunch" that calls `stop()` then `launch()` again.
- **Scenario panel** (`/#/scenarios`) — one button per catalog scenario (S1–S14), each calling the real
  SDK API and showing its own local-level result; see `scenarios.md`.
- A **Service Worker** (`src/sw/service-worker.ts`) caches the app shell and runs its own
  `@bugsee/webworker` session, with `withBugseeEvent` wrapping its fetch/sync handlers.

## Staging app

- App key: `SBROWSER`
- App id: `6a86d8e549f15abdb072ea8a`
- Type: `javascript`, subtype: `browser`
- Endpoint: `https://apidev.bugsee.com` (staging — **never** production)

`.env` (gitignored) holds `BUGSEE_APP_TOKEN` and `BUGSEE_ENDPOINT`; `.env.example` documents the
shape. The app token is never committed.

## Known backend defect — why there's a reverse proxy in `server/`

**All five of the blocker-severity defects this sample originally found (F-1..F-5) are fixed**, and as
of the 2026-08-24 re-verification this sample talks to the real staging collector **directly** — no
proxy, no relay, no browser flags. `server/bugsee-proxy.ts` has been deleted.

For the record, what they were and where they were fixed: the hardcoded `x-client-type: 'web'` header,
the unparsed `{ok, result}` response envelope with its snake_case ids, and the `x-amz-checksum-sha256`
header that invalidated the presigned PUT's own signature — all in `@bugsee/core` (`0318229`,
`84976f7`); the missing `publishConfig` on the replay packages (`3921760`); and the collector's CORS
policy, fixed in appserver and **confirmed deployed on staging** (`samples/FINDINGS.md` F-X10, which
records the preflight evidence).

If you are building the next web sample: you need none of this. Point `endpoint` at the collector and
the browser reaches it, exactly as a customer's page does.

## Scenario coverage

See `scenarios.md` for the full table (every scenario id → control → expected → verified/unverified
with evidence). Headline numbers from this pass:

- **48/48** local-level checks pass via `pnpm verify` (10 whole-app checks + 38 scenario-panel
  controls).
- **12 issues** created and inspected on the real staging backend via
  `mcp__bugsee-staging__get_issue` during this verification pass (`SBROWSER-1` through `SBROWSER-12`),
  covering S1, S2, S4 (incl. the nested-cause chain and instance dedupe), S5 (crash vs. handled-error
  classification), S8 (report-handler mutate vs. veto — confirmed the vetoed report never arrived),
  S12 (a real kill-and-recover round trip), and S14 (the Web Worker's and Service Worker's own
  sessions).
- S7, S9, S11, S13 are **not exposed by the MCP `get_issue` surface** per `docs/samples/PLAN.md` §6
  step 6 (network entries, performance transactions, replay contents) — those are verified at Local/
  Wire depth only, honestly, in `scenarios.md`.
- One backend-visibility gap (`FINDINGS.md` F-6): captured console logs and breadcrumbs never showed
  up in `get_issue`'s `# Logs` section in any of the issues inspected, despite clear prior activity in
  the same session.

## Findings

`FINDINGS.md` — six numbered defects (five blockers that together prevented ANY data from reaching
the backend, one major logs-visibility gap), plus three investigated-and-explained non-findings. Sample
authors do not fix SDK code; every workaround here is sample-local (`server/`, `vite.config.ts`,
`src/bugsee-client.ts`) and clearly marked as such.

