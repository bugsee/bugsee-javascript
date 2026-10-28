// The main-process control manager — the DOWNstream half of the bridge (main→renderers). Renderers
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
  /**
   * Electron `webContents` lifecycle, used to unregister a renderer that is gone. Both optional:
   * the object is host-supplied, and a test double, an older Electron or a proxy may expose neither — such
   * a sender is still registered and still broadcast to, just never pruned early.
   */
  once?(event: string, listener: () => void): void;
  /** Releases the `destroyed` subscription on `stop()` (optional; `off` is the fallback). Absent: the one-shot listener stays until the webContents dies. */
  removeListener?(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
  isDestroyed?(): boolean;
  /**
   * True after the renderer process died (OOM, native crash) while the webContents object is still alive:
   * `isDestroyed()` stays false, but `send` prints 'Render frame was disposed' to stderr. Optional; absent or
   * throwing is read as "not crashed".
   */
  isCrashed?(): boolean;
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
  /**
   * Whether the owner's blackout is currently in force. Sent with every `session` reply so a renderer that
   * launches (or reloads) mid-blackout starts dark. A throwing probe fails CLOSED (reported as active).
   * Without a probe every reply says `bo:false` (nothing to report), so a renderer never waits on it.
   */
  isBlackout?: () => boolean;
  /**
   * The trace names this main process writes itself (so a renderer must not): sent with every `session` reply. Without it
   * the reply declares nothing and a renderer keeps its built-in default (an older main behaves the same).
   */
  hostOwnedTraces?: readonly string[];
}

export interface ElectronMainControl {
  start(): void;
  /** Broadcast `stop` to every renderer and remove the hello listener. */
  stop(): void;
  pause(): void;
  resume(): void;
  flush(): void;
  /** Tell every renderer the owner's blackout began (renderers suspend visual capture). */
  blackoutStart(): void;
  /** Tell every renderer the owner's blackout ended. */
  blackoutEnd(): void;
  /**
   * A renderer process died (`render-process-gone`): forget the webContents with this id. If it reloads, its new
   * frame's `hello` re-registers it and re-sends the session reply, so a crashed-then-reloaded window rejoins.
   * Unknown ids are ignored.
   */
  rendererGone(id: number): void;
  /** The number of currently-registered renderers (window count). */
  readonly rendererCount: number;
}

/** Build the main-process control manager: handshake replies + pause/resume/flush/stop broadcasts. */
export function createElectronMainControl(
  options: ElectronMainControlOptions,
): ElectronMainControl {
  const helloChannel = options.helloChannel ?? BUGSEE_HELLO_CHANNEL;
  const controlChannel = options.controlChannel ?? BUGSEE_CONTROL_CHANNEL;
  // The declaration is fixed when the control is built: a later change to the caller's array is not a protocol change.
  const declaredOwned =
    options.hostOwnedTraces === undefined ? undefined : [...options.hostOwnedTraces];
  // Registered renderers, deduped by sender identity (a reload reuses the same webContents object).
  const renderers = new Set<ControlSenderLike>();

  // The `destroyed` subscription we hold per webContents: a forget-then-rejoin (crash + reload) must not stack a
  // second listener on the same object, and `stop()` releases every one so a stopped control leaves nothing on it.
  const subscribed = new Map<ControlSenderLike, () => void>();

  const isCrashed = (sender: ControlSenderLike): boolean => {
    try {
      return sender.isCrashed?.() === true;
    } catch {
      return false;
    }
  };

  const sendTo = (sender: ControlSenderLike, raw: string): void => {
    try {
      sender.send?.(controlChannel, raw);
    } catch {
      // A destroyed webContents throws — ignore and keep broadcasting to the rest.
    }
  };

  /** Drop a renderer that is gone. Idempotent — `destroyed` and a later `isDestroyed()` both land here. */
  const forget = (sender: ControlSenderLike): void => {
    renderers.delete(sender);
  };

  const broadcast = (
    command: 'pause' | 'resume' | 'flush' | 'stop' | 'blackout-start' | 'blackout-end',
  ): void => {
    const raw = encodeControl({ command });
    for (const sender of [...renderers]) {
      // Prune on the way past. `destroyed` is the primary signal, but it is an EVENT — a missed or absent
      // one would keep the corpse forever, and broadcasting is where we would notice anyway.
      if (sender.isDestroyed?.() === true) {
        forget(sender);
        continue;
      }
      // A crashed renderer is alive as an object but has no frame: sending prints a stderr error. It stays
      // registered (it may reload and then receives control again). Control sent while it was crashed is NOT replayed: a
      // rejoining renderer's `hello` reply re-sends only the session id and the blackout flag, so a pause/resume/flush
      // issued meanwhile is lost for it (the same as before the skip, when the send hit a disposed frame).
      if (isCrashed(sender)) {
        continue;
      }
      sendTo(sender, raw);
    }
  };

  /** Fail closed: if the probe throws we cannot prove there is no blackout, so say there is. */
  const readBlackout = (probe: () => boolean): boolean => {
    try {
      return probe();
    } catch {
      return true;
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
    // The registry has to SHRINK. Every window that ever said hello used to be retained for the
    // process lifetime, pinning destroyed `webContents` (and whatever they retain) in the main process:
    // an app that opens and closes windows leaked monotonically, `rendererCount` was wrong after the first
    // close, and every broadcast walked a growing set of corpses.
    //
    // Subscribed only on FIRST registration, so a reload's repeat hello does not stack listeners on the
    // same webContents.
    if (!renderers.has(sender)) {
      renderers.add(sender);
      if (!subscribed.has(sender)) {
        const onDestroyed = (): void => {
          subscribed.delete(sender);
          forget(sender);
        };
        // Tracked ONLY when it can actually be subscribed (`once` present): otherwise `destroyed` never fires to
        // drop the entry and the map would pin the sender until stop().
        if (typeof sender.once === 'function') {
          subscribed.set(sender, onDestroyed);
          sender.once('destroyed', onDestroyed);
        }
      }
    }
    // Reply with the owner's session id — always, so a reloaded renderer re-learns the session.
    sendTo(
      sender,
      encodeControl({
        command: 'session',
        sessionId: options.sessionId,
        // ALWAYS stated: a probe-less owner says `false` instead of leaving the renderer to guess.
        blackout: options.isBlackout !== undefined ? readBlackout(options.isBlackout) : false,
        ...(declaredOwned !== undefined ? { hostOwnedTraces: declaredOwned } : {}),
      }),
    );
  };

  return {
    start(): void {
      options.ipcMain.on(helloChannel, onHello);
    },
    stop(): void {
      broadcast('stop');
      options.ipcMain.removeListener(helloChannel, onHello);
      for (const [sender, onDestroyed] of subscribed) {
        try {
          (sender.removeListener ?? sender.off)?.call(sender, 'destroyed', onDestroyed);
        } catch {
          // a webContents that is already gone may throw on removal: nothing left to release
        }
      }
      subscribed.clear();
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
    blackoutStart(): void {
      broadcast('blackout-start');
    },
    blackoutEnd(): void {
      broadcast('blackout-end');
    },
    rendererGone(id: number): void {
      for (const sender of [...renderers]) {
        if (sender.id === id) {
          forget(sender);
        }
      }
    },
    get rendererCount(): number {
      return renderers.size;
    },
  };
}
