import type { WebVitalsEnv } from './env';
import { bindReporter, initMetric, type Metric, THRESHOLDS } from './metric';
import { getActivationStart, getNavigationType } from './navigation';
import { observe } from './observe';
import { createVisibilityWatcher } from './visibility';
import type { VitalReportOptions } from './vitals';

// FCP (reimplemented from web-vitals onFCP — design reference). The first `paint` entry named
// 'first-contentful-paint' (NOT 'first-paint'): report once, value = startTime − activationStart clamped
// >=0, disconnecting the observer. Gated by the visibility watcher — an FCP that occurs after the page
// was first hidden (a background-loaded tab) is dropped.

export function onFCP(
  env: WebVitalsEnv,
  callback: (metric: Metric) => void,
  opts: VitalReportOptions = {},
): void {
  const watcher = createVisibilityWatcher(env);
  const metric = initMetric('FCP', getNavigationType(env));
  const report = bindReporter(callback, metric, THRESHOLDS.FCP, opts.reportAllChanges);
  const activationStart = getActivationStart(env);
  const observer = observe(env, 'paint', (entries) => {
    for (const entry of entries) {
      if (entry.name === 'first-contentful-paint') {
        observer?.disconnect(); // report once
        if (entry.startTime < watcher.firstHiddenTime) {
          metric.value = Math.max(entry.startTime - activationStart, 0);
          metric.entries = [entry];
          report(true);
        }
      }
    }
  });
}
