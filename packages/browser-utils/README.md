# @bugsee/browser-utils

Browser-side building blocks of the Bugsee JavaScript SDK: a `fetch` transport, IndexedDB storage and DOM helpers.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install `@bugsee/browser`, or the umbrella `@bugsee/bugsee` instead.

## What it contains

- A `fetch`-based HTTP transport for uploads.
- IndexedDB-backed storage and a durable bundle store, so captured data survives page reloads.
- Helpers shared by the browser, Web Worker and edge platforms.

It is used by `@bugsee/browser`, `@bugsee/webworker` and `@bugsee/vercel-edge`. Its API is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/browser-utils
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
