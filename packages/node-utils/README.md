# @bugsee/node-utils

Node.js building blocks of the Bugsee JavaScript SDK: an HTTP transport and file-system storage.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install `@bugsee/node` (or `@bugsee/bun` / `@bugsee/deno`), or the umbrella `@bugsee/bugsee` instead.

## What it contains

- A `node:http` / `node:https` transport for uploads.
- File-system storage and a durable bundle store for captured data.
- Hashing and worker-thread helpers shared by the Node.js, Bun and Deno platforms (requires Node.js 18 or newer).

It is used by `@bugsee/node`, `@bugsee/bun` and `@bugsee/deno`. Its API is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/node-utils
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
