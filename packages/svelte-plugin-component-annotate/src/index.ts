import { parse } from 'svelte/compiler';
import { annotateMarkup } from './annotate';
import { componentNameFromFilename } from './component-name';
import { injectRenderSpan, type SvelteScriptInput } from './render-span-inject';

// @bugsee/svelte-plugin-component-annotate — a Svelte PREPROCESSOR (the Svelte emit side of the shared D2/D3
// component-attribution mechanism). It stamps each `.svelte` component's host elements with
// `data-bugsee-component="<Name>"` (the name derived from the file), so the @bugsee/browser runtime can
// attribute a captured interaction/error to the COMPONENT that rendered the target. The Svelte counterpart to
// React's babel plugin: a build-time tool with only `svelte` as a peer (no @bugsee runtime dependency). Wire
// it in svelte.config.js: `preprocess: [componentAnnotatePreprocessor(), ...]`.

/** The subset of a Svelte `markup` preprocessor input we use. */
export interface SvelteMarkupInput {
  content: string;
  filename?: string;
}

/** A minimal Svelte `PreprocessorGroup` (the `markup` hook + an optional `script` hook for render spans). */
export interface ComponentAnnotatePreprocessor {
  markup(input: SvelteMarkupInput): { code: string } | undefined;
  script?(input: SvelteScriptInput): { code: string } | undefined;
}

export interface ComponentAnnotateOptions {
  /** ALSO inject onMount-based render-span timing (the Svelte init-span). Opt-in (default false); requires
   *  `@bugsee/svelte` at runtime, whose `startSvelteRenderSpan` the injected code calls. */
  renderSpans?: boolean;
}

/** Build the preprocessor. The `markup` hook stamps host elements with `data-bugsee-component` (a no-op for
 *  non-.svelte files, files with no host elements, or unparseable markup). With `{ renderSpans: true }` it
 *  also adds a `script` hook that injects an onMount render-span call into each component's instance script. */
export function componentAnnotatePreprocessor(
  options: ComponentAnnotateOptions = {},
): ComponentAnnotatePreprocessor {
  const group: ComponentAnnotatePreprocessor = {
    markup({ content, filename }: SvelteMarkupInput): { code: string } | undefined {
      const name = componentNameFromFilename(filename);
      if (name === undefined) return undefined;
      const code = annotateMarkup(content, name, (source) => parse(source, { filename }));
      return code === undefined ? undefined : { code };
    },
  };
  if (options.renderSpans) {
    group.script = (input: SvelteScriptInput) => injectRenderSpan(input);
  }
  return group;
}

export { annotateMarkup } from './annotate';
export { componentNameFromFilename } from './component-name';
export { injectRenderSpan, type SvelteScriptInput } from './render-span-inject';
