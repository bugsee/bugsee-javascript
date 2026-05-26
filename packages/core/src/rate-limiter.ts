import type { Clock } from './clock';

// Sustained-error-storm self-protection (design §7.7): at most `limit` captures per rolling
// `windowMs` window per Client; excess captures are refused (the pipeline drops them with outcome
// `rate_limit`). Independent of server-side dedup — we still upload what we admit. Uses the clock's
// MONOTONIC source so a wall-clock adjustment can't widen or collapse the window.

export interface RateLimiter {
  /** Records and admits a capture if under the limit; returns false (refuse) when the window is full. */
  tryAcquire(): boolean;
}

export interface RateLimiterOptions {
  /** Max admissions per window. Default 100 (§7.7). */
  limit?: number;
  /** Rolling window width in ms. Default 60_000 (§7.7). */
  windowMs?: number;
}

export function createRateLimiter(clock: Clock, options?: RateLimiterOptions): RateLimiter {
  const limit = options?.limit ?? 100;
  const windowMs = options?.windowMs ?? 60_000;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`RateLimiter limit must be a positive integer, got ${limit}`);
  }
  if (!(windowMs > 0)) {
    throw new RangeError(`RateLimiter windowMs must be a positive number, got ${windowMs}`);
  }

  // Admission timestamps in increasing order; the window holds those in (now - windowMs, now].
  const hits: number[] = [];

  return {
    tryAcquire(): boolean {
      const now = clock.monotonicNow();
      const cutoff = now - windowMs;
      while (hits.length > 0 && (hits[0] as number) <= cutoff) {
        hits.shift();
      }
      if (hits.length >= limit) {
        return false;
      }
      hits.push(now);
      return true;
    },
  };
}
