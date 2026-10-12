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

// A listener that toggles the state from inside its own notification is cut off after this many rounds
// of re-delivery: an application bug must not hang the host.
const MAX_DELIVERY_ROUNDS = 100;

/**
 * Create the blackout state. A throwing listener is isolated to `onError` so one misbehaving subscriber
 * can neither block the others nor leave the state half-toggled.
 *
 * Re-entrancy: a listener may start or end the blackout from inside its notification (a lifecycle
 * listener reacting to BlackoutEnded, say). The state changes immediately, delivery is NOT nested: the
 * outer dispatch loop keeps going until every listener has been told the state it ends on, each listener
 * is told at most once per net change, and it is always handed the CURRENT state, never the stale
 * argument of an outer round. Otherwise a replay recorder subscribed after such a listener would be told
 * "false" after the nested "true" and resume recording during a blackout.
 *
 * `initiallyActive` starts the state active WITHOUT notifying anyone (a blackout carried across a
 * relaunch: nobody is subscribed yet and providers read `isActive()` when they start).
 */
export function createBlackoutState(
  onError?: (error: unknown) => void,
  initiallyActive = false,
): BlackoutState {
  let active = initiallyActive;
  // Subscribed listener -> the last state it was told (or was born into).
  const listeners = new Map<(active: boolean) => void, boolean>();
  let dispatching = false;

  const dispatch = (): void => {
    dispatching = true;
    try {
      for (let round = 0; ; round += 1) {
        // Snapshot: a listener that unsubscribes (or subscribes) mid-dispatch must not disturb this round.
        const pending = [...listeners].filter(([, told]) => told !== active);
        if (pending.length === 0) {
          return;
        }
        if (round >= MAX_DELIVERY_ROUNDS) {
          onError?.(
            new Error('blackout: a listener keeps toggling the blackout; delivery stopped'),
          );
          return;
        }
        for (const [listener] of pending) {
          if (!listeners.has(listener) || listeners.get(listener) === active) {
            continue; // unsubscribed, or already brought up to date by a nested round
          }
          listeners.set(listener, active);
          try {
            listener(active);
          } catch (error) {
            onError?.(error);
          }
        }
      }
    } finally {
      dispatching = false;
    }
  };

  const set = (next: boolean): void => {
    if (active === next) {
      return;
    }
    active = next;
    if (!dispatching) {
      dispatch();
    }
  };

  return {
    isActive: () => active,
    start: () => set(true),
    end: () => set(false),
    onChange(listener) {
      listeners.set(listener, active);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
