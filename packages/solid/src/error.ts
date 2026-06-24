import type { Bugsee } from '@bugsee/browser';
import { getCarrierClient, type LogExceptionOptions } from '@bugsee/core';

// The @bugsee/solid ERROR SEAM (frontend-adapters §7 fan-out — the F6-thin pattern for Solid). Solid catches
// render/reactive errors via the built-in `<ErrorBoundary>` component and the `onError(handler)` /
// `catchError(fn, handler)` primitives — all of which hand a plain `error` to a USER callback. So (unlike
// React) we don't ship a boundary component; we provide the reporter the user wires into Solid's own seam:
//   import { onError } from 'solid-js'; onError(solidErrorHandler());
//   <ErrorBoundary fallback={(e) => (solidErrorHandler()(e), <Fallback/>)}>…</ErrorBoundary>
// A STRUCTURAL approach (no `solid-js` import) → version-agnostic + unit-testable. A no-op when no SDK is
// launched. Solid's seams give just the error (no component context), so the report is the error itself.

/** Capture mechanism for a Solid error report (the `logException` mechanism vocabulary). */
export type SolidErrorMechanism = NonNullable<LogExceptionOptions['mechanism']>;

export interface SolidErrorOptions {
  /** Resolve the client. Default: the process-singleton carrier client. Injectable for tests. */
  getClient?: () => Bugsee | undefined;
  /** Capture mechanism. Default `uncaught`. */
  mechanism?: SolidErrorMechanism;
}

const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

/** Report a Solid error to the launched Bugsee client. A no-op when no SDK is launched. */
export function reportSolidError(error: unknown, options: SolidErrorOptions = {}): void {
  const client = (options.getClient ?? defaultGetClient)();
  if (client === undefined) return;
  void client.logException(error, { mechanism: options.mechanism ?? 'uncaught' });
}

/** Build an error handler `(error) => void` to wire into Solid's `onError` / `catchError` / an
 *  `<ErrorBoundary>` fallback. */
export function solidErrorHandler(options: SolidErrorOptions = {}): (error: unknown) => void {
  return (error) => reportSolidError(error, options);
}
