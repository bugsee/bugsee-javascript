// @bugsee/astro — the package `.` entry IS the Astro Integration: `integrations: [bugsee({ appToken })]` in
// `astro.config.mjs`. At `astro:config:setup` it injects the browser launch (`injectScript('page')`) + a
// generated server-middleware virtual module (`addMiddleware`) that launches the server SDK AND captures
// errors + injects the trace. BUILD-TIME only (imports `astro` types + generates strings — no eager
// bugsee/node/browser).
//
// The middleware runtime lives at `@bugsee/astro/{middleware,edge}`; the launches at
// `@bugsee/astro/{client,server,edge}`.
export {
  type BugseeAstroOptions,
  bugsee,
  bugsee as default,
  clientInitScript,
  SERVER_MIDDLEWARE_ID,
  serverMiddlewareModule,
} from './integration';
