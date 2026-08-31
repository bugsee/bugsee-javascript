// A hand-rolled hash router — this sample is a plain Svelte SPA, NOT a SvelteKit app (SvelteKit has its
// own file-based router; `sveltekit-app`, PLAN §5.11, is the separate sample for that). `@bugsee/svelte`
// (packages/svelte/src/router.ts) is nonetheless wired here: `instrumentSvelteKitNavigation` /
// `routeIdFromNavigation` / `setRouteName` are all STRUCTURAL PEERS over SvelteKit's `afterNavigate`
// argument shape (`{ to: { route: { id } } }`, no `$app/navigation` import) — so this router builds that
// exact shape by hand on every navigation and hands it to the same seam a real SvelteKit host would use.
// Route ids follow SvelteKit's own bracket syntax (`/habits/[id]`) per the package's convention of NOT
// normalizing to another framework's route-naming style.
import {
  instrumentSvelteKitNavigation,
  routeIdFromNavigation,
  setRouteName,
  type AfterNavigateLike,
} from '@bugsee/svelte';

export interface RouteDef {
  /** SvelteKit-style route id, e.g. '/habits/[id]'. */
  id: string;
  test: RegExp;
  params: string[];
}

export const ROUTES: RouteDef[] = [
  { id: '/habits', test: /^\/habits\/?$/, params: [] },
  { id: '/habits/[id]', test: /^\/habits\/([^/]+)\/?$/, params: ['id'] },
  { id: '/calendar', test: /^\/calendar\/?$/, params: [] },
  { id: '/stats', test: /^\/stats\/?$/, params: [] },
  { id: '/settings', test: /^\/settings\/?$/, params: [] },
  { id: '/scenarios', test: /^\/scenarios\/?$/, params: [] },
];

export interface RouteMatch {
  /** null mirrors SvelteKit's own `route.id` for an unmatched path. */
  id: string | null;
  path: string;
  params: Record<string, string>;
}

function matchPath(path: string): RouteMatch {
  for (const route of ROUTES) {
    const m = route.test.exec(path);
    if (m) {
      const params: Record<string, string> = {};
      route.params.forEach((key, i) => {
        params[key] = m[i + 1] ?? '';
      });
      return { id: route.id, path, params };
    }
  }
  return { id: null, path, params: {} };
}

function currentPath(): string {
  const h = window.location.hash.slice(1);
  return h === '' ? '/habits' : h;
}

// eslint-disable-next-line prefer-const -- reassigned from handleChange below
let routeState = $state<RouteMatch>(matchPath(currentPath()));

// Wired ONCE at module init — real usage is `afterNavigate(instrumentSvelteKitNavigation())` in
// SvelteKit; here the hand-rolled router calls the returned function on every hash change instead of a
// framework navigation event.
const afterNavigate = instrumentSvelteKitNavigation();

function handleChange(): void {
  const match = matchPath(currentPath());
  routeState = match;
  const navigation: AfterNavigateLike = { to: { route: { id: match.id } } };
  afterNavigate(navigation);
}

let wired = false;
export function initRouter(): void {
  if (wired) return;
  wired = true;
  window.addEventListener('hashchange', handleChange);
  handleChange(); // name the initial route too
}

export function navigate(path: string): void {
  window.location.hash = path;
}

/** Reactive read of the current route — call from a template/`$derived` to track it. */
export function currentRoute(): RouteMatch {
  return routeState;
}

// ---- Scenario-panel direct-call demos (beyond-catalog: routeIdFromNavigation + setRouteName) --------

/** Direct call proving `routeIdFromNavigation` extracts a SvelteKit route id from a synthetic
 *  navigation object, independent of this router's own wiring above. */
export function demoRouteIdFromNavigation(): string | undefined {
  return routeIdFromNavigation({ to: { route: { id: '/habits/[id]' } } });
}

/** Direct call to `setRouteName` (bypassing the navigation wiring), for the Scenario panel. */
export function demoSetRouteName(name: string): void {
  setRouteName(name);
}
