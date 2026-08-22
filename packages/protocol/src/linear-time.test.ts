import { describe, expect, it } from 'vitest';
import { bestOf, expectLinearIn } from './linear-time.test-helper';

// ---------------------------------------------------------------------------------------------
// Tests for the guard itself. It decides whether other tests pass, so it gets the same scrutiny.
// Every workload below is synthetic and its COST RATIO is fixed by construction, so these assert
// the same thing on any machine at any speed.
// ---------------------------------------------------------------------------------------------

/** Burn time proportional to `n`. The absolute rate is machine-dependent; the ratio is not. */
const burn = (n: number): void => {
  let sink = 0;
  for (let i = 0; i < n; i += 1) {
    sink += i % 7;
  }
  if (sink === -1) {
    throw new Error('unreachable — keeps the loop from being optimized away');
  }
};

describe('bestOf', () => {
  it('keeps the smallest of the measurements, not the last or the mean', () => {
    // Costs 4 units, then 1, then 4. A mean would report ~3 units and `last` would report 4; only the
    // minimum reports the cheap run, which is the one closest to the work's true cost.
    const costs = [4_000_000, 250_000, 4_000_000];
    let call = 0;
    const measured = bestOf(3, () => burn(costs[call++] as number));

    const cheapest = bestOf(1, () => burn(250_000));
    // Generous: this asserts the CHEAP run was the one kept, not an exact duration.
    expect(measured).toBeLessThan(cheapest * 4);
  });

  it('runs the workload exactly `attempts` times', () => {
    let calls = 0;
    bestOf(5, () => {
      calls += 1;
    });
    expect(calls).toBe(5);
  });

  it('returns a finite measurement rather than the initial sentinel', () => {
    expect(Number.isFinite(bestOf(2, () => burn(200_000)))).toBe(true);
  });
});

describe('expectLinearIn', () => {
  it('accepts work that grows linearly with the input', () => {
    expect(() => expectLinearIn((n) => n, burn, 4_000_000)).not.toThrow();
  });

  it('REJECTS work that grows quadratically — the regression it exists to catch', () => {
    expect(() =>
      expectLinearIn(
        (n) => n,
        (n) => {
          // n^2 in shape, scaled down so the small case stays quick: 4x the input, 16x the work.
          burn((n / 1000) * (n / 1000));
        },
        4_000_000,
      ),
    ).toThrow();
  });

  it('does NOT charge the work for the cost of preparing its input', () => {
    // The decisive case. `prepare` here is deliberately QUADRATIC while `work` is linear, so the two
    // verdicts disagree: measured separately the ratio is ~4 and this passes; fold `prepare` into the
    // measurement and the ratio becomes ~16 and it fails. A build that costs more at the large size
    // is exactly what the real guards do — they allocate a string proportional to the input.
    expect(() =>
      expectLinearIn(
        (n) => {
          burn((n / 1000) * (n / 1000));
          return n;
        },
        burn,
        4_000_000,
      ),
    ).not.toThrow();
  });

  it('fails loudly when the baseline is too small to divide by', () => {
    // A ratio built on a near-zero denominator is noise wearing a verdict's clothes. The guard must
    // say so rather than emit a pass or an Infinity.
    expect(() =>
      expectLinearIn(
        () => 0,
        () => {},
        1_000,
      ),
    ).toThrow(/unmeasurably small/);
  });
});
