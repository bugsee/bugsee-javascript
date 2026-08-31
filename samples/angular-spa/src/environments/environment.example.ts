// Committed TEMPLATE only. `src/environments/environment.ts` is generated (and gitignored) by
// `scripts/generate-environment.mjs`, which reads `.env` (BUGSEE_APP_TOKEN / BUGSEE_ENDPOINT) before
// every `ng serve` / `ng build` — see package.json `dev:app` / `build`. This keeps the app token out
// of git the same way every other sample does, using Angular's own environment-file convention
// instead of a bundler `define`.
export const environment = {
  bugseeAppToken: '',
  bugseeEndpoint: 'https://apidev.bugsee.com',
  appBuild: 'dev',
};
