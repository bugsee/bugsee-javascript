# @bugsee/capture

Cross-runtime capture sources and capture providers of the Bugsee JavaScript SDK.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install the umbrella `@bugsee/bugsee`, or a platform package such as `@bugsee/browser` or `@bugsee/node` instead.

## What it contains

- Interceptors for console output and `fetch`, and the network capture umbrella that platform packages extend with their own sources.
- Providers that turn intercepted events into captured logs, network entries, HTTP errors and input events.
- The default network sanitizer and the outgoing-request decorator registry (used for trace propagation).
- Runtime-agnostic: platform packages add the runtime-specific sources (XHR, `node:http`, global error handlers).

It is used by `@bugsee/browser`, `@bugsee/node`, `@bugsee/bun`, `@bugsee/deno`, `@bugsee/webworker`, `@bugsee/vercel-edge`, `@bugsee/webview`, the backend adapters and the umbrella. Its API is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/capture
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
