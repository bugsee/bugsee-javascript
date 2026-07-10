// launchMain — the Electron main-process entry (the session OWNER). Runs @bugsee/node's full launch (ring +
// bundler + upload pipeline + durable queue + the main's own node capture) and wires the ElectronMainReceiver
// to node's capture store, so every renderer's streamed capture merges into ONE session / one bundle. `electron`
// is taken as an arg (the app passes `require('electron').ipcMain`) so @bugsee/electron has no electron dep.
//
//   import { launchMain } from '@bugsee/electron/main';
//   import { ipcMain } from 'electron';
//   launchMain(appToken, { ipcMain });
import { CaptureStoreToken } from '@bugsee/core';
import { type Bugsee, type BugseeLaunchOptions, launchCore } from '@bugsee/node';
import {
  type CrashReporterLike,
  deriveMinidumpUrl,
  installNativeCrashReporter,
} from './crash-reporter';
import { createElectronMainReceiver, type IpcMainLike } from './main-receiver';

/** The node `launchCore` shape, injectable for tests. */
type NodeLaunch = typeof launchCore;

export interface LaunchMainOptions extends BugseeLaunchOptions {
  /** Electron's `ipcMain` (the app passes `require('electron').ipcMain`). */
  ipcMain: IpcMainLike;
  /** Electron's `crashReporter` — when provided, native minidumps are captured, session-correlated (E5). */
  crashReporter?: CrashReporterLike;
  /** Override the minidump submit URL (default derived from the API base, Android-parity). */
  minidumpUrl?: string;
  /** Extra params attached to native crash minidumps (merged under the session correlation). */
  crashReporterExtra?: Record<string, string>;
  /** Test seam: the node launch fn (default @bugsee/node `launchCore`). */
  launch?: NodeLaunch;
}

/** Launch Bugsee in the Electron main process: it owns the session and merges all renderers' capture. */
export function launchMain(appToken: string, options: LaunchMainOptions): Bugsee {
  const { ipcMain, crashReporter, minidumpUrl, crashReporterExtra, launch, ...nodeOptions } = options;
  const { client, internals } = (launch ?? launchCore)(appToken, nodeOptions);

  // Merge every renderer's streamed capture into the main process's own store (resolved from the client's DI).
  const store = client.getService(CaptureStoreToken);
  const receiver = createElectronMainReceiver({ ipcMain, store });
  receiver.start();

  // Native crashes (all processes): start Electron's crashReporter, session-correlated. `internals` is only
  // present on the FIRST launch (the SDK is a per-process singleton), so this installs exactly once.
  if (crashReporter !== undefined && internals !== undefined) {
    installNativeCrashReporter({
      crashReporter,
      appToken,
      sessionId: internals.api.sessionId,
      submitURL: minidumpUrl ?? deriveMinidumpUrl(internals.baseUrl, appToken),
      extra: crashReporterExtra,
    });
  }

  // Tie the receiver's lifecycle to the client: stopping the client removes the IPC listener.
  const stop = client.stop.bind(client);
  (client as { stop: Bugsee['stop'] }).stop = ((): ReturnType<Bugsee['stop']> => {
    receiver.stop();
    return stop();
  }) as Bugsee['stop'];

  return client;
}
