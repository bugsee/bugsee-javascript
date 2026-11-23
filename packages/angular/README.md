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
- A build with a service worker works: `ngsw.json` (one per locale for a localized build) lists the SHA-1 of every file it caches, so after stamping those entries are re-computed and checked; if one cannot be reconciled the build is restored and nothing is uploaded.
- If the output is not where `angular.json` says (`ng build --output-path other`), pass `--output-path other` (or `--dist <browser dir>`). When the output is named by its browser directory (also `browser/<locale>`) and a sibling `server/` exists inside the project, the output root is re-sealed, because the server embeds the page (for one locale of several, only that locale and its `server/<locale>` pages: Angular emits identical shared scripts into every locale, and the others must keep pinning their unstamped copies); if the output root is the project root itself (or outside it) the tool says it cannot, and you should build into its own directory and use `--output-path`. A problem locating the output (no `angular.json`, several applications without `--project`, no build output yet) is printed and the command still exits 0, so it cannot fail a pipeline whose build succeeded; add `--fail-on-error` to make it exit non-zero.
- Install weight: `@bugsee/angular` depends on `@bugsee/bundler-plugin-core` (and through it `@bugsee/cli`, `acorn`, `magic-string`, `unplugin`), because the `bugsee-angular-upload` bin and `@bugsee/angular/sourcemaps` need them. They are build-time only and never reach a browser bundle, but they are installed with the package. Making them an optional peer that `ng add` installs as a devDependency was considered and not done: `ng add` saves the package itself under `dependencies`, the bin would fail for anyone who skips `ng add`, and the extra install step has to be verified against every package manager.
- If your app already provides its own `ErrorHandler`, `ng add` does not add a second one (the last provider wins and would silence yours); it prints how to report from yours with `reportAngularError(error)`, or to wrap it with `createAngularErrorHandler({ delegate })`.
- Known limits: the `ErrorHandler` check scans only the project's `sourceRoot`, so a handler provided from a shared (Nx) library is not seen; the deletion rule assumes Angular cleans its output directory (`deleteOutputPath`, default true), so with `deleteOutputPath: false` or a wider `--dist`, a stale foreign map that carries a debug-ID could be deleted; the integrity check does not follow `<base href>` for nested prerendered pages (the digest swap still fixes them).
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
