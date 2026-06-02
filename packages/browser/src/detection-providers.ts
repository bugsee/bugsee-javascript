import type { DetectionProvider } from '@bugsee/core';
import { DetectionProviderBase, formatStack, parseLocation } from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { parseStack } from './stack';

// Browser crash/error detection providers (design §3.2 globalErrorInterceptor on the browser, §8.5
// mechanisms). Each subscribes to a window event and submits a ReportingRequest via
// DetectionProviderBase: `error` → crash (mechanism 'uncaught'), `unhandledrejection` → error
// (mechanism 'unhandledrejection'). They DETECT + submit only; flush policy lives in launch(). The
// window event target is injectable for tests. Unlike node there is no process.exit window — the
// browser flushes via the pipeline / pagehide.

/** The minimal window event surface these providers need (the global `window` satisfies it). */
export interface WindowEvents {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

// Describe a thrown value (the unhandledrejection `reason`, or an `error` event's `.error`): summary
// from the message (or the error name), and a path-scrubbed, dialect-dispatched stack description.
function describeError(value: unknown): { summary: string; description?: string } {
  if (value instanceof Error) {
    const summary = value.message || value.name;
    if (value.stack) {
      return { summary, description: formatStack(parseStack(value.stack)) };
    }
    return { summary };
  }
  return { summary: String(value) };
}

// Describe an ErrorEvent: prefer the thrown value (`event.error`); when it's absent (a cross-origin
// "Script error." carries none), fall back to the event message + a synthetic frame from
// filename:lineno:colno (path-scrubbed via parseLocation), or no description when there is no filename.
function describeErrorEvent(event: ErrorEvent): { summary: string; description?: string } {
  if (event.error != null) {
    return describeError(event.error);
  }
  const summary = event.message;
  if (event.filename) {
    const frame = parseLocation(`${event.filename}:${event.lineno}:${event.colno}`);
    return { summary, description: formatStack([frame]) };
  }
  return { summary };
}

abstract class BrowserWindowDetectionProvider extends DetectionProviderBase {
  protected abstract readonly event: 'error' | 'unhandledrejection';
  readonly #win: WindowEvents;
  readonly #handler = (event: Event): void => this.onDetected(event);

  constructor(win: WindowEvents) {
    super();
    this.#win = win;
  }

  protected onStart(): void {
    this.#win.addEventListener(this.event, this.#handler);
  }

  protected override onStop(): void {
    this.#win.removeEventListener(this.event, this.#handler);
  }

  protected abstract onDetected(event: Event): void;
}

class WindowErrorProvider extends BrowserWindowDetectionProvider {
  readonly name = 'browser-window-error';
  readonly controllingOption = BugseeOption.DetectCrash;
  protected readonly event = 'error' as const;

  protected onDetected(event: Event): void {
    const { summary, description } = describeErrorEvent(event as ErrorEvent);
    this.handleReportingRequest(
      this.createCrashReport({
        mechanism: 'uncaught',
        summary,
        ...(description !== undefined ? { description } : {}),
      }),
    );
  }
}

class WindowUnhandledRejectionProvider extends BrowserWindowDetectionProvider {
  readonly name = 'browser-unhandled-rejection';
  readonly controllingOption = BugseeOption.DetectCrash;
  protected readonly event = 'unhandledrejection' as const;

  protected onDetected(event: Event): void {
    const { summary, description } = describeError((event as PromiseRejectionEvent).reason);
    this.handleReportingRequest(
      this.createErrorReport({
        mechanism: 'unhandledrejection',
        summary,
        ...(description !== undefined ? { description } : {}),
      }),
    );
  }
}

/** Detect a window `error` event and report it as a crash. */
export function createWindowErrorProvider(win: WindowEvents = window): DetectionProvider {
  return new WindowErrorProvider(win);
}

/** Detect a window `unhandledrejection` event and report it as an error. */
export function createUnhandledRejectionProvider(win: WindowEvents = window): DetectionProvider {
  return new WindowUnhandledRejectionProvider(win);
}
