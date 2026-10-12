// @bugsee/electron/renderer — the renderer-process entry. Imports @bugsee/browser only (never @bugsee/node),
// so it's safe to load in a Chromium renderer.

// API parity with the umbrella entries: the same VALUE surface as `@bugsee/bugsee`, thin
// re-exports of the same functions. No `relaunch`: a renderer's session is OWNED by the main process (the
// handshake, control channel and capture stream belong to it), so re-running `launchRenderer` alone is not a
// restart of the session; reload the renderer instead.
export {
  addReportAttachment,
  BugseeStatus,
  getDefaultNetworkSanitizer,
  getStatus,
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
  type ReportAttachmentInput,
} from '@bugsee/browser';
export {
  type LaunchRendererOptions,
  launchRenderer,
  resolveRendererBridge,
  resolveRendererPost,
} from './launch-renderer';
export {
  createElectronRendererCaptureStore,
  type ElectronRendererCaptureStoreOptions,
} from './renderer-capture-store';
export {
  createRendererControlHandler,
  type RendererControlHandlerOptions,
} from './renderer-control';
export {
  createMediaRecorderVideoSource,
  type MediaRecorderLike,
  type MediaRecorderVideoSourceOptions,
  type VideoCaptureSource,
  type VideoFrame,
} from './video-capture';
