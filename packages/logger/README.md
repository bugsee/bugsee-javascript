# @bugsee/logger

The internal diagnostic logger of the Bugsee JavaScript SDK: a log level plus handler registration.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install `@bugsee/bugsee` instead.

## What it contains

- `createLogger(level)` returns a logger with the levels `silent`, `error`, `warn`, `info` and `debug`, and pluggable log handlers.

It is used by `@bugsee/integration-shims` and `@bugsee/vercel-edge`. Its API is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/logger
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
