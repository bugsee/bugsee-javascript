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

export interface LifecycleEmitter {
  /** Install the listener (replacing any previous one); `null` clears it. */
  set(listener: LifecycleEventsListener | null): void;
  /** Deliver an event. Never throws. */
  emit(eventType: LifecycleEventType, data?: unknown): void;
}

export function createLifecycleEmitter(onError: (error: unknown) => void): LifecycleEmitter {
  let listener: LifecycleEventsListener | null = null;
  return {
    set(next: LifecycleEventsListener | null): void {
      listener = next;
    },
    emit(eventType: LifecycleEventType, data?: unknown): void {
      if (listener === null) {
        return;
      }
      try {
        listener(eventType, data);
      } catch (error) {
        try {
          onError(error);
        } catch {
          // a throwing sink must not defeat the guard either
        }
      }
    },
  };
}
