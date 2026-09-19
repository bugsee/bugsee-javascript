import { describe, expect, it } from 'vitest';
import { expectLinearIn, measurePair, timePerCall } from './linear-time.test-helper';

/**
 * Tests for the complexity guard itself.
 *
 * It decides whether other tests pass, so it gets the same scrutiny they do. Every workload below is
 * synthetic and its COST RATIO is fixed by construction, so these assert the same thing on any
 * machine at any speed — which is the whole property the guard is supposed to have and, for one
 * unhappy CI run, did not.
 */

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

describe('timePerCall', () => {
  it('reports the cost of ONE call, not of the batch it needed to measure it', () => {
    // Driven by an INJECTED clock, so the assertion is exact rather than approximate. Twice before
    // this test measured real work and compared wall-clock ratios: it read 16.7x for 4x work when the
    // small sample got a quiet moment, and later 1.886x — under the lower bound — when the large one
    // did. A guard against timing noise cannot itself be a timing measurement, and no amount of
    // interleaving fixes that; the property under test is arithmetic, not performance.
    //
    // Each call to `work` costs exactly `costPerCall` on this clock, whatever the batch.
    const fakeClock = (costPerCall: number) => {
      let elapsed = 0;
      return {
        clock: () => elapsed,
        work: () => {
          elapsed += costPerCall;
        },
      };
    };

    // The sample floor forces MANY repetitions for cheap work — 250 of them here — and the reported
    // number must still be the cost of one. Returning the batch time would read 25, not 0.1.
    const cheap = fakeClock(0.1);
    expect(timePerCall(cheap.work, cheap.clock, 25)).toBeCloseTo(0.1, 10);

    // Work that already exceeds the floor in one call runs exactly once, and is reported as itself.
    const expensive = fakeClock(40);
    expect(timePerCall(expensive.work, expensive.clock, 25)).toBeCloseTo(40, 10);

    // And the ratio the real guards depend on is exact: 4x the cost per call, 4x the reading, even
    // though the cheap side needed 250 repetitions to reach the floor and the dear side needed 63.
    const one = fakeClock(0.1);
    const four = fakeClock(0.4);
    expect(
      timePerCall(four.work, four.clock, 25) / timePerCall(one.work, one.clock, 25),
    ).toBeCloseTo(4, 10);
  });

  it('still measures REAL work, and reports something sane for it', () => {
    // The fake clock above pins the arithmetic; this pins that the helper is wired to a real clock at
    // all — a `timePerCall` that always returned 0, or the batch's start time, would satisfy every
    // assertion above. Deliberately one-sided and unbounded above: any ceiling here is a wall-clock
    // budget on a shared runner, which is what made this file flaky twice.
    const cost = timePerCall(() => burn(200_000));
    expect(cost).toBeGreaterThan(0);
    expect(Number.isFinite(cost)).toBe(true);
  });

  it('repeats cheap work rather than trusting a single unmeasurable reading', () => {
    // A single call here lasts nanoseconds — exactly the case that made a bare integer loop read
    // 8.31x for a 4x input on the CI runner, because the sample landed entirely on whichever core it
    // happened to get. It has to be batched, so the callback must run many times.
    let calls = 0;
    timePerCall(() => {
      calls += 1;
    });

    expect(calls).toBeGreaterThan(1_000);
  });

  it('calls work that is already slow enough exactly once', () => {
    // The broken cases this guard exists to catch are slow on their own. Repeating them would turn a
    // detected regression into a suite timeout, which reports as infrastructure rather than as a bug.
    let calls = 0;
    timePerCall(() => {
      calls += 1;
      const started = Date.now();
      while (Date.now() - started < 30) {
        // deliberately busy: one call alone exceeds the sample floor
      }
    });

    expect(calls).toBe(1);
  });

  it('keeps batching until the batch reaches the floor it is given', () => {
    // A virtual clock: each call costs exactly 1 ms, so the batch sizes are exact.
    let t = 0;
    let calls = 0;
    const work = (): void => {
      calls += 1;
      t += 1;
    };

    expect(timePerCall(work, () => t)).toBe(1);
    expect(calls).toBe(1 + 25); // the default 25 ms floor: a 1-call probe, then a 25-call batch

    calls = 0;
    expect(timePerCall(work, () => t, 100)).toBe(1);
    expect(calls).toBe(1 + 100);

    // A single call already past the DEFAULT floor but short of the given one is not trusted either.
    let slowCalls = 0;
    expect(
      timePerCall(
        () => {
          slowCalls += 1;
          t += 30;
        },
        () => t,
        100,
      ),
    ).toBe(30);
    expect(slowCalls).toBe(1 + 4);
  });

  it('escapes rather than spinning when the clock never advances', () => {
    // `MIN_SAMPLE_MS / 0` is Infinity, and `for (i = 0; i < Infinity; i += 1)` is an unbreakable
    // SYNCHRONOUS spin that no test timeout can interrupt. A stopped clock is the only way to reach
    // it, which is why the clock is injectable at all — so this is a test rather than a comment.
    let calls = 0;

    expect(() =>
      timePerCall(
        () => {
          calls += 1;
        },
        () => 0,
      ),
    ).toThrow(/never accumulated/);

    // And it must keep GROWING the batch while it tries. Without that the loop would give up after
    // 40 identical single-call attempts, and genuinely cheap work would never reach the floor.
    expect(calls).toBeGreaterThan(1_000);
  });
});

describe('measurePair', () => {
  it('INTERLEAVES the two sizes rather than finishing one before starting the other', () => {
    // The property, not a preference. The version this replaced measured every small run and THEN
    // every large one, so a core migration between the two blocks shifted one group entire and the
    // ratio absorbed all of it. Alternating makes both sizes sample the same conditions.
    const order: string[] = [];

    measurePair(
      () => {
        order.push('small');
      },
      () => {
        order.push('large');
      },
    );

    // Segregated ordering puts every 'small' before every 'large'; interleaved cannot.
    expect(order.lastIndexOf('small')).toBeGreaterThan(order.indexOf('large'));
  });

  // THE CI FLAKE this answers: a large sample that is ONE long call (1.6 s on the runner) straddles the
  // scheduler moving the thread between performance and efficiency cores, while a 25 ms small batch
  // usually does not — so noise inflated only the large side (ratio 65.5 for work that measures ~16
  // locally). Batching the small side to last as long as one large call exposes both to the same noise.
  it('batches the SMALL side to last as long as one large call, so both see the same noise', () => {
    let t = 0;
    let smallCalls = 0;
    let largeCalls = 0;
    const result = measurePair(
      () => {
        smallCalls += 1;
        t += 1; // 1 ms a call
      },
      () => {
        largeCalls += 1;
        t += 200; // one call already exceeds the floor, so it runs once per round
      },
      () => t,
    );

    expect(result).toStrictEqual({ small: 1, large: 200 });
    expect(largeCalls).toBe(3);
    // Each round: a 1-call probe, then a batch reaching 200 ms — not the 25 ms default floor.
    expect(smallCalls).toBe(3 * (1 + 200));
  });

  it('never matches BELOW the default floor when the large side is cheap', () => {
    let t = 0;
    let smallCalls = 0;
    measurePair(
      () => {
        smallCalls += 1;
        t += 1;
      },
      () => {
        t += 2; // cheap: batched to the 25 ms floor, a per-call cost of 2 ms
      },
      () => t,
    );

    expect(smallCalls).toBe(3 * (1 + 25));
  });

  it('caps that matched batch, so a very slow large call cannot stall the suite', () => {
    let t = 0;
    let smallCalls = 0;
    measurePair(
      () => {
        smallCalls += 1;
        t += 1;
      },
      () => {
        t += 5_000;
      },
      () => t,
    );

    expect(smallCalls).toBe(3 * (1 + 1_000));
  });

  it('keeps the CHEAPEST reading of each size, not the dearest', () => {
    // Noise only ever ADDS time, so the minimum is the least contaminated estimate of the work
    // itself. This workload is cheap for its first batch and 20x dearer thereafter, which puts min
    // and max at opposite ends: keeping the worst would report the dear phase and inflate the
    // baseline, which is exactly how a single slow round would poison the ratio.
    const CHEAP = 40_000;
    const DEAR = 800_000;
    // Comfortably more calls than one batch needs to reach the sample floor, and comfortably fewer
    // than three batches make — so round 1 is entirely cheap and rounds 2 and 3 entirely dear.
    const FIRST_BATCH_CALLS = 4_000;

    const reference = timePerCall(() => burn(CHEAP));

    let calls = 0;
    const measured = measurePair(
      () => {
        calls += 1;
        burn(calls <= FIRST_BATCH_CALLS ? CHEAP : DEAR);
      },
      () => burn(CHEAP),
    );

    // Landing near the all-cheap reference is only possible if the cheap round was the one kept;
    // the dear phase costs 20x as much.
    expect(measured.small).toBeLessThan(reference * 4);
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
    // measurement and it becomes ~16 and fails. A build that costs more at the large size is exactly
    // what the real guards do — they allocate a string proportional to the input.
    expect(() =>
      expectLinearIn(
        (n) => {
          // Quadratic, and scaled so it DOMINATES the linear work at the large size — otherwise the
          // folded-in cost lands right on the ceiling and the test stops discriminating.
          burn((n / 500) * (n / 500));
          return n;
        },
        burn,
        4_000_000,
      ),
    ).not.toThrow();
  });
});
