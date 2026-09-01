/**
 * Resolve a usable `performance.timeOrigin`.
 *
 * Shared by every call site that converts a `performance.now()`-relative reading into a wire epoch-ms
 * timestamp (render-span helpers in `@bugsee/react`/`angular`/`svelte`/`vue`, `@bugsee/performance`'s
 * navigation/long-task/resource-timing collection). Each of those timestamps nests as a child span inside
 * a transaction whose OWN start time comes from a real wall clock (`Date.now()`-based), so an unusable
 * origin cannot be allowed to silently produce a nonsensical position (or `NaN`) in an otherwise-real trace.
 *
 * "Usable" means finite AND non-zero:
 *  - `NaN` / `Infinity` / `-Infinity` poison any sum they participate in — screened by `Number.isFinite`,
 *    which (unlike `??`) is false for anything that isn't literally a `number`, so it also screens a
 *    non-number arriving through an unchecked `globalThis` cast (a hostile/non-compliant host) in the same
 *    test.
 *  - A literal `0` is treated as "no real origin" too, even though it passes `Number.isFinite`: no
 *    spec-compliant host anchors its performance clock at the Unix epoch, so accepting it would just be
 *    `NaN`'s twin failure mode — every timestamp derived from it lands ~1970, decades before the
 *    transaction it is nested in.
 *
 * When the origin is unusable, this reconstructs one from a live wall-clock reading: `Date.now() -
 * perf.now()` is exactly the quantity `timeOrigin` is spec-defined to be, just recomputed instead of
 * trusted from the host. Degrades precision (loses `performance.now()`'s sub-millisecond alignment — two
 * `now()` calls microseconds apart no longer cancel exactly) but keeps the result anchored to reality
 * instead of the Unix epoch. When `perf` itself (or its `now`) is unusable too, this collapses to plain
 * `Date.now()` (the `now()` term drops to 0), which is still a real, if coarser, epoch anchor.
 */
export function resolveTimeOrigin(
  perf: { now?: () => unknown; timeOrigin?: unknown } | undefined,
): number {
  const origin = perf?.timeOrigin;
  if (Number.isFinite(origin) && origin !== 0) {
    return origin as number;
  }
  const nowFn = perf?.now;
  const relativeNow = typeof nowFn === 'function' ? nowFn.call(perf) : undefined;
  const usableRelativeNow = typeof relativeNow === 'number' && Number.isFinite(relativeNow);
  return Date.now() - (usableRelativeNow ? relativeNow : 0);
}
