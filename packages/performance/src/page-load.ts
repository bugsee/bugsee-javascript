import { resolveTimeOrigin } from '@bugsee/util';
import type { PerformanceApi } from './controller';
import type { Span } from './span';
import { onCLS } from './web-vitals/cls';
import type { PerformanceEntryLike, WebVitalsEnv } from './web-vitals/env';
import { onFCP } from './web-vitals/fcp';
import { onINP } from './web-vitals/inp';
import { onLCP } from './web-vitals/lcp';
import type { Metric } from './web-vitals/metric';
import { getNavigationEntry } from './web-vitals/navigation';
import { observe, onHidden } from './web-vitals/observe';
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

// Resource timing → one `resource.<initiatorType>` child span per asset (Sentry resource.* parity).
// Rakes: skip fetch/xhr (those are covered by the http-span instrumentation, avoiding duplicates);
// normalize the URL (strip query/fragment + collapse data:/blob:) so it is low-cardinality + PII-free;
// omit a 0 status (cross-origin opaque); cap the count so a resource-heavy page can't bloat the bundle.
const MAX_RESOURCE_SPANS = 100;
const SKIP_INITIATORS = new Set(['fetch', 'xmlhttprequest']);

interface ResourceTimingLike extends PerformanceEntryLike {
  readonly initiatorType?: string;
  readonly transferSize?: number;
  readonly encodedBodySize?: number;
  readonly decodedBodySize?: number;
  readonly responseStatus?: number;
}

const normalizeResourceUrl = (url: string): string => {
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    return `${url.slice(0, url.indexOf(':') + 1)}…`; // collapse the (huge) inline payload
  }
  return url.replace(/[?#].*$/, ''); // strip query + fragment
};

const resourceAttributes = (r: ResourceTimingLike): Record<string, unknown> => {
  const attrs: Record<string, unknown> = {};
  if (r.responseStatus) attrs['http.status_code'] = r.responseStatus; // 0 = cross-origin opaque → omit
  if (r.transferSize) attrs['http.transfer_size'] = r.transferSize;
  if (r.encodedBodySize) attrs['http.encoded_body_size'] = r.encodedBodySize;
  if (r.decodedBodySize) attrs['http.decoded_body_size'] = r.decodedBodySize;
  return attrs;
};

// Long tasks (main-thread blocks >50ms) → one `ui.long-task` span each, observed live across the page
// load (recordChildSpan creates an INDEPENDENT span, so — unlike Sentry's startAndEndSpan — a long task
// can never back-date the transaction; the classic back-dating rake is structurally avoided here). The
// longtask startTime is timeOrigin-relative, so it is always within the page load. Capped for safety.
const MAX_LONGTASK_SPANS = 50;

export function collectLongTasks(env: WebVitalsEnv, transaction: Span): void {
  // Not `?? 0`: these spans nest as children of `transaction`, whose OWN start time is a real epoch value
  // (the controller's `Clock.wallNow()`), so an unusable `timeOrigin` cannot be allowed to silently stamp
  // a child ~1970 (or NaN) inside it. `resolveTimeOrigin` (@bugsee/util) screens NaN/Infinity/a non-number
  // (all pass `?? 0` unharmed — only `null`/`undefined` don't) and a literal 0 (no spec-compliant host
  // anchors its clock at the Unix epoch), reconstructing a usable origin from a live wall-clock reading
  // when the host's own is unusable.
  const timeOrigin = resolveTimeOrigin(env.performance);
  let count = 0;
  observe(env, 'longtask', (entries) => {
    for (const e of entries) {
      if (count >= MAX_LONGTASK_SPANS) return;
      count += 1;
      transaction.recordChildSpan('ui.long-task', {
        startTimestampMs: timeOrigin + e.startTime,
        endTimestampMs: timeOrigin + e.startTime + e.duration,
        ...(e.name ? { description: e.name } : {}), // the long-task attribution (self / same-origin / …)
      });
    }
  });
}

export function collectResourceTiming(env: WebVitalsEnv, transaction: Span): void {
  const resources = (env.performance?.getEntriesByType('resource') ?? []) as ResourceTimingLike[];
  // See `collectLongTasks` above for why `?? 0` is wrong here too — same nesting-under-a-real-epoch-
  // transaction reasoning.
  const timeOrigin = resolveTimeOrigin(env.performance);
  let count = 0;
  for (const r of resources) {
    if (count >= MAX_RESOURCE_SPANS) break;
    const initiatorType = r.initiatorType ?? 'other';
    if (SKIP_INITIATORS.has(initiatorType)) continue; // deduped by the http-span instrumentation
    count += 1;
    transaction.recordChildSpan(`resource.${initiatorType}`, {
      startTimestampMs: timeOrigin + r.startTime,
      endTimestampMs: timeOrigin + r.startTime + r.duration,
      description: normalizeResourceUrl(r.name),
      attributes: resourceAttributes(r),
    });
  }
}

// Collect the five Core Web Vitals into a single `pageload` transaction (the Sentry/Datadog page-load
// model). Each metric, as it reports, stamps `web_vital.<name>.value` + `.rating` attributes on the
// transaction; the transaction finishes when the page is hidden (after LCP/CLS/INP have finalized — the
// vital onHidden listeners are registered before this one, so they run first). The finished transaction
// is buffered by the controller for delivery (bundle / continuous upload).

export interface PageLoadVitalsOptions {
  /** The page name (URL / route) used as the transaction name. */
  name: string;
  /** Continue a server-injected trace (the `<meta name="traceparent">` pageload continuation, D4) — the
   *  pageload adopts this trace id + becomes a child of the server span, so SSR and the client are one trace. */
  continuation?: { traceId: string; parentSpanId?: string; sampled?: boolean };
}

export function collectPageLoadVitals(
  env: WebVitalsEnv,
  api: PerformanceApi,
  options: PageLoadVitalsOptions,
): void {
  const transaction = api.startTransaction({
    name: options.name,
    operation: 'pageload',
    ...(options.continuation !== undefined ? { continuation: options.continuation } : {}),
  });
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
  collectLongTasks(env, transaction); // observed live across the load (records as they arrive)
  // Finalize ONCE (hidden fires for both visibilitychange + pagehide): collect navigation + resource
  // timing then finish — registered after the vital onHidden listeners, so LCP/CLS/INP report final first.
  let finalized = false;
  onHidden(env, () => {
    if (finalized) return;
    finalized = true;
    collectNavigationTiming(env, transaction);
    collectResourceTiming(env, transaction);
    transaction.finish();
  });
}
