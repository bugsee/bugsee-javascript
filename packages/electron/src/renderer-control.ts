// The renderer-side control dispatcher. The main process drives the renderer DOWN the control channel;
// this decodes each control message and applies it locally: pause/resume flip the streaming store's paused
// flag (dropping the capture stream while backgrounded — incidents still report via the separate report
// path), flush/stop forward to the renderer client, and `session` delivers the owner's session id (the
// handshake reply). Unknown / malformed messages are ignored.
import { decodeControl } from './protocol';

export interface RendererControlHandlerOptions {
  /** Flip the renderer streaming store's paused flag (pause → true, resume → false). */
  setPaused(paused: boolean): void;
  /** Stop the renderer client (main sent `stop`). */
  stop(): void;
  /**
   * Deliver the owner's assigned session id (the `session` handshake reply). Optional. This is the
   * handshake: it RELEASES the renderer's launch hold, so it is called AFTER `onBlackout` for the same
   * reply (the owner's state must be known before the hold opens, or a dark owner would flicker light).
   */
  onSession?(sessionId: string): void;
  /** Flush the renderer client (main sent `flush`). Optional — streaming has nothing local to drain. */
  flush?(): void;
  /**
   * The owner's blackout began (`true`) or ended (`false`) — also delivered with the `session` handshake
   * reply, BEFORE `onSession`. Optional.
   */
  onBlackout?(active: boolean): void;
  /**
   * The trace names the host owns, carried by the `session` reply (so the renderer stops writing them). Delivered BEFORE
   * `onSession`, like the blackout state. Optional; not called when the reply declares none.
   */
  onHostOwned?(names: readonly string[]): void;
  /**
   * Whether this renderer's window is the session's key window: delivered with the `session` reply (BEFORE `onSession`; a
   * reply that says nothing means "key": a main that cannot resolve windows must not silence any) and on every
   * `window-key` command (a missing flag there is "not key"). Optional.
   */
  onKeyWindow?(isKey: boolean): void;
}

/** Build the renderer's control dispatcher: `handle(raw)` applies one main→renderer control message. */
export function createRendererControlHandler(
  options: RendererControlHandlerOptions,
): (raw: string) => void {
  return (raw: string): void => {
    const message = decodeControl(raw);
    if (message === undefined) {
      return;
    }
    switch (message.command) {
      case 'pause':
        options.setPaused(true);
        break;
      case 'resume':
        options.setPaused(false);
        break;
      case 'flush':
        options.flush?.();
        break;
      case 'stop':
        options.stop();
        break;
      case 'session':
        if (message.blackout !== undefined) {
          options.onBlackout?.(message.blackout);
        }
        if (message.hostOwnedTraces !== undefined) {
          options.onHostOwned?.(message.hostOwnedTraces);
        }
        options.onKeyWindow?.(message.keyWindow ?? true);
        if (message.sessionId !== undefined) {
          options.onSession?.(message.sessionId);
        }
        break;
      case 'window-key':
        options.onKeyWindow?.(message.keyWindow === true);
        break;
      case 'blackout-start':
        options.onBlackout?.(true);
        break;
      case 'blackout-end':
        options.onBlackout?.(false);
        break;
    }
  };
}
