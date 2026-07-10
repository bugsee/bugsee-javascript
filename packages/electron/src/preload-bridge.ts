// The preload bridge (E2). Under Electron's contextIsolation, a renderer's page world can't `require`
// electron, so the renderer→main sink is exposed from the PRELOAD context via contextBridge: it publishes
// `window.__bugseeElectron.post(raw)` which forwards to the main process over IPC. The app calls
// `registerBugseePreload(require('electron'))` in its preload — we take `contextBridge`+`ipcRenderer` as
// plain args so @bugsee/electron needs no `electron` dependency and this stays fully unit-testable.

/** The `window` global key the renderer's `resolveRendererPost` reads (must match launch-renderer.ts). */
export const BUGSEE_BRIDGE_KEY = '__bugseeElectron';
/** The IPC channel renderer→main capture is streamed on (must match the main receiver, E3). */
export const BUGSEE_STREAM_CHANNEL = 'bugsee:stream';
/** The IPC channel renderer→main handshake (`hello`) is sent on (must match the main control manager, E6). */
export const BUGSEE_HELLO_CHANNEL = 'bugsee:hello';
/** The IPC channel main→renderer control (pause/resume/flush/stop/session) is sent on (must match E6). */
export const BUGSEE_CONTROL_CHANNEL = 'bugsee:control';

/** The subset of Electron's `contextBridge` we use. */
export interface ContextBridgeLike {
  exposeInMainWorld(apiKey: string, api: unknown): void;
}
/** The subset of Electron's `ipcRenderer` we use. */
export interface IpcRendererLike {
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

/** The API exposed into the renderer's main world as `window.__bugseeElectron`. */
export interface BugseeElectronBridge {
  /** Stream one encoded capture entry UP to the main process. */
  post(raw: string): void;
  /** Send the handshake request UP to the main process (prompts the `session` reply). */
  sendHello(raw: string): void;
  /** Subscribe to main→renderer control messages (pause/resume/flush/stop/session). */
  onControl(handler: (raw: string) => void): void;
}

export interface RegisterBugseePreloadOptions {
  contextBridge: ContextBridgeLike;
  ipcRenderer: IpcRendererLike;
  /** Stream channel override (default {@link BUGSEE_STREAM_CHANNEL}). */
  channel?: string;
  /** Hello (handshake) channel override (default {@link BUGSEE_HELLO_CHANNEL}). */
  helloChannel?: string;
  /** Control channel override (default {@link BUGSEE_CONTROL_CHANNEL}). */
  controlChannel?: string;
  /** Exposed global key override (default {@link BUGSEE_BRIDGE_KEY}). */
  key?: string;
}

/**
 * Expose the Bugsee renderer↔main bridge into the page's main world. Call from an Electron preload:
 *   const { registerBugseePreload } = require('@bugsee/electron/preload');
 *   registerBugseePreload(require('electron'));
 */
export function registerBugseePreload(options: RegisterBugseePreloadOptions): void {
  const { contextBridge, ipcRenderer } = options;
  const channel = options.channel ?? BUGSEE_STREAM_CHANNEL;
  const helloChannel = options.helloChannel ?? BUGSEE_HELLO_CHANNEL;
  const controlChannel = options.controlChannel ?? BUGSEE_CONTROL_CHANNEL;
  const key = options.key ?? BUGSEE_BRIDGE_KEY;
  const bridge: BugseeElectronBridge = {
    post(raw: string): void {
      ipcRenderer.send(channel, raw);
    },
    sendHello(raw: string): void {
      ipcRenderer.send(helloChannel, raw);
    },
    onControl(handler: (raw: string) => void): void {
      ipcRenderer.on(controlChannel, (_event: unknown, ...args: unknown[]): void => {
        const raw = args[0];
        if (typeof raw === 'string') {
          handler(raw);
        }
      });
    },
  };
  contextBridge.exposeInMainWorld(key, bridge);
}
