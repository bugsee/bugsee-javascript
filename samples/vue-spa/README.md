# Recipe Book — `@bugsee/vue` sample

A Vue 3 SPA that exercises the `@bugsee/vue` SDK adapter: error handling, router naming, component
attribution and render spans, layered on a genuinely usable recipe-book app.

## Run it

```bash
cd samples/vue-spa
cp .env.example .env      # already has staging values checked in below — see "Staging app"
pnpm install
pnpm dev                  # http://localhost:5303
```

Production build:

```bash
pnpm build
pnpm preview               # serves the built dist/ on http://localhost:5303
```

Scripted scenario sweep (drives a real headless browser through every control):

```bash
pnpm verify
```

**Read `samples/vue-spa/FINDINGS.md` before trusting any "it works" claim.** Three SDK/backend
defects had to be worked around just to get the app to boot and to reach the staging collector at
all (F-1 packaging, F-2 CORS, F-4 SDK version), and a fourth (F-5, backend) means **no scenario in
this sample could be verified against real captured data on the backend** — see `scenarios.md` for
exactly what was and wasn't checked, at which depth.

## What it does

A "Recipe book": a recipe list and detail pages, a rich recipe editor (ingredients/steps as dynamic
lists, tags, validation), favourites persisted in `localStorage`, Vue Router with dynamic routes
(`/recipes/:id`, `/recipes/:id/edit`), a Pinia store backed by a real (if tiny) local API
(`src/api/server-plugin.ts`, mounted straight into the Vite dev/preview server — recipes are actually
stored and mutated, not faked). It is a real, usable app, not a button farm around the SDK.

The **Scenario panel** (`/scenarios`) is one route within that app: a control for every scenario in
`docs/samples/PLAN.md` §4/§5.3, each stamping a unique marker into whatever field is searchable on the
resulting issue so a specific run can be found again. It includes `ErrorLab.vue`, which exercises
every distinct Vue error surface `@bugsee/vue` catches: a render error, a lifecycle-hook error, an
event-handler error, a watcher error, and an async-component/`<Suspense>` error (see
`RecipeDetail.vue` + `NutritionPanel.vue`), plus a direct `reportVueError()` call that bypasses the
installed handler on purpose.

## Package under test

`@bugsee/vue` — every export is exercised: `installBugseeErrorHandler`, `reportVueError`,
`createBugseeVueComponentMixin`, `createBugseeVueRenderMixin`, `instrumentVueRouter`,
`routePatternFromVueRoute`, `setRouteName`, plus the full re-exported `@bugsee/bugsee` browser surface
(`launch`, `logException`, `setUserIdentifier`, filters, the performance extension, …).

## Staging app

- App key: `SVUE`
- App id: `6a86d8ec990cb94c0b8e8f01`
- Type/subtype: `javascript` / `vue`
- Endpoint: `https://apidev.bugsee.com` (staging — never production)

`.env` (gitignored) holds `BUGSEE_APP_TOKEN` / `BUGSEE_ENDPOINT`; see `.env.example` for the shape.

## Scenario coverage

See `scenarios.md` for the full id → control → expected → verified table. Summary:

| Depth | Status |
| --- | --- |
| **Local** (the SDK call didn't throw, the app kept working) | 50/50 automated checks pass (`pnpm verify`) |
| **Wire** (the right request, shape, left the process) | verified by hand for the scenarios where it mattered (session creation, `logException`, network filters, performance transactions) |
| **Backend** (the data arrived and is correct, via MCP) | **unblocked and confirmed reaching the backend** — F-5 is fixed; the 2026-08-24 re-verification delivered to `SVUE` (49/49 local, new issues on the app). Per-scenario backend depth has **not** been re-walked row by row — the rows below still say so individually |

S10 (distributed tracing) and S13 (OpenTelemetry) are N/A for this sample (no peer server / package
not under test — see `scenarios.md`). S11 (session replay) is N/A because it is architecturally
untestable here (`FINDINGS.md` F-1).

## Findings

`FINDINGS.md` — five findings, three of them blockers found in this order while just trying to get
the app running and its data verified:

1. **F-1** — `@bugsee/replay`/`@bugsee/replay-canvas` ship without `publishConfig.exports`, breaking
   `vite dev`/`vite build` for ANY consumer, unconditionally (worked around via `vite.config.ts`
   externals + `replay: false`).
2. **F-2** — the staging collector's CORS policy hardcoded `Access-Control-Allow-Origin` to
   `https://appdev.bugsee.com`, blocking every browser-based sample from its own dev server. **Fixed in
   appserver and confirmed deployed**; `--disable-web-security` has been removed from
   `scripts/verify.mts` and the sweep now runs a stock Chromium.
3. **F-3** (minor) — `installBugseeErrorHandler(app)` doesn't typecheck against a real Vue `App`.
4. **F-4** — the SDK's default `sdk.version` (`0.0.0`) is rejected outright by staging as
   `UnsupportedSdkError` (worked around via an explicit `sdkVersion` override).
5. **F-5** — even past F-2/F-4, the collector rejects every session for this `type: "javascript"` app
   with `ApplicationTypeMismatchError`. This is the one that actually blocks backend verification of
   everything in `scenarios.md`.
