import type { JSX } from 'solid-js';

/**
 * The app-level `<ErrorBoundary>` fallback (wired in main.tsx, wrapping `<AppRouter/>` — see
 * docs/samples/PLAN.md §5.5). Deliberately a PLAIN `<a>`, not `@solidjs/router`'s `<A>`: the
 * ErrorBoundary sits ABOVE `<Router>` (it wraps AppRouter, which is what creates the Router context),
 * so when this fallback renders it replaces the Router along with everything under it — there is no
 * Route context left for `<A>` to resolve against, and it throws "'<A> ... primitives can be only
 * used inside a Route" (a SECOND, uncaught error, escaping straight past this same boundary). A plain
 * anchor triggers a full page reload instead of a client-side nav, which is the right degradation for
 * a fatal-error screen anyway.
 */
export default function ErrorFallback(props: { error: unknown }): JSX.Element {
  const message = props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <div class="error-fallback" data-testid="error-fallback">
      <h2>Something broke</h2>
      <p>{message}</p>
      <p>This was reported to Bugsee via solidErrorHandler in an &lt;ErrorBoundary&gt;.</p>
      <a href="/issues">Back to issues</a>
    </div>
  );
}
