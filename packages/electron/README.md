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

`launchMain(appToken, options)` takes `ipcMain` (required), `app`, `powerMonitor`, `screen`, `BrowserWindow`, `gpuInfoType`, `captureWindowEvents`, `crashReporter`, `crashReporterExtra` and `video`, plus every `@bugsee/node` launch option (`appVersion`, `captureLogs`, `captureNetwork`, `maxRecordingTime`, `dataDir` and others).

`launchRenderer(appToken, options)` takes the `@bugsee/browser` launch options. Session replay is on by default and streams to the main process; pass `replay: false` to opt out.

`video` (main process, opt-in) adds pixel video capture next to the default DOM replay. You supply the capture source (`video: { source }`).

Notes for Electron 45 and later:

- Screen, window and tab capture requests (`getDisplayMedia()`, and `getUserMedia()` with `chromeMediaSource`; `desktopCapturer.getSources()` itself only lists sources) reach `session.setPermissionRequestHandler` as `display-capture`, no longer `media`. If your app allows only `media`, a `getDisplayMedia`-based source will be denied. Allow `display-capture` for the window that hosts your source, and if your app also installs `session.setPermissionCheckHandler`, allow it there too. The `capturePage` source needs no permission.
- To capture a WebContents with your own `MediaRecorder` stream, use `chromeMediaSource: 'tab'` with `webContents.getMediaSourceId()`, or `session.setDisplayMediaRequestHandler`. The old `chromeMediaSource: 'desktop'` form with a WebContents source id fails with "Invalid state". The SDK never builds this stream itself; it records the one you supply.
- Sandboxed renderers (`sandbox: true`): a sandboxed preload must be CommonJS, and its `require` can load only Electron's built-in modules, not an external package or a sibling file. Bundle `@bugsee/electron/preload` into your single preload file (esbuild, webpack, Vite); copying `dist/preload.cjs` next to your preload does not work. The preload entry is a thin wrapper over `contextBridge` and `ipcRenderer`, and a test checks its TypeScript sources import nothing else and use none of the Node polyfills (`events`, `timers`, `url`, `Buffer`, `setImmediate`, `clearImmediate`) that Electron 45 removed from sandboxed preloads. The built output is not covered by a test: in one local `tsup` build, `dist/preload.cjs` contained no `require(` calls (the ESM build splits shared code into chunks, so use the CommonJS one). We have not run a real `sandbox: true` window on Electron 45.

## Native crashes on Windows

Pass Electron's `crashReporter` to `launchMain` as shown above. Electron 45 adds a Windows Error Reporting helper (`<app>_wer.dll`, next to the executable) so that `crashReporter` also sees crashes such as `__fastfail` that used to bypass it. This is part of Electron's packaging, not ours: make sure your packager keeps that file in the install directory (Electron ships it as `electron_wer.dll`; if you rename `electron.exe`, rename the helper to match), and expect more minidumps from Windows than before.

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
- A `child_process_gone` system event (`{ type, reason, exitCode, name, serviceName }`, the last two when Electron supplies them; `serviceName` is e.g. `network.mojom.NetworkService`) when a GPU or utility process exits, including a normal exit (`reason: 'clean-exit'`), so filter on `reason` if you only want crashes. It is recorded only while `captureSystemEvents` is on, and the `child-process-gone` listener is removed again by `client.stop()`.
- `environment.hardware.gpu` from `app.getGPUInfo(gpuInfoType)` (`'basic'` by default). A usable result is kept; a failed read, or a different `gpuInfoType` on a later launch, asks again.

A `relaunch()` from `@bugsee/node` or `@bugsee/bugsee` is not Electron-aware: after it `hardware.gpu` is still served, but `app_metrics`, `child_process_gone` and the power (including `thermal_state` and `cpu_speed_limit`), display and window telemetry below stop until `launchMain` runs again.

## Power, display and window telemetry

Pass any of `powerMonitor`, `screen` and `BrowserWindow` (the Electron objects, injected like `app`) to `launchMain`; a domain whose object is absent is simply off.

**Pass `screen` safely.** Electron's real `screen` throws on any property read until the app is ready, so `import { screen } from 'electron'` and passing it straight to a `launchMain` call made before `app.whenReady()` turns the display domain off (the failure is reported through `onError`; the launch and the other domains are unaffected). To get display telemetry, either call `launchMain` after `app.whenReady()`, or leave `screen` out of the early call. The `powerMonitor` has the same rule on some platforms.

- `powerMonitor` -> `events.system`: `power_suspend`, `power_resume`, `power_lock`, `power_unlock`, `power_ac`, `power_battery`. No params. Platform dependent, per Electron's typings: `lock-screen`/`unlock-screen` are macOS and Windows, `on-ac` is macOS and Windows, and `on-battery` is macOS only, so an event that never fires is not evidence about the power state.
- `powerMonitor` -> system traces `thermal_state` and `cpu_speed_limit` (on whenever `powerMonitor` is passed and `captureSystemTraces` is on; supplying the legacy `systemMetricsSampler` option replaces the trace producers, so these stay absent then). They are event-driven and sampled, never held: a state the OS stops reporting leaves a gap. `thermal_state` is macOS only: it is written once at start from `getCurrentThermalState()` and on every `thermal-state-change` (a state outside Electron's four named ones reads as `unknown`, which writes nothing). `cpu_speed_limit` is an integer percent 0-100 (fractions are rounded to the nearest integer; out-of-range or non-numeric values are dropped) from `speed-limit-change` only, on macOS and Windows: Electron has no `getCurrentCPUSpeedLimit()`, so there is no value until the OS reports a limit, and a measured 0 is written. `thermal-state-change` and `speed-limit-change` pass a details object (`{ state }` / `{ limit }`) as the first listener argument; the tracker also accepts a bare value.
- `screen` -> `events.system`: `display_added` and `display_removed` (camelCase `{ id, nativeId, width, height, naturalWidth, naturalHeight, scale, maxFps, rotation, type }`, absent keys omitted; `id` is the display's number in the CURRENT `displays` list (a removed display is no longer listed and takes the number after the last listed one, so correlate display events by `nativeId`, which is the stable key), `width`/`height` are device pixels, `rotation` is quarter turns; a display whose id is -1, Electron's "invalid or not yet known" marker, is ignored) and `display_metrics_changed` (the same plus `changed`, Electron's changed metrics). **Pass `screen` (after app ready) to get the `displays` trace: without it an Electron session has no display trace at all, because renderers never write it (the host owns it).** It also feeds the `displays` system trace, the mobile layout: a list `[{ id, native_id, state?, type?, width, height, natural_width?, natural_height?, scale?, max_fps?, rotation? }]` (`id` 0 is the display showing the KEY window (the focused window, else the most recently focused, else the first created; the primary display when there is no window yet), the others follow in ascending order of Electron's id with Electron's own id in `native_id`; the numbering is recomputed, and the list re-written, when focus or a window move changes the key window's display; `state: "on"` marks id 0; windows on other displays are not recorded; the retired `electron_displays` name is gone), written when it changes. The trace is absent only before its first value: if a later refresh cannot read a usable list, the previous list stays held and keeps being re-recorded (the same open decision as other held traces).
- `app` (plus `BrowserWindow` for windows that already exist) -> `events.system`: `window_focus`, `window_blur`, `window_show`, `window_hide` (`{ windowId }`), and `renderer_unresponsive` / `renderer_responsive` (`{ webContentsId }`). These are on whenever `app` is passed (they add two `browser-window-created` listeners, for focus and for show/hide, and one `web-contents-created` listener); pass `captureWindowEvents: false` to opt out of the events. That switch does NOT stop key-window tracking: when `screen` is passed the `displays` trace follows the focused window, so two `browser-window-created` listeners (focus, moved) and focus/blur/moved/closed listeners on every window stay armed even with the option off (with window events on and `screen` passed, `app` carries three `browser-window-created` listeners). Windows created after `launchMain` are tracked too. The hang pair is listened for on `webContents` only, because `BrowserWindow` re-emits it and each hang would otherwise be recorded twice; a `<webview>` or `BrowserView` is covered when Electron announces it through `web-contents-created`.

All of these events are recorded only while `captureSystemEvents` is on, the listeners are removed again by `client.stop()`, and a throwing Electron getter is reported through `onError` and never fails the launch. Window titles and URLs are never read.

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/electron
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
