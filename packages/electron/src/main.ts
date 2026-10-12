// @bugsee/electron/main — the main-process entry. Imports @bugsee/node (never @bugsee/browser), so it's safe
// in the Node main process.
// API parity with the umbrella entries: the same VALUE surface as `@bugsee/bugsee/node`, thin
// re-exports of the same functions. `relaunch` is deliberately NOT offered: `launchMain` needs the app's
// `ipcMain` (and `app` / `crashReporter`), which are not retained launch seams, and every launch registers a
// receiver + control channel on it; a relaunch would stack a second set of handlers on the same `ipcMain`.
// Restart by stopping the client and calling `launchMain` again with the same objects when needed.
export {
  addReportAttachment,
  BugseeStatus,
  getDefaultNetworkSanitizer,
  getStatus,
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
  type ReportAttachmentInput,
} from '@bugsee/node';
export {
  type CrashReporterLike,
  type CrashReporterStartOptions,
  getCrashDumpsDirectory,
  type InstallNativeCrashReporterOptions,
  installNativeCrashReporter,
} from './crash-reporter';
export { type LaunchMainOptions, launchMain, type VideoLaunchOptions } from './launch-main';
export {
  type ControlSenderLike,
  createElectronMainControl,
  type ElectronMainControl,
  type ElectronMainControlOptions,
  type IpcMainControlEventLike,
  type IpcMainControlLike,
  type IpcMainControlListener,
} from './main-control';
export {
  createElectronMainReceiver,
  type ElectronMainReceiver,
  type ElectronMainReceiverOptions,
  type IpcMainEventLike,
  type IpcMainLike,
  type IpcMainListener,
} from './main-receiver';
export {
  type CrashDumpFs,
  createElectronNativeCrashSource,
  createNodeCrashDumpFs,
  type ElectronNativeCrashSource,
  type ElectronNativeCrashSourceOptions,
} from './native-crash-source';
export {
  createPixelVideoController,
  encodePixelVideo,
  type PixelVideoController,
  type PixelVideoControllerOptions,
} from './pixel-video-controller';
export {
  type CapturePageVideoSourceOptions,
  createCapturePageVideoSource,
  createMediaRecorderVideoSource,
  type MediaRecorderLike,
  type MediaRecorderVideoSourceOptions,
  type VideoCaptureSource,
  type VideoFrame,
} from './video-capture';
