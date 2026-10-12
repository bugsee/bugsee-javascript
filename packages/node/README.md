# @bugsee/node

The Node.js platform build of the Bugsee JavaScript SDK: uncaught-exception and unhandled-rejection capture, console and `node:http` capture, incoming-request instrumentation, on-disk capture with crash recovery, and optional event-loop hang detection and CPU profiling.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install `@bugsee/bugsee` instead. It selects this build automatically on Node.js and adds performance monitoring, trace propagation and OpenTelemetry on top of it.

The backend adapters (`@bugsee/express`, `@bugsee/fastify`, `@bugsee/nestjs`, `@bugsee/hono`, `@bugsee/koa`, `@bugsee/hapi`, `@bugsee/elysia`), the Next.js and other meta-framework adapters, `@bugsee/bun`, `@bugsee/deno` and `@bugsee/electron` also build on it. Requires Node.js 18 or newer.

What it contains:

- `launch(appToken, options)` and `launchCore`, the Node composition root (`launch` returns the client synchronously).
- Wiring of the `node:http` transport, the file-backed capture store and the durable bundle queue.
- Detection providers, environment and system-metrics collection, and the per-request context store.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/node
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
