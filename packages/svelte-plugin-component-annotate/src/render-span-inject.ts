import { componentNameFromFilename } from './component-name';

// The render-span SCRIPT injection (frontend-adapters depth pass — the Svelte init-span emit). Svelte has no
// global lifecycle hook, so we inject an `onMount`-based init-span call into each component's INSTANCE script:
//   import { onMount as __bugsee_onMount } from 'svelte';
//   import { startSvelteRenderSpan as __bugsee_startRenderSpan } from '@bugsee/svelte';
//   __bugsee_onMount(__bugsee_startRenderSpan('<Name>'));
// `startSvelteRenderSpan` (in @bugsee/svelte, the runtime) captures the start at component-init time and, when
// `onMount` fires, records a `ui.render` 'mount' span (init→mounted). INIT-ONLY: `onMount` works on Svelte 4
// AND 5 (incl. runes); update tracking (beforeUpdate/afterUpdate) is deprecated/disallowed under runes, so we
// don't. The `svelte` value import lands in the USER's bundle (not this build-tool package), and the
// `@bugsee/svelte` import resolves the runtime helper the user already has installed.

// Aliases unlikely to collide with user code; the render alias also doubles as the idempotency marker.
const ONMOUNT_ALIAS = '__bugsee_onMount';
const RENDER_ALIAS = '__bugsee_startRenderSpan';

export interface SvelteScriptInput {
  /** The inner code of a `<script>` block. */
  content: string;
  /** The `<script>` tag's attributes (e.g. `{ context: 'module' }` / `{ module: true }` / `{ lang: 'ts' }`). */
  attributes?: Record<string, string | boolean>;
  /** The component file path. */
  filename?: string;
}

/** Inject the onMount render-span call into a component's INSTANCE `<script>`. Returns the transformed code,
 *  or undefined to leave the script untouched: a module script (`onMount` belongs to the instance), a
 *  non-.svelte / nameless file, or one already injected (idempotent). */
export function injectRenderSpan(input: SvelteScriptInput): { code: string } | undefined {
  const attributes = input.attributes ?? {};
  // A module script is `<script context="module">` (Svelte 4) or `<script module>` (Svelte 5) — skip it.
  if (attributes.context === 'module' || 'module' in attributes) return undefined;
  const name = componentNameFromFilename(input.filename);
  if (name === undefined) return undefined;
  if (input.content.includes(RENDER_ALIAS)) return undefined; // already injected — don't double up
  const injection =
    `import { onMount as ${ONMOUNT_ALIAS} } from 'svelte';\n` +
    `import { startSvelteRenderSpan as ${RENDER_ALIAS} } from '@bugsee/svelte';\n` +
    `${ONMOUNT_ALIAS}(${RENDER_ALIAS}(${JSON.stringify(name)}));\n`;
  return { code: injection + input.content };
}
