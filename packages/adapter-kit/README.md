# @bugsee/adapter-kit

Runtime-portable primitives shared by the Bugsee SSR meta-framework adapters.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install the adapter for your framework: `@bugsee/nextjs`, `@bugsee/remix`, `@bugsee/nuxt`, `@bugsee/sveltekit` or `@bugsee/astro` instead.

## What it contains

- A server-error bridge (`reportServerError`) that reports an error caught on the server through the launched client.
- Trace-data helpers (`getTraceparent`, `traceMetaEntries`, `traceMetaTag`) that expose the active trace to the page for server-to-browser trace linking.

It is used by `@bugsee/nextjs`, `@bugsee/remix`, `@bugsee/nuxt`, `@bugsee/sveltekit` and `@bugsee/astro`. Its API is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/adapter-kit
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
