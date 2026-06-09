import type { PerformanceEntryLike, WebVitalsEnv } from './env';
import { bindReporter, initMetric, type Metric, THRESHOLDS } from './metric';
import { getNavigationType } from './navigation';
import { observe, onHidden } from './observe';
import type { VitalReportOptions } from './vitals';

// CLS (reimplemented from web-vitals onCLS — design reference). Sum layout-shift scores within a SESSION
// WINDOW (a new window starts when the gap since the last shift is >=1s or the window is already >=5s),
// and CLS is the value of the LARGEST window ever seen — NOT the total of all shifts. Shifts that follow
// recent user input (hadRecentInput) are dropped entirely. Finalize on hidden.

const SESSION_GAP_MS = 1000;
const SESSION_MAX_MS = 5000;

interface LayoutShiftLike extends PerformanceEntryLike {
  readonly value: number;
  readonly hadRecentInput: boolean;
}

export function onCLS(
  env: WebVitalsEnv,
  callback: (metric: Metric) => void,
  opts: VitalReportOptions = {},
): void {
  // CLS starts at 0 (a shift-free page reports a good CLS of 0).
  const metric = initMetric('CLS', getNavigationType(env), 0);
  const report = bindReporter(callback, metric, THRESHOLDS.CLS, opts.reportAllChanges);
  let sessionValue = 0;
  let sessionEntries: PerformanceEntryLike[] = [];

  const handleEntries = (entries: PerformanceEntryLike[]): void => {
    for (const entry of entries) {
      const shift = entry as LayoutShiftLike;
      if (shift.hadRecentInput) continue; // ignore shifts right after user input
      const first = sessionEntries[0];
      const last = sessionEntries[sessionEntries.length - 1];
      if (
        sessionValue &&
        first !== undefined &&
        last !== undefined &&
        entry.startTime - last.startTime < SESSION_GAP_MS &&
        entry.startTime - first.startTime < SESSION_MAX_MS
      ) {
        sessionValue += shift.value; // continue the current window
        sessionEntries.push(entry);
      } else {
        sessionValue = shift.value; // start a new window
        sessionEntries = [entry];
      }
      // CLS = the largest window, not the running total.
      if (sessionValue > metric.value) {
        metric.value = sessionValue;
        metric.entries = sessionEntries;
        report();
      }
    }
  };

  const observer = observe(env, 'layout-shift', handleEntries);
  if (observer === undefined) return;
  onHidden(env, () => {
    handleEntries(observer.takeRecords());
    report(true);
  });
}
