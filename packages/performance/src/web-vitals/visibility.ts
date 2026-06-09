import type { WebVitalsEnv } from './env';

// First-hidden-time watcher (reimplemented from web-vitals lib/getVisibilityWatcher — design reference).
// Paint metrics (FCP/LCP) drop entries that occur AFTER the page was first hidden, so a tab loaded in the
// background does not report a bogus paint time. firstHiddenTime = 0 if hidden at creation, the clock at
// the first hidden transition otherwise, else Infinity (never hidden).

export interface VisibilityWatcher {
  readonly firstHiddenTime: number;
}

export function createVisibilityWatcher(env: WebVitalsEnv): VisibilityWatcher {
  let firstHiddenTime = env.document?.visibilityState === 'hidden' ? 0 : Number.POSITIVE_INFINITY;
  const markHidden = () => {
    firstHiddenTime = Math.min(firstHiddenTime, env.performance?.now() ?? 0);
  };
  env.document?.addEventListener(
    'visibilitychange',
    () => {
      if (env.document?.visibilityState === 'hidden') markHidden();
    },
    { capture: true },
  );
  env.window?.addEventListener('pagehide', markHidden, { capture: true });
  return {
    get firstHiddenTime() {
      return firstHiddenTime;
    },
  };
}
