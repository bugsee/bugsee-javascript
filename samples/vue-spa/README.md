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

**Read this before trusting any "it works" claim.** Three SDK/backend defects had to be worked around
just to get the app to boot and to reach the staging collector at all (packaging, CORS and the SDK version),
and a backend defect means **no scenario in this sample could be verified against real captured data on the
backend**.

## What it does

A "Recipe book": a recipe list and detail pages, a rich recipe editor (ingredients/steps as dynamic
lists, tags, validation), favourites persisted in `localStorage`, Vue Router with dynamic routes
(`/recipes/:id`, `/recipes/:id/edit`), a Pinia store backed by a real (if tiny) local API
(`src/api/server-plugin.ts`, mounted straight into the Vite dev/preview server — recipes are actually
stored and mutated, not faked). It is a real, usable app, not a button farm around the SDK.

The **Scenario panel** (`/scenarios`) is one route within that app: a control for every scenario in
the scenario catalog, each stamping a unique marker into whatever field is searchable on the
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
