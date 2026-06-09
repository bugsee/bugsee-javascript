import type { PerformanceApi } from './controller';
import type { Span } from './span';
import { onCLS } from './web-vitals/cls';
import type { WebVitalsEnv } from './web-vitals/env';
import { onFCP } from './web-vitals/fcp';
import { onINP } from './web-vitals/inp';
import { onLCP } from './web-vitals/lcp';
import type { Metric } from './web-vitals/metric';
import { getNavigationEntry } from './web-vitals/navigation';
import { onHidden } from './web-vitals/observe';
import { onTTFB } from './web-vitals/ttfb';

// Navigation-timing breakdown (Sentry browser.* / Datadog view.* parity) → `nav.<phase>_ms` attributes
// on the pageload transaction. A phase is skipped when its start or end is missing/zero (a cache hit or
// redirect leaves them 0; secureConnectionStart is 0 with no TLS; responseEnd is 0 while the HTML is
// still streaming), so we never emit a bogus or negative duration.
export function collectNavigationTiming(env: WebVitalsEnv, transaction: Span): void {
  const nav = getNavigationEntry(env);
  if (nav === undefined) return;
  const phase = (key: string, start: number | undefined, end: number | undefined): void => {
    if (start && end && end >= start) {
      transaction.setAttribute(`nav.${key}_ms`, Math.round(end - start));
    }
  };
  phase('redirect', nav.redirectStart, nav.redirectEnd);
  phase('dns', nav.domainLookupStart, nav.domainLookupEnd);
  phase('connect', nav.connectStart, nav.connectEnd);
  phase('tls', nav.secureConnectionStart, nav.connectEnd); // secureConnectionStart 0 → no TLS → skipped
  phase('request', nav.requestStart, nav.responseStart);
  phase('response', nav.responseStart, nav.responseEnd); // responseEnd 0 while streaming → skipped
  const milestone = (key: string, value: number | undefined): void => {
    if (value) transaction.setAttribute(`nav.${key}_ms`, Math.round(value));
  };
  milestone('dom_interactive', nav.domInteractive);
  milestone('dom_content_loaded', nav.domContentLoadedEventEnd);
  milestone('load', nav.loadEventEnd);
}

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
  // Finalize ONCE (hidden fires for both visibilitychange + pagehide): collect navigation timing then
  // finish — registered after the vital onHidden listeners, so LCP/CLS/INP report their final values first.
  let finalized = false;
  onHidden(env, () => {
    if (finalized) return;
    finalized = true;
    collectNavigationTiming(env, transaction);
    transaction.finish();
  });
}
