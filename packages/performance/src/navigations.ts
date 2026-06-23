import type { EventSubscribable } from '@bugsee/core';
import type { PerformanceApi } from './controller';
import type { NetworkSource } from './http-spans';
import {
  createIdleTransaction,
  type IdleTimer,
  type IdleTransactionHandle,
} from './idle-transaction';
import { realWebVitalsEnv, type WebVitalsEnv } from './web-vitals/env';
import { onHidden } from './web-vitals/observe';

// Wire an (injected) navigation SOURCE to navigation transactions (frontend-adapters F1c). Each detected
// navigation supersedes the previous one (finish it) and opens a new `navigation` transaction wrapped in
// the idle lifecycle (auto-finish on inactivity). In-flight network activity keeps the transaction alive
// (the idle timer resets), and the tab going hidden cancels it. The source is a structural abstraction
// (the @bugsee/browser navigation source, injected by the umbrella — same shape as `networkSource`), so
// @bugsee/performance owns the transaction machinery without depending on the browser tier.

/** The minimal navigation detail the wiring reads — structurally matches the browser `NavigationDetail`. */
export interface NavigationDetailLike {
  /** The destination path / adapter name → the transaction name. */
  to: string;
  navigationType: string;
  /** Provenance: `url` (built-in, raw) vs `route`/`custom` (adapter-supplied). */
  source: string;
}

/** A listenable source of navigations (the browser `NavigationSource` satisfies this). */
export type NavigationSource = EventSubscribable<{ navigate: NavigationDetailLike }>;

export interface CollectNavigationsDeps {
  source: NavigationSource;
  api: PerformanceApi;
  /** Optional network source — its activity keeps the active navigation transaction alive (the proper idle
   *  model: the idle timer resets on each request start/end, so the txn spans the navigation's actual work). */
  networkSource?: NetworkSource;
  /** Env for the hidden lifecycle (background-cancel). Default the real globals. */
  env?: WebVitalsEnv;
  /** One-shot timer forwarded to the idle transaction (tests). Default the global setTimeout/clearTimeout. */
  timer?: IdleTimer;
  /** Finish OK after this idle gap (ms). Default the idle-transaction default (1000). */
  idleTimeoutMs?: number;
  /** Hard cap (ms). Default the idle-transaction default (30000). */
  finalTimeoutMs?: number;
}

const NETWORK_STAGES = ['before', 'complete', 'error', 'abort'] as const;

export function collectNavigations(deps: CollectNavigationsDeps): () => void {
  // The single active navigation transaction (correlation-by-tagging — one current activity on the browser,
  // D11). `undefined` after teardown, so the (un-removable) onHidden callback below safely no-ops then.
  let current: IdleTransactionHandle | undefined;
  const offs: Array<() => void> = [];

  offs.push(
    deps.source.on('navigate', (detail) => {
      current?.finishNow(); // the previous navigation/view is superseded → finish it
      const transaction = deps.api.startTransaction({ name: detail.to, operation: 'navigation' });
      transaction.setAttribute('nav.source', detail.source); // provenance: url / route / custom (Sentry parity)
      transaction.setAttribute('nav.type', detail.navigationType);
      current = createIdleTransaction({
        transaction,
        ...(deps.timer !== undefined ? { timer: deps.timer } : {}),
        ...(deps.idleTimeoutMs !== undefined ? { idleTimeoutMs: deps.idleTimeoutMs } : {}),
        ...(deps.finalTimeoutMs !== undefined ? { finalTimeoutMs: deps.finalTimeoutMs } : {}),
      });
    }),
  );

  // In-flight network activity keeps the active navigation transaction alive (reset its idle timer).
  if (deps.networkSource !== undefined) {
    const keepAlive = (): void => current?.keepAlive();
    for (const stage of NETWORK_STAGES) offs.push(deps.networkSource.on(stage, keepAlive));
  }

  // The tab going hidden cancels the in-flight navigation transaction (it didn't complete in the foreground).
  onHidden(deps.env ?? realWebVitalsEnv(), () => current?.cancel());

  return () => {
    for (const off of offs) off(); // unsubscribe source + network (no more navigations/keepAlives)
    current?.cancel(); // cancel any in-flight navigation on teardown
    current = undefined; // the leaked onHidden callback now no-ops
  };
}
