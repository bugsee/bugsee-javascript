# @bugsee/electron

The Bugsee SDK for Electron. It joins the main process (Node.js), the renderer processes (Chromium) and native crashes into one Bugsee session, so a report carries console, network, logs and session replay from every process.

Part of the Bugsee JavaScript SDK (public beta, 0.1.0-beta.x).

Install this package directly in Electron apps. You do not need `@bugsee/bugsee`. The main process owns the session and uploads reports; renderers stream their capture up to it over IPC. Native crashes are collected through Electron's built-in `crashReporter` and attached to the same session. The package has no dependency on `electron` itself: you pass Electron objects in.

## Install

```sh
npm install @bugsee/electron
# or
pnpm add @bugsee/electron
# or
yarn add @bugsee/electron
```

## Usage

There are three entry points, one per process type.

Main process (launch it early). Pass Electron's `ipcMain`, plus `app` (to catch renderer processes that die) and `crashReporter` (for native crashes):

```ts
// main.ts
import { launchMain } from '@bugsee/electron/main';
import { app, crashReporter, ipcMain } from 'electron';

launchMain('YOUR_APP_TOKEN', { ipcMain, app, crashReporter });
```

Preload script (exposes the IPC bridge through `contextBridge`, so it works with context isolation):

```ts
// preload.ts
import { registerBugseePreload } from '@bugsee/electron/preload';
import electron from 'electron';

registerBugseePreload(electron);
```

Renderer process (returns a `Promise` of the client):

```ts
// renderer.ts
import { launchRenderer } from '@bugsee/electron/renderer';

launchRenderer('YOUR_APP_TOKEN');
```

## Options

`launchMain(appToken, options)` takes `ipcMain` (required), `app`, `crashReporter`, `crashReporterExtra` and `video`, plus every `@bugsee/node` launch option (`appVersion`, `captureLogs`, `captureNetwork`, `maxRecordingTime`, `dataDir` and others).

`launchRenderer(appToken, options)` takes the `@bugsee/browser` launch options. Session replay is on by default and streams to the main process; pass `replay: false` to opt out.

`video` (main process, opt-in) adds pixel video capture next to the default DOM replay. You supply the capture source (`video: { source }`).

## App version and build

If you pass `app` to `launchMain`, the SDK reports `app.getVersion()` as your app version, so a packaged app shows the version from its `package.json` without any extra setup. The order is:

1. The `appVersion` and `appBuild` launch options. These always win.
2. Values injected at build time.
3. Your own `appIdentitySource`, if you pass one (it is asked first), then `app.getVersion()` for anything it left out.
4. The `BUGSEE_APP_VERSION` and `BUGSEE_APP_BUILD` environment variables, the nearest `package.json`, and the commit variables set by CI systems, as described in the `@bugsee/node` documentation.

Electron does not expose a build number, so set `appBuild` (or `BUGSEE_APP_BUILD`) if you want one; in CI the commit hash is picked up automatically.

## Process telemetry

If you pass `app` to `launchMain`, the main process also reports what Electron can say about the app's processes, next to the usual Node traces (`process_memory_*`, `cpu_*`, `event_loop_*`):

- The `app_metrics` system trace, polled from `app.getAppMetrics()` once a second while system traces are captured: `{ processes: [{ type, pid, cpu_percent, working_set_mb, peak_working_set_mb, private_mb }] }`. `type` is Electron's process type (`Browser`, `Tab`, `GPU`, `Utility`, ...). `cpu_percent` is the share of the whole machine (0-100, rounded to 2 decimals), measured since the previous call. A field Electron does not supply is left out, never sent as zero, there is no sample for the first interval, and a process's first appearance (a new renderer, a restarted GPU or utility process) carries no `cpu_percent` because Chromium has no CPU window for it yet.
- A `child_process_gone` system event (`{ type, reason, exitCode, name }`) when a GPU or utility process exits, including a normal exit (`reason: 'clean-exit'`), so filter on `reason` if you only want crashes. It is recorded only while `captureSystemEvents` is on, and the `child-process-gone` listener is removed again by `client.stop()`.
- `environment.hardware.gpu` from `app.getGPUInfo(gpuInfoType)` (`'basic'` by default). A usable result is kept; a failed read, or a different `gpuInfoType` on a later launch, asks again.

A `relaunch()` from `@bugsee/node` or `@bugsee/bugsee` is not Electron-aware: after it `hardware.gpu` is still served, but `app_metrics`, `child_process_gone` and the power, display and window telemetry below stop until `launchMain` runs again.

## Power, display and window telemetry

Pass any of `powerMonitor`, `screen` and `BrowserWindow` (the Electron objects, injected like `app`) to `launchMain`; a domain whose object is absent is simply off. Pass `screen` only after the app is ready.

- `powerMonitor` -> `events.system`: `power_suspend`, `power_resume`, `power_lock`, `power_unlock` (macOS/Windows), `power_ac`, `power_battery`. No params.
- `screen` -> `events.system`: `display_added` and `display_removed` (`{ id, width, height, scaleFactor, rotation, internal, refreshRate }`, absent keys omitted) and `display_metrics_changed` (the same plus `changed`, Electron's changed metrics). It also feeds the `electron_displays` system trace (`{ displays: [{ id, width, height, scale_factor, rotation, internal, refresh_rate_hz }] }`, written when it changes; absent when Electron gives no usable list). The name is JS-specific: `displays` is reserved until an Android-shaped list is confirmed against the viewer.
- `app` (plus `BrowserWindow` for windows that already exist) -> `events.system`: `window_focus`, `window_blur`, `window_show`, `window_hide` (`{ windowId }`), and `renderer_unresponsive` / `renderer_responsive` (`{ webContentsId }`). Windows created after `launchMain` are tracked too. The hang pair is listened for on `webContents` only, because `BrowserWindow` re-emits it and each hang would otherwise be recorded twice; a `<webview>` or `BrowserView` is covered when Electron announces it through `web-contents-created`.

All of these events are recorded only while `captureSystemEvents` is on, the listeners are removed again by `client.stop()`, and a throwing Electron getter is reported through `onError` and never fails the launch. Window titles and URLs are never read.


## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/electron
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
