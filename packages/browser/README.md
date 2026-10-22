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

## Persistence

By default the rolling capture window and the queue of reports waiting to upload are kept in IndexedDB, so, where the browser supports it, the recent past survives a page reload or a browser restart, and a report interrupted mid-upload is sent on the next visit. Data is stored in per-app databases named `bugsee-<hash>`, `bugsee-capture-<hash>` and `bugsee-markers-<hash>`.

Pass `persist: false` to keep everything in memory instead. The default applies only when the page exposes both an IndexedDB object and Web Locks (`navigator.locks`, which needs a secure `https://` context; Safari before 15.4 and some embedded WebViews lack it): without locks a previous visit's data can never be recovered or cleaned up, so the SDK stays in memory instead. Pass `persist: true` to store anyway. If the browser refuses to store data (over quota, some private modes), writes fail best-effort and are reported to `onError`; the SDK does not switch to memory at that point. Any `persist` value other than `true` or `false` counts as off and is reported.

The SDK protects the origin's storage quota by default whenever it persists to IndexedDB (set `diskProtection: false` to opt out; any other value keeps it on). It watches `navigator.storage.estimate()` headroom (`quota - usage`; an estimate, not device free space) every 5 minutes, and every 30 seconds once headroom is under 500 MiB. Under 50 MiB it stops writing replay, logs and network data to IndexedDB, and under 10 MiB it writes nothing but a small `capture` state entry (traces, events, input and breadcrumbs keep being written until then); the in-memory window is kept either way, so a report built while the page is alive is complete, and what a crash or reload loses is the data that was not written. A state is left only 10 MiB above its threshold, and a write refused with `QuotaExceededError` moves it to the out-of-space state until a write succeeds again. Chromium reports a flat, generous headroom from `estimate()`, so on Chrome that refused write is what triggers the protection. When replay resumes being written the recorder restarts with a fresh full snapshot. `captureDiskSpace: true` (off by default; only the boolean `true` counts) adds the telemetry: with replay on, the `capture` system trace also states `low_disk_space` and `no_disk_space`. It needs the protection and a durable store, and is reported once through `onError` when there is none.

## License

MIT. See the LICENSE file.
