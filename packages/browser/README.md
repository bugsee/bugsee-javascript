# @bugsee/browser

The browser platform build of the Bugsee JavaScript SDK: global error and unhandled-rejection capture, console and network capture, user-interaction breadcrumbs, session replay, and IndexedDB-backed persistence.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install `@bugsee/bugsee` instead. It selects this build automatically in the browser and adds performance monitoring (web vitals, navigation and interaction transactions), trace propagation and OpenTelemetry on top of it.

The framework adapters (`@bugsee/react`, `@bugsee/vue`, `@bugsee/angular`, `@bugsee/svelte`, `@bugsee/solid`, and the Next.js, Nuxt, Remix, SvelteKit and Astro adapters), `@bugsee/webworker`, `@bugsee/webview` and `@bugsee/electron` also build on it.

What it contains:

- `launch(appToken, options)` and `launchCore`, the browser composition root (`launch` returns a `Promise` of the client).
- Capture sources: window errors, unhandled rejections, interactions, navigation, input, system events and traces, DOM view hierarchy.
- The report dialog, and the wiring of the fetch transport and IndexedDB bundle storage.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/browser
- Bugsee: https://bugsee.com

## Persistence

By default the rolling capture window and the queue of reports waiting to upload are kept in IndexedDB, so the recent past survives a page reload or a browser restart, and a report interrupted mid-upload is sent on the next visit. Data is stored in per-app databases named `bugsee-<hash>`, `bugsee-capture-<hash>` and `bugsee-markers-<hash>`.

Pass `persist: false` to keep everything in memory instead. The default only checks that the page exposes an IndexedDB object. If the browser refuses to store data (over quota, some private modes), writes fail best-effort and are reported to `onError`; the SDK does not switch to memory at that point. Any `persist` value other than `true` or `false` counts as off and is reported.

## License

MIT. See the LICENSE file.
