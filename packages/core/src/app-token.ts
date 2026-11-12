import { reportGuarded } from '@bugsee/util';
import { getCarrierClient } from './carrier';
import { type BugseeClient, createClient } from './client';

/** A usable app token is a string with at least one non-whitespace character. */
export function isValidAppToken(appToken: unknown): appToken is string {
  return typeof appToken === 'string' && appToken.trim().length > 0;
}

const describeReceived = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'an empty string';
  return typeof value;
};

/**
 * The shared missing-token guard every platform `launch()` calls first.
 *
 * Returns `undefined` for a usable token (launch proceeds). Otherwise it reports ONE clear error — through the
 * host's `onError`, or `console.warn` when none was given — and returns a DISABLED client: one that was never
 * started and cannot be (`isLaunched()` stays false, nothing is captured or uploaded) and that does NOT claim the process
 * carrier slot, so a later launch with a valid token still works. A monitoring SDK must not crash the host at
 * startup because `process.env.BUGSEE_APP_TOKEN` is unset (CI, containers, a fresh checkout).
 *
 * Never throws, whatever the host's sink does.
 */
export function createDisabledClientForMissingToken(
  appToken: unknown,
  options: { onError?: (error: unknown) => void; carrier?: object | undefined },
): BugseeClient | undefined {
  if (isValidAppToken(appToken)) {
    return undefined;
  }
  // A client already owns the process: let the platform's own repeat-launch path hand THAT client back (a
  // handler that calls `launch(env.TOKEN)` on every invocation must not swap the live client for a dead one).
  if (getCarrierClient(options.carrier) !== undefined) {
    return undefined;
  }
  const error = new Error(
    `Bugsee: the app token is missing (expected a non-empty string, got ${describeReceived(appToken)}); the SDK is disabled.`,
  );
  if (options.onError !== undefined) {
    reportGuarded(options.onError, error);
  } else {
    try {
      (globalThis as unknown as { console?: { warn?: (message: string) => void } }).console?.warn?.(
        error.message,
      );
    } catch {
      // a broken console must not crash the host either
    }
  }
  // Deliberately NO carrier: a real client claims carrier-level state (blackout ownership, the lifecycle slot),
  // and a placeholder must not take any of it from a live client or leave it behind for a later valid launch.
  const client = createClient({
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  // Never started, and `launch()` must not start it either: it is a placeholder, not a session.
  return { ...client, launch: () => {} };
}
