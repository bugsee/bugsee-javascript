import type { BugseeClient } from '@bugsee/core';
import {
  createPerformanceFacade,
  type PerformanceApi,
  type PerformanceFacade,
} from '@bugsee/performance';

// The mobile SDKs expose `Bugsee.startTransaction` / `startSpan` / `getActiveSpan` as top-level calls.
// In JS the performance API lives behind `client.ext('performance')`; this installs thin pass-throughs on
// the launched client so the same calls work directly. Entries that never wire performance (workers,
// edge) get the same methods, backed by no-ops, exactly as the mobile SDKs behave with performance off.

/**
 * `ext('performance')` throws when nothing registered it (performance off, or a runtime without it). A client
 * that is not launched (never started, stopped, or killed by the collector) records nothing, as on the mobile
 * SDKs: the extension stays registered after `stop()`, so without this check new transactions would still be
 * created and a later flush would upload them.
 */
function performanceApiOf(client: BugseeClient): PerformanceApi | undefined {
  try {
    return client.isLaunched() ? client.ext('performance') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Install the performance pass-throughs on `client` IN PLACE (the client is the process singleton, so a
 * repeat launch sees the same methods). Idempotent. Resolves the performance API on every call, so it
 * works whether the extension was wired before or after this runs.
 */
export function withPerformanceFacade<C extends BugseeClient>(client: C): C & PerformanceFacade {
  const target = client as C & Partial<PerformanceFacade>;
  if (target.startTransaction === undefined) {
    const facade = createPerformanceFacade(() => performanceApiOf(client));
    target.startTransaction = facade.startTransaction;
    target.startSpan = facade.startSpan;
    target.getActiveSpan = facade.getActiveSpan;
  }
  return client as C & PerformanceFacade;
}
