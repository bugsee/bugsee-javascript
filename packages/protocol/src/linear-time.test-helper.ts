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

/** How many times each size is measured. The BEST is kept — see `bestOf`. */
const ATTEMPTS = 3;

/**
 * A baseline below this is too small to divide by: at that scale the reading is mostly clock noise,
 * and a ratio built on it says nothing. Failing is the right answer — the fix is a larger input, not
 * a more forgiving rule.
 */
const MIN_BASELINE_MS = 0.02;

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

/**
 * The BEST of `attempts` measurements.
 *
 * Noise only ever ADDS time — a GC pause, a scheduler preemption, another job on a shared runner —
 * so the minimum is the least contaminated estimate of what the work itself costs. An average lets a
 * single pause decide the verdict, which is how this guard failed on a shared runner while the code
 * under it was provably linear.
 */
export const bestOf = (attempts: number, fn: () => void): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < attempts; i += 1) {
    const elapsed = measure(fn);
    if (elapsed < best) {
      best = elapsed;
    }
  }
  return best;
};

/**
 * Assert that `work` scales linearly in the size of the input `prepare` builds.
 *
 * ⚠️ `prepare` IS DELIBERATELY NOT MEASURED. Building a 400 KB string costs real time and real
 * allocation, and it costs *more at the large size than at the small one* — so folding it into the
 * measurement adds a super-linear term that has nothing to do with the code under test. That is not
 * hypothetical: with the build inside the measured region this guard read 5 ms at 100 K and 98 ms at
 * 400 K on a loaded runner — a 19x ratio for a scan that measures 4x when timed on its own.
 */
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
  const small = bestOf(ATTEMPTS, () => work(smallInput));
  const large = bestOf(ATTEMPTS, () => work(largeInput));

  if (small < MIN_BASELINE_MS) {
    throw new Error(
      `linearity baseline is unmeasurably small (${small.toFixed(4)} ms < ${MIN_BASELINE_MS} ms) — ` +
        'raise the size rather than relaxing the ceiling',
    );
  }

  expect(large / small).toBeLessThan(LINEAR_BUDGET);
};
