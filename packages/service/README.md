# @bugsee/service

The service container of the Bugsee JavaScript SDK: a registry used for dependency injection inside the SDK.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install `@bugsee/bugsee` instead.

## What it contains

- `serviceToken`, `defineService` and `createServiceContainer` for registering and resolving services.
- Lazy and explicit instantiation modes.

It is used by `@bugsee/core`. Its API is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/service
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
