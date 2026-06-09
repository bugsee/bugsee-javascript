import type { WebVitalsEnv } from './env';
import { bindReporter, initMetric, type Metric, THRESHOLDS } from './metric';
import { getActivationStart, getNavigationEntry, getNavigationType } from './navigation';
import type { VitalReportOptions } from './vitals';

// TTFB (reimplemented from web-vitals onTTFB — design reference). Read directly from the navigation entry
// (no observer): responseStart − activationStart, clamped >=0. responseStart is validated (>0 && <now)
// because browsers report 0 for privacy or occasionally garbage/huge values.

export function onTTFB(
  env: WebVitalsEnv,
  callback: (metric: Metric) => void,
  opts: VitalReportOptions = {},
): void {
  const metric = initMetric('TTFB', getNavigationType(env));
  const report = bindReporter(callback, metric, THRESHOLDS.TTFB, opts.reportAllChanges);
  const navEntry = getNavigationEntry(env);
  if (navEntry === undefined) return;
  const responseStart = navEntry.responseStart;
  const now = env.performance?.now() ?? 0;
  if (responseStart === undefined || responseStart <= 0 || responseStart >= now) return; // invalid
  metric.value = Math.max(responseStart - getActivationStart(env), 0);
  metric.entries = [navEntry];
  report(true);
}
