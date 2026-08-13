import { neverThrow } from '@bugsee/core';
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
   * The JS-minted per-session token published once on `hello` (D-A1), used ONLY against a host that
   * injected no `nativeSecret`. Such a host would echo it on every control message — no shipped receiver ever
   * did, and a current one mints its own secret instead. Omitted → the channel can never
   * authenticate and stays open, which is the pre-token behaviour.
   *
   * Superseded by {@link nativeSecret} wherever native mints one: a token this SDK mints is one a page
   * script can mint too, which is why this path must start open and wait to latch.
   */
  token?: string;
  /**
   * A secret minted by NATIVE and handed to this SDK out of band — interpolated into the bundle native
   * injects, so it arrives by a route the page never observes (D-A10).
   *
   * When present it supersedes {@link token} entirely and the channel is CLOSED from the first message.
   * That is the difference that matters: `token` is minted by JS and published in `hello`, so a page script
   * can mint one too and native cannot tell them apart — which is why that scheme can only ever start open
   * and wait to latch. Native already knows this one, so an untokened message is an attack from the outset
   * rather than a possible legacy receiver.
   */
  nativeSecret?: string;
  /** Reports a REJECTED control message, so a page-script hijack attempt is visible rather than silent. */
  onError?: (error: unknown) => void;
  /**
   * The one-way latch, owned by the CALLER so it can outlive this handler (review round 1).
   *
   * It used to be a closure variable here, which made "one-way" true only within a single `launch()` —
   * and `launch` is itself a page global, so a script could relaunch to get an un-latched channel. The
   * launch passes the per-GLOBAL slot's object instead. Defaults to a private one for standalone use.
   */
  auth?: { authenticated: boolean };
}): BridgeControl {
  const config: BridgeControlConfig = { reportTrigger: opts?.reportTrigger ?? false };
  const token = opts?.token;
  const nativeSecret = opts?.nativeSecret;
  // The one-way upgrade (D-A2) — the FALLBACK path only, reached when native injected no `nativeSecret`.
  // There, requiring a token immediately would break every host whose receiver echoes none, so the channel
  // starts open and latches CLOSED the first time a correctly-tokened message proves native speaks the new
  // protocol. A page script cannot force the latch (it needs the secret) or release it (no path back).
  //
  // With a native-minted secret there is no upgrade and no latch: the channel is closed from the first
  // message (see `admits`). The open period is precisely what D-A10 removed, because a page script could
  // stop capture inside it — and forever, when the realm had no CSPRNG to mint a token with.
  const auth = opts?.auth ?? { authenticated: false };
  // A page script can call `__bugsee_bridge.control(...)` in a loop, so the rejection report is ONCE per
  // handler. D-A4 declined to report sink swaps for exactly this reason ("a page could trigger it at will
  // to flood `onError`"); applying the opposite rule here would have been inconsistent.
  let reportedRejection = false;

  /** Whether this message may act on the SDK. */
  const admits = (msg: ControlMessage): boolean => {
    // A native-minted secret admits nothing else, from the very first message. No open period, no latch to
    // arm — native knew the secret before this SDK existed, so there is no legacy receiver to accommodate.
    // This is what closes the window in which a page script could `control({cmd:"stop"})` the capture off,
    // and the permanent hole when `mintControlToken` finds no CSPRNG and returns undefined.
    if (nativeSecret !== undefined) {
      return (msg as { tok?: unknown }).tok === nativeSecret;
    }
    // No secret was minted, so nothing can be authenticated against — and rejecting a token we cannot
    // verify would lock out a MODERN native rather than an old one. Stay open; the latch never arms.
    if (token === undefined) {
      return true;
    }
    const tok = (msg as { tok?: unknown }).tok;
    if (tok === token) {
      auth.authenticated = true; // latch
      return true;
    }
    // A present-but-wrong token is an attack, never a legacy receiver — the whole point of the
    // `tok === undefined` allowance is that OLD natives send no token at all.
    if (tok !== undefined) {
      return false;
    }
    return !auth.authenticated;
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
        // Contained AND rate-limited. `control()` is documented "never throws" because an exception here
        // propagates into native's `evaluateJavascript` — the fail-open shape fixed as SEV1-1 — and a host
        // `onError` is arbitrary app code that may throw.
        if (!reportedRejection) {
          reportedRejection = true;
          neverThrow(
            () =>
              opts?.onError?.(
                new Error(
                  'Bugsee: rejected an unauthenticated control message on the WebView bridge',
                ),
              ),
            undefined,
          );
        }
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
