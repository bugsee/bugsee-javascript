# @bugsee/util

Pure, runtime-portable helpers for the Bugsee JavaScript SDK.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install `@bugsee/bugsee` instead.

## What it contains

- Environment detection, `Deferred`, base64 and SHA-256 helpers.
- Deep merge, JSON-safe stringify and exponential backoff.
- A re-export of `fflate` for compression.

It is used by `@bugsee/core`, `@bugsee/protocol`, `@bugsee/service`, `@bugsee/capture`, `@bugsee/browser-utils`, `@bugsee/performance` and other SDK packages. Its API is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/util
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
