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
 * divides out.
 */

/**
 * The size gap between the two measurements. Linear work costs about this much more at the large
 * size; quadratic work costs about the SQUARE of it.
 *
 * ⚠️ 16x RATHER THAN THE 4x THIS STARTED WITH, and the reason is measured rather than chosen. At 4x
 * the two outcomes are 4 and 16 — a factor of four apart — and the CI runner inflates a real
 * string-scanning ratio by about 2.1x even with batched samples (it read 8.56 and 8.77 for work that
 * measures 4.07 on an idle machine). Half the available separation went to noise and the guard
 * failed on healthy code twice.
 *
 * At 16x the outcomes are 16 and 256 — a factor of SIXTEEN apart — so the same 2.1x inflation moves
 * healthy work to ~34 and quadratic work to ~122, and the ceiling below sits between them with
 * comparable room on each side. The large size is unchanged, so a broken build costs no more to
 * detect than it did before; only the baseline moved down.
 */
const SIZE_SEPARATION = 16;

/**
 * The ceiling, expressed as a multiple of what the SAME MACHINE measures for work that is linear by
 * construction (see `referenceRatioFor`). Healthy work lands near 1x that reference and quadratic
 * work near `SIZE_SEPARATION`x it, so 4 is the geometric middle with equal room on each side.
 *
 * It is a RELATIVE budget because an absolute one is not portable, and that cost two red builds. A
 * fixed ceiling of 64 was calibrated on one machine; the CI runner measured healthy XML work at 65.8
 * and 65.3 — twice, once under load and once idle, so it was not noise — while the same work reads
 * ~15 here. Duration-matching the two samples was tried first and did not move it, which rules out
 * unequal exposure to scheduling noise and leaves the large side being genuinely disproportionate on
 * that hardware (a 200 KB input falls out of a cache that a 12.5 KB one sits inside). A reference
 * measured in the same run, at the same two sizes, with the same memory shape, absorbs exactly that.
 */
export const LINEAR_TOLERANCE = 4;

/**
 * The time budget for a test that calls {@link expectLinearIn} — a HANG guard, not a performance
 * assertion, so it is sized from what the measurement genuinely costs and never tuned to pass.
 *
 * Each call measures TWO workloads at two sizes over several rounds: the subject, and the control it
 * is judged against (the same work on benign input, or a reference scan) — twice the work of the
 * version the old 30 s limit was set for. The slowest caller, the three-shape XML guard, measures
 * 3.4 s on a developer machine and 4.0 s under coverage instrumentation.
 *
 * On 2026-09-23 it took 32.9 s on the CI runner and failed. That is NOT the runner's speed — idle, it
 * is at least as fast as a developer machine (this guard ran in 618 ms there on 2026-09-22, and
 * docs/dev-environment.md records the old "runner is 7–18× slower" note as obsolete). Nor is it a
 * race: the work is CPU-bound with nothing to lose a race against. It is CONTENTION — the runner is
 * one machine shared by several repositories' jobs — and contention has no fixed ceiling, so the only
 * honest budget is a generous multiple of the real cost: 120 s is ~30× it, and still stops a
 * measurement that has genuinely hung.
 */
export const LINEARITY_TEST_TIMEOUT_MS = 120_000;

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
 * The ceiling on a MATCHED small-side batch (see `measurePair`).
 *
 * The small side is batched to last as long as one large call, but a large call can run for seconds
 * under coverage on the runner (1.6 s measured), and matching that in full across three rounds and
 * several shapes would push a guard past its 30 s timeout. A second still spans the scheduler's core
 * moves, which is the noise being matched.
 */
const MATCHED_SAMPLE_CAP_MS = 1_000;

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
export const timePerCall = (
  fn: () => void,
  clock: () => number = now,
  minSampleMs: number = MIN_SAMPLE_MS,
): number => {
  let iterations = 1;
  for (let step = 0; step < MAX_SCALE_STEPS; step += 1) {
    const started = clock();
    for (let i = 0; i < iterations; i += 1) {
      fn();
    }
    const elapsed = clock() - started;
    if (elapsed >= minSampleMs) {
      return elapsed / iterations;
    }
    // Scale toward the floor, but always advance: a zero reading would otherwise multiply by zero.
    if (iterations >= MAX_ITERATIONS) {
      break;
    }
    iterations = Math.min(
      MAX_ITERATIONS,
      elapsed > 0
        ? Math.max(iterations + 1, Math.ceil(iterations * (minSampleMs / elapsed)))
        : iterations * 8,
    );
  }
  throw new Error(
    `work never accumulated ${minSampleMs} ms of runtime — it may have been optimized away`,
  );
};

/**
 * Measure both sizes over `ROUNDS` INTERLEAVED rounds and keep the best of each.
 *
 * DURATION-MATCHED: each round times the large side first, then batches the small side until it has
 * run about as long as ONE large call (never less than `MIN_SAMPLE_MS`, never more than
 * `MATCHED_SAMPLE_CAP_MS`). Before this, a large sample that was a single 1.6 s call on the CI runner
 * straddled the scheduler moving the thread between performance and efficiency cores, while the 25 ms
 * small batch usually did not — so the noise inflated ONLY the large side, and healthy XML work read
 * 65.5 against a ceiling of 64 (it measures ~16 locally). Equal-length samples see the same noise.
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
  clock: () => number = now,
): { small: number; large: number } => {
  let bestSmall = Number.POSITIVE_INFINITY;
  let bestLarge = Number.POSITIVE_INFINITY;
  for (let round = 0; round < ROUNDS; round += 1) {
    // Per-call cost of the large side; when it already exceeds the floor it ran ONCE, so this is also
    // how long that single sample lasted.
    const largeCost = timePerCall(large, clock);
    bestLarge = Math.min(bestLarge, largeCost);
    const matched = Math.min(MATCHED_SAMPLE_CAP_MS, Math.max(MIN_SAMPLE_MS, largeCost));
    bestSmall = Math.min(bestSmall, timePerCall(small, clock, matched));
  }
  return { small: bestSmall, large: bestLarge };
};

/**
 * Work that is LINEAR BY CONSTRUCTION — one pass over a string of the given length — used to
 * calibrate the ceiling on the machine actually running the test.
 *
 * It is deliberately STRING-SHAPED rather than a pure arithmetic loop. What makes a machine read a
 * healthy subject as superlinear is the large input falling out of a cache the small one fits in, and
 * a reference that touches no memory would not feel that and so would not correct for it. Every
 * subject this calibrates scans a body, so the reference scans one too.
 */
const referenceWork = (input: string): void => {
  let hits = 0;
  for (let i = 0; i < input.length; i += 1) {
    // `0x61` is the character the input is built from, so the body runs on EVERY iteration: the
    // reference must pay a per-character cost, not just walk the string. Counting something absent
    // would let the branch predictor skip the work the subjects actually do.
    if (input.charCodeAt(i) === 0x61) {
      hits += 1;
    }
  }
  // Consumed so the loop cannot be optimized away, the same guard the subjects' own `burn` uses.
  /* v8 ignore next 3 -- unreachable by construction: `hits` counts matches, so it is never negative.
     The comparison exists only to make the loop's result observable to the optimizer. */
  if (hits === -1) {
    throw new Error('unreachable — keeps the reference scan from being optimized away');
  }
};

/**
 * The ratio the reference produces at this size on this machine — what "linear" MEASURES here, as
 * opposed to what it predicts (`SIZE_SEPARATION`). Memoised: it depends only on the size, and several
 * subjects share one, so a suite pays for each distinct size once.
 */
const referenceRatios = new Map<number, number>();

const referenceRatioFor = (size: number): number => {
  const cached = referenceRatios.get(size);
  if (cached !== undefined) {
    return cached;
  }
  const small = 'a'.repeat(Math.round(size / SIZE_SEPARATION));
  const large = 'a'.repeat(Math.round(size));
  const measured = measurePair(
    () => referenceWork(small),
    () => referenceWork(large),
  );
  const ratio = measured.large / measured.small;
  referenceRatios.set(size, ratio);
  return ratio;
};

/**
 * How much MORE than linear the subject grew, in multiples of what linear growth actually measures on
 * this machine. 1 means "grew exactly like known-linear work"; `SIZE_SEPARATION` means quadratic.
 *
 * Extracted so the arithmetic that decides the verdict can be checked against real readings without
 * needing the machine that produced them — the CI runner reads 65x for work this machine reads at 15x,
 * and neither number can be conjured locally.
 */
export const linearityVerdict = (observed: number, reference: number): number =>
  observed / reference;

export const expectLinearIn = <T>(
  prepare: (size: number) => T,
  work: (input: T) => void,
  size: number,
  benign?: (size: number) => T,
): void => {
  // Warm up BELOW the baseline, purely to get the path JIT-compiled before the baseline is taken. An
  // unwarmed baseline is inflated, which makes the ceiling too generous and could mask a regression.
  work(prepare(size / (SIZE_SEPARATION * 4)));

  const smallInput = prepare(size / SIZE_SEPARATION);
  const largeInput = prepare(size);
  const { small, large } = measurePair(
    () => work(smallInput),
    () => work(largeInput),
  );

  // No "is the baseline measurable" check any more: `timePerCall` guarantees every sample runs for
  // at least MIN_SAMPLE_MS, so a per-call cost is always positive and always meaningful. The
  // invariant moved from a defensive branch nothing could reach into the construction of the
  // measurement itself.
  const observed = large / small;
  // The control, and the best one available: THE SAME `work`, at the same two sizes, on input that
  // cannot reach the shape under suspicion. Same code path, same allocations, same regexes — only the
  // hostile shape differs, so whatever the machine does to this function it does to both sides.
  //
  // A synthetic scan was tried first and was WRONG in a way worth recording: it read 6.8x on the CI
  // runner where it reads 14.2x here, because it only walks characters and never allocates, so it
  // could not feel the thing that actually stretches the subject on a small container. Calibrating
  // against work of a different shape is calibrating against a different question.
  const reference =
    benign === undefined
      ? referenceRatioFor(size)
      : (() => {
          const refSmall = benign(size / SIZE_SEPARATION);
          const refLarge = benign(size);
          const pair = measurePair(
            () => work(refSmall),
            () => work(refLarge),
          );
          return pair.large / pair.small;
        })();
  const verdict = linearityVerdict(observed, reference);

  // EVERY number rides along in the message. This fails on machines that cannot be inspected, and
  // the verdict alone does not say whether the subject grew, the baseline shrank, or the machine
  // simply reads a 16x step as more than 16x for everything — which is the whole reason the ceiling
  // is relative. The reference reading is what separates those.
  expect(
    verdict,
    `linearity: ${small.toFixed(4)} ms at n/${SIZE_SEPARATION} vs ${large.toFixed(4)} ms at n ` +
      `= ${observed.toFixed(1)}x, against ${reference.toFixed(1)}x for work that is linear by ` +
      `construction on this machine (quadratic would be ~${SIZE_SEPARATION}x the reference)`,
  ).toBeLessThan(LINEAR_TOLERANCE);
};
