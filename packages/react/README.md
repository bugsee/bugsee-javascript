# @bugsee/react

The React adapter for the Bugsee SDK (tier 4) — a structural peer: `react` is a peer dependency, imported
only by the error boundary. Plugs React's error + routing into the `@bugsee/browser` foundation.

## Error seam

Wrap a subtree so a render error is reported (with the React component stack, linked via `error.cause`) and
a fallback is shown:

```tsx
import { BugseeErrorBoundary, withBugseeErrorBoundary } from '@bugsee/react';

<BugseeErrorBoundary fallback={<Crashed />}>
  <App />
</BugseeErrorBoundary>;

// or as a HOC
export default withBugseeErrorBoundary(App, { fallback: <Crashed /> });
```

`reportReactError(error, { componentStack })` is the underlying call if you wire your own boundary or a
React-19 global handler. Reports go to the launched Bugsee client (the process carrier by default).

## Router naming (react-router v6/v7)

Refine the active navigation transaction to the parameterized route (`/users/:id`) once routing resolves —
the second phase of two-phase naming. Pass react-router's `matchRoutes()` output on each navigation:

```ts
import { matchRoutes } from 'react-router-dom';
import { instrumentRouterMatches } from '@bugsee/react';

instrumentRouterMatches(matchRoutes(routes, location));
// or set a name directly: setRouteName('/users/:id')
```

`routePatternFromMatches(matches)` builds the pattern; `setRouteName(name)` is the generic primitive.

## Preact

Preact (≥10) is supported through this adapter via `preact/compat` (the standard React-compat aliasing) — no
separate package. Under compat, `preact/compat`'s `Component` provides React-compatible error boundaries
(`getDerivedStateFromError` / `componentDidCatch`), so `BugseeErrorBoundary` / `withBugseeErrorBoundary` catch
descendant render errors unchanged, and the router helpers are structural (they consume a `matchRoutes()`-shaped
value from react-router or preact-iso). Alias `react`/`react-dom` → `preact/compat` in your bundler (as a Preact
app already does) and use `@bugsee/react` as-is. Caveat: Preact's `componentDidCatch` does not populate
`errorInfo.componentStack`, so under Preact the report carries the error but no React component-stack tree (the
boundary handles this gracefully — it simply omits it).

Built test-first per `docs/implementation-standards.md`; see `docs/design/frontend-adapters.md` §6 (D8).
