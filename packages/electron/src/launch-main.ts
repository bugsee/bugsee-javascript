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
import { createElectronMainReceiver, type IpcMainLike } from './main-receiver';

/** The node `launchCore` shape, injectable for tests. */
type NodeLaunch = typeof launchCore;

export interface LaunchMainOptions extends BugseeLaunchOptions {
  /** Electron's `ipcMain` (the app passes `require('electron').ipcMain`). */
  ipcMain: IpcMainLike;
  /** Test seam: the node launch fn (default @bugsee/node `launchCore`). */
  launch?: NodeLaunch;
}

/** Launch Bugsee in the Electron main process: it owns the session and merges all renderers' capture. */
export function launchMain(appToken: string, options: LaunchMainOptions): Bugsee {
  const { ipcMain, launch, ...nodeOptions } = options;
  const client = (launch ?? launchCore)(appToken, nodeOptions).client;

  // Merge every renderer's streamed capture into the main process's own store (resolved from the client's DI).
  const store = client.getService(CaptureStoreToken);
  const receiver = createElectronMainReceiver({ ipcMain, store });
  receiver.start();

  // Tie the receiver's lifecycle to the client: stopping the client removes the IPC listener.
  const stop = client.stop.bind(client);
  (client as { stop: Bugsee['stop'] }).stop = ((): ReturnType<Bugsee['stop']> => {
    receiver.stop();
    return stop();
  }) as Bugsee['stop'];

  return client;
}
