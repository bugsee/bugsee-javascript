// @bugsee/nuxt — the package `.` entry, which will be the Nuxt Module (`defineNuxtModule`, U1) that wires
// the client plugin (@bugsee/vue) + the Nitro server plugin (@bugsee/nuxt/server `installBugseeNitro`).
//
// Tier 4. Built so far: the Nitro server-error bridge core (`@bugsee/nuxt/server`). The Nuxt Module (U1),
// client plugin (U2), and `render:html` trace injection (U5) are forthcoming — see
// docs/design/meta-framework-adapters.md.
export {};
