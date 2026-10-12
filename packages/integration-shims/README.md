# @bugsee/integration-shims

No-op stand-ins for DOM-only integrations, for the Bugsee JavaScript SDK on DOM-less runtimes.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install `@bugsee/bugsee` instead.

## What it contains

- Typed no-op capture providers and interceptors (view hierarchy, breadcrumbs, XHR) that capture nothing and log a one-time warning when used.
- The logger and runtime label are injected by the platform package that builds the shim.

No other published package depends on it directly at the moment. Its API is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/integration-shims
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
