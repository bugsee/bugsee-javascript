# @bugsee/web-adapter

Shared plumbing for the Bugsee frontend framework adapters.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install the adapter for your framework: `@bugsee/react`, `@bugsee/vue`, `@bugsee/svelte`, `@bugsee/solid` or `@bugsee/angular` instead.

## What it contains

- Resolution of the launched client, error reporting for framework error hooks, and route naming for navigation transactions.
- Each framework adapter layers its own error context and route-pattern extraction on top.

It is used by `@bugsee/react`, `@bugsee/vue`, `@bugsee/svelte`, `@bugsee/solid` and `@bugsee/angular`. Its API is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/web-adapter
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
