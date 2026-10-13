# @bugsee/browser

The browser platform build of the Bugsee JavaScript SDK: global error and unhandled-rejection capture, console and network capture, user-interaction breadcrumbs, session replay, and IndexedDB-backed persistence.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install `@bugsee/bugsee` instead. It selects this build automatically in the browser and adds performance monitoring (web vitals, navigation and interaction transactions), trace propagation and OpenTelemetry on top of it.

The framework adapters (`@bugsee/react`, `@bugsee/vue`, `@bugsee/angular`, `@bugsee/svelte`, `@bugsee/solid`, and the Next.js, Nuxt, Remix, SvelteKit and Astro adapters), `@bugsee/webworker`, `@bugsee/webview` and `@bugsee/electron` also build on it.

What it contains:

- `launch(appToken, options)` and `launchCore`, the browser composition root (`launch` returns a `Promise` of the client).
- Capture sources: window errors, unhandled rejections, interactions, navigation, input, system events and traces, DOM view hierarchy.
- The report dialog, and the wiring of the fetch transport and IndexedDB bundle storage.

## App version and build

Reports carry the version and build of your app. The most direct way is to pass them to `launch`:

```js
await launch('<app-token>', { appVersion: '2.4.1', appBuild: '381' });
```

Bugsee can also pick them up at build time. The Bugsee Vite and webpack plugins inject the constants `__BUGSEE_APP_VERSION__` and `__BUGSEE_APP_BUILD__` automatically when you give `appVersion` and `appBuild` to the plugin, or when `BUGSEE_APP_VERSION` and `BUGSEE_APP_BUILD` are set in the build environment. You can also define those two constants yourself in your bundler, or set `__BUGSEE_APP_VERSION__` and `__BUGSEE_APP_BUILD__` as globals before launching (for example `window.__BUGSEE_APP_VERSION__ = '2.4.1'`). Options passed to `launch` always win over the build-time values.

If no version can be found, Bugsee logs a single warning to the console and reports the version as `0.0.0` and the build as `0`. A page can also declare them in its HTML:

```html
<meta name="bugsee:app-version" content="2.4.1">
<meta name="bugsee:app-build" content="381">
```

When more than one source is present, the order is: launch options, then build-time constants, then meta tags.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/browser
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
