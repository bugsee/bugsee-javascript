import process from 'node:process';
import type { CrashJson, DetectionProvider } from '@bugsee/core';
import { buildCrashJson, DetectionProviderBase, formatStack, parseV8Stack } from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { markOwnHandler } from './process-policy';

// Node crash/error detection providers (design §3.2 globalErrorInterceptor on Node, §8.5 mechanisms).
// Each subscribes to a process event and submits a ReportingRequest via DetectionProviderBase:
// uncaughtException → crash (mechanism 'uncaught'), unhandledRejection → error (mechanism
// 'unhandledrejection'). They DETECT + submit only; the flush-then-exit policy (uncaught: flush
// then process.exit(1) when sole handler; rejection: warn, stay alive — the Sentry/Bugsnag standard)
// is installed by launch(), where flush + options are available. The process emitter is injectable
// for tests. Uses the listening `uncaughtException` event (not the observe-only monitor) so launch
// gets the async window to flush before exit.

/** The minimal process event surface these providers need (the global `process` satisfies it). */
export interface ProcessEvents {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

function describeError(value: unknown): { summary: string; description?: string } {
  if (value instanceof Error) {
    const summary = value.message || value.name;
    if (value.stack) {
      return { summary, description: formatStack(parseV8Stack(value.stack)) };
    }
    return { summary };
  }
  return { summary: String(value) };
}

/** Structured crash.json (SC3) from an uncaught value — `handled: false`. Undefined for non-Errors. */
function crashOf(value: unknown): CrashJson | undefined {
  return buildCrashJson(value, { parseStack: parseV8Stack, handled: false });
}

abstract class NodeProcessDetectionProvider extends DetectionProviderBase {
  protected abstract readonly event: 'uncaughtException' | 'unhandledRejection';
  readonly #proc: ProcessEvents;
  // Marked as Bugsee-owned so the process policy can tell OUR listeners from the host's — the SDK installs
  // more than one listener per event, so a raw count cannot answer "does the host handle this too?" (D2).
  readonly #handler = markOwnHandler((value: unknown): void => this.onDetected(value));

  constructor(proc: ProcessEvents) {
    super();
    this.#proc = proc;
  }

  protected onStart(): void {
    this.#proc.on(this.event, this.#handler);
  }

  protected override onStop(): void {
    this.#proc.off(this.event, this.#handler);
  }

  protected abstract onDetected(value: unknown): void;
}

class UncaughtExceptionProvider extends NodeProcessDetectionProvider {
  readonly name = 'node-uncaught-exception';
  readonly controllingOption = BugseeOption.DetectCrash;
  protected readonly event = 'uncaughtException' as const;

  protected onDetected(value: unknown): void {
    const { summary, description } = describeError(value);
    const crash = crashOf(value);
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

class UnhandledRejectionProvider extends NodeProcessDetectionProvider {
  readonly name = 'node-unhandled-rejection';
  readonly controllingOption = BugseeOption.DetectCrash;
  protected readonly event = 'unhandledRejection' as const;

  protected onDetected(value: unknown): void {
    const { summary, description } = describeError(value);
    const crash = crashOf(value);
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

/** Detect `uncaughtException` and report it as a crash. */
export function createUncaughtExceptionProvider(proc: ProcessEvents = process): DetectionProvider {
  return new UncaughtExceptionProvider(proc);
}

/** Detect `unhandledRejection` and report it as an error. */
export function createUnhandledRejectionProvider(proc: ProcessEvents = process): DetectionProvider {
  return new UnhandledRejectionProvider(proc);
}
