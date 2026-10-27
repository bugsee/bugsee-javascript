import { ScreenTracker } from '@bugsee/trackers';
import { getCarrier } from './carrier';

// The route / view state of the application, shared through the process carrier so that the client that RECEIVES
// `setRoute` / `setView` (core) and the `route` / `view` trace producer that LISTENS (a platform tier) meet on one
// instance without either importing the other, and a relaunch inherits what was set (the carrier outlives a client).
// It lives in its own carrier slot, not the interceptor map (that map is one global patch per entry; this patches nothing).

/**
 * The carrier's one {@link ScreenTracker}, created on first use. `onError` is only used by the creating call (the first
 * caller's configuration wins, as for every carrier-shared tracker); it receives a throwing subscriber.
 */
export function screenTrackerFor(
  carrier?: object,
  onError?: (error: unknown) => void,
): ScreenTracker {
  const slot = getCarrier(carrier ?? globalThis);
  slot.screenTracker ??= new ScreenTracker(onError);
  return slot.screenTracker as ScreenTracker;
}
