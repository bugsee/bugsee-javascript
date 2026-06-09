import type { PerformanceApi } from './controller';
import { onCLS } from './web-vitals/cls';
import type { WebVitalsEnv } from './web-vitals/env';
import { onFCP } from './web-vitals/fcp';
import { onINP } from './web-vitals/inp';
import { onLCP } from './web-vitals/lcp';
import type { Metric } from './web-vitals/metric';
import { onHidden } from './web-vitals/observe';
import { onTTFB } from './web-vitals/ttfb';

// Collect the five Core Web Vitals into a single `pageload` transaction (the Sentry/Datadog page-load
// model). Each metric, as it reports, stamps `web_vital.<name>.value` + `.rating` attributes on the
// transaction; the transaction finishes when the page is hidden (after LCP/CLS/INP have finalized — the
// vital onHidden listeners are registered before this one, so they run first). The finished transaction
// is buffered by the controller for delivery (bundle / continuous upload).

export interface PageLoadVitalsOptions {
  /** The page name (URL / route) used as the transaction name. */
  name: string;
}

export function collectPageLoadVitals(
  env: WebVitalsEnv,
  api: PerformanceApi,
  options: PageLoadVitalsOptions,
): void {
  const transaction = api.startTransaction({ name: options.name, operation: 'pageload' });
  const stamp =
    (key: string) =>
    (metric: Metric): void => {
      transaction.setAttribute(`web_vital.${key}.value`, metric.value);
      transaction.setAttribute(`web_vital.${key}.rating`, metric.rating);
    };
  onTTFB(env, stamp('ttfb'));
  onFCP(env, stamp('fcp'));
  onLCP(env, stamp('lcp'));
  onCLS(env, stamp('cls'));
  onINP(env, stamp('inp'));
  onHidden(env, () => transaction.finish());
}
