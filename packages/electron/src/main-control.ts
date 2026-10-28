// The main-process control manager — the DOWNstream half of the bridge (main→renderers). Renderers
// stream capture UP (main-receiver.ts); this drives them DOWN. On a renderer `hello` it registers the sender
// and replies with the owner's `session` id (the handshake), then broadcasts pause/resume/flush/stop control
// to every registered renderer (reusing the WebView control kinds). Sends are best-effort: a destroyed
// webContents throws, so each send is guarded and never breaks the broadcast to the others. `electron` is
// taken as plain args (no dependency; fully testable).
import { reportGuarded } from '@bugsee/util';
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
  /**
   * Resolves the session's KEY window (spec "Several windows in one session"): `currentId` is the key window's id (undefined:
   * there is none; null: it CANNOT SAY, a failed window-list read, which fails open like a failing probe) and `ownerId` the id of the window that owns a renderer's webContents (undefined: it has none). When given, every
   * `session` reply states whether the renderer is key (`kw`) and {@link ElectronMainControl.keyWindowChanged} tells the
   * renderers whose answer changed. A renderer whose window cannot be resolved (`ownerId` undefined) and a probe that
   * throws (reported to `onError`) both fail OPEN: an unknown key never silences a window. Without it no `kw` is stated and every renderer stays key.
   */
  keyWindow?: {
    currentId(): number | undefined | null;
    /** Called once at the start of every evaluation (a probe may read its window list once for all the owner lookups). */
    beginEvaluation?(): void;
    ownerId(sender: ControlSenderLike): number | undefined;
  };
  /** How long the key is held on a window whose renderer left while the tracker still calls it key (default 3000 ms). */
  holdMs?: number;
  /** Internal-error sink (a failing key-window probe). */
  onError?: (error: unknown) => void;
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
   * The key window may have changed: re-evaluate every registered renderer and send `window-key` to those whose answer
   * differs from what they were last told. A no-op without the `keyWindow` option.
   */
  keyWindowChanged(): void;
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

  // The key-window flag each renderer was LAST told (reply or `window-key`): a change is sent only to those it changed for.
  // (a WeakMap: a forgotten webContents is never pinned by it)
  const sentKey = new WeakMap<ControlSenderLike, boolean>();
  // The last key window that hosted an SDK renderer: a focused window with NO Bugsee in it must not silence every
  // instrumented window, so the key falls back to this one while it still hosts a renderer.
  let lastParticipatingKey: number | undefined;
  // When the tracker's key window is the one whose renderer just left, the key is HELD there (nobody writes) until the tracker
  // moves it (its `closed` follows the webContents `destroyed` by a tick) or this expires: a crash with no reload never gets
  // a `closed`, and must not silence every other window for ever.
  const HOLD_MS = options.holdMs ?? 3000;
  let heldSince: number | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** No window id equals this: a held key makes every placed renderer non-key. */
  const HELD = -1;
  /**
   * ONE evaluation of "which renderer is key", from a single snapshot (the key is read once, each renderer's owner window
   * once, and the probe may read the window list once for all of them). Returns `isKey(sender)`.
   *
   * The key window is the tracker's when it hosts a registered renderer; else the last window that did (while it still does);
   * else, when the tracker's key is still the window whose renderer just left (a closing window's webContents `destroyed`
   * fires before its `closed`; a crash), the key is HELD there for a short while so nobody flashes in and the tracker's own
   * next choice wins when it publishes it; else the window of the EARLIEST registered renderer. `undefined`: no key window
   * at all. `null`: the probe cannot say (everyone is key). A renderer whose window cannot be resolved is never silenced
   * (key). A failing probe is reported and fails OPEN.
   */
  const evaluate = (
    probe: NonNullable<ElectronMainControlOptions['keyWindow']>,
  ): ((sender: ControlSenderLike) => boolean) => {
    try {
      probe.beginEvaluation?.();
      const owners = new Map<ControlSenderLike, number | undefined>();
      for (const r of renderers) if (r.isDestroyed?.() !== true) owners.set(r, probe.ownerId(r));
      const hosts = (id: number | undefined): boolean =>
        id !== undefined && [...owners.values()].includes(id);
      const current = probe.currentId();
      let key: number | undefined | null = current;
      if (current !== null && current !== undefined) {
        const earliest = (): number | null => {
          heldSince = undefined;
          lastParticipatingKey = [...owners.values()].find((id) => id !== undefined);
          return lastParticipatingKey ?? null;
        };
        if (hosts(current)) {
          lastParticipatingKey = current;
          heldSince = undefined;
        } else if (hosts(lastParticipatingKey)) {
          key = lastParticipatingKey;
        } else if (current === lastParticipatingKey) {
          const now = Date.now();
          heldSince ??= now;
          if (now - heldSince < HOLD_MS) {
            key = HELD;
            // one timer, always aimed at THIS hold's expiry (an earlier hold's timer must not decide for a later one)
            if (holdTimer !== undefined) clearTimeout(holdTimer);
            holdTimer = setTimeout(
              () => {
                holdTimer = undefined;
                rediffKey();
              },
              HOLD_MS - (now - heldSince) + 1,
            );
            (holdTimer as { unref?: () => void }).unref?.();
          } else {
            key = earliest();
          }
        } else {
          key = earliest();
        }
      }
      return (sender) => {
        const owner = owners.has(sender) ? owners.get(sender) : probe.ownerId(sender);
        return owner === undefined || key === null || owner === key;
      };
    } catch (error) {
      reportGuarded(options.onError, error);
      return () => true;
    }
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
          rediffKey(); // the key window's participating renderer may be the one that just went
        };
        // Tracked ONLY when it can actually be subscribed (`once` present): otherwise `destroyed` never fires to
        // drop the entry and the map would pin the sender until stop().
        if (typeof sender.once === 'function') {
          subscribed.set(sender, onDestroyed);
          sender.once('destroyed', onDestroyed);
        }
      }
    }
    // Whether this renderer is the key window's: stated (and remembered, so a later change is diffed against it) only when
    // main can resolve windows at all.
    const probe = options.keyWindow;
    const keyWindow = probe === undefined ? undefined : evaluate(probe)(sender);
    if (keyWindow !== undefined) sentKey.set(sender, keyWindow);
    // Reply with the owner's session id — always, so a reloaded renderer re-learns the session.
    sendTo(
      sender,
      encodeControl({
        command: 'session',
        sessionId: options.sessionId,
        // ALWAYS stated: a probe-less owner says `false` instead of leaving the renderer to guess.
        blackout: options.isBlackout !== undefined ? readBlackout(options.isBlackout) : false,
        ...(declaredOwned !== undefined ? { hostOwnedTraces: declaredOwned } : {}),
        ...(keyWindow !== undefined ? { keyWindow } : {}),
      }),
    );
    // A new renderer can change who the key window's participating renderer is (a window that took focus before its SDK
    // started): re-evaluate the others now, not at the next focus change. The sender's own flag is already recorded.
    if (probe !== undefined) rediffKey();
  };

  /** Re-evaluate every registered renderer and tell those whose key flag differs from what they were last told. */
  const rediffKey = (): void => {
    const probe = options.keyWindow;
    if (probe === undefined) return;
    // forget the destroyed first: they must not count as participating
    for (const sender of [...renderers]) if (sender.isDestroyed?.() === true) forget(sender);
    const isKey = evaluate(probe);
    for (const sender of [...renderers]) {
      if (isCrashed(sender)) continue; // no frame to address; its reload's hello re-states the flag
      const now = isKey(sender);
      if (sentKey.get(sender) === now) continue;
      sentKey.set(sender, now);
      sendTo(sender, encodeControl({ command: 'window-key', keyWindow: now }));
    }
  };

  return {
    start(): void {
      options.ipcMain.on(helloChannel, onHello);
    },
    stop(): void {
      if (holdTimer !== undefined) clearTimeout(holdTimer);
      holdTimer = undefined;
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
    keyWindowChanged: rediffKey,
    rendererGone(id: number): void {
      for (const sender of [...renderers]) {
        if (sender.id === id) {
          forget(sender);
        }
      }
      rediffKey();
    },
    get rendererCount(): number {
      return renderers.size;
    },
  };
}
