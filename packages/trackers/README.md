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

The `./browser` entry exports the `ApplicationTracker` (`applicationTrackerFor`, `resetApplicationTracker`), the `PowerTracker` (`powerTrackerFor`, `resetPowerTracker`), the `ConnectivityTracker` (`connectivityTrackerFor`, `resetConnectivityTracker`), the `ProcessTracker` (`processTrackerFor`, `resetProcessTracker`; stages `heap`, `mainThreadLag` (timer drift), `idle` (`requestIdleCallback`), `userIdle` (Idle Detection) and `uptime`, each armed only while it has listeners; the SDK never prompts, so `userIdle` runs only when the `idle-detection` permission is already granted; the SDK's `user_idle_state` trace additionally needs the browser/WebView launch option `captureUserIdle: true`, because a page's own grant is not consent to record and upload idle/locked state), the UI/display `UiTracker` (`uiTrackerFor`, `resetUiTracker`: orientation, screenSize, viewport, colorScheme, reducedMotion, displayMode, frameRate), the `StorageTracker` (`storageTrackerFor`, `resetStorageTracker`; an approximate origin quota estimate, not device free space: browsers may pad `usage`, and `quota` can roughly reveal the device's disk size, so treat it as potentially identifying), the `EnvironmentTracker` (`environmentTrackerFor`, `resetEnvironmentTracker`; language, time zone, and, only when a consumer sets `observeHints` / `queryPermissions`, environment hints and Permissions API states queried without ever prompting; the private-browsing heuristic runs when `detectPrivateMode` is set (the browser launch sets it by default; opt out with `captureEnvironmentHints: false`) and is never reported as a certainty) and `hostRead`; `./electron` is reserved in `exports` and currently exports nothing. Its API is internal and may change between releases.

The `./node` entry is shared by Node, Bun and Deno and exports the process `ProcessTracker` (`processTrackerFor`, `resetProcessTracker`; a per-process singleton, keyed on the `process` object by default). Its ten stages (`memory`, `systemMemory`, `cpu`, `eventLoop`, `utilization`, `gc`, `v8Heap`, `memoryLimit`, `availableMemory`, `uptime`) are each armed only while they have listeners, behind one shared sampling timer. A stage the runtime cannot honestly measure emits nothing rather than zero (event-loop utilization on Bun/Deno, the event-loop delay histogram on Deno, the GC observer on Bun/Deno, the V8 heap on Bun), controlled by the `measures*` flags the platform packages pass in. It also exports the guarded runtime sources it is built from (`createGuardedEventLoopSource`, `createGuardedElu`, `createGcSource`, `createV8HeapReader`, `createMemoryLimitReader`, `createAvailableMemoryReader`).

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/trackers
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
