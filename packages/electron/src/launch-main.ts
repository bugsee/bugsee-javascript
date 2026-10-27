// launchMain — the Electron main-process entry (the session OWNER). Runs @bugsee/node's full launch (ring +
// bundler + upload pipeline + durable queue + the main's own node capture) and wires the ElectronMainReceiver
// to node's capture store, so every renderer's streamed capture merges into ONE session / one bundle. `electron`
// is taken as an arg (the app passes `require('electron').ipcMain`) so @bugsee/electron has no electron dep.
//
//   import { launchMain } from '@bugsee/electron/main';
//   import { ipcMain } from 'electron';
//   launchMain(appToken, { ipcMain });
import { CaptureStateProducer } from '@bugsee/capture';
import {
  type AppIdentity,
  BlackoutToken,
  CaptureStoreToken,
  createDiskPressure,
  getCarrierClient,
  resolveFailClosedBoolean,
} from '@bugsee/core';
import {
  type Bugsee,
  type BugseeLaunchOptions,
  createNodeSystemTraceProducers,
  launchCore,
  sanitizeHardwareGpu,
  V8_HEAP_PRODUCER_NAME,
} from '@bugsee/node';
import {
  type BrowserWindowSource,
  electronApplicationTrackerFor,
  electronDisplayTrackerFor,
  electronPowerTrackerFor,
  electronProcessTrackerFor,
  type GpuInfoType,
  type PowerMonitorSource,
  type ScreenSource,
} from '@bugsee/trackers/electron';
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
   * `child-process-gone` (a GPU/utility process died) is watched ONLY while system events are captured, through the
   * shared ElectronProcessTracker. When `removeListener`/`off` is missing the listener is never attached (it could not
   * be released on `client.stop()`).
   */
  on(event: 'child-process-gone', listener: (event: unknown, details: unknown) => void): unknown;
  /**
   * `browser-window-created` / `web-contents-created` are watched ONLY while system events are captured, through the
   * shared ElectronApplicationTracker (window focus/blur/show/hide and renderer hangs); same release rule as above.
   */
  on(
    event: 'browser-window-created' | 'web-contents-created',
    listener: (event: unknown, created: unknown) => void,
  ): unknown;
  /** Releases the `render-process-gone` handler on `client.stop()`. Optional: when absent the handler cannot be released (guarded, never throws). */
  removeListener?(
    event: 'render-process-gone',
    listener: (
      event: unknown,
      contents: { id?: number },
      details: { reason: string; exitCode?: number },
    ) => void,
  ): unknown;
  removeListener?(
    event: 'child-process-gone' | 'browser-window-created' | 'web-contents-created',
    listener: (event: unknown, details: unknown) => void,
  ): unknown;
  off?(
    event: 'render-process-gone',
    listener: (
      event: unknown,
      contents: { id?: number },
      details: { reason: string; exitCode?: number },
    ) => void,
  ): unknown;
  off?(
    event: 'child-process-gone' | 'browser-window-created' | 'web-contents-created',
    listener: (event: unknown, details: unknown) => void,
  ): unknown;
  /**
   * Electron's `app.getAppMetrics` — optional. When present and system traces are captured, per-process CPU/memory is
   * reported as the `app_metrics` trace (polled by the ElectronProcessTracker; absent fields are omitted, never zero).
   */
  getAppMetrics?(): unknown;
  /**
   * Electron's `app.getGPUInfo` — optional. When present, `getGPUInfo('basic')` is kicked once at launch and
   * the active device's strings (when Electron supplies them) are reported as `environment.hardware.gpu` on
   * every report assembled after it settles. A rejection, or an app without it, just omits the field.
   */
  getGPUInfo?(type: 'basic' | 'complete'): Promise<unknown>;
}

import type { CrashpadSessionMarker } from '@bugsee/core';
import { TraceName } from '@bugsee/protocol';
import { reportGuarded, reportOncePerMessage } from '@bugsee/util';
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
import { createElectronSystemEventsSource } from './system-events';
import { createElectronSystemTraceProducers } from './system-traces';
import { ELECTRON_MAIN_HEAP_TRACES } from './trace-tables';
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
   * VERIFIED on Electron 44.9.3 (macOS arm64): `'basic'` yields no vendor/renderer strings, so `hardware.gpu` is
   * absent (never guessed); `'complete'` yields `vendorString`/`deviceString`/`glVersion` and a ~3 KB
   * `glExtensions` string (under the 8192 cap). Pass `'complete'` for the GL strings (the default stays `'basic'`;
   * that choice is an open owner decision, docs/PROGRESS.md). A usable result is kept for the life of the `app` object; a later launch (after
   * `client.stop()`) asks again when the earlier read rejected or returned nothing usable, or when it asks for a
   * different type (a failed re-ask keeps the earlier usable value).
   */
  gpuInfoType?: GpuInfoType;
  /**
   * Electron's `powerMonitor` — optional. When present and system events are captured, `power_suspend`/`power_resume`/
   * `power_lock`/`power_unlock`/`power_ac`/`power_battery` are recorded on `events.system`, and (system traces on)
   * `thermal_state` (macOS) and `cpu_speed_limit` (macOS, Windows) are traced. Absent: that domain is off.
   */
  powerMonitor?: PowerMonitorSource;
  /**
   * Electron's `screen` — optional. When present, `display_added`/`display_removed`/`display_metrics_changed` are recorded
   * on `events.system` (system events on) and the `displays` list is traced (system traces on). Absent: off.
   * Pass it only after `app` is ready (Electron throws if `screen` is touched earlier).
   */
  screen?: ScreenSource;
  /**
   * Electron's `BrowserWindow` class — optional. With `app`, windows that exist when system events start are tracked
   * for `window_*`/`renderer_*` events too (windows created later are always tracked through `app`).
   */
  BrowserWindow?: BrowserWindowSource;
  /**
   * Record `window_*` / `renderer_*` events (default `true`). They are ON whenever `app` is passed (and system events are
   * captured), which adds two `app` listeners for windows (`browser-window-created` for focus and for show/hide) and one `web-contents-created`;
   * pass `false` to opt out of the EVENTS (any non-boolean value is OFF and reported). It does NOT opt out of key-window tracking: when `screen` is
   * passed, the `displays` trace needs the focused/moved window, so the application tracker still arms its `windowFocus` and `windowMoved`
   * stages, i.e. two `browser-window-created` listeners and focus/blur/moved/closed listeners on every window even with this option `false`
   * (with window events on AND `screen` passed, `app` carries three `browser-window-created` listeners).
   */
  captureWindowEvents?: boolean;
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
    powerMonitor,
    screen,
    BrowserWindow,
    captureWindowEvents,
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

  // The Electron PROCESS tracker (`@bugsee/trackers/electron`): the one per-`app` singleton that owns everything the
  // `app` object can say about the app's processes, and so feeds ALL of the following (this file is composition):
  //  - the `app_metrics` trace (a producer subscribed to its `appMetrics` stage);
  //  - the `child_process_gone` system event (the lazy mux subscribes to its `childProcessGone` stage);
  //  - `environment.hardware.gpu` (its once-only `getGPUInfo` read, below).
  // Without an `app` there is nothing to read, so there is no tracker and none of it is wired. The SAME is true of a
  // REPEAT call: `launchCore` returns the running client untouched, but building the tracker (or the node producers)
  // first would rebind the shared trackers' onError/scheduler and tear down the live launch's timer and listener. So a
  // repeat is detected up front (the carrier already holds a client, exactly `launchCore`'s own test) and touches
  // nothing.
  const repeat = getCarrierClient(nodeOptions.carrier) !== undefined;
  const tracker =
    app !== undefined && !repeat
      ? electronProcessTrackerFor(
          {
            app,
            ...(nodeOptions.scheduler !== undefined ? { scheduler: nodeOptions.scheduler } : {}),
          },
          nodeOptions.onError,
        )
      : undefined;
  // The DOMAIN trackers (power / display / application windows) follow the same rule: built THROUGH their registry
  // accessors, once per injected object, never on a repeat call, and absent when their Electron object was not injected.
  const power =
    powerMonitor !== undefined && !repeat
      ? electronPowerTrackerFor({ powerMonitor }, nodeOptions.onError)
      : undefined;
  // Default ON; fail closed like the other capture switches: anything but a boolean is OFF, and reported.
  const windowEvents = resolveFailClosedBoolean(captureWindowEvents, true);
  if (captureWindowEvents !== undefined && typeof captureWindowEvents !== 'boolean') {
    reportGuarded(
      nodeOptions.onError,
      new TypeError('captureWindowEvents must be a boolean: window events are OFF'),
    );
  }
  // ONE shared application tracker serves two jobs: the `window_*`/`renderer_*` EVENTS (gated by `captureWindowEvents`) and
  // the KEY window (focused, else most recently focused, else first created) that decides which display is `displays` id 0
  // and re-reads the list on focus/move. The key-window job needs the tracker whenever `screen` is injected, independent
  // of `captureWindowEvents` (which only governs the events below).
  const appTracker =
    app !== undefined && !repeat && (windowEvents || screen !== undefined)
      ? electronApplicationTrackerFor(
          { app, ...(BrowserWindow !== undefined ? { BrowserWindow } : {}) },
          nodeOptions.onError,
        )
      : undefined;
  const application = windowEvents ? appTracker : undefined;
  const display =
    screen !== undefined && !repeat
      ? electronDisplayTrackerFor(
          {
            screen,
            ...(appTracker !== undefined
              ? { keyWindowBounds: () => appTracker.keyWindowBounds() }
              : {}),
          },
          nodeOptions.onError,
        )
      : undefined;
  const hasElectronTrackers = [tracker, power, display, application].some((t) => t !== undefined);

  // The `capture` trace (C7): main writes it, and only while it HAS visual capture (opt-in pixel video: a renderer's
  // rrweb replay is the renderer's own and streams up, but the trace names the session's state, which main owns).
  // `active`/`blackout` are written once the controller is really running (below); the disk states follow the SAME
  // DiskPressure the node launch feeds from `statfs` of the data dir (its disk-protection feed; the STATES are the `captureDiskSpace` telemetry, so the pressure is shared only then). They describe main's own on-disk store (renderer replay/log/network); the pixel video is never persisted, so "video stops reaching disk" does not apply to it. Not on a repeat call
  // (it would never be started); under the legacy sampler (which replaces the producer list) it is simply never added.
  const diskPressure =
    nodeOptions.captureDiskSpace === true && nodeOptions.diskProtection !== false && !repeat
      ? createDiskPressure({
          ...(nodeOptions.onError !== undefined ? { onError: nodeOptions.onError } : {}),
        })
      : undefined;
  if (diskPressure !== undefined) {
    nodeOptions.diskPressure = diskPressure;
  }
  const captureState = video !== undefined && !repeat ? new CaptureStateProducer() : undefined;
  if (captureState !== undefined && diskPressure !== undefined) {
    captureState.bindPressure(diskPressure);
  }

  // The trace names main will actually WRITE, which the handshake tells every renderer not to write (one writer per name per
  // session): `displays` with a screen, `capture` with pixel video, and its own V8 heap unless the caller replaces the node
  // producer set. Nothing at all when the legacy sampler replaces the producers or system traces are off.
  // main writes its heap when the node set is in use (the default) or the caller's own set contains the `v8-heap` producer
  // (the pattern `createNodeSystemTraceProducers()` recommends); a set without it never writes `ram_js_heap_*`
  const writesHeap =
    nodeOptions.systemTraceProducers === undefined ||
    nodeOptions.systemTraceProducers.some((p) => p.name === V8_HEAP_PRODUCER_NAME);
  const writesTraces =
    nodeOptions.systemMetricsSampler === undefined &&
    resolveFailClosedBoolean(nodeOptions.captureSystemTraces, true);

  // Trace producers: `systemTraceProducers` REPLACES the node defaults when supplied, so pass the node set (the caller's,
  // else the default one wired to this launch's scheduler/onError) PLUS the Electron producers. The node producers keep
  // `process_memory_*`/`cpu_*`/`event_loop_*` for the process that owns the session; the Electron ones only add names the
  // node set never emits (`app_metrics`, `displays`, `thermal_state`, `cpu_speed_limit`). Not built when the legacy `systemMetricsSampler` replaces
  // the producer list (they would never start).
  if (
    (tracker !== undefined ||
      display !== undefined ||
      power !== undefined ||
      captureState !== undefined) &&
    nodeOptions.systemMetricsSampler === undefined
  ) {
    nodeOptions.systemTraceProducers = [
      ...(nodeOptions.systemTraceProducers ??
        createNodeSystemTraceProducers({
          ...(nodeOptions.scheduler !== undefined ? { scheduler: nodeOptions.scheduler } : {}),
          ...(nodeOptions.onError !== undefined ? { onError: nodeOptions.onError } : {}),
        })),
      ...createElectronSystemTraceProducers({
        ...(tracker !== undefined ? { process: tracker } : {}),
        ...(display !== undefined ? { display } : {}),
        ...(power !== undefined ? { power } : {}),
        ...(screen !== undefined && appTracker !== undefined ? { application: appTracker } : {}),
        ...(nodeOptions.scheduler !== undefined ? { scheduler: nodeOptions.scheduler } : {}),
      }),
      ...(captureState !== undefined ? [captureState] : []),
    ];
  }

  // System events: ONE `events.system` provider exists, so the node events source is wrapped by a LAZY mux that adds
  // `child_process_gone`, `power_*`, `display_*`, `window_*` and `renderer_(un)responsive`. The mux attaches (inner node
  // handlers + every Electron listener) only when the provider subscribes, i.e. only while `captureSystemEvents` is on,
  // and releases all of them on `client.stop()`. A caller-supplied wrapper is applied first (it sees the plain node
  // source), ours wraps its result.
  if (hasElectronTrackers) {
    const callerWrap = nodeOptions.wrapSystemEventsSource;
    nodeOptions.wrapSystemEventsSource = (inner) =>
      createElectronSystemEventsSource(
        callerWrap === undefined ? inner : callerWrap(inner),
        {
          ...(tracker !== undefined ? { process: tracker } : {}),
          ...(power !== undefined ? { power } : {}),
          ...(display !== undefined ? { display } : {}),
          ...(application !== undefined ? { application } : {}),
        },
        nodeOptions.onError,
      );
  }

  // GPU for environment.hardware.gpu: the tracker's settled GPU is read LIVE by the node environment builder on every
  // assemble (so a GPU that settles after launch lands on the next report); the read is only REQUESTED once this
  // launch is known to be the first (below). Precedence is FIELD-WISE: the tracker's fields, overridden by
  // whatever non-empty string fields a caller-supplied `hardwareExtras` gives (so a caller that supplies only
  // `gl_version` keeps the tracker's vendor/renderer). A caller gpu that cleans up to nothing, or a caller that
  // throws (reported), leaves the tracker's GPU untouched.
  // RELAUNCH: `@bugsee/node`/the umbrella do export `relaunch()`, and it is not Electron-aware. `hardwareExtras` is a KEPT
  // relaunch option, so a relaunch keeps THIS wrapper (closing over the tracker) and `hardware.gpu` keeps being served
  // (stop() does not clear it; a GPU that had not yet resolved is not re-requested). `systemTraceProducers` and
  // `wrapSystemEventsSource` are RESET options, so a relaunched client has the plain node producers and events source:
  // every Electron trace and event (`app_metrics`, `displays`, `child_process_gone`, `power_*`, `display_*`,
  // `window_*`, `renderer_*`) stops until `launchMain` is called again (the carrier client must be cleared by a stop for
  // that, as for any launch).
  const callerExtras = nodeOptions.hardwareExtras;
  const reportExtrasOnce = reportOncePerMessage(nodeOptions.onError);
  nodeOptions.hardwareExtras = () => {
    const gpu = tracker?.current('gpu');
    const cached = gpu === undefined ? undefined : { gpu };
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
  // returns the already-wired client untouched (nothing above bound the shared trackers for it, see `repeat`), so all
  // Electron wiring hangs off the first-launch internals.
  if (internals === undefined) {
    return client;
  }

  tracker?.requestGpuInfo(gpuInfoType);

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
    const controller = videoController;
    captureState?.bindBlackout(blackout);
    void controller.start().then(() => {
      captureState?.setVisualCapture(controller.isActive());
    });
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

  let releaseGone: (() => void) | undefined;
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
    const onGone = (
      _event: unknown,
      contents: { id?: number },
      details: { reason: string; exitCode?: number },
    ): void => {
      // The process is dead but its webContents object is not destroyed: stop addressing it (a reload's new
      // frame says hello again and rejoins). Without this the main process kept sending into a disposed frame.
      if (contents?.id !== undefined) {
        control.rendererGone(contents.id);
      }
      void goneHandler.handle(contents?.id ?? -1, details);
    };
    app.on('render-process-gone', onGone);
    // Released in the wrapped stop (idempotent). Verified on real Electron 44.9.3: without this the app's
    // listener count stayed raised after `client.stop()` and stacked on every relaunch.
    releaseGone = (): void => {
      releaseGone = undefined;
      const remover = (app.removeListener ?? app.off) as
        | ((event: 'render-process-gone', listener: typeof onGone) => unknown)
        | undefined;
      remover?.call(app, 'render-process-gone', onGone);
    };
  }

  // The DOWNstream control channel: reply to each renderer's `hello` with this session id (the handshake)
  // and propagate pause/resume/flush/stop to every renderer.
  const control = createElectronMainControl({
    ipcMain,
    sessionId: internals.api.sessionId,
    // A renderer that says hello mid-blackout is told in its session reply and starts dark.
    isBlackout: () => blackout.isActive(),
    // What main actually writes (see `writesTraces`): every renderer is told in its handshake reply and must not write it.
    hostOwnedTraces: !writesTraces
      ? []
      : [
          ...(display !== undefined ? [TraceName.DISPLAYS] : []),
          ...(captureState !== undefined ? [TraceName.CAPTURE] : []),
          ...(writesHeap ? ELECTRON_MAIN_HEAP_TRACES : []),
        ],
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
      // The render-process-gone listener must not outlive the client. Its own guard: a hostile `app` whose remover
      // throws must not skip the rest of the cleanup below.
      releaseGone?.();
    } catch (error) {
      reportGuarded(nodeOptions.onError, error);
    }
    try {
      tracker?.cancelGpuInfo(); // a late getGPUInfo resolve must not write after stop (an already-resolved GPU is kept)
      offBlackout();
      control.stop(); // broadcast stop to renderers + remove the hello listener
      receiver.stop();
      videoController?.stop(); // stop pixel capture
      captureState?.setVisualCapture(false);
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
