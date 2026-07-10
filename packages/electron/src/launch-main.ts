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
import { createElectronMainControl, type IpcMainControlLike } from './main-control';
import { createElectronMainReceiver, type IpcMainLike } from './main-receiver';
import {
  createPixelVideoController,
  encodePixelVideo,
  type PixelVideoController,
} from './pixel-video-controller';
import type { VideoCaptureSource } from './video-capture';

/** The node `launchCore` shape, injectable for tests. */
type NodeLaunch = typeof launchCore;

/** Opt-in pixel-capture video (D8). The app supplies a source built with its Electron/DOM specifics (e.g.
 *  `createCapturePageVideoSource` over `webContents.capturePage`, and/or a `MediaRecorder` source — they can
 *  be composed into one source). rrweb DOM-replay stays the DEFAULT and rides the renderer streaming path. */
export interface VideoLaunchOptions {
  /** The pixel-video capture source. */
  source: VideoCaptureSource;
  /** macOS Screen-Recording (TCC) permission gate — resolves false → inert. Default granted. */
  hasPermission?: () => boolean | Promise<boolean>;
}

export interface LaunchMainOptions extends BugseeLaunchOptions {
  /** Electron's `ipcMain` (the app passes `require('electron').ipcMain`). Drives both the inbound capture
   *  receiver (renderer→main) and the outbound control channel (main→renderer). */
  ipcMain: IpcMainLike & IpcMainControlLike;
  /** Electron's `crashReporter` — when provided, native minidumps are captured, session-correlated (E5). */
  crashReporter?: CrashReporterLike;
  /** Override the minidump submit URL (default derived from the API base, Android-parity). */
  minidumpUrl?: string;
  /** Extra params attached to native crash minidumps (merged under the session correlation). */
  crashReporterExtra?: Record<string, string>;
  /** Opt-in pixel-capture video (D8). Omit for the rrweb-replay default. */
  video?: VideoLaunchOptions;
  /** Test seam: the node launch fn (default @bugsee/node `launchCore`). */
  launch?: NodeLaunch;
}

/** Launch Bugsee in the Electron main process: it owns the session and merges all renderers' capture. */
export function launchMain(appToken: string, options: LaunchMainOptions): Bugsee {
  const { ipcMain, crashReporter, minidumpUrl, crashReporterExtra, video, launch, ...nodeOptions } =
    options;

  // Opt-in pixel video (D8): build the permission-gated controller and forward its report-time snapshot +
  // the `video` binary encoder into the node launch (merged with any the caller passed directly).
  let videoController: PixelVideoController | undefined;
  if (video !== undefined) {
    videoController = createPixelVideoController({
      source: video.source,
      ...(video.hasPermission !== undefined ? { hasPermission: video.hasPermission } : {}),
      ...(nodeOptions.onError !== undefined ? { onError: nodeOptions.onError } : {}),
    });
    const controller = videoController;
    nodeOptions.reportSnapshots = [
      ...(nodeOptions.reportSnapshots ?? []),
      (now: number) => controller.snapshot(now),
    ];
    nodeOptions.fileEncoders = { ...nodeOptions.fileEncoders, video: encodePixelVideo };
  }

  const { client, internals } = (launch ?? launchCore)(appToken, nodeOptions);

  // `internals` is present only on the FIRST launch (the SDK is a per-process singleton); a repeat launch
  // returns the already-wired client untouched, so all Electron wiring hangs off the first-launch internals.
  if (internals === undefined) {
    return client;
  }

  // Start pixel capture (async permission check; a report before it's active just carries no video).
  videoController?.start();

  // Merge every renderer's streamed capture into the main process's own store (resolved from the client's DI).
  const store = client.getService(CaptureStoreToken);
  const receiver = createElectronMainReceiver({ ipcMain, store });
  receiver.start();

  // The DOWNstream control channel: reply to each renderer's `hello` with this session id (the handshake)
  // and propagate pause/resume/flush/stop to every renderer.
  const control = createElectronMainControl({ ipcMain, sessionId: internals.api.sessionId });
  control.start();

  // Native crashes (all processes): start Electron's crashReporter, session-correlated.
  if (crashReporter !== undefined) {
    installNativeCrashReporter({
      crashReporter,
      appToken,
      sessionId: internals.api.sessionId,
      submitURL: minidumpUrl ?? deriveMinidumpUrl(internals.baseUrl, appToken),
      extra: crashReporterExtra,
    });
  }

  // Tie the renderer-facing lifecycle to the client: stopping the client stops the renderers + removes the
  // IPC listeners; flushing the client flushes the renderers too.
  const stop = client.stop.bind(client);
  (client as { stop: Bugsee['stop'] }).stop = ((timeout?: number): ReturnType<Bugsee['stop']> => {
    control.stop(); // broadcast stop to renderers + remove the hello listener
    receiver.stop();
    videoController?.stop(); // stop pixel capture
    return stop(timeout);
  }) as Bugsee['stop'];

  const flush = client.flush.bind(client);
  (client as { flush: Bugsee['flush'] }).flush = ((timeout?: number): ReturnType<
    Bugsee['flush']
  > => {
    control.flush(); // ask renderers to flush too
    return flush(timeout);
  }) as Bugsee['flush'];

  return client;
}
