# @bugsee/svelte-plugin-component-annotate

A Svelte **preprocessor** that annotates each host element of a `.svelte` component with
`data-bugsee-component="<ComponentName>"` — the name of the component (derived from the file). At capture
time the `@bugsee/browser` runtime (depth pass D2) reads the nearest annotated ancestor of an
interaction/error target, so clicks and errors attribute to a **component name** that survives minification
(the literal name is emitted at build time). This is the Svelte counterpart to
`@bugsee/babel-plugin-component-annotate` (the JSX/React side) and the `createBugseeVueComponentMixin` (the
Vue side).

```js
// svelte.config.js
import { componentAnnotatePreprocessor } from '@bugsee/svelte-plugin-component-annotate';

export default {
  preprocess: [componentAnnotatePreprocessor()],
};
```

**Render spans (opt-in).** With `componentAnnotatePreprocessor({ renderSpans: true })` the preprocessor also
adds a `script` hook that injects an `onMount`-based init render-span into each component — it records a
`ui.render` 'mount' span (component init → mounted) on the active transaction via `@bugsee/svelte`'s
`startSvelteRenderSpan` (which the injected code calls, so `@bugsee/svelte` must be installed). Init-only by
design: `onMount` works on Svelte 4 **and** Svelte 5 (incl. runes mode), whereas update tracking
(`beforeUpdate`/`afterUpdate`) is deprecated and disallowed under runes. Module scripts
(`<script context="module">` / `<script module>`) and already-injected files are skipped.

The component name is the file basename (`UserCard.svelte` → `UserCard`); for files with no meaningful
basename — `index.svelte` and SvelteKit route files (`+page` / `+layout` / `+error`) — the enclosing
directory name is used (`routes/dashboard/+page.svelte` → `dashboard`). Every host (lowercase-tag) element is
annotated; component instances (`<Child/>`) get no DOM attribute, and an element you annotated by hand is left
alone. Version-agnostic: it handles both the legacy AST (Svelte ≤4 and Svelte 5's default) and the modern AST
(Svelte ≥6 / `modern: true`). A parse failure is a no-op here (Svelte's own compiler reports the real syntax
error). Insertions are inline on the tag line, so source line numbers are preserved. `svelte` is a peer
dependency. See `docs/design/frontend-adapters.md` §7 (the depth pass).
