import { type AdapterMechanism, type ReportErrorOptions, reportError } from '@bugsee/web-adapter';

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
  return (error) => reportSolidError(error, options);
}
