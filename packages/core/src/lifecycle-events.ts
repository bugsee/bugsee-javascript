// Lifecycle events (Android `LifecycleEvents`, iOS `BugseeLifecycleEventType`): coarse SDK milestones an
// application can observe through ONE listener. The wire names are the Android ones so a cross-platform
// app can share its handler. Observe-only: a listener can neither veto nor alter anything, and one that
// throws is routed to `onError` and otherwise ignored.

const PREFIX = 'com.bugsee.lifecycle.';

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
}

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
  const queue: Array<[LifecycleEventType, unknown]> = [];
  let delivering = false;
  return {
    set(next: LifecycleEventsListener | null): void {
      listenerSlot.set(next);
    },
    emit(eventType: LifecycleEventType, data?: unknown): void {
      queue.push([eventType, data]);
      if (delivering) {
        return;
      }
      delivering = true;
      try {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          // Read per event: a listener cleared or replaced mid-queue governs what follows.
          const listener = listenerSlot.get();
          if (listener === null) {
            continue;
          }
          try {
            listener(next[0], next[1]);
          } catch (error) {
            try {
              onError(error);
            } catch {
              // a throwing sink must not defeat the guard either
            }
          }
        }
      } finally {
        delivering = false;
      }
    },
  };
}
