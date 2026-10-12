# @bugsee/angular

Angular adapter for the Bugsee SDK: an `ErrorHandler` that reports uncaught errors and Router-based route naming, for apps running in the browser.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Angular apps, together with the `@bugsee/bugsee` umbrella that provides `launch()`.

## Install

```sh
npm install @bugsee/bugsee @bugsee/angular
# or
pnpm add @bugsee/bugsee @bugsee/angular
# or
yarn add @bugsee/bugsee @bugsee/angular
```

Peer dependencies: `@angular/core` >= 16 and `@angular/router` >= 16 (both optional).

## Usage

Launch Bugsee as early as possible, at the top of your entry module. In the browser `launch()` returns a Promise of the client. Await it only if you need the client right away.

```ts
// main.ts
import { launch } from "@bugsee/bugsee";

launch("YOUR_APP_TOKEN");
```

Register the Bugsee error handler in place of Angular's default `ErrorHandler`:

```ts
// app.config.ts
import { ErrorHandler } from "@angular/core";
import { BugseeErrorHandler } from "@bugsee/angular";

bootstrapApplication(AppComponent, {
  providers: [{ provide: ErrorHandler, useClass: BugseeErrorHandler }],
});
```

### Route naming (Angular Router)

Name the active navigation after the matched route pattern. Call `setRouteNameFromRouter(router)` on each `NavigationEnd` event:

```ts
import { NavigationEnd, Router } from "@angular/router";
import { setRouteNameFromRouter } from "@bugsee/angular";
import { filter } from "rxjs";

constructor(router: Router) {
  router.events
    .pipe(filter((event) => event instanceof NavigationEnd))
    .subscribe(() => setRouteNameFromRouter(router));
}
```

## Options

`launch(appToken, options)` accepts the SDK launch options. The most relevant ones in the browser:

- `captureLogs`: capture console output (default `true`).
- `captureNetwork`: capture network requests (default `true`).
- `maxRecordingTime`: seconds of recording to keep (default `60`).
- `replay`: session replay settings, or `false` to turn replay off.
- `captureInteractions`: capture user interactions (default `true`).

This package also re-exports everything from `@bugsee/bugsee`.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/angular
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
