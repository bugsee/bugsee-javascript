// Head sampling: turn a performanceSampleRate (0..1) into the controller's `() => boolean` decision,
// made once per transaction. random is injectable for deterministic tests.

export function createRateSampler(rate: number, random: () => number = Math.random): () => boolean {
  if (rate >= 1) return () => true; // sample everything (skip the RNG)
  if (rate <= 0) return () => false; // sample nothing
  return () => random() < rate;
}
