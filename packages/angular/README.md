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

Peer dependencies: `@angular/core` >= 16 and `@angular/router` >= 16 (both optional). `@angular-devkit/schematics` and `@schematics/angular` (>= 16.1, optional) are only used by `ng add` and are already in every Angular workspace.

## Quick start: `ng add`

```sh
ng add @bugsee/angular
```

It asks for your app token and then, in the workspace's application:

- turns on hidden script source maps in the production configuration of `angular.json` (`"sourceMap": { "scripts": true, "styles": false, "hidden": true }`), unless it already produces maps;
- launches the SDK in `main.ts`, before the bootstrap;
- registers `BugseeErrorHandler` as your `ErrorHandler` (standalone `app.config.ts` or `AppModule`);
- adds a `build:bugsee` script, and keeps the token for it in `.env.bugsee-build-plugin` (added to `.gitignore`).

Where it cannot find your bootstrap it changes no source and prints the lines to add by hand. Running it again changes nothing. With several applications pass `--project <name>`.

## Source maps

Build for release with the script it added:

```sh
npm run build:bugsee      # ng build --configuration production && bugsee-angular-upload --configuration production
```

`bugsee-angular-upload` stamps debug-IDs into `dist/<project>/browser`, uploads the maps, registers the build and removes the local maps, so a crash from the shipped bundle shows your original source. Set `BUGSEE_APP_TOKEN` (or keep the env file) where you run it. A plain `ng build` does not upload.

You can also run it by hand after any `ng build` (`bugsee-angular-upload --help` lists the options: `--project`, `--configuration`, `--dist`, `--dry-run`, `--keep-maps`, `--fail-on-error`, …), or call it from code:

```ts
import { uploadAngularSourcemaps } from "@bugsee/angular/sourcemaps";

await uploadAngularSourcemaps({ project: "my-app", configuration: "production" });
```

It works with the esbuild `application` builder and the webpack `browser` builder. Notes:

- `subresourceIntegrity: true` is supported: after stamping, the integrity hashes in `index.html`, in the import map and in the SSR server modules are re-written to match, so the page keeps loading.
- A build with a service worker (`ngsw.json` in the output) is not stamped, since the service worker pins a hash of every file; nothing is uploaded for it.
- Only the browser output is uploaded; errors from an SSR server are reported by the Node SDK.

Details and the measurements behind them: [source maps](https://github.com/bugsee/bugsee-javascript/blob/main/docs/source-maps-usage.md).

## Usage by hand

`ng add` does this for you. To do it yourself, launch Bugsee as early as possible, at the top of your entry module. In the browser `launch()` returns a Promise of the client. Await it only if you need the client right away.

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
