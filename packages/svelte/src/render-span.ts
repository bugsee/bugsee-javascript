import {
  type AdapterClientOptions,
  recordRenderSpan,
  resolveTimeOrigin,
} from '@bugsee/web-adapter';

// @bugsee/svelte RENDER SPANS (frontend-adapters depth pass — the Svelte init-span). Svelte has no global
// lifecycle hook (unlike Vue's mixin), so the @bugsee/svelte-plugin-component-annotate preprocessor INJECTS a
// call to this helper into each component: `onMount(startSvelteRenderSpan('<Name>'))`. The helper captures
// the start at COMPONENT-INIT time (when the injected call runs, top of the script) and returns a function
// that, when `onMount` fires (after the DOM mount), records a `ui.render` 'mount' span from init→mounted.
// INIT-ONLY by design: `onMount` works on Svelte 4 AND Svelte 5 (incl. runes mode), whereas update-tracking
// (beforeUpdate/afterUpdate) is deprecated + disallowed under Svelte 5 runes — so we deliberately don't.
// A no-op when no transaction is active / no SDK.

export interface SvelteRenderSpanOptions extends AdapterClientOptions {
  /** Injectable epoch-ms clock. Default `performance.timeOrigin + performance.now()`. */
  now?: () => number;
}

// Not `(perf?.timeOrigin ?? 0) + …`: `??` only replaces `null`/`undefined`, so a NaN (or, via an unchecked
// cast, a non-number) `timeOrigin` sailed through and poisoned the span's wire timestamps into NaN. And a
// literal 0 fared no better — this span nests under a transaction whose own start time is a real epoch
// value (Date.now()-based), so a 0 origin stamped the span ~1970 inside it. `resolveTimeOrigin` (from
// @bugsee/util, via the web-adapter re-export) screens both and reconstructs a usable-if-imprecise origin
// from a live wall-clock reading when the host's own is unusable.
const defaultNow = (): number => {
  const perf = (globalThis as { performance?: { now?: () => number; timeOrigin?: unknown } })
    .performance;
  return (perf?.now?.() ?? 0) + resolveTimeOrigin(perf);
};

/** Begin timing a Svelte component's init→mount render. Call at component init (the preprocessor injects
 *  `onMount(startSvelteRenderSpan('<Name>'))`); the returned function records the `ui.render` span and is
 *  meant to be passed to `onMount`. */
export function startSvelteRenderSpan(
  componentName: string,
  options: SvelteRenderSpanOptions = {},
): () => void {
  const now = options.now ?? defaultNow;
  const startTimestampMs = now();
  return (): void => {
    recordRenderSpan(
      { name: componentName, startTimestampMs, endTimestampMs: now(), phase: 'mount' },
      { getClient: options.getClient },
    );
  };
}
