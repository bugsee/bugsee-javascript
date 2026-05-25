/**
 * Exponential backoff with symmetric jitter, used by the upload pipeline's retry logic
 * (design §7.5 / §14.8: start 5 s, max 1 h, jitter ±10%).
 *
 * `random` is injectable so callers (and tests) can make the jitter deterministic; it must
 * return a value in [0, 1) like `Math.random`.
 */
export interface BackoffOptions {
  /** Delay for attempt 0, before jitter. Default 5_000 ms. */
  initialDelayMs?: number;
  /** Upper bound applied before jitter. Default 3_600_000 ms (1 h). */
  maxDelayMs?: number;
  /** Growth base; delay ~ initial * factor^attempt. Default 2. */
  factor?: number;
  /** Symmetric jitter as a fraction of the delay, e.g. 0.1 => ±10%. Default 0.1. */
  jitterRatio?: number;
  /** Source of randomness in [0, 1). Default Math.random. */
  random?: () => number;
}

/** Returns the delay in milliseconds to wait before the given 0-based retry `attempt`. */
export function computeBackoff(attempt: number, options: BackoffOptions = {}): number {
  const {
    initialDelayMs = 5_000,
    maxDelayMs = 3_600_000,
    factor = 2,
    jitterRatio = 0.1,
    random = Math.random,
  } = options;

  const safeAttempt = attempt > 0 ? attempt : 0;
  const exponential = initialDelayMs * factor ** safeAttempt;
  const capped = Math.min(exponential, maxDelayMs);
  const jitter = 1 + (random() * 2 - 1) * jitterRatio;
  const delay = capped * jitter;

  return delay > 0 ? delay : 0;
}
