import { reportGuarded } from '@bugsee/util';
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
  options: { onError?: (error: unknown) => void; carrier?: object },
): BugseeClient | undefined {
  if (isValidAppToken(appToken)) {
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
  const client = createClient({
    ...(options.carrier !== undefined ? { carrier: options.carrier } : {}),
  });
  // Never started, and `launch()` must not start it either: it is a placeholder, not a session.
  return { ...client, launch: () => {} };
}
