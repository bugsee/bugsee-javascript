import { expect } from 'vitest';

/**
 * The shared complexity guard for this package's hostile-input tests, and its own tests.
 *
 * TEST-ONLY, despite living in `src/`: nothing exports it from `index.ts`, so it never reaches the
 * published entry graph. It is NOT named `*.test.ts` on purpose — that would make vitest collect it
 * as a suite, and every file importing it would re-run its tests. The trade is that the coverage gate
 * counts it as ordinary source, which is the safer direction: `linear-time.test.ts` covers it fully
 * rather than the gate being widened to let a whole filename pattern escape.
 *
 * It was duplicated verbatim in `pairs.test.ts` and `sanitize.test.ts` before. Two copies of a
 * measurement rule drift, and only one of them ever gets fixed.
 *
 * WHAT IT ASSERTS: a RATIO, never a wall-clock budget. Both measurements are taken on the same
 * machine, in the same process, under the same instrumentation, so however slow that machine is
 * divides out. 4x the input costs about 4x the time when the work is linear and about 16x when it is
 * quadratic; the ceiling sits between the two.
 */

/** 4x the input must not cost 8x the time. Linear lands near 4x, quadratic near 16x. */
export const LINEAR_BUDGET = 8;

// `performance.now()`, not `Date.now()`: this tier compiles with neither the DOM nor the Node libs
// (tsconfig.base `lib: ["ES2023"]`, `types: []`), so it is reached through the same globalThis cast
// the runtime-portable tiers use. Millisecond resolution is NOT ample, which is what the previous
// version got wrong: on a fast machine the baseline rounded to 0-1 ms, and the floor that was added
// to compensate quietly converted this from a ratio into a fixed 40 ms wall-clock ceiling.
const now = (): number =>
  (globalThis as unknown as { performance: { now(): number } }).performance.now();

/**
 * One measurement, in milliseconds.
 *
 * Exported for the one guard that legitimately wants an ABSOLUTE ceiling rather than a ratio: the
 * `end`-overshoot test, whose baseline is a 14-character scan that no clock can resolve, and whose
 * defect costs 301 ms against ~0. When the gap is six orders of magnitude an absolute budget
 * separates the two cleanly; it is only the 4x-versus-16x distinction that needs a ratio.
 */
export const measure = (fn: () => void): number => {
  const started = now();
  fn();
  return now() - started;
};

/** How many interleaved rounds each size is measured over. The BEST of each is kept — see below. */
const ROUNDS = 3;

/**
 * How long ONE measurement must run before it is trusted, in milliseconds.
 *
 * ⚠️ THIS IS THE LOAD-BEARING NUMBER, and the reason is specific to the runner. A single 400 K scan
 * takes well under a millisecond, and macOS moves a CI runner's low-QoS threads between performance
 * and efficiency cores, which differ by roughly 3x. A sub-millisecond sample lands entirely on
 * whichever core it happened to get, so the ratio measures the SCHEDULER. Proof: a bare integer loop
 * — no allocation, no strings, linear by construction — measured 8.31x for a 4x input on that
 * machine, and failed a ceiling of 8.
 *
 * Repeating the work until the batch reaches this long makes a mid-batch migration a fraction of the
 * sample rather than the whole of it. 25 ms costs about a second across all six guards.
 */
const MIN_SAMPLE_MS = 25;

/**
 * Refuse to spin forever if the work never accumulates time. A real clock always advances, so this
 * only fires for a stopped one — but without it, `MIN_SAMPLE_MS / 0` is Infinity and the inner loop
 * becomes an unbreakable spin. `clock` is injectable purely so that case can be tested rather than
 * asserted about in a comment.
 */
const MAX_SCALE_STEPS = 40;

/**
 * And a ceiling on the batch itself. Scaling alone is not enough: eightfold growth reaches ~10^36
 * iterations well before step 40, so the INNER loop spins forever and the escape above never runs.
 * A stopped clock hits this cap instead and fails in about a tenth of a second. Sized far above what
 * genuinely cheap work needs — a no-op batch this long already runs for ~100 ms, four times the
 * sample floor.
 */
const MAX_ITERATIONS = 1e8;

/**
 * The cost of ONE call to `fn`, in milliseconds, measured over a batch long enough to be resistant
 * to scheduling noise.
 *
 * Work that already exceeds the floor in a single call — which is every BROKEN case this guards
 * against — runs exactly once, so a quadratic defect does not multiply into a timeout.
 */
export const timePerCall = (fn: () => void, clock: () => number = now): number => {
  let iterations = 1;
  for (let step = 0; step < MAX_SCALE_STEPS; step += 1) {
    const started = clock();
    for (let i = 0; i < iterations; i += 1) {
      fn();
    }
    const elapsed = clock() - started;
    if (elapsed >= MIN_SAMPLE_MS) {
      return elapsed / iterations;
    }
    // Scale toward the floor, but always advance: a zero reading would otherwise multiply by zero.
    if (iterations >= MAX_ITERATIONS) {
      break;
    }
    iterations = Math.min(
      MAX_ITERATIONS,
      elapsed > 0
        ? Math.max(iterations + 1, Math.ceil(iterations * (MIN_SAMPLE_MS / elapsed)))
        : iterations * 8,
    );
  }
  throw new Error(
    `work never accumulated ${MIN_SAMPLE_MS} ms of runtime — it may have been optimized away`,
  );
};

/**
 * Measure both sizes over `ROUNDS` INTERLEAVED rounds and keep the best of each.
 *
 * Interleaved, not one size and then the other: the failure this replaced measured three small runs
 * and then three large ones, so a throttling episode or a core migration between the two blocks
 * moved one group entire and the ratio absorbed all of it. Alternating means both sizes sample the
 * same conditions. The minimum is kept because noise only ever ADDS time, so the cheapest reading is
 * the least contaminated estimate of the work itself.
 */
export const measurePair = (
  small: () => void,
  large: () => void,
): { small: number; large: number } => {
  let bestSmall = Number.POSITIVE_INFINITY;
  let bestLarge = Number.POSITIVE_INFINITY;
  for (let round = 0; round < ROUNDS; round += 1) {
    bestSmall = Math.min(bestSmall, timePerCall(small));
    bestLarge = Math.min(bestLarge, timePerCall(large));
  }
  return { small: bestSmall, large: bestLarge };
};

export const expectLinearIn = <T>(
  prepare: (size: number) => T,
  work: (input: T) => void,
  size: number,
): void => {
  // Warm up on a SMALL input, purely to get the path JIT-compiled before the baseline is taken. An
  // unwarmed baseline is inflated, which makes the ceiling too generous and could mask a regression.
  work(prepare(size / 16));

  const smallInput = prepare(size / 4);
  const largeInput = prepare(size);
  const { small, large } = measurePair(
    () => work(smallInput),
    () => work(largeInput),
  );

  // No "is the baseline measurable" check any more: `timePerCall` guarantees every sample runs for
  // at least MIN_SAMPLE_MS, so a per-call cost is always positive and always meaningful. The
  // invariant moved from a defensive branch nothing could reach into the construction of the
  // measurement itself.
  expect(large / small).toBeLessThan(LINEAR_BUDGET);
};
