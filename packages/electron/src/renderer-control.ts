// The renderer-side control dispatcher (E6). The main process drives the renderer DOWN the control channel;
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
  /** Deliver the owner's assigned session id (the `session` handshake reply). Optional. */
  onSession?(sessionId: string): void;
  /** Flush the renderer client (main sent `flush`). Optional — streaming has nothing local to drain. */
  flush?(): void;
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
        if (message.sessionId !== undefined) {
          options.onSession?.(message.sessionId);
        }
        break;
    }
  };
}
