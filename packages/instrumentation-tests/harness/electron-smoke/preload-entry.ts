// The single-file sandboxed preload an app is told to build (README: bundle `@bugsee/electron/preload`).
// A sandboxed preload can `require` only Electron's built-ins, so the runner bundles this to ONE file.
import { registerBugseePreload } from '../../../electron/src/preload';

// biome-ignore lint/suspicious/noExplicitAny: the Electron module is injected by the runtime, untyped here.
declare const require: (id: string) => any;
const electron = require('electron');
registerBugseePreload(electron);
// Probe what the sandbox really provides (Electron 45 removed the Node polyfills from sandboxed preloads).
electron.contextBridge.exposeInMainWorld('__probe', {
  sandboxed: (process as unknown as { sandboxed?: boolean }).sandboxed,
  hasBuffer: typeof Buffer,
  hasSetImmediate: typeof setImmediate,
});
