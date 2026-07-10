// @bugsee/electron/renderer — the renderer-process entry. Imports @bugsee/browser only (never @bugsee/node),
// so it's safe to load in a Chromium renderer. See docs/design/electron.md.

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
