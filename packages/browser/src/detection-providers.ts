import type { CrashJson, DetectionProvider } from '@bugsee/core';
import {
  applyDebugIds,
  buildCrashJson,
  DetectionProviderBase,
  formatStack,
  parseLocation,
} from '@bugsee/core';
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
      const frames = parseStack(value.stack);
      // Stamp source-map debug-IDs (when a build injected them) so the report can symbolicate.
      applyDebugIds(frames, { parseStack });
      return { summary, description: formatStack(frames) };
    }
    return { summary };
  }
  return { summary: String(value) };
}

/** Structured crash.json (SC3) from a thrown value — `handled: false` (uncaught). Undefined for non-Errors
 *  (incl. a cross-origin `error` event with no `.error`). Uses the browser's multi-engine stack parser. */
function crashOf(value: unknown): CrashJson | undefined {
  return buildCrashJson(value, { parseStack, handled: false });
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
    const errorEvent = event as ErrorEvent;
    const { summary, description } = describeErrorEvent(errorEvent);
    // The thrown value (absent for a cross-origin "Script error." → no crash.json).
    const crash = crashOf(errorEvent.error);
    this.handleReportingRequest(
      this.createCrashReport({
        mechanism: 'uncaught',
        summary,
        ...(description !== undefined ? { description } : {}),
        ...(crash !== undefined ? { crash } : {}),
      }),
    );
  }
}

class WindowUnhandledRejectionProvider extends BrowserWindowDetectionProvider {
  readonly name = 'browser-unhandled-rejection';
  readonly controllingOption = BugseeOption.DetectCrash;
  protected readonly event = 'unhandledrejection' as const;

  protected onDetected(event: Event): void {
    const reason = (event as PromiseRejectionEvent).reason;
    const { summary, description } = describeError(reason);
    const crash = crashOf(reason);
    this.handleReportingRequest(
      this.createErrorReport({
        mechanism: 'unhandledrejection',
        summary,
        ...(description !== undefined ? { description } : {}),
        ...(crash !== undefined ? { crash } : {}),
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
