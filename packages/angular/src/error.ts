import {
  type AdapterMechanism,
  neverThrow,
  type ReportErrorOptions,
  reportError,
} from '@bugsee/web-adapter';

// The @bugsee/angular ERROR SEAM (frontend-adapters §7 fan-out — the F6-thin pattern for Angular). Angular
// reports uncaught errors through its injectable `ErrorHandler` (`handleError(error)`); the app replaces it
// via `{ provide: ErrorHandler, useClass: BugseeErrorHandler }`. We report the error to the launched Bugsee
// client, UNWRAPPING Angular's error wrapper (`error.ngOriginalError`) to the real thrown error, and DELEGATE
// to a chained handler (e.g. the default ErrorHandler) so the app keeps its console logging. A STRUCTURAL
// PEER over the duck-typed `handleError` contract (no `@angular/core` import) → version-agnostic +
// unit-testable. A no-op when no SDK is launched.

/** Capture mechanism for an Angular error report (the `logException` mechanism vocabulary). */
export type AngularErrorMechanism = AdapterMechanism;

/** Options for the Angular error seam (client resolver + mechanism). */
export type AngularErrorOptions = Omit<ReportErrorOptions, 'labels'>;

/** Unwrap Angular's error wrapper to the real thrown error: `error.ngOriginalError` when present, else the
 *  error itself (also for a non-object thrown value). NOTE: `ngOriginalError` is the wrapper field Angular
 *  ≤18 set (its own ErrorHandler unwrapped it); Angular 19+ removed the wrapper and forwards the raw error
 *  straight to `handleError`, so this read is simply a best-effort no-op there (returns the error unchanged).
 *  Either way the right error is reported. */
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
  // The unwrap is contained SEPARATELY from the report, and falls back to the raw error. `originalError`
  // probes a value the HOST threw — `'ngOriginalError' in error` fires a proxy's `has` trap and the read
  // fires a getter, either of which can throw. Unguarded and outside `reportError`'s own guard, that threw
  // straight out of this PUBLIC export, and inside `createAngularErrorHandler` it was swallowed together
  // with the report — so an exotic thrown value cost the error report entirely. Unwrapping is a
  // best-effort refinement (Angular ≤18 only); losing it must never lose the error.
  let target = error;
  neverThrow(() => {
    target = originalError(error);
  }, options.onError);
  reportError(target, options);
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
      // Contained (Wave 2.1): unguarded, an SDK failure escaped into Angular's error pipeline AND skipped
      // the delegate below — so the app lost both its error handling and its own handler.
      neverThrow(() => reportAngularError(error, options), options.onError);
      options.delegate?.handleError(error); // keep a chained handler (e.g. the default ErrorHandler)
    },
  };
}

/**
 * Angular's OWN default `ErrorHandler` behaviour, reproduced.
 *
 * `{ provide: ErrorHandler, useClass: BugseeErrorHandler }` — the wiring this adapter documents as its
 * primary one — REPLACES whatever handler the application had. With nothing chained, an app that provided a
 * custom `ErrorHandler` lost it silently, and an app that provided none lost Angular's default, which is the
 * only thing that surfaces an uncaught error in the console. Measured against real `@angular/core`: the
 * default prints one `console.error('ERROR', error)`; resolving `BugseeErrorHandler` printed none
 * (docs/review/frontend-adapters-vue-angular-svelte-solid.md SEV1 #2).
 *
 * Angular is a structural peer here — never imported — so its default is reproduced rather than delegated to.
 */
const angularDefaultErrorHandler = {
  handleError(error: unknown): void {
    console.error('ERROR', error);
  },
};

/** A parameterless `ErrorHandler` (duck-typed) reporting via the carrier client — for the simple wiring
 *  `{ provide: ErrorHandler, useClass: BugseeErrorHandler }`. Chains to Angular's DEFAULT behaviour, so the
 *  documented one-liner adds Bugsee instead of silently removing the app's error surfacing. An app with its
 *  own custom `ErrorHandler` should use {@link createAngularErrorHandler} with an explicit `delegate`. */
export class BugseeErrorHandler {
  readonly #handler = createAngularErrorHandler({ delegate: angularDefaultErrorHandler });
  handleError(error: unknown): void {
    this.#handler.handleError(error);
  }
}
