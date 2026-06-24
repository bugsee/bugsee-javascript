import type { Bugsee } from '@bugsee/browser';
import { getCarrierClient, type LogExceptionOptions } from '@bugsee/core';

// The @bugsee/angular ERROR SEAM (frontend-adapters §7 fan-out — the F6-thin pattern for Angular). Angular
// reports uncaught errors through its injectable `ErrorHandler` (`handleError(error)`); the app replaces it
// via `{ provide: ErrorHandler, useClass: BugseeErrorHandler }`. We report the error to the launched Bugsee
// client, UNWRAPPING Angular's error wrapper (`error.ngOriginalError`) to the real thrown error, and DELEGATE
// to a chained handler (e.g. the default ErrorHandler) so the app keeps its console logging. A STRUCTURAL
// PEER over the duck-typed `handleError` contract (no `@angular/core` import) → version-agnostic +
// unit-testable. A no-op when no SDK is launched.

/** Capture mechanism for an Angular error report (the `logException` mechanism vocabulary). */
export type AngularErrorMechanism = NonNullable<LogExceptionOptions['mechanism']>;

export interface AngularErrorOptions {
  /** Resolve the client. Default: the process-singleton carrier client. Injectable for tests. */
  getClient?: () => Bugsee | undefined;
  /** Capture mechanism. Default `uncaught`. */
  mechanism?: AngularErrorMechanism;
}

const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

/** Unwrap Angular's error wrapper to the real thrown error: `error.ngOriginalError` when present, else the
 *  error itself (also for a non-object thrown value). */
function originalError(error: unknown): unknown {
  if (error !== null && typeof error === 'object' && 'ngOriginalError' in error) {
    const wrapped = (error as { ngOriginalError?: unknown }).ngOriginalError;
    if (wrapped !== undefined && wrapped !== null) return wrapped;
  }
  return error;
}

/** Report an Angular error to the launched Bugsee client (unwrapping `ngOriginalError`). A no-op when no SDK
 *  is launched. */
export function reportAngularError(error: unknown, options: AngularErrorOptions = {}): void {
  const client = (options.getClient ?? defaultGetClient)();
  if (client === undefined) return;
  void client.logException(originalError(error), { mechanism: options.mechanism ?? 'uncaught' });
}

export interface AngularErrorHandlerOptions extends AngularErrorOptions {
  /** A chained handler run AFTER reporting — e.g. the default `ErrorHandler` so console logging is kept. */
  delegate?: { handleError(error: unknown): void };
}

/** Build an `ErrorHandler`-shaped object (`{ handleError }`) that reports the error then delegates. For the
 *  configurable wiring: `{ provide: ErrorHandler, useFactory: () => createAngularErrorHandler({ delegate }) }`. */
export function createAngularErrorHandler(options: AngularErrorHandlerOptions = {}): {
  handleError(error: unknown): void;
} {
  return {
    handleError(error) {
      reportAngularError(error, options);
      options.delegate?.handleError(error); // keep a chained handler (e.g. the default ErrorHandler)
    },
  };
}

/** A parameterless `ErrorHandler` (duck-typed) reporting via the carrier client — for the simple wiring
 *  `{ provide: ErrorHandler, useClass: BugseeErrorHandler }`. (For a delegate/options use the factory above.) */
export class BugseeErrorHandler {
  readonly #handler = createAngularErrorHandler();
  handleError(error: unknown): void {
    this.#handler.handleError(error);
  }
}
