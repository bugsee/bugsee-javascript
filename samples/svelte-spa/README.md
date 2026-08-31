# svelte-spa — Habitbugsee

A working habit-tracker app built to exercise `@bugsee/svelte` and
`@bugsee/svelte-plugin-component-annotate` — see `docs/samples/PLAN.md` §5.4 for the plan this sample
was built against.

## Run it

```bash
cd samples/svelte-spa
cp .env.example .env      # then paste the SSVELTE app token (see "Staging app" below) — .env is gitignored, never commit it
pnpm install
pnpm dev                  # local API on :5334 + Vite dev server on :5304
```

Open http://localhost:5304. `pnpm dev` runs both the local API (`server/api-server.mjs`, port 5334)
and the Vite dev server (port 5304) together via `concurrently`; `pnpm dev:api` / `pnpm dev:app` run
them separately.

**Production build:**

```bash
pnpm build
pnpm preview               # serves dist/ on :5304 + the API on :5334
```

No source-map/bundler plugin is under test in this sample (that's `webpack-sourcemaps` and the
frontend samples that use `@bugsee/vite-plugin`/`@bugsee/babel-plugin-component-annotate`) — the build
step here just proves the app + `@bugsee/svelte-plugin-component-annotate` preprocessor survive a real
production Vite build (minified, tree-shaken).

**Scenario sweep:**

```bash
pnpm verify
```

Drives the app + every Scenario-panel control headlessly via Playwright and prints a pass/fail table
(LOCAL/WIRE level — see `scenarios.md` for the backend/MCP verification this repo's author did by hand
against the results). **Requires `pnpm dev` running in another terminal first.**

Budget ~8 minutes per run, most of it the S4 storm: 200 `logException` calls, of which the SDK's rate
limiter admits ~97, each costing two round trips to real staging. The sweep waits for that backlog to
reach genuine quiet before the flush and persist/recover controls run — measured 80-88s — because those
two checks are meaningless while uploads are still in flight. That wait's budget is DERIVED from the
work the storm requests rather than being a fixed constant, and the sweep asserts it exited on quiet
rather than on its deadline; see `scenarios.md`'s S4 storm row for why.

## What the app does

**Habitbugsee** is a small habit tracker: a habit list with a "mark today" toggle, a per-habit detail
page with a 12-week calendar heat map, a combined Calendar page (pick any habit, see/toggle its heat
map), a Stats page (current streak / longest streak / 28-day completion rate per habit), and a Settings
page (display name → `setUserIdentifier`, custom attributes, and a collapsible **drawer** holding the
S11 replay masking-target fields — a "PIN code" field, a `.bugsee-unmask`-marked field, an
`ignoreSelector` field, and the `maskTextSelector`/`blockSelector` targets, all of which
`scripts/verify.mjs` looks for by name inside the decoded `replay.bin`). All of it
talks to a small local API (`server/api-server.mjs` — plain `node:http`, no framework, since the
framework under test is on the client). The API server also runs a WebSocket endpoint
(`/api/ws`) that broadcasts check-in events server-side, but the app itself never opens a
connection to it — the only client of that endpoint is the Scenario panel's own `s7-ws` control
(S7 network capture); it is not a real "activity feed" feature the app uses. The same is true of
`/api/scenario/beacon` + `/api/scenario/beacon-log`, which exist only for the `s7-beacon` control:
`navigator.sendBeacon` is fire-and-forget, so the POST is absorbed by the first route and read back
over the second, which is what lets the panel report that the payload really reached the server
rather than only that the browser accepted it for delivery.

Routing is a **hand-rolled hash router** (`src/router.svelte.ts`) — this is a plain Svelte SPA, not a
SvelteKit app (`sveltekit-app`, PLAN §5.11, is the separate sample for that). `@bugsee/svelte`'s router
helpers (`instrumentSvelteKitNavigation` / `routeIdFromNavigation` / `setRouteName`) are **structural
peers** over SvelteKit's `afterNavigate` argument shape (`{ to: { route: { id } } }`, no `$app/navigation`
import — `packages/svelte/src/router.ts`), so the hand-rolled router builds that exact shape on every
hash change and hands it to the same seam a real SvelteKit host would use. Route ids follow SvelteKit's
own bracket syntax (`/habits/[id]`).

A dedicated `/#/scenarios` route is the SDK **Scenario panel** — one control per scenario in
`docs/samples/PLAN.md` §4, plus every `@bugsee/svelte`-specific API named in §5.4's "beyond the
catalog" list: `handleErrorWithBugsee` (wired as `App.svelte`'s outer `<svelte:boundary onerror={...}>`,
built by hand from a synthetic SvelteKit-shaped `HandleErrorInput`), `reportSvelteError` (direct call),
`startSvelteRenderSpan` (both via the preprocessor's `renderSpans: true` auto-injection into EVERY
component, and a direct manual call), `instrumentSvelteKitNavigation` (wired in the router), plus
direct calls to `routeIdFromNavigation` and `setRouteName`. Two error-boundary controls are provided: a
**local** one (a nested `<svelte:boundary>` around a `ThrowingWidget`) and a **global** one (the same
widget rendered with NO nested boundary, so the throw propagates to `App.svelte`'s own boundary) — see
`scenarios.md` for how this compares to `react-spa`'s F-5 finding.

`@bugsee/svelte-plugin-component-annotate` is wired into `svelte.config.js` with `{ renderSpans: true }`:
every `.svelte` component's host elements get `data-bugsee-component="<Name>"` (confirmed in the DOM by
the Scenario panel's live count), and every component's instance script gets an injected
`onMount(startSvelteRenderSpan('<Name>'))` call — so render spans are exercised for the WHOLE app, not
just a demo widget.

## Staging app

- App key: **`SSVELTE`**
- App id: **`6a8ebe51d58badbb348fbec4`**
- Type: `javascript`, subtype `svelte`
- Endpoint: `https://apidev.bugsee.com` (staging — never production)

## Ports

- `5304` — Vite dev/preview server (assigned to this sample per `docs/samples/PLAN.md`'s 53xx range)
- `5334` — the local API (`server/api-server.mjs`)

## Scenario coverage

See `scenarios.md` for the full table (every scenario id → control → expected Bugsee content →
verified/unverified with evidence).

## Findings

See `FINDINGS.md` for defects specific to this sample. Headline: `pnpm verify` runs **104/104** against
real staging (LOCAL + WIRE depth — WIRE checks parse the actual UPLOADED bundle via a tee transport,
`src/bugsee-transport.ts`, not just the app's own filter-callback log), measured green on **three
consecutive runs** of this build against the current SDK (97 admitted of 200 stormed on every run;
storm settle 83.5-85.9s; the S12 recovery on a clear channel every time). Do not quote that as a
property of the sample: an earlier round did claim "86/86 clean" as a fact, and five consecutive
re-review sweeps then scored 84/86, 86/86, 84/86, 86/86, 86/86 — roughly 60% green, because this
script's S4 storm-settle wait was exiting on its 45s deadline with uploads still in flight and taking
`s1-flush` and `s12-persist-recover` down with it. That budget is now DERIVED from the work the storm
requests and its exit reason is asserted (see `scenarios.md`'s S4 storm row); re-run the sweep rather
than trusting the number.

**Session replay is ON BY DEFAULT.** `@bugsee/browser` records unless you opt out with `replay: false`
(`launch.ts`: `options.replay !== false && domDocument !== undefined`); it self-skips silently with no
`document`. `FULL_LAUNCH_OPTIONS` in `src/bugsee.ts` still says `replay: true`, but that line is
REDUNDANT — it is not what enables recording. One consequence for this sample's own checks: `replay.bin`
being present in an uploaded bundle no longer proves the SDK read the `replay` option at all, so the
`s11-replay-default-on` / `s11-replay-off` pair (a launch with the key removed entirely must still
record; `replay: false` must produce no `replay.bin`) is what covers the option path now. See
`scenarios.md`'s S11 section.

Substantively, the S12 persist+recover control found that **one incident recovers as two separate
uploaded reports** — not +1. The duplicate itself is deterministic: an isolated click uploads twice
every time, and `solid-spa` measured the same seam at `SSOLID-80` = 10 → 12 → 14 across three sweeps,
exactly +2 each, against a `+1` dedupe control. What is load-dependent is only whether a SWEEP can
witness both legs: `SSVELTE-111`'s `events_count` moved +1/+2/+0/+2 across the re-review's runs, whose
S4 storm was still draining into the recovery's observation window. See **F-1** for the root cause:
both legs run from the SAME `coexistence.recoverDeadSiblings(...)` call
(`packages/browser/src/launch.ts:516-534`) — `recoverSiblingBundleQueue` (re-uploads the dead sibling's
already-queued bundle) and core's `recoverReports` (rebuilds and uploads a fresh one from the marker +
preserved chunks) — because `packages/core/src/client.ts`'s report marker is cleared only once the
network upload settles, rather than once the durable bundle queue has already taken over delivery.
**F-2** is a related defect found investigating F-1: a marker-recovered report's `created_on` is
stamped at RECOVERY time (next launch), not at the original incident time —
`packages/core/src/bundle-assembler.ts` has no way to prefer an incident timestamp because
`ReportMarker` never carries one. Cross-cutting findings shared with the other samples (already fixed
on `main` by the time this sample was built — CORS, the wire-contract defects, the `0.0.0` SDK version
floor, etc.) live in `samples/FINDINGS.md` and are not repeated here.
