import type { OptionDefinition } from '@bugsee/core';

// The @bugsee/performance extension owns its options (design §0.6 — `performance.*` were removed from
// core BugseeOptions). Canonical com.bugsee.option.performance.* identifiers, the typed value contract
// declaration-merged into @bugsee/protocol's BugseeOptionTypes, and the friendly→canonical definitions
// the launch / umbrella feeds to the core resolver.

export const PerformanceOption = {
  /** Master gate: capture performance (web-vitals + transactions). */
  Monitoring: 'com.bugsee.option.performance.monitoring',
  /** Head sampling rate for transactions, 0..1. */
  SampleRate: 'com.bugsee.option.performance.sample-rate',
  /** Continuous upload cadence: batched (every flush interval) or realtime (per transaction). */
  UploadMode: 'com.bugsee.option.performance.upload-mode',
  /** Batched-upload flush interval in milliseconds. */
  FlushIntervalMs: 'com.bugsee.option.performance.flush-interval-ms',
} as const;

export type PerformanceUploadMode = 'batched' | 'realtime';

declare module '@bugsee/protocol' {
  interface BugseeOptionTypes {
    'com.bugsee.option.performance.monitoring': boolean;
    'com.bugsee.option.performance.sample-rate': number;
    'com.bugsee.option.performance.upload-mode': PerformanceUploadMode;
    'com.bugsee.option.performance.flush-interval-ms': number;
  }
}

/** Friendly → canonical option definitions for the launch resolver. Passive monitoring is on by default. */
export const PERFORMANCE_OPTION_DEFINITIONS: readonly OptionDefinition[] = [
  { friendly: 'performanceMonitoring', key: PerformanceOption.Monitoring, default: true },
  { friendly: 'performanceSampleRate', key: PerformanceOption.SampleRate, default: 1 },
  { friendly: 'performanceUploadMode', key: PerformanceOption.UploadMode, default: 'batched' },
  {
    friendly: 'performanceFlushIntervalMs',
    key: PerformanceOption.FlushIntervalMs,
    default: 30000,
  },
];
