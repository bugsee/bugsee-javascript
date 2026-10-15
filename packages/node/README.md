# @bugsee/node

The Node.js platform build of the Bugsee JavaScript SDK: uncaught-exception and unhandled-rejection capture, console and `node:http` capture, incoming-request instrumentation, on-disk capture with crash recovery, and optional event-loop hang detection and CPU profiling.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install `@bugsee/bugsee` instead. It selects this build automatically on Node.js and adds performance monitoring, trace propagation and OpenTelemetry on top of it.

The backend adapters (`@bugsee/express`, `@bugsee/fastify`, `@bugsee/nestjs`, `@bugsee/hono`, `@bugsee/koa`, `@bugsee/hapi`, `@bugsee/elysia`), the Next.js and other meta-framework adapters, `@bugsee/bun`, `@bugsee/deno` and `@bugsee/electron` also build on it. Requires Node.js 18 or newer.

What it contains:

- `launch(appToken, options)` and `launchCore`, the Node composition root (`launch` returns the client synchronously).
- Wiring of the `node:http` transport, the file-backed capture store and the durable bundle queue.
- Detection providers, environment and system-metrics collection, and the per-request context store.

## App version and build

Reports show which version of your app produced them. You normally do not have to set it: at launch the SDK looks for the version and build in this order and uses the first usable value for each.

1. The `appVersion` and `appBuild` launch options. These always win.
2. Values injected at build time (`__BUGSEE_APP_VERSION__` and `__BUGSEE_APP_BUILD__`).
3. The `appIdentitySource` launch option, a function returning `{ version?, build? }`. Use it when something else in your host knows the version.
4. For the version: the `BUGSEE_APP_VERSION` environment variable, then `npm_package_version` (set when you start the app with `npm run` or `pnpm run`), then the `version` field of the nearest `package.json`, searched upward from `appRoot` (or the working directory), up to 12 levels. The nearest `package.json` wins: if it has no usable version, there is no version (a parent or workspace version is not adopted). Blank values are ignored.
5. For the build: the `BUGSEE_APP_BUILD` environment variable, then the commit variable of your CI or host, tried in this order: `GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`, `CI_COMMIT_SHA`, `CIRCLE_SHA1`, `BUILDKITE_COMMIT`, `SOURCE_VERSION`, `RENDER_GIT_COMMIT`, `COMMIT_REF`, `CF_PAGES_COMMIT_SHA`, `GIT_COMMIT`.

Detection runs once, at launch. If no version is found, reports show `0.0.0` and a single warning is printed; set `appVersion` or `BUGSEE_APP_VERSION`, or give your `package.json` a version, to fix it.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/node
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
