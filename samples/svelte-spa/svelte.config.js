// Wires the package under test into the Svelte compiler pipeline: `@bugsee/svelte-plugin-component-annotate`
// stamps `data-bugsee-component="<Name>"` on every host element (component attribution, the Svelte
// counterpart to the React babel plugin) and, with `renderSpans: true`, also injects an `onMount`-based
// `startSvelteRenderSpan` call into every component (see `packages/svelte-plugin-component-annotate/README.md`
// + docs/samples/PLAN.md §5.4's "beyond the catalog" list). Both are exercised for EVERY component in this
// app, not just a demo widget, because the preprocessor runs at compile time over the whole tree.
import { componentAnnotatePreprocessor } from '@bugsee/svelte-plugin-component-annotate';

export default {
  preprocess: [componentAnnotatePreprocessor({ renderSpans: true })],
};
