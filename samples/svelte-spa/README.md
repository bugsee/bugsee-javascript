# svelte-spa — Habitbugsee

A working habit-tracker app built to exercise `@bugsee/svelte` and
`@bugsee/svelte-plugin-component-annotate` — for the plan this sample
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
(local and wire level). **Requires `pnpm dev` running in another terminal first.**

Budget ~8 minutes per run, most of it the error storm: 200 `logException` calls, of which the SDK's rate
limiter admits ~97, each costing two round trips to real staging. The sweep waits for that backlog to
reach genuine quiet before the flush and persist/recover controls run — measured 80-88s — because those
two checks are meaningless while uploads are still in flight. That wait's budget is DERIVED from the
work the storm requests rather than being a fixed constant, and the sweep asserts it exited on quiet
rather than on its deadline.

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
SvelteKit app (`sveltekit-app`) is the separate sample for that. `@bugsee/svelte`'s router
helpers (`instrumentSvelteKitNavigation` / `routeIdFromNavigation` / `setRouteName`) are **structural
peers** over SvelteKit's `afterNavigate` argument shape (`{ to: { route: { id } } }`, no `$app/navigation`
import — `packages/svelte/src/router.ts`), so the hand-rolled router builds that exact shape on every
hash change and hands it to the same seam a real SvelteKit host would use. Route ids follow SvelteKit's
own bracket syntax (`/habits/[id]`).

A dedicated `/#/scenarios` route is the SDK **Scenario panel** — one control per scenario in
the scenario catalog, plus every `@bugsee/svelte`-specific API that the catalog does not list: `handleErrorWithBugsee` (wired as `App.svelte`'s outer `<svelte:boundary onerror={...}>`,
built by hand from a synthetic SvelteKit-shaped `HandleErrorInput`), `reportSvelteError` (direct call),
`startSvelteRenderSpan` (both via the preprocessor's `renderSpans: true` auto-injection into EVERY
component, and a direct manual call), `instrumentSvelteKitNavigation` (wired in the router), plus
direct calls to `routeIdFromNavigation` and `setRouteName`. Two error-boundary controls are provided: a
**local** one (a nested `<svelte:boundary>` around a `ThrowingWidget`) and a **global** one (the same
widget rendered with NO nested boundary, so the throw propagates to `App.svelte`'s own boundary) — see
`react-spa` for how this compares.

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

- `5304` — Vite dev/preview server (assigned to this sample)
- `5334` — the local API (`server/api-server.mjs`)
