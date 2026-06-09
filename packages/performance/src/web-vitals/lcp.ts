import type { PerformanceEntryLike, WebVitalsEnv } from './env';
import { bindReporter, initMetric, type Metric, THRESHOLDS } from './metric';
import { getActivationStart, getNavigationType } from './navigation';
import { observe, onHidden } from './observe';
import { createVisibilityWatcher } from './visibility';
import type { VitalReportOptions } from './vitals';

// LCP (reimplemented from web-vitals onLCP — design reference). Observe `largest-contentful-paint`; the
// candidate is the LAST entry (it can change many times — only the final one matters). Finalize on the
// FIRST of: a trusted keydown, a trusted click, or the page becoming hidden — draining takeRecords()
// first so an entry delivered in the same task isn't lost. Scroll is deliberately NOT a stop signal (it
// can be generated programmatically). Gated by the visibility watcher (drop a candidate after first hide).

const STOP_EVENTS = ['keydown', 'click'] as const;

const runOnce = (fn: () => void): (() => void) => {
  let called = false;
  return () => {
    if (!called) {
      called = true;
      fn();
    }
  };
};

export function onLCP(
  env: WebVitalsEnv,
  callback: (metric: Metric) => void,
  opts: VitalReportOptions = {},
): void {
  const watcher = createVisibilityWatcher(env);
  const metric = initMetric('LCP', getNavigationType(env));
  const report = bindReporter(callback, metric, THRESHOLDS.LCP, opts.reportAllChanges);
  const activationStart = getActivationStart(env);

  const handleEntries = (entries: PerformanceEntryLike[]): void => {
    // Last-entry-wins (process all only when streaming every change).
    const candidates = opts.reportAllChanges ? entries : entries.slice(-1);
    for (const entry of candidates) {
      if (entry.startTime < watcher.firstHiddenTime) {
        metric.value = Math.max(entry.startTime - activationStart, 0);
        metric.entries = [entry];
        report();
      }
    }
  };

  const observer = observe(env, 'largest-contentful-paint', handleEntries);
  if (observer === undefined) return;

  const finalize = runOnce(() => {
    handleEntries(observer.takeRecords()); // drain any pending entry before reporting
    observer.disconnect();
    report(true);
  });

  for (const type of STOP_EVENTS) {
    env.window?.addEventListener(
      type,
      (event) => {
        if (event.isTrusted === true) finalize();
      },
      { capture: true, once: true },
    );
  }
  onHidden(env, finalize);
}
