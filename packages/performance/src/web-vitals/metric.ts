import type { PerformanceEntryLike } from './env';

// The web-vitals Metric model + rating + reporter binder (reimplemented from Google's web-vitals
// lib/bindReporter + initMetric + getRating — design reference only). A metric streams toward its final
// value; bindReporter centralizes the report-once / delta-dedup / rating logic that every metric shares.

export type Rating = 'good' | 'needs-improvement' | 'poor';
export type MetricName = 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB';
export type NavigationType =
  | 'navigate'
  | 'reload'
  | 'back-forward'
  | 'back-forward-cache'
  | 'prerender'
  | 'restore';

export interface Metric {
  name: MetricName;
  /** Current value (the -1 sentinel until measured; bindReporter never reports a negative value). */
  value: number;
  rating: Rating;
  /** value − the previously reported value (== value on the first report). */
  delta: number;
  id: string;
  navigationType: NavigationType;
  entries: PerformanceEntryLike[];
}

/** Core Web Vitals good (≤[0]) / poor (>[1]) cutoffs. */
export const THRESHOLDS: Readonly<Record<MetricName, readonly [number, number]>> = {
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

/** Rate a value: strict `>` so a value exactly equal to a threshold falls in the BETTER bucket. */
export function getRating(value: number, thresholds: readonly [number, number]): Rating {
  if (value > thresholds[1]) return 'poor';
  if (value > thresholds[0]) return 'needs-improvement';
  return 'good';
}

/** A per-metric-instance unique id (`v1-<timestamp>-<random>`); a fresh one per bfcache restore. */
export function generateUniqueID(): string {
  return `v1-${Date.now()}-${Math.floor(Math.random() * (9e12 - 1)) + 1e12}`;
}

/** A fresh metric, value initialized to the -1 sentinel (which never reports). */
export function initMetric(name: MetricName, navigationType: NavigationType): Metric {
  return {
    name,
    value: -1,
    rating: 'good',
    delta: 0,
    id: generateUniqueID(),
    navigationType,
    entries: [],
  };
}

/**
 * Bind a reporter to a metric: returns `report(forceReport?)`. It emits ONLY when the value is set
 * (>=0) and either forced or `reportAllChanges`, and only when the value actually changed (delta != 0)
 * or it's the very first report — stamping `delta` + `rating` before the callback.
 */
export function bindReporter(
  callback: (metric: Metric) => void,
  metric: Metric,
  thresholds: readonly [number, number],
  reportAllChanges?: boolean,
): (forceReport?: boolean) => void {
  let prevValue: number | undefined;
  let delta: number;
  return (forceReport?: boolean) => {
    if (metric.value >= 0) {
      if (forceReport || reportAllChanges) {
        delta = metric.value - (prevValue ?? 0);
        // Report on a real change, or the first time (so a genuine 0 reports once).
        if (delta || prevValue === undefined) {
          prevValue = metric.value;
          metric.delta = delta;
          metric.rating = getRating(metric.value, thresholds);
          callback(metric);
        }
      }
    }
  };
}
