// The main-process control manager (E6) — the DOWNstream half of the bridge (main→renderers). Renderers
// stream capture UP (main-receiver.ts); this drives them DOWN. On a renderer `hello` it registers the sender
// and replies with the owner's `session` id (the handshake), then broadcasts pause/resume/flush/stop control
// to every registered renderer (reusing the WebView control kinds). Sends are best-effort: a destroyed
// webContents throws, so each send is guarded and never breaks the broadcast to the others. `electron` is
// taken as plain args (no dependency; fully testable).
import { BUGSEE_CONTROL_CHANNEL, BUGSEE_HELLO_CHANNEL } from './preload-bridge';
import { encodeControl, isHello } from './protocol';

/** An Electron webContents sender — we send control DOWN and read its id. */
export interface ControlSenderLike {
  id?: number;
  send?(channel: string, raw: string): void;
}
/** An Electron `ipcMain` event carrying the originating renderer's sender. */
export interface IpcMainControlEventLike {
  sender?: ControlSenderLike;
}
export type IpcMainControlListener = (event: IpcMainControlEventLike, ...args: unknown[]) => void;
/** The subset of Electron's `ipcMain` the control manager uses. */
export interface IpcMainControlLike {
  on(channel: string, listener: IpcMainControlListener): void;
  removeListener(channel: string, listener: IpcMainControlListener): void;
}

export interface ElectronMainControlOptions {
  ipcMain: IpcMainControlLike;
  /** The owner's session id — sent to each renderer on its `hello` handshake. */
  sessionId: string;
  /** The renderer→main handshake channel (default {@link BUGSEE_HELLO_CHANNEL}). */
  helloChannel?: string;
  /** The main→renderer control channel (default {@link BUGSEE_CONTROL_CHANNEL}). */
  controlChannel?: string;
}

export interface ElectronMainControl {
  start(): void;
  /** Broadcast `stop` to every renderer and remove the hello listener. */
  stop(): void;
  pause(): void;
  resume(): void;
  flush(): void;
  /** The number of currently-registered renderers (window count). */
  readonly rendererCount: number;
}

/** Build the main-process control manager: handshake replies + pause/resume/flush/stop broadcasts. */
export function createElectronMainControl(
  options: ElectronMainControlOptions,
): ElectronMainControl {
  const helloChannel = options.helloChannel ?? BUGSEE_HELLO_CHANNEL;
  const controlChannel = options.controlChannel ?? BUGSEE_CONTROL_CHANNEL;
  // Registered renderers, deduped by sender identity (a reload reuses the same webContents object).
  const renderers = new Set<ControlSenderLike>();

  const sendTo = (sender: ControlSenderLike, raw: string): void => {
    try {
      sender.send?.(controlChannel, raw);
    } catch {
      // A destroyed webContents throws — ignore and keep broadcasting to the rest.
    }
  };

  const broadcast = (command: 'pause' | 'resume' | 'flush' | 'stop'): void => {
    const raw = encodeControl({ command });
    for (const sender of renderers) {
      sendTo(sender, raw);
    }
  };

  const onHello = (event: IpcMainControlEventLike, ...args: unknown[]): void => {
    const raw = args[0];
    if (typeof raw !== 'string' || !isHello(raw)) {
      return;
    }
    const sender = event.sender;
    if (sender === undefined) {
      return;
    }
    renderers.add(sender); // dedupes a reload's repeat hello
    // Reply with the owner's session id — always, so a reloaded renderer re-learns the session.
    sendTo(sender, encodeControl({ command: 'session', sessionId: options.sessionId }));
  };

  return {
    start(): void {
      options.ipcMain.on(helloChannel, onHello);
    },
    stop(): void {
      broadcast('stop');
      options.ipcMain.removeListener(helloChannel, onHello);
    },
    pause(): void {
      broadcast('pause');
    },
    resume(): void {
      broadcast('resume');
    },
    flush(): void {
      broadcast('flush');
    },
    get rendererCount(): number {
      return renderers.size;
    },
  };
}
