import { serviceToken } from '@bugsee/service';

// BLACKOUT state (mobile `Bugsee.startBlackout/endBlackout/isBlackout`, iOS Bugsee.h / Android Bugsee.java).
// While active, every VISUAL / INTERACTION capture source is suppressed (replay/video, touches and
// gestures, keyboard/focus breadcrumbs, the view hierarchy); logs, network, traces and events carry on.
//
// The kernel owns only this tiny boolean and its change subscription. It knows nothing about WHICH
// providers are visual: each visual provider is handed the read-only {@link BlackoutGate} and decides for
// itself (pub/sub, not piercing the core). Idempotent and NOT counted — matches mobile, where one
// `endBlackout()` ends any number of `startBlackout()`s.

/** The read-only view of the blackout state a capture provider is handed. */
export interface BlackoutGate {
  /** Whether a blackout is currently in force. */
  isActive(): boolean;
  /**
   * Subscribe to changes; the listener receives the NEW state (true = blackout began). Fires only on a
   * real transition. Returns an unsubscribe function.
   */
  onChange(listener: (active: boolean) => void): () => void;
}

/** The mutable state the Client drives. */
export interface BlackoutState extends BlackoutGate {
  /** Begin a blackout (no-op when already active). */
  start(): void;
  /** End the blackout (no-op when not active). */
  end(): void;
}

/** The blackout state's identity in the internal container (resolve with `client.getService`). */
export const BlackoutToken = serviceToken<BlackoutState>('blackout');

/**
 * Create the blackout state. A throwing listener is isolated to `onError` so one misbehaving subscriber
 * can neither block the others nor leave the state half-toggled.
 */
export function createBlackoutState(onError?: (error: unknown) => void): BlackoutState {
  let active = false;
  const listeners = new Set<(active: boolean) => void>();

  const set = (next: boolean): void => {
    if (active === next) {
      return;
    }
    active = next;
    // Snapshot: a listener that unsubscribes (or subscribes) mid-dispatch must not disturb this round.
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (error) {
        onError?.(error);
      }
    }
  };

  return {
    isActive: () => active,
    start: () => set(true),
    end: () => set(false),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
