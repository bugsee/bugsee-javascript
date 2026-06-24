import {
  type AdapterMechanism,
  type ReportErrorOptions,
  reportError,
  resolveClient,
} from '@bugsee/web-adapter';

// The @bugsee/react REPORTING core (frontend-adapters D8) — runtime-portable, no React import, so it is
// unit-tested injection-first and reused by the ErrorBoundary, a React-19 global handler, or a direct app
// call. Links the React component stack to the error via `error.cause` (Sentry-style LinkedErrors), which
// the core's `logException` surfaces in the report description. The client defaults to the process carrier
// (the launched SDK); a no-op when none is launched.

/** Capture mechanism for a React error report (the `logException` mechanism vocabulary). */
export type ReactErrorMechanism = AdapterMechanism;

export interface ReportReactErrorOptions extends Omit<ReportErrorOptions, 'labels'> {
  /** The React component stack (`errorInfo.componentStack`) — linked to the error via `error.cause`. */
  componentStack?: string;
}

/**
 * Link a React component stack to an error via `error.cause` (the LinkedErrors convention the design D8
 * prescribes) so it travels with the report (surfaced by the core's `describeError`). DELIBERATELY mutates
 * the caught error's `.cause` — non-destructively: any EXISTING cause is preserved by chaining it behind the
 * component-stack frame, so no information is lost (this is opt-in instrumentation the app added around its
 * own tree, and the original error object is what reaches `logException`, preserving instance-dedup). A
 * no-op for a non-Error value or an empty/absent stack.
 */
export function linkComponentStack(error: unknown, componentStack: string | undefined): void {
  if (!(error instanceof Error) || componentStack === undefined || componentStack === '') return;
  const frame = new Error(`React component stack:${componentStack}`);
  frame.stack = `React component stack:${componentStack}`; // describeError reads `.stack` for the description
  frame.cause = error.cause; // chain any existing cause BEHIND the component-stack frame (non-destructive)
  error.cause = frame;
}

/**
 * Report a React error (from the ErrorBoundary or a direct app call) to the launched Bugsee client, with the
 * component stack linked. The ORIGINAL error object is passed to `logException` (preserving the core's
 * instance-dedup). A no-op when no SDK is launched. (A React-19 `onUncaughtError`/`onCaughtError` global
 * handler that also routes here is a possible later addition — see D8; not built yet.)
 */
export function reportReactError(error: unknown, options: ReportReactErrorOptions = {}): void {
  const client = resolveClient(options.getClient);
  if (client === undefined) return; // no launched SDK → nothing to report to (and don't touch the error)
  linkComponentStack(error, options.componentStack); // mutates error.cause (non-destructive); see above
  reportError(error, { ...options, getClient: () => client });
}
