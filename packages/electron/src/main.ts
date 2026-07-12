// @bugsee/electron/main — the main-process entry. Imports @bugsee/node (never @bugsee/browser), so it's safe
// in the Node main process. See docs/design/electron.md.
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
