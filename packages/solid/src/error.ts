import {
  type AdapterMechanism,
  neverThrow,
  type ReportErrorOptions,
  reportError,
} from '@bugsee/web-adapter';

// The @bugsee/solid ERROR SEAM (frontend-adapters §7 fan-out — the F6-thin pattern for Solid). Solid catches
// render/reactive errors via the built-in `<ErrorBoundary>` component and the `onError(handler)` /
// `catchError(fn, handler)` primitives — all of which hand a plain `error` to a USER callback. So (unlike
// React) we don't ship a boundary component; we provide the reporter the user wires into Solid's own seam:
//   <ErrorBoundary fallback={(e) => (solidErrorHandler()(e), <Fallback/>)}>…</ErrorBoundary>
//   import { catchError } from 'solid-js'; catchError(() => <App/>, solidErrorHandler());
//   // (onError(solidErrorHandler()) also works but is deprecated since solid-js 1.7 in favour of catchError)
// A STRUCTURAL approach (no `solid-js` import) → version-agnostic + unit-testable. A no-op when no SDK is
// launched. These seams catch SYNCHRONOUS render/reactive errors in their owner scope (like React boundaries)
// — async/event-handler/rejection errors are covered by the SDK's global handlers, not here. The seams give
// just the error (no component context), so the report is the error itself.

/** Capture mechanism for a Solid error report (the `logException` mechanism vocabulary). */
export type SolidErrorMechanism = AdapterMechanism;

/** Options for {@link reportSolidError} (client resolver + mechanism). */
export type SolidErrorOptions = Omit<ReportErrorOptions, 'labels'>;

/** Report a Solid error to the launched Bugsee client. A no-op when no SDK is launched. */
export function reportSolidError(error: unknown, options: SolidErrorOptions = {}): void {
  reportError(error, options); // Solid's seams give just the error (no component context)
}

/** Build an error handler `(error) => void` to wire into Solid's `onError` / `catchError` / an
 *  `<ErrorBoundary>` fallback. */
export function solidErrorHandler(options: SolidErrorOptions = {}): (error: unknown) => void {
  // Contained (Wave 2.1): this is wired into `<ErrorBoundary>` / `catchError`, so a throw here escapes the
  // boundary that was supposed to contain the customer's error and takes the fallback UI down with it.
  // Today this guard is REDUNDANT — `reportSolidError` only forwards to the already-guarded `reportError`,
  // with no pre-report work of its own (unlike vue's component-name lookup, svelte's route read or angular's
  // error unwrapping), so a mutation removing it is not observable. It stays because the Wave 2.1 rule is
  // "every host-facing entry point is wrapped", enforced by construction rather than re-derived per adapter:
  // the day this function gains any pre-work, the guard is already in place.
  return (error) => {
    neverThrow(() => reportSolidError(error, options), options.onError);
  };
}
