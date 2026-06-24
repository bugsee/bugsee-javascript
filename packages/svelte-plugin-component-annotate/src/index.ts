import { parse } from 'svelte/compiler';
import { annotateMarkup } from './annotate';
import { componentNameFromFilename } from './component-name';

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

/** A minimal Svelte `PreprocessorGroup` (just the `markup` hook). */
export interface ComponentAnnotatePreprocessor {
  markup(input: SvelteMarkupInput): { code: string } | undefined;
}

/** Build the preprocessor. A no-op (returns undefined → original source kept) for non-.svelte files, files
 *  with no host elements, or unparseable markup. */
export function componentAnnotatePreprocessor(): ComponentAnnotatePreprocessor {
  return {
    markup({ content, filename }: SvelteMarkupInput): { code: string } | undefined {
      const name = componentNameFromFilename(filename);
      if (name === undefined) return undefined;
      const code = annotateMarkup(content, name, (source) => parse(source, { filename }));
      return code === undefined ? undefined : { code };
    },
  };
}

export { annotateMarkup } from './annotate';
export { componentNameFromFilename } from './component-name';
