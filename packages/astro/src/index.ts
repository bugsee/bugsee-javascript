// @bugsee/astro — the package `.` entry IS the Astro Integration: `integrations: [bugsee({ appToken })]` in
// `astro.config.mjs`. At `astro:config:setup` it injects the browser launch (`injectScript('page')`) + the
// server launch (`injectScript('page-ssr')`) + the request middleware (`addMiddleware`, error capture +
// trace). BUILD-TIME only (imports `astro` types + generates strings — no eager bugsee/node/browser).
//
// The middleware itself lives at `@bugsee/astro/middleware` (the Astro `addMiddleware` entrypoint); the
// runtime launches at `@bugsee/astro/{client,server,edge}`.
export {
  type BugseeAstroOptions,
  bugsee,
  bugsee as default,
  clientInitScript,
  edgeServerInitScript,
  serverInitScript,
} from './integration';
