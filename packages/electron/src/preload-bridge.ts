// The preload bridge (E2). Under Electron's contextIsolation, a renderer's page world can't `require`
// electron, so the renderer→main sink is exposed from the PRELOAD context via contextBridge: it publishes
// `window.__bugseeElectron.post(raw)` which forwards to the main process over IPC. The app calls
// `registerBugseePreload(require('electron'))` in its preload — we take `contextBridge`+`ipcRenderer` as
// plain args so @bugsee/electron needs no `electron` dependency and this stays fully unit-testable.

/** The `window` global key the renderer's `resolveRendererPost` reads (must match launch-renderer.ts). */
export const BUGSEE_BRIDGE_KEY = '__bugseeElectron';
/** The IPC channel renderer→main capture is streamed on (must match the main receiver, E3). */
export const BUGSEE_STREAM_CHANNEL = 'bugsee:stream';

/** The subset of Electron's `contextBridge` we use. */
export interface ContextBridgeLike {
  exposeInMainWorld(apiKey: string, api: unknown): void;
}
/** The subset of Electron's `ipcRenderer` we use. */
export interface IpcRendererLike {
  send(channel: string, ...args: unknown[]): void;
}

export interface RegisterBugseePreloadOptions {
  contextBridge: ContextBridgeLike;
  ipcRenderer: IpcRendererLike;
  /** IPC channel override (default {@link BUGSEE_STREAM_CHANNEL}). */
  channel?: string;
  /** Exposed global key override (default {@link BUGSEE_BRIDGE_KEY}). */
  key?: string;
}

/**
 * Expose the Bugsee renderer→main sink into the page's main world. Call from an Electron preload:
 *   const { registerBugseePreload } = require('@bugsee/electron/preload');
 *   registerBugseePreload(require('electron'));
 */
export function registerBugseePreload(options: RegisterBugseePreloadOptions): void {
  const { contextBridge, ipcRenderer } = options;
  const channel = options.channel ?? BUGSEE_STREAM_CHANNEL;
  const key = options.key ?? BUGSEE_BRIDGE_KEY;
  contextBridge.exposeInMainWorld(key, {
    post(raw: string): void {
      ipcRenderer.send(channel, raw);
    },
  });
}
