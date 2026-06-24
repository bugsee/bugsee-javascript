import { type ReportReactErrorOptions, reportReactError } from './report';

// React-19 root-level error handlers (frontend-adapters depth pass D5). React 19's `createRoot`/`hydrateRoot`
// accept `{ onUncaughtError, onCaughtError }` — the global seam for errors that an `<ErrorBoundary>` does NOT
// catch (event handlers and effects still reach `onUncaughtError`; a boundary-caught error reaches
// `onCaughtError`). Routing both to `reportReactError` captures EVERY React error with its component stack,
// closing the gap the boundary alone leaves. Deduped by the core (instance-dedup), so it coexists with
// `BugseeErrorBoundary` without double-reporting. React-free (the user passes these to createRoot):
//   createRoot(el, createBugseeErrorHandlers()).render(<App/>);

/** React's error-info side-channel (`{ componentStack }`) passed to the root error handlers. */
export interface ReactErrorInfo {
  componentStack?: string | null;
}

export interface ReactRootErrorHandlers {
  onUncaughtError: (error: unknown, errorInfo: ReactErrorInfo) => void;
  onCaughtError: (error: unknown, errorInfo: ReactErrorInfo) => void;
}

/** Build the React-19 root error handlers that report to the launched Bugsee client (component stack linked).
 *  Pass the result to `createRoot(container, …)` / `hydrateRoot`. */
export function createBugseeErrorHandlers(
  options: Omit<ReportReactErrorOptions, 'componentStack'> = {},
): ReactRootErrorHandlers {
  const handle = (error: unknown, errorInfo: ReactErrorInfo): void => {
    const componentStack = errorInfo?.componentStack ?? undefined;
    reportReactError(error, {
      ...options,
      ...(componentStack !== undefined ? { componentStack } : {}),
    });
  };
  return { onUncaughtError: handle, onCaughtError: handle };
}
