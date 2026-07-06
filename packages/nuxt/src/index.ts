// @bugsee/nuxt — the package `.` entry IS the Nuxt Module (so `modules: ['@bugsee/nuxt']` resolves to it).
// The module (U1) wires the browser client plugin (@bugsee/vue via `./client`) + the Nitro server plugin
// (@bugsee/node via `./server`) — see docs/design/meta-framework-adapters.md.
//
// Build-time only: this entry pulls in `@nuxt/kit`, never the `bugsee`/`bugsee/node` runtimes (those load
// through the generated client template / the shipped `./runtime/nitro-plugin`). U5 (`render:html` trace
// injection) is forthcoming.
export {
  clientPluginContent,
  default,
  type ModuleOptions,
  type NuxtLike,
  setupBugseeModule,
} from './module';
