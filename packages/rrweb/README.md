# @bugsee/rrweb

A thin wrapper over the record path of the Bugsee-hardened rrweb fork, used by Bugsee session replay.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install `@bugsee/bugsee` or `@bugsee/browser`; session replay is configured with the `replay` launch option instead.

## What it contains

- The single import point for rrweb inside the SDK, so the recorder can be swapped in one place.

It is used by `@bugsee/replay`, which `@bugsee/browser` loads when session replay runs. Its API is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/rrweb
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
