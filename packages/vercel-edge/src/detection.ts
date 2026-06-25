import {
  type DetectionProvider,
  DetectionProviderBase,
  formatStack,
  parseV8Stack,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';

// Edge crash/error detection (docs/design/edge-runtime.md §2.1.6 / E5b). On edge there is no reliable global
// `error` / `process.on('uncaughtException')`, but Cloudflare (with nodejs_compat) and Vercel Edge DO expose
// `addEventListener('unhandledrejection')` — the safety net for FLOATING-promise rejections the fetch-handler
// wrapper's try/catch misses. Reports them as an error (mechanism 'unhandledrejection') with a V8-parsed stack
// (parseV8Stack — the edge runtimes are V8). Self-skips where the global event target is absent (non-edge).
// DELIVERY: a rejection that fires DURING a request is flushed by that request's wrapper waitUntil; a rejection
// AFTER the response is best-effort (no waitUntil → flushed by the next request, or lost on isolate freeze).

/** The minimal global event surface this provider needs — the worker `globalThis` satisfies it on Vercel Edge
 *  / Cloudflare (nodejs_compat). Absent (a non-edge runtime) → the provider self-skips. */
export interface EdgeGlobalEvents {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
}

// Describe a rejection reason: summary from the message (or the error name), + a path-formatted V8 stack.
function describeError(value: unknown): { summary: string; description?: string } {
  if (value instanceof Error) {
    const summary = value.message || value.name;
    return value.stack !== undefined
      ? { summary, description: formatStack(parseV8Stack(value.stack)) }
      : { summary };
  }
  return { summary: String(value) };
}

class EdgeUnhandledRejectionProvider extends DetectionProviderBase {
  readonly name = 'edge-unhandled-rejection';
  readonly controllingOption = BugseeOption.DetectCrash;
  readonly #target: EdgeGlobalEvents;
  readonly #handler = (event: unknown): void => this.#onDetected(event);

  constructor(target: EdgeGlobalEvents) {
    super();
    this.#target = target;
  }

  protected onStart(): void {
    if (typeof this.#target.addEventListener === 'function') {
      this.#target.addEventListener('unhandledrejection', this.#handler);
    }
  }

  protected override onStop(): void {
    if (typeof this.#target.removeEventListener === 'function') {
      this.#target.removeEventListener('unhandledrejection', this.#handler);
    }
  }

  #onDetected(event: unknown): void {
    const reason = (event as { reason?: unknown } | null | undefined)?.reason;
    const { summary, description } = describeError(reason);
    this.handleReportingRequest(
      this.createErrorReport({
        mechanism: 'unhandledrejection',
        summary,
        ...(description !== undefined ? { description } : {}),
      }),
    );
  }
}

/** Detect a global `unhandledrejection` and report it as an error. Default target: the worker `globalThis`. */
export function createEdgeUnhandledRejectionProvider(
  target: EdgeGlobalEvents = globalThis as EdgeGlobalEvents,
): DetectionProvider {
  return new EdgeUnhandledRejectionProvider(target);
}
