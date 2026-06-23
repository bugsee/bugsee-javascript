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

// Wire an (injected) interaction SOURCE to interaction transactions (frontend-adapters F4 / D6). Each
// qualifying user interaction (the Event Timing INP unit) opens a short `ui.interaction` transaction
// wrapped in the idle lifecycle, so the interaction's async tail (the fetch/xhr it triggers) is captured
// as child work. Mirrors `collectNavigations`: in-flight network activity keeps the transaction alive,
// the tab going hidden cancels it, and the source is a structural abstraction (the @bugsee/browser
// interaction source, injected by the umbrella) so @bugsee/performance owns the machinery without a
// browser dep.
//
// Coexistence (D11/D12 — the browser's single active slot): an interaction is SKIPPED when an active
// `navigation` already owns the slot — a click that triggers a route change must not be double-counted
// (the navigation transaction already captures that work). The lingering `pageload` (active until tab-hide)
// does NOT block interactions: otherwise a no-navigation SPA would never record one. The interaction
// transiently becomes the active span (its triggered requests attach to it via getActiveSpan), then
// idle-finishes and frees the slot; the pageload finalizes its own vitals/resource timing on hide
// independently. A previous interaction is superseded (rapid taps collapse to the latest).
//
// SCOPE: this records the interaction TRANSACTION + its triggered work (the http.client async tail) and
// stamps the Event-Timing latency as an attribute. Per-interaction CLS/INP web-vital ATTRIBUTION (D6) is
// intentionally DEFERRED to a later slice (per D12 — per-navigation/interaction vitals are not in F4).

/** The minimal interaction detail the wiring reads — structurally matches the browser `InteractionDetail`. */
export interface InteractionDetailLike {
  /** The interaction modality ('click' | 'keydown' | 'pointerup' | …) → part of the transaction name. */
  interactionType: string;
  /** A PII-safe target label ('button#submit') → completes the transaction name; omitted when unavailable. */
  target?: string;
  /** The interaction latency (ms) — stamped as an attribute (the INP contribution). */
  duration: number;
  /** The Event Timing interactionId (carried for correlation; not used by the wiring). */
  interactionId: number;
}

/** A listenable source of interactions (the browser `InteractionSource` satisfies this). */
export type InteractionSource = EventSubscribable<{ interact: InteractionDetailLike }>;

export interface CollectInteractionsDeps {
  source: InteractionSource;
  api: PerformanceApi;
  /** Optional network source — its activity keeps the active interaction transaction alive (the async tail). */
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

export function collectInteractions(deps: CollectInteractionsDeps): () => void {
  // The single active interaction transaction (correlation-by-tagging, D11). `undefined` after teardown,
  // so the (un-removable) onHidden callback below safely no-ops then.
  let current: IdleTransactionHandle | undefined;
  const offs: Array<() => void> = [];

  offs.push(
    deps.source.on('interact', (detail) => {
      // A navigation already owns this user action (a click that triggered a route change) → don't
      // double-count. The lingering pageload does NOT gate (a no-navigation SPA must still record).
      if (deps.api.getActiveSpan()?.getOperation() === 'navigation') return;
      current?.finishNow(); // supersede a previous interaction (rapid taps collapse to the latest)
      const name =
        detail.target !== undefined
          ? `${detail.interactionType} ${detail.target}`
          : detail.interactionType;
      const transaction = deps.api.startTransaction({ name, operation: 'ui.interaction' });
      transaction.setAttribute('ui.interaction_type', detail.interactionType);
      if (detail.target !== undefined)
        transaction.setAttribute('ui.interaction_target', detail.target);
      transaction.setAttribute('ui.interaction_duration_ms', detail.duration);
      current = createIdleTransaction({
        transaction,
        ...(deps.timer !== undefined ? { timer: deps.timer } : {}),
        ...(deps.idleTimeoutMs !== undefined ? { idleTimeoutMs: deps.idleTimeoutMs } : {}),
        ...(deps.finalTimeoutMs !== undefined ? { finalTimeoutMs: deps.finalTimeoutMs } : {}),
      });
    }),
  );

  // In-flight network activity keeps the active interaction transaction alive (reset its idle timer).
  if (deps.networkSource !== undefined) {
    const keepAlive = (): void => current?.keepAlive();
    for (const stage of NETWORK_STAGES) offs.push(deps.networkSource.on(stage, keepAlive));
  }

  // The tab going hidden cancels the in-flight interaction (it didn't complete in the foreground). Its
  // cleanup joins `offs`, so teardown removes the visibility listener (no leak across launch/stop).
  offs.push(onHidden(deps.env ?? realWebVitalsEnv(), () => current?.cancel()));

  return () => {
    for (const off of offs) off(); // unsubscribe source + network + the hidden listener
    current?.cancel(); // cancel any in-flight interaction on teardown
    current = undefined;
  };
}
