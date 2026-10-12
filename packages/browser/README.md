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

## License

MIT. See the LICENSE file.
