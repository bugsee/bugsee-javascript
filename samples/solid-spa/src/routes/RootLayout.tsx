import { A, useCurrentMatches } from '@solidjs/router';
import { createEffect } from 'solid-js';
import type { JSX } from 'solid-js';
import type { RouteSectionProps } from '@solidjs/router';
import { setRouteNameFromSolidMatches } from '@bugsee/solid';

/**
 * @bugsee/solid router integration under test, wired globally: `useCurrentMatches` + a reactive
 * `createEffect` refine the active navigation transaction to the matched route PATTERN
 * (`/issues/:id`), never the concrete URL (`/issues/issue-1`) — see docs/design/frontend-adapters.md
 * §7 / the D5 two-phase naming seam. Solid Router has no afterEach hook (it's reactive, not
 * event-based), so this effect IS the wiring — one call site for the whole app.
 */
function RouteNameSync() {
  const matches = useCurrentMatches();
  createEffect(() => {
    setRouteNameFromSolidMatches(matches());
  });
  return null;
}

export default function RootLayout(props: RouteSectionProps): JSX.Element {
  return (
    <div class="app-shell">
      <nav class="app-nav">
        <h1>Bugtrackee</h1>
        <A href="/issues">Issues</A>
        <A href="/settings">Settings</A>
        <A href="/scenarios">Scenarios</A>
      </nav>
      <main class="app-main">
        <RouteNameSync />
        {props.children}
      </main>
    </div>
  );
}
