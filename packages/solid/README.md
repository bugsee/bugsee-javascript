# @bugsee/solid

The Solid adapter for the Bugsee SDK (tier 4) — a structural peer: no `solid-js` / `@solidjs/router` import.
Plugs Solid's error + routing into the `@bugsee/browser` foundation. v1: error + routing only.

## Error reporting

Solid catches errors via the built-in `<ErrorBoundary>` and the `onError` / `catchError` primitives, all of
which hand a plain error to a callback — so wire Bugsee's reporter into Solid's own seam:

```tsx
import { onError } from 'solid-js';
import { solidErrorHandler } from '@bugsee/solid';

// at the app root:
onError(solidErrorHandler());

// or in an ErrorBoundary fallback:
<ErrorBoundary fallback={(err, reset) => { solidErrorHandler()(err); return <Crashed onReset={reset} />; }}>
  <App />
</ErrorBoundary>;
```

`reportSolidError(error)` is the underlying call. Reports go to the launched Bugsee client (the process
carrier by default).

## Router naming (@solidjs/router)

Refine the active navigation transaction to the matched route pattern (`/users/:id`). Wire it reactively:

```ts
import { useCurrentMatches } from '@solidjs/router';
import { createEffect } from 'solid-js';
import { setRouteNameFromSolidMatches } from '@bugsee/solid';

const matches = useCurrentMatches();
createEffect(() => setRouteNameFromSolidMatches(matches()));
```

`routePatternFromSolidMatches(matches)` builds the pattern; `setRouteName(name)` is the generic primitive.

Built test-first per `docs/implementation-standards.md`; see `docs/design/frontend-adapters.md` §7.
