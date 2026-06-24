import type { Bugsee } from '@bugsee/browser';
import { getCarrierClient, type LogExceptionOptions } from '@bugsee/core';

// The @bugsee/react REPORTING core (frontend-adapters D8) — runtime-portable, no React import, so it is
// unit-tested injection-first and reused by the ErrorBoundary, a React-19 global handler, or a direct app
// call. Links the React component stack to the error via `error.cause` (Sentry-style LinkedErrors), which
// the core's `logException` surfaces in the report description. The client defaults to the process carrier
// (the launched SDK); a no-op when none is launched.

/** Capture mechanism for a React error report (the `logException` mechanism vocabulary). */
export type ReactErrorMechanism = NonNullable<LogExceptionOptions['mechanism']>;

export interface ReportReactErrorOptions {
  /** The React component stack (`errorInfo.componentStack`) — linked to the error via `error.cause`. */
  componentStack?: string;
  /** Resolve the client. Default: the process-singleton carrier client. Injectable for tests. */
  getClient?: () => Bugsee | undefined;
  /** Capture mechanism. Default `uncaught` — a render error the boundary caught as the last line of defense. */
  mechanism?: ReactErrorMechanism;
}

/**
 * Link a React component stack to an error via `error.cause` (Sentry LinkedErrors) so it travels with the
 * report (surfaced by the core's `describeError`). Any EXISTING cause is preserved by chaining it behind
 * the component-stack frame. A no-op for a non-Error value or an empty/absent stack.
 */
export function linkComponentStack(error: unknown, componentStack: string | undefined): void {
  if (!(error instanceof Error) || componentStack === undefined || componentStack === '') return;
  const frame = new Error(`React component stack:${componentStack}`);
  frame.stack = `React component stack:${componentStack}`; // describeError reads `.stack` for the description
  frame.cause = error.cause; // chain any existing cause BEHIND the component-stack frame (non-destructive)
  error.cause = frame;
}

const defaultGetClient = (): Bugsee | undefined => getCarrierClient<Bugsee>();

/**
 * Report a React error (from an ErrorBoundary, a React-19 `onUncaughtError`/`onCaughtError` handler, or a
 * direct app call) to the launched Bugsee client, with the component stack linked. The ORIGINAL error
 * object is passed to `logException` (preserving the core's instance-dedup). A no-op when no SDK is launched.
 */
export function reportReactError(error: unknown, options: ReportReactErrorOptions = {}): void {
  const client = (options.getClient ?? defaultGetClient)();
  if (client === undefined) return; // no launched SDK → nothing to report to
  linkComponentStack(error, options.componentStack);
  void client.logException(error, { mechanism: options.mechanism ?? 'uncaught' });
}
