// @bugsee/electron/preload — wire the Bugsee renderer→main bridge from your Electron preload script:
//
//   const { registerBugseePreload } = require('@bugsee/electron/preload');
//   registerBugseePreload(require('electron'));   // { contextBridge, ipcRenderer }
//
// Takes electron as an argument (rather than importing it) so @bugsee/electron has no electron dependency.
export {
  BUGSEE_BRIDGE_KEY,
  BUGSEE_STREAM_CHANNEL,
  type ContextBridgeLike,
  type IpcRendererLike,
  type RegisterBugseePreloadOptions,
  registerBugseePreload,
} from './preload-bridge';
