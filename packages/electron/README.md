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

## Links

- Repository: https://github.com/bugsee/bugsee-javascript/tree/main/packages/electron
- Bugsee: https://bugsee.com

## License

MIT. See the LICENSE file.
