import type { PerformanceEntryLike, WebVitalsEnv } from './env';
import type { NavigationType } from './metric';

// Navigation-timing helpers (reimplemented from web-vitals lib/getNavigationEntry + getActivationStart +
// initMetric's navigationType derivation — design reference only). The navigation entry is the source of
// TTFB (responseStart) and the prerender offset (activationStart); the navigation type classifies how the
// page was loaded.

export interface NavigationTimingLike extends PerformanceEntryLike {
  readonly responseStart?: number;
  readonly responseEnd?: number;
  readonly requestStart?: number;
  readonly domainLookupStart?: number;
  readonly domainLookupEnd?: number;
  readonly connectStart?: number;
  readonly connectEnd?: number;
  readonly secureConnectionStart?: number;
  readonly redirectStart?: number;
  readonly redirectEnd?: number;
  readonly domInteractive?: number;
  readonly domContentLoadedEventEnd?: number;
  readonly loadEventEnd?: number;
  readonly activationStart?: number;
  /** 'navigate' | 'reload' | 'back_forward' | 'prerender'. */
  readonly type?: string;
}

export function getNavigationEntry(env: WebVitalsEnv): NavigationTimingLike | undefined {
  return env.performance?.getEntriesByType('navigation')[0] as NavigationTimingLike | undefined;
}

/** The prerender activation offset (paint metrics subtract it); 0 when not prerendered. */
export function getActivationStart(env: WebVitalsEnv): number {
  return getNavigationEntry(env)?.activationStart ?? 0;
}

/** Classify the navigation (prerender / restore / the entry's type with underscores → hyphens). */
export function getNavigationType(env: WebVitalsEnv): NavigationType {
  if (env.document?.prerendering || getActivationStart(env) > 0) return 'prerender';
  if (env.document?.wasDiscarded) return 'restore';
  const type = getNavigationEntry(env)?.type;
  return type !== undefined ? (type.replace(/_/g, '-') as NavigationType) : 'navigate';
}
