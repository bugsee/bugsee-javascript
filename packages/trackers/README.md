# @bugsee/trackers

The foundation the Bugsee JavaScript SDK builds its domain trackers on.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

This is an internal building block of the Bugsee SDK, not intended to be installed directly. Install `@bugsee/bugsee` instead.

## What it contains

- The multi-key event emitter (`MultiKeyEmitterBase`, `createMultiKeyEmitter`) and the `EventSubscribable` / `Interceptor` contracts.
- `InterceptorBase`, the base for sources that install a runtime hook only while someone listens.
- `createTrackerRegistry`, the per-window (per key object) singleton registry that trackers are looked up through.

`@bugsee/core` imports this package and re-exports the same public names, so SDK code keeps importing them from `@bugsee/core`.

## Layout

Trackers are the abstraction over system and runtime APIs. The package root is runtime-portable: it never imports DOM, `node:*` or Electron, and receives runtime APIs only through injected env objects and guarded globals. Platform-specific tracker implementations live behind these subpath entries, and only code under them may use that platform's APIs:

- `@bugsee/trackers/browser` (`src/browser/`)
- `@bugsee/trackers/node` (`src/node/`)
- `@bugsee/trackers/electron` (`src/electron/`)

The `./browser` entry exports the `PowerTracker` (`powerTrackerFor`, `resetPowerTracker`), the `ConnectivityTracker` (`connectivityTrackerFor`, `resetConnectivityTracker`) and `hostRead`; `./node` and `./electron` are reserved in `exports` and currently export nothing. Its API is internal and may change between releases.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/trackers
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
