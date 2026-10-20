// launchMain — the Electron main-process entry (the session OWNER). Runs @bugsee/node's full launch (ring +
// bundler + upload pipeline + durable queue + the main's own node capture) and wires the ElectronMainReceiver
// to node's capture store, so every renderer's streamed capture merges into ONE session / one bundle. `electron`
// is taken as an arg (the app passes `require('electron').ipcMain`) so @bugsee/electron has no electron dep.
//
//   import { launchMain } from '@bugsee/electron/main';
//   import { ipcMain } from 'electron';
//   launchMain(appToken, { ipcMain });
import { type AppIdentity, BlackoutToken, CaptureStoreToken } from '@bugsee/core';
import {
  type Bugsee,
  type BugseeLaunchOptions,
  launchCore,
  sanitizeHardwareGpu,
} from '@bugsee/node';
import {
  type CrashReporterLike,
  getCrashDumpsDirectory,
  installNativeCrashReporter,
} from './crash-reporter';
/** The subset of Electron's `app` that the SDK needs. */
export interface ElectronAppLike {
  /** The app's version (Electron's `app.getVersion()`): used as the reported app version when set. */
  getVersion?(): string;
  on(
    event: 'render-process-gone',
    listener: (
      event: unknown,
      contents: { id?: number },
      details: { reason: string; exitCode?: number },
    ) => void,
  ): unknown;
  /**
   * Electron's `app.getGPUInfo` — optional. When present, `getGPUInfo('basic')` is kicked once at launch and
   * the active device's strings (when Electron supplies them) are reported as `environment.hardware.gpu` on
   * every report assembled after it settles. A rejection, or an app without it, just omits the field.
   */
  getGPUInfo?(type: 'basic' | 'complete'): Promise<unknown>;
}

import type { CrashpadSessionMarker } from '@bugsee/core';
import { reportGuarded, reportOncePerMessage } from '@bugsee/util';
import { createGpuInfoCache, type GpuInfoType } from './gpu-info-cache';
import { createElectronMainControl, type IpcMainControlLike } from './main-control';
import { createElectronMainReceiver, type IpcMainLike } from './main-receiver';
import { createElectronNativeCrashSource, createNodeCrashDumpFs } from './native-crash-source';
import {
  createPixelVideoController,
  encodePixelVideo,
  type PixelVideoController,
} from './pixel-video-controller';
import { createRendererGoneHandler } from './renderer-gone';
import { type RendererGoneIncident, RendererIncidentProvider } from './renderer-incident-provider';
import type { VideoCaptureSource } from './video-capture';

/** The node `launchCore` shape, injectable for tests. */
type NodeLaunch = typeof launchCore;

/** Opt-in pixel-capture video. The app supplies a source built with its Electron/DOM specifics (e.g.
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
  /**
   * Electron's `app` — when provided, `render-process-gone` is watched so a renderer killed before it could
   * forward anything (OOM, native crash) still produces an incident on this session. Injected like
   * `ipcMain`, so @bugsee/electron keeps no electron dependency.
   */
  app?: ElectronAppLike;
  /**
   * The `app.getGPUInfo` argument used for `environment.hardware.gpu`. Default `'basic'`. `'complete'` is
   * expected to carry `auxAttributes.glRenderer`/`glVendor`/`glVersion` (more useful names) but is heavier.
   * UNVERIFIED against a real Electron: on macOS/Linux `'basic'` commonly yields only numeric vendor/device
   * ids, in which case `hardware.gpu` is absent (never guessed) until confirmed on a real Electron; pass
   * `'complete'` for the GL strings.
   */
  gpuInfoType?: GpuInfoType;
  /** Electron's `crashReporter` — when provided, native minidumps are captured, session-correlated. */
  crashReporter?: CrashReporterLike;
  /** Extra params attached to native crash minidumps (merged under the session correlation). */
  crashReporterExtra?: Record<string, string>;
  /** Opt-in pixel-capture video. Omit for the rrweb-replay default. */
  video?: VideoLaunchOptions;
  /** Test seam: the node launch fn (default @bugsee/node `launchCore`). */
  launch?: NodeLaunch;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/** Merges identity sources field by field: the first source with a usable value for a field wins it. */
const chainAppIdentity =
  (first: (() => AppIdentity | undefined) | undefined, second: () => AppIdentity) =>
  (): AppIdentity => {
    let primary: AppIdentity | undefined;
    try {
      primary = first?.();
    } catch {
      primary = undefined;
    }
    let fallback: AppIdentity = {};
    try {
      fallback = second();
    } catch {
      // `app.getVersion()` can throw before the app is ready; the version is simply unknown then.
    }
    const version = text(primary?.version) ?? text(fallback.version);
    const build = text(primary?.build) ?? text(fallback.build);
    return {
      ...(version !== undefined ? { version } : {}),
      ...(build !== undefined ? { build } : {}),
    };
  };

/** Launch Bugsee in the Electron main process: it owns the session and merges all renderers' capture. */
export function launchMain(appToken: string, options: LaunchMainOptions): Bugsee {
  const {
    ipcMain,
    app,
    gpuInfoType,
    crashReporter,
    crashReporterExtra,
    video,
    launch,
    ...nodeOptions
  } = options;

  // The Electron app knows its own version (package.json of the packaged app); offer it behind any source
  // the caller supplied, which is asked first.
  if (app?.getVersion !== undefined) {
    nodeOptions.appIdentitySource = chainAppIdentity(nodeOptions.appIdentitySource, () => ({
      version: app.getVersion?.(),
    }));
  }

  // Opt-in pixel video: build the permission-gated controller and forward its report-time snapshot +
  // the `video` binary encoder into the node launch (merged with any the caller passed directly).
  let videoController: PixelVideoController | undefined;
  if (video !== undefined) {
    // The controller needs the client's blackout state, which exists only after the node launch below, so it
    // is built there; until then a report snapshot simply carries no video (it cannot be reported on
    // before the launch returns anyway).
    nodeOptions.reportSnapshots = [
      ...(nodeOptions.reportSnapshots ?? []),
      async (now: number) => (await videoController?.snapshot(now)) ?? [],
    ];
    nodeOptions.fileEncoders = { ...nodeOptions.fileEncoders, video: encodePixelVideo };
  }

  // Native-crash harvesting (Electron/Crashpad): when a crashReporter is provided, wire its crash-dumps
  // directory into the node launch so it persists a crashpad-session marker at START and, on the NEXT
  // launch, harvests + session-stitches a dead run's `.dmp`s. The
  // reporter itself is started (uploadToServer:false) AFTER launch, below.
  // Hoisted so the render-process-gone handler can claim dumps through the SAME seam the next-launch
  // recovery uses — a claim here is what stops recovery re-reporting the crash.
  let nativeCrashSource: ReturnType<typeof createElectronNativeCrashSource> | undefined;
  let nativeDumpDir: string | undefined;
  if (crashReporter !== undefined) {
    const dumpDir = getCrashDumpsDirectory(crashReporter);
    if (dumpDir !== undefined) {
      nativeCrashSource = createElectronNativeCrashSource({ fs: createNodeCrashDumpFs() });
      nativeDumpDir = dumpDir;
      nodeOptions.nativeCrash = { source: nativeCrashSource, dumpDir };
    }
  }

  // GPU for environment.hardware.gpu: the cache is read LIVE by the node environment builder on every
  // assemble (so a GPU that settles after launch lands on the next report); it is only STARTED once this
  // launch is known to be the first (below). Precedence is FIELD-WISE: the cache's fields, overridden by
  // whatever non-empty string fields a caller-supplied `hardwareExtras` gives (so a caller that supplies only
  // `gl_version` keeps the cache's vendor/renderer). A caller gpu that cleans up to nothing, or a caller that
  // throws (reported), leaves the cache's GPU untouched.
  // `hardwareExtras` is a KEPT relaunch option, so a node/umbrella `relaunch()` in an Electron main keeps THIS
  // wrapper (closing over this cache): it keeps serving the cached GPU after a relaunch (stop() does not clear
  // it), but a GPU that had not yet resolved before the relaunch is not re-requested.
  const gpuCache = createGpuInfoCache({
    source: app,
    ...(gpuInfoType !== undefined ? { type: gpuInfoType } : {}),
    ...(nodeOptions.onError !== undefined ? { onError: nodeOptions.onError } : {}),
  });
  const callerExtras = nodeOptions.hardwareExtras;
  const reportExtrasOnce = reportOncePerMessage(nodeOptions.onError);
  nodeOptions.hardwareExtras = () => {
    const cached = gpuCache.current();
    if (callerExtras === undefined) return cached;
    try {
      const own = sanitizeHardwareGpu(callerExtras()?.gpu);
      return own === undefined ? cached : { gpu: { ...cached?.gpu, ...own } };
    } catch (error) {
      reportExtrasOnce(error); // a throwing caller extra is polled on every report: tell the host once
      return cached;
    }
  };

  const { client, internals } = (launch ?? launchCore)(appToken, nodeOptions);

  // `internals` is present only on the FIRST launch (the SDK is a per-process singleton); a repeat launch
  // returns the already-wired client untouched, so all Electron wiring hangs off the first-launch internals.
  if (internals === undefined) {
    return client;
  }

  gpuCache.start();

  // The main client's blackout: the one state the whole session follows (renderers and pixel video).
  const blackout = client.getService(BlackoutToken);

  // Start pixel capture (async permission check; a report before it's active just carries no video). The
  // controller follows the blackout: frames stop, the ring is cleared, and snapshots are empty for the span.
  if (video !== undefined) {
    videoController = createPixelVideoController({
      source: video.source,
      blackout,
      ...(video.hasPermission !== undefined ? { hasPermission: video.hasPermission } : {}),
      ...(nodeOptions.onError !== undefined ? { onError: nodeOptions.onError } : {}),
    });
    void videoController.start();
  }

  // Merge every renderer's streamed capture into the main process's own store (resolved from the client's DI).
  const store = client.getService(CaptureStoreToken);

  // The main-side submit path for renderer incidents. Registering this is what makes the feature
  // LIVE: renderers no longer upload locally, so without a join here every renderer incident is silently
  // destroyed while the app is told it was delivered — strictly worse than the defect
  // it fixes.
  const incidents = new RendererIncidentProvider({
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  client.addDetectionProvider(incidents);

  const receiver = createElectronMainReceiver({
    ipcMain,
    store,
    onReport: (report, windowId) => incidents.submitForwarded(report, windowId),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  receiver.start();

  // A renderer killed before it could forward anything (OOM, native crash). Claims the Crashpad
  // minidump so the LIVE incident carries it; falls back to capture + reason when none arrives.
  if (app !== undefined) {
    const marker =
      nativeCrashSource !== undefined && nativeDumpDir !== undefined
        ? ({
            session: internals.api.sessionId,
            dumpDir: nativeDumpDir,
          } as unknown as CrashpadSessionMarker)
        : undefined;
    const goneHandler = createRendererGoneHandler({
      marker: () => marker,
      // Omitted when there is no crashReporter: no dump dir means nothing to claim, and the handler then
      // reports capture + reason. (A literal empty-source fallback here was dead code — `marker` is
      // undefined in exactly the same case, so it could never be consulted.)
      ...(nativeCrashSource !== undefined ? { source: nativeCrashSource } : {}),
      submit: (incident: RendererGoneIncident) => incidents.submitGone(incident),
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
    });
    app.on('render-process-gone', (_event, contents, details) => {
      void goneHandler.handle(contents?.id ?? -1, details);
    });
  }

  // The DOWNstream control channel: reply to each renderer's `hello` with this session id (the handshake)
  // and propagate pause/resume/flush/stop to every renderer.
  const control = createElectronMainControl({
    ipcMain,
    sessionId: internals.api.sessionId,
    // A renderer that says hello mid-blackout is told in its session reply and starts dark.
    isBlackout: () => blackout.isActive(),
  });
  control.start();
  // Forward the main client's blackout to EVERY renderer. Without this a blackout applied in main only
  // blacked out main's own capture while each renderer kept recording its DOM replay, input and
  // breadcrumbs into the same session.
  const offBlackout = blackout.onChange((active) => {
    if (active) {
      control.blackoutStart();
    } else {
      control.blackoutEnd();
    }
  });

  // Native crashes (all processes): start Electron's crashReporter in harvest mode (uploadToServer:false),
  // session-correlated. The dumps are harvested + bundled on the next launch.
  if (crashReporter !== undefined) {
    installNativeCrashReporter({
      crashReporter,
      appToken,
      sessionId: internals.api.sessionId,
      ...(crashReporterExtra !== undefined ? { extra: crashReporterExtra } : {}),
    });
  }

  // Tie the renderer-facing lifecycle to the client: stopping the client stops the renderers + removes the
  // IPC listeners; flushing the client flushes the renderers too.
  const stop = client.stop.bind(client);
  (client as { stop: Bugsee['stop'] }).stop = ((timeout?: number): ReturnType<Bugsee['stop']> => {
    // Electron cleanup must NEVER block the real shutdown: guard it so `stop(timeout)` always runs.
    try {
      gpuCache.stop(); // a late getGPUInfo resolve must not write after stop (an already-resolved GPU is kept)
      offBlackout();
      control.stop(); // broadcast stop to renderers + remove the hello listener
      receiver.stop();
      videoController?.stop(); // stop pixel capture
    } catch (error) {
      reportGuarded(nodeOptions.onError, error);
    }
    return stop(timeout);
  }) as Bugsee['stop'];

  const flush = client.flush.bind(client);
  (client as { flush: Bugsee['flush'] }).flush = ((
    timeout?: number,
  ): ReturnType<Bugsee['flush']> => {
    control.flush(); // ask renderers to flush too
    return flush(timeout);
  }) as Bugsee['flush'];

  return client;
}
