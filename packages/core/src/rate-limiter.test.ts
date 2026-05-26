import { describe, expect, it } from 'vitest';
import type { Clock } from './clock';
import { createRateLimiter } from './rate-limiter';

// Controllable clock: monotonic time is set explicitly; wall time is deliberately different so tests
// can prove the limiter reads the monotonic source.
function fakeClock(): { clock: Clock; setMono: (n: number) => void } {
  let mono = 0;
  return {
    clock: { wallNow: () => -1, monotonicNow: () => mono },
    setMono: (n) => {
      mono = n;
    },
  };
}

describe('createRateLimiter', () => {
  it('admits up to the limit within a window', () => {
    const { clock } = fakeClock();
    const rl = createRateLimiter(clock, { limit: 3, windowMs: 1000 });
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(true);
  });

  it('refuses the admission beyond the limit in the same window', () => {
    const { clock } = fakeClock();
    const rl = createRateLimiter(clock, { limit: 3, windowMs: 1000 });
    rl.tryAcquire();
    rl.tryAcquire();
    rl.tryAcquire();
    expect(rl.tryAcquire()).toBe(false);
    expect(rl.tryAcquire()).toBe(false); // stays refused
  });

  it('admits again once earlier hits age out of the window', () => {
    const { clock, setMono } = fakeClock();
    const rl = createRateLimiter(clock, { limit: 2, windowMs: 1000 });
    setMono(0);
    rl.tryAcquire(); // t=0
    rl.tryAcquire(); // t=0
    expect(rl.tryAcquire()).toBe(false); // full
    setMono(1001); // both t=0 hits now older than the window
    expect(rl.tryAcquire()).toBe(true);
  });

  it('slides: only expired hits free up capacity, not all of them', () => {
    const { clock, setMono } = fakeClock();
    const rl = createRateLimiter(clock, { limit: 2, windowMs: 1000 });
    setMono(0);
    rl.tryAcquire(); // t=0
    setMono(600);
    rl.tryAcquire(); // t=600 -> window now [t0, t600], full
    setMono(1001); // t=0 expired (<= 1001-1000=1 cutoff), t=600 still in window
    expect(rl.tryAcquire()).toBe(true); // admits using the freed slot
    expect(rl.tryAcquire()).toBe(false); // t=600 and t=1001 now fill it again
  });

  it('evicts a hit exactly at the window boundary (half-open window)', () => {
    const { clock, setMono } = fakeClock();
    const rl = createRateLimiter(clock, { limit: 1, windowMs: 1000 });
    setMono(0);
    rl.tryAcquire(); // t=0
    setMono(1000); // cutoff = 0; hit at 0 is <= cutoff -> evicted
    expect(rl.tryAcquire()).toBe(true);
  });

  it('keeps a hit just inside the window boundary', () => {
    const { clock, setMono } = fakeClock();
    const rl = createRateLimiter(clock, { limit: 1, windowMs: 1000 });
    setMono(0);
    rl.tryAcquire(); // t=0
    setMono(999); // cutoff = -1; hit at 0 is > cutoff -> retained
    expect(rl.tryAcquire()).toBe(false);
  });

  it('defaults to 100 admissions per 60s', () => {
    const { clock } = fakeClock();
    const rl = createRateLimiter(clock);
    for (let i = 0; i < 100; i += 1) {
      expect(rl.tryAcquire()).toBe(true);
    }
    expect(rl.tryAcquire()).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])('throws for invalid limit %s', (limit) => {
    const { clock } = fakeClock();
    expect(() => createRateLimiter(clock, { limit })).toThrow(/limit must be a positive integer/);
  });

  it.each([0, -1, Number.NaN])('throws for invalid windowMs %s', (windowMs) => {
    const { clock } = fakeClock();
    expect(() => createRateLimiter(clock, { windowMs })).toThrow(
      /windowMs must be a positive number/,
    );
  });

  it('reads the monotonic clock source, not wall time', () => {
    // wallNow() is -1 in the fake; if the limiter used it the window math would misbehave.
    const { clock, setMono } = fakeClock();
    const rl = createRateLimiter(clock, { limit: 1, windowMs: 1000 });
    setMono(5000);
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(false);
    setMono(6001);
    expect(rl.tryAcquire()).toBe(true);
  });
});
