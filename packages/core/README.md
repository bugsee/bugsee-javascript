# @bugsee/core

The kernel of the Bugsee JavaScript SDK: the client, capture aggregation and storage, report and upload pipelines, and the extension registry.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install the umbrella `@bugsee/bugsee`, or a platform package such as `@bugsee/browser` or `@bugsee/node` instead.

## What it contains

- The `Client` and the launch-option resolver.
- The capture aggregator, capture stores, bundle writer and durable bundle queue.
- Trigger and upload pipelines, plus the interceptor and event-emitter base classes.
- Runtime-portable: it reaches runtime globals only through injected seams, so the same code runs in browsers, Node.js, Bun, Deno and edge runtimes.

Every platform and adapter package (`@bugsee/browser`, `@bugsee/node`, `@bugsee/bun`, `@bugsee/deno`, `@bugsee/electron`, the framework adapters and others) depends on it. Its API is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/core
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
