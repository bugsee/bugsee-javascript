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
}): BridgeControl {
  const config: BridgeControlConfig = { reportTrigger: opts?.reportTrigger ?? false };
  return {
    config,
    control(raw: string): void {
      const msg = parseControl(raw);
      if (msg === undefined) {
        return; // foreign / malformed message on a shared channel — ignore
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
