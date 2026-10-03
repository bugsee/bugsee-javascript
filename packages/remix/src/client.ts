// @bugsee/remix — client (browser runtime) composition.
//
// Reached from `app/entry.client.tsx` (the browser hydration entry). Browser-only (composes the
// batteries-included browser umbrella + @bugsee/react) → behind the `@bugsee/remix/client` subpath, never
// the portable `.` or node `./server` entry. Captures the SESSION the server `handleError` bridge (R1)
// stitches to a failing request.

import { type Bugsee, type BugseeLaunchOptionsWithPerformance, launch } from '@bugsee/bugsee';
import type { BugseeClient } from '@bugsee/core';
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

/**
 * The React Router v7 `<HydratedRouter onError>` (and data-router `onError`) handler — report a client
 * React error to Bugsee with its component stack. Defensive + no-ops when Bugsee is not launched (via
 * `reportReactError`).
 */
export function bugseeOnError(error: unknown, errorInfo?: ReactErrorInfo): void {
  // React's `errorInfo.componentStack` is `string | null` — narrow to a real stack before forwarding.
  const componentStack = errorInfo?.componentStack;
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
  options: { getClient?: () => BugseeClient | undefined } = {},
): void {
  if (isRouteErrorResponse(error)) return;
  reportReactError(error, options.getClient !== undefined ? { getClient: options.getClient } : {});
}
