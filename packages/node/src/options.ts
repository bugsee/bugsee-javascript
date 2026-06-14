import type { OptionDefinition } from '@bugsee/core';

// @bugsee/node owns its platform-specific diagnostic options. These have NO Android counterpart and no
// cross-SDK identity, so — per the @bugsee/protocol convention (and as @bugsee/performance does) — they are
// declared HERE, not in the cross-SDK BugseeOption enum: the canonical com.bugsee.option.profiling.*
// identifiers, the typed value contract declaration-merged into BugseeOptionTypes, and the
// friendly→canonical definitions launch feeds to the resolver. (ANR/hang options join this module too.)

export const ProfilingOption = {
  /** Attach a rolling V8 CPU profile to incident bundles. Default off (overhead). */
  Enabled: 'com.bugsee.option.profiling.enabled',
  /** CPU profiler sampling interval in microseconds (lower = higher resolution + overhead). */
  SamplingInterval: 'com.bugsee.option.profiling.sampling-interval-micros',
} as const;

declare module '@bugsee/protocol' {
  interface BugseeOptionTypes {
    'com.bugsee.option.profiling.enabled': boolean;
    'com.bugsee.option.profiling.sampling-interval-micros': number;
  }
}

/** Friendly → canonical option definitions for the launch resolver. Profiling is opt-in (overhead). */
export const PROFILING_OPTION_DEFINITIONS: readonly OptionDefinition[] = [
  { friendly: 'profiling', key: ProfilingOption.Enabled, default: false },
  {
    friendly: 'profilingSamplingIntervalMicros',
    key: ProfilingOption.SamplingInterval,
    default: 1000,
  },
];
