// Rate-limits "the store lost every visual base, restart the recorder". A restart costs a full-DOM snapshot; if one
// snapshot does not fit the byte cap, every restart is followed by another reset, so resets that keep coming must back off
// instead of snapshotting every few seconds. Shared by the browser launch (its own store) and the Electron main (whose
// store the renderers stream into, and which tells them to restart over the control channel).

/** The shortest gap between two restarts. */
const QUIET_MS = 5000;
/** The longest gap the backoff reaches. */
const MAX_INTERVAL_MS = 300_000;
/** A quiet spell longer than this starts the backoff over. */
const QUIET_RESET_MS = 600_000;

export interface VisualResetGateOptions {
  /** A monotonic millisecond clock. */
  now(): number;
  /** Ask the recorder(s) for a fresh base. */
  restart(): void;
  /** False while there is nothing to restart (no recorder yet): such a reset neither restarts nor uses up the budget. Default always ready. */
  ready?(): boolean;
}

/** The function to call on every visual reset; it restarts the recorder at most as often as the backoff allows. */
export function createVisualResetGate(options: VisualResetGateOptions): () => void {
  let last = Number.NEGATIVE_INFINITY;
  let interval = QUIET_MS;
  return (): void => {
    const at = options.now();
    if (options.ready?.() === false || at - last < interval) {
      return;
    }
    // Resets that keep coming mean one snapshot does not fit the cap: back off (doubling) instead of snapshotting the whole
    // DOM every few seconds; a long quiet spell starts over from the base interval.
    interval = at - last > QUIET_RESET_MS ? QUIET_MS : Math.min(interval * 2, MAX_INTERVAL_MS);
    last = at;
    options.restart();
  };
}
