// Lifecycle events (Android `LifecycleEvents`, iOS `BugseeLifecycleEventType`): coarse SDK milestones an
// application can observe through ONE listener. The wire names are the Android ones so a cross-platform
// app can share its handler. Observe-only: a listener can neither veto nor alter anything, and one that
// throws (or returns a rejecting promise) is routed to `onError` and otherwise ignored.
//
// Coverage: upload events and `ReportHandler.after` follow the live trigger -> assemble -> upload path.
// A report delivered another way (durable recovery on the next launch, native-crash harvest, a queue
// overflow, a WebView/Electron-renderer hand-off) is not announced; see "Kept differences" in

import { neverThrow } from './never-throw';

const PREFIX = 'com.bugsee.lifecycle.';

// `RelaunchedAfterCrash` is emitted ONLY where a launch finds evidence that the previous run did not end
// cleanly, and never invented: `@bugsee/node` (a dead sibling instance that was not cleanly stopped and left an
// unsettled incident marker, an undelivered bundle or a harvested native dump), `@bugsee/browser` and
// `@bugsee/webworker` (a dead sibling instance that left an unsettled incident marker; a tab closed normally
// after a failed upload leaves one too, so it can over-report but never fabricate). It is NOT emitted on the
// edge runtimes, WebView or anywhere else that keeps nothing durable across runs.
//
// KNOWN LIMITS on node, both consequences of "evidence on disk, nothing invented":
//  - FALSE NEGATIVE: the commonest crash, an `uncaughtException`, uploads its report BEFORE the process exits and so
//    leaves no unsettled marker or bundle behind; the next launch then finds a dead sibling with nothing in flight
//    and stays silent. Only a crash whose report did not finish uploading (a kill, an OOM, an upload cut short) is
//    reported.
//  - FALSE POSITIVE: a script that exits normally while a report upload is still in flight (no `stop()`) leaves the
//    same marker as a crash, so the next launch reports a crash that did not happen.
// An application that needs certainty keeps its own "clean exit" flag; this event is a hint, not a verdict.
export const LifecycleEvents = {
  Launching: `${PREFIX}Launching`,
  Launched: `${PREFIX}Launched`,
  Stopping: `${PREFIX}Stopping`,
  Stopped: `${PREFIX}Stopped`,
  BlackoutStarted: `${PREFIX}BlackoutStarted`,
  BlackoutEnded: `${PREFIX}BlackoutEnded`,
  RelaunchedAfterCrash: `${PREFIX}RelaunchedAfterCrash`,
  BeforeReportShown: `${PREFIX}BeforeReportShown`,
  AfterReportShown: `${PREFIX}AfterReportShown`,
  BeforeReportUploaded: `${PREFIX}BeforeReportUploaded`,
  AfterReportUploaded: `${PREFIX}AfterReportUploaded`,
  ReportUploadFailed: `${PREFIX}ReportUploadFailed`,
  ReportUploadFailedWithFutureRetry: `${PREFIX}ReportUploadFailedWithFutureRetry`,
  BeforeReportAssembled: `${PREFIX}BeforeReportAssembled`,
  AfterReportAssembled: `${PREFIX}AfterReportAssembled`,
  ReportAssemblyFailed: `${PREFIX}ReportAssemblyFailed`,
} as const;

export type LifecycleEventType = (typeof LifecycleEvents)[keyof typeof LifecycleEvents];

/** The application's observer. `data` is event-specific (report events carry `{ reportId }`). */
export type LifecycleEventsListener = (eventType: string, data?: unknown) => void;

/**
 * Where the listener lives. By default each emitter owns a private slot; the platform composition roots
 * pass the PROCESS carrier's slot, so one listener serves every client the process ever builds (Android
 * keeps a single static listener) and survives `relaunch()`.
 */
export interface LifecycleListenerSlot {
  get(): LifecycleEventsListener | null;
  set(listener: LifecycleEventsListener | null): void;
  /**
   * The delivery queue + re-entrancy flag, kept NEXT TO the listener they serve. The listener is shared
   * by every client of the process, so a listener that calls `launch()` from client A's Stopped must see
   * client B's Launching queued behind it, not nested inside it. Absent: the emitter keeps its own.
   */
  delivery?: LifecycleDeliveryState;
}

/** The pending events and the "a listener is running" flag of one listener slot. */
export interface LifecycleDeliveryState {
  queue: Array<[LifecycleEventType, unknown]>;
  delivering: boolean;
}

// One listener stack can only cause this many deliveries before the chain is cut: a pair of listeners that
// keep stopping/launching each other would otherwise spin the host forever (an application bug must not
// hang it). A real burst is a handful of events; this leaves two orders of magnitude of headroom.
const MAX_DELIVERIES_PER_DRAIN = 100;

export interface LifecycleEmitter {
  /** Install the listener (replacing any previous one); `null` clears it. */
  set(listener: LifecycleEventsListener | null): void;
  /**
   * Deliver an event. Never throws. Re-entrant: an event emitted from INSIDE a listener (because the
   * listener called `launch()`, `stop()`, `startBlackout()`...) is queued and delivered, in order, once
   * the current listener has returned — a listener is never re-entered by the events its own actions cause.
   */
  emit(eventType: LifecycleEventType, data?: unknown): void;
}

export function createLifecycleEmitter(
  onError: (error: unknown) => void,
  slot?: LifecycleListenerSlot,
): LifecycleEmitter {
  let own: LifecycleEventsListener | null = null;
  const listenerSlot: LifecycleListenerSlot = slot ?? {
    get: () => own,
    set: (next) => {
      own = next;
    },
  };
  const state: LifecycleDeliveryState = listenerSlot.delivery ?? { queue: [], delivering: false };
  return {
    set(next: LifecycleEventsListener | null): void {
      listenerSlot.set(next);
    },
    emit(eventType: LifecycleEventType, data?: unknown): void {
      state.queue.push([eventType, data]);
      if (state.delivering) {
        return;
      }
      state.delivering = true;
      let delivered = 0;
      try {
        for (let next = state.queue.shift(); next !== undefined; next = state.queue.shift()) {
          delivered += 1;
          if (delivered > MAX_DELIVERIES_PER_DRAIN) {
            // Fail closed: stop delivering, drop what is queued, say so once.
            state.queue.length = 0;
            try {
              onError(
                new Error(
                  'lifecycle: listeners keep triggering each other; event delivery stopped',
                ),
              );
            } catch {
              // a throwing sink must not defeat the guard either
            }
            return;
          }
          // Read per event: a listener cleared or replaced mid-queue governs what follows.
          const listener = listenerSlot.get();
          if (listener === null) {
            continue;
          }
          // neverThrow also handles an async listener whose promise rejects (otherwise an unhandled rejection
          // in the host), and survives a throwing sink.
          neverThrow(() => listener(next[0], next[1]), onError);
        }
      } finally {
        state.delivering = false;
      }
    },
  };
}
