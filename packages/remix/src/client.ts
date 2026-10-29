// @bugsee/remix — client (browser runtime) composition.
//
// Reached from `app/entry.client.tsx` (the browser hydration entry). Browser-only (composes the
// batteries-included browser umbrella + @bugsee/react) → behind the `@bugsee/remix/client` subpath, never
// the portable `.` or node `./server` entry. Captures the SESSION the server `handleError` bridge
// stitches to a failing request.

import { type Bugsee, type BugseeLaunchOptionsWithPerformance, launch } from '@bugsee/bugsee';
import { type ReactErrorInfo, reportReactError } from '@bugsee/react';

export type { Bugsee } from '@bugsee/bugsee';
// Re-export the @bugsee/react surface (error boundary / Profiler / router helpers) so a Remix app gets
// everything from `@bugsee/remix/client`. `react` is an OPTIONAL peer (server-only users don't need it).
export * from '@bugsee/react';

/** Options for the Remix client composition — the batteries-included browser umbrella options. */
export interface RemixClientOptions extends BugseeLaunchOptionsWithPerformance {}

/**
 * Start Bugsee for the Remix / React Router **client** (browser) runtime. Call at the top of
 * `entry.client.tsx`. Returns the started per-tab client.
 *
 * ```tsx
 * // entry.client.tsx
 * import { registerClient, bugseeOnError } from '@bugsee/remix/client';
 * registerClient(import.meta.env.VITE_BUGSEE_TOKEN);
 * hydrateRoot(document, <HydratedRouter onError={bugseeOnError} />);
 * ```
 */
export async function registerClient(
  appToken: string,
  options: RemixClientOptions = {},
): Promise<Bugsee> {
  return await launch(appToken, options);
}

/** What React Router's `onError` receives as its second argument (structural; no `react-router` dep): the
 *  RR8 `{ location, params, pattern, errorInfo }` shape (extra fields ignored) or a bare React `ErrorInfo`. */
export interface RouterOnErrorInfo extends ReactErrorInfo {
  errorInfo?: ReactErrorInfo;
  location?: unknown;
  params?: unknown;
  pattern?: string;
}

/**
 * The React Router v7/v8 `<HydratedRouter onError>` (and data-router `onError`) handler — report a client
 * React error to Bugsee with its component stack. Defensive + no-ops when Bugsee is not launched (via
 * `reportReactError`).
 */
export function bugseeOnError(error: unknown, info?: RouterOnErrorInfo): void {
  // React Router (7.x/8) passes `{ location, params, pattern, errorInfo }`; the React `ErrorInfo` is NESTED
  // under `errorInfo`. A bare React `ErrorInfo` (older RR7 / direct use) is still accepted. React's
  // `componentStack` is `string | null` — narrow to a real stack before forwarding.
  const componentStack = info?.errorInfo?.componentStack ?? info?.componentStack;
  reportReactError(error, typeof componentStack === 'string' ? { componentStack } : {});
}

/** A Remix/RR `useRouteError()` route-error-response (thrown `Response`/`data()` → `{ status, statusText,
 *  data }`) — expected control flow (404/redirect), NOT a crash. Structural (no `react-router` dep). */
function isRouteErrorResponse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    'statusText' in error &&
    'data' in error
  );
}

/**
 * Remix v2 (no `onError` prop) — call from your root `ErrorBoundary` with `useRouteError()`:
 * `export function ErrorBoundary() { captureRemixErrorBoundaryError(useRouteError()); return <RootError/>; }`.
 * SKIPS route-error-responses (404/redirect/data — expected control flow) and reports every actual thrown
 * error (mirrors @sentry/remix). (RR7 uses `bugseeOnError` via `<HydratedRouter onError>` instead.)
 */
export function captureRemixErrorBoundaryError(
  error: unknown,
  options: { getClient?: () => Bugsee | undefined } = {},
): void {
  if (isRouteErrorResponse(error)) return;
  reportReactError(error, options.getClient !== undefined ? { getClient: options.getClient } : {});
}

// API parity with the umbrella entries: the same VALUE surface, thin re-exports of the same functions.
export {
  addReportAttachment,
  BugseeStatus,
  getDefaultNetworkSanitizer,
  getStatus,
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
  type ReportAttachmentInput,
  relaunch,
} from '@bugsee/bugsee';
