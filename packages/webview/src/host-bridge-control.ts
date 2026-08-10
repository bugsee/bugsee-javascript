import { type ControlMessage, parseControl } from './protocol';

// The native→JS control entry point (docs/design/webview-bridge.md §7). Native drives the JS SDK by calling
// `__bugsee_bridge.control(raw)` via `evaluateJavascript`; the launch exposes this method on the bridge global.
// SLICE 1 scope: receive the handshake REPLY and apply its config — the native session id + the `reportTrigger`
// gate (D5, default off; native may override the launch option). Commands (pause/resume/flush/snapshot/stop)
// are forwarded to an `onCommand` seam that the full control channel (slice 3) fills. Defensive: a foreign /
// malformed message on a shared channel is ignored (never throws).

/** The mutable control state resolved from the launch option + the handshake reply. */
export interface BridgeControlConfig {
  /** The native session id (from the control reply); undefined until the handshake completes. */
  session?: string;
  /** Whether the WebView may emit report triggers (D5). Seeded from the launch option; native may override. */
  reportTrigger: boolean;
}

export interface BridgeControl {
  /** The native→JS entry point exposed as `__bugsee_bridge.control`. Defensive — never throws. */
  control(raw: string): void;
  /** The live resolved config (mutated by control replies; read by the launch). */
  readonly config: Readonly<BridgeControlConfig>;
}

/** Build the bridge control handler. */
export function createBridgeControl(opts?: {
  /** Initial `reportTrigger` from the launch option (D5, default false). */
  reportTrigger?: boolean;
  /** Seam for native commands (slice 3 wires pause/resume/flush/snapshot/stop). */
  onCommand?: (command: NonNullable<ControlMessage['command']>) => void;
  /**
   * The per-session token published once on `hello` (Wave 0.3 / D-A1). Native echoes it on every control
   * message. Omitted → the channel can never authenticate and stays open, which is the pre-token behaviour.
   */
  token?: string;
  /** Reports a REJECTED control message, so a page-script hijack attempt is visible rather than silent. */
  onError?: (error: unknown) => void;
}): BridgeControl {
  const config: BridgeControlConfig = { reportTrigger: opts?.reportTrigger ?? false };
  const token = opts?.token;
  // The one-way upgrade (D-A2). No shipped native receiver echoes a token yet, so requiring one immediately
  // would break every existing host. Instead the channel starts open and latches CLOSED the first time a
  // correctly-tokened message proves native speaks the new protocol. A page script cannot force the latch
  // (it needs the secret) and cannot release it (there is no path back to false).
  let authenticated = false;

  /** Whether this message may act on the SDK. */
  const admits = (msg: ControlMessage): boolean => {
    // No secret was minted, so nothing can be authenticated against — and rejecting a token we cannot
    // verify would lock out a MODERN native rather than an old one. Stay open; the latch never arms.
    if (token === undefined) {
      return true;
    }
    const tok = (msg as { tok?: unknown }).tok;
    if (tok === token) {
      authenticated = true; // latch
      return true;
    }
    // A present-but-wrong token is an attack, never a legacy receiver — the whole point of the
    // `tok === undefined` allowance is that OLD natives send no token at all.
    if (tok !== undefined) {
      return false;
    }
    return !authenticated;
  };

  return {
    config,
    control(raw: string): void {
      const msg = parseControl(raw);
      if (msg === undefined) {
        return; // foreign / malformed message on a shared channel — ignore
      }
      if (!admits(msg)) {
        // Rejected wholesale: config as well as commands. Flipping `reportTrigger` from the page is the
        // quiet half of this attack (the WebView opens native bug reports at will, past the D5 gate).
        opts?.onError?.(
          new Error('Bugsee: rejected an unauthenticated control message on the WebView bridge'),
        );
        return;
      }
      if (msg.session !== undefined) {
        config.session = msg.session;
      }
      if (msg.config?.reportTrigger !== undefined) {
        config.reportTrigger = msg.config.reportTrigger;
      }
      if (msg.command !== undefined) {
        opts?.onCommand?.(msg.command);
      }
    },
  };
}
