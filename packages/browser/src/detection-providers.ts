import type { AsyncOriginReporting } from '@bugsee/capture';
import type { CrashJson, DetectionProvider } from '@bugsee/core';
import {
  applyDebugIds,
  buildCrashJson,
  DetectionProviderBase,
  describeThrown,
  formatStack,
  neverThrow,
  parseLocation,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { parseStack } from './stack';

// Browser crash/error detection providers (globalErrorInterceptor on the browser,
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
function describeError(
  value: unknown,
  origins?: AsyncOriginReporting,
): { summary: string; description?: string } {
  if (value instanceof Error) {
    const summary = value.message || value.name;
    const frames = value.stack ? parseStack(value.stack) : [];
    if (frames.length > 0) {
      // Stamp source-map debug-IDs (when a build injected them) so the report can symbolicate.
      applyDebugIds(frames, { parseStack });
      return { summary, description: formatStack(frames) };
    }
    // No frames of its own (no stack, or only the `Name: message` header Chromium gives an async DOMException): an async platform
    // rejection (`video.play()`). Where the call was made, and on what, if the recorder saw it.
    const located = describeOrigin(value, origins);
    return located === undefined ? { summary } : { summary, description: located };
  }
  return { summary: describeThrown(value) };
}

function describeOrigin(value: Error, origins?: AsyncOriginReporting): string | undefined {
  if (origins === undefined) {
    return undefined;
  }
  const frames = origins.enrichFrames(value, []);
  const text = [
    frames.length > 0 ? formatStack(frames).trimEnd() : undefined,
    origins.describeTarget(value),
  ]
    .filter((part) => part !== undefined)
    .join('\n');
  return text === '' ? undefined : text;
}

/** Structured crash.json from a thrown value — `handled: false` (uncaught). A non-Error gets a
 *  synthetic exception rather than nothing. Uses the browser's multi-engine stack parser. */
function crashOf(value: unknown, origins?: AsyncOriginReporting): CrashJson {
  return buildCrashJson(value, {
    parseStack,
    handled: false,
    ...(origins !== undefined ? { enrichFrames: origins.enrichFrames } : {}),
  });
}

/**
 * The crash for an `error` event. Prefer the thrown value; when the event carries none — a cross-origin
 * "Script error." has no `.error` — synthesise the exception from what the EVENT knows (its message and
 * `filename:lineno:colno`) rather than from the absent value, whose synthetic form would say only
 * "Null". This is the same information the description already falls back to.
 */
function crashOfErrorEvent(event: ErrorEvent, origins?: AsyncOriginReporting): CrashJson {
  if (event.error != null) {
    return crashOf(event.error, origins);
  }
  const crash = crashOf(new Error(event.message));
  crash.exception.name = 'Error';
  if (event.filename) {
    const frame = parseLocation(`${event.filename}:${event.lineno}:${event.colno}`);
    crash.exception.frames = [{ trace: formatStack([frame]).trim(), user: true }];
  } else {
    // A cross-origin "Script error." has neither a thrown value nor a filename, and the page cannot learn
    // more (hiding that is the point of the restriction). An issue is grouped on its frames, so ZERO
    // frames made every occurrence an issue of its own. One fixed frame makes them one issue.
    crash.exception.frames = [{ trace: 'at <cross-origin script>', user: true }];
  }
  return crash;
}

// Describe an ErrorEvent: prefer the thrown value (`event.error`); when it's absent (a cross-origin
// "Script error." carries none), fall back to the event message + a synthetic frame from
// filename:lineno:colno (path-scrubbed via parseLocation), or no description when there is no filename.
function describeErrorEvent(
  event: ErrorEvent,
  origins?: AsyncOriginReporting,
): { summary: string; description?: string } {
  if (event.error != null) {
    return describeError(event.error, origins);
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
  protected readonly origins: AsyncOriginReporting | undefined;
  // CONTAINED at the listener itself, which is where the browser calls in. `error` and
  // `unhandledrejection` fire exactly when the page is already in trouble, and the event is entirely
  // page-supplied — `ErrorEvent.error` is whatever the app threw (commonly not an Error), and a getter on
  // it can throw. An escape here does not cost one report: the browser turns a throwing listener into
  // ANOTHER `error` event, which this same listener handles, which can throw again — a loop at the page's
  // worst moment. Subclasses stay free of try/catch, so the guarantee cannot be forgotten by a new one.
  readonly #handler = (event: Event): void => {
    neverThrow(() => this.onDetected(event));
  };

  constructor(win: WindowEvents, origins?: AsyncOriginReporting) {
    super();
    this.#win = win;
    this.origins = origins;
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
    const { summary, description } = describeErrorEvent(errorEvent, this.origins);
    // The thrown value (absent for a cross-origin "Script error." → no crash.json).
    const crash = crashOfErrorEvent(errorEvent, this.origins);
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
    const { summary, description } = describeError(reason, this.origins);
    const crash = crashOf(reason, this.origins);
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
export function createWindowErrorProvider(
  win: WindowEvents = window,
  origins?: AsyncOriginReporting,
): DetectionProvider {
  return new WindowErrorProvider(win, origins);
}

/** Detect a window `unhandledrejection` event and report it as an error. */
export function createUnhandledRejectionProvider(
  win: WindowEvents = window,
  origins?: AsyncOriginReporting,
): DetectionProvider {
  return new WindowUnhandledRejectionProvider(win, origins);
}
