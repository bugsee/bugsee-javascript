// Knobs of the esbuild concurrent-build retry (plugin.ts `settledUpload`). A mutable object only so a test can
// shrink the waits; production never changes it and it is not exported from the package entry.
export const uploadTuning = {
  /** Attempts for one directory's upload when it keeps coinciding with another build writing. */
  attempts: 3,
  /**
   * How long a RETRY waits for the other builds of the directory to finish. Bounded and short on purpose:
   * the first attempt never waits, because a build nested inside another (a plugin running esbuild.build()
   * for a worker into the same outdir) cannot finish until its own upload has, so waiting on it would stall
   * the whole build for the full cap.
   */
  idleWaitMs: 5_000,
  pollMs: 25,
};
