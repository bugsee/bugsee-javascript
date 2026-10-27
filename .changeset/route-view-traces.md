---
'@bugsee/protocol': minor
'@bugsee/trackers': minor
'@bugsee/core': minor
'@bugsee/capture': minor
'@bugsee/browser': minor
'@bugsee/webview': minor
'@bugsee/web-adapter': minor
'@bugsee/react': minor
'@bugsee/vue': minor
'@bugsee/solid': minor
'@bugsee/svelte': minor
'@bugsee/angular': minor
'@bugsee/nuxt': minor
---

New `route` and best-effort `view` system traces, and `client.setRoute(route)` / `client.setView(view)` (C12).

`route` is the router's route pattern (`/orders/:id`), never a query, fragment or credentials; `view` is `{name, type?}`
(or `"$$none"` for `setView(null)`). Both are held and de-duplicated. The React, Vue, Solid, Angular and SvelteKit
adapters report committed navigations (Vue skips a navigation that carries a failure); the view name is written only
when the adapter can read a non-minified, non-wrapper component name. `@bugsee/nuxt` instruments Nuxt's router, and
`instrumentVueRouter` now also seeds the already-committed route. `setRouteName` (re-exported by every adapter) now also
writes `route`, and Vue no longer refines the transaction name for a navigation that carries a failure. A WebView writes
`route` but not `view` (the native host owns it).
