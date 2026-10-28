import { TraceName } from '@bugsee/protocol';

// The Electron trace-ownership tables. They live here, not in `@bugsee/capture`, so they never ship in the WebView's
// injectable bundle (which has a size budget): only `@bugsee/electron` uses them.

/** The node trace set's V8 heap names: written by Electron MAIN for its own heap. */
export const ELECTRON_MAIN_HEAP_TRACES: readonly TraceName[] = [
  TraceName.RAM_JS_HEAP_TOTAL,
  TraceName.RAM_JS_HEAP_USED,
  TraceName.RAM_JS_HEAP_FREE,
];

/**
 * Names an Electron RENDERER never writes, whatever main declares (spec platforms/javascript.md "Host-owned traces"): the
 * full `displays` list and the `capture` state belong to main (pixel video; the blackout state is session-wide), and the
 * heap `ram_js_heap_*` is main's own V8 heap (the spec marks it "-" for renderers). Main may not write them (no `screen`, no
 * pixel video, a producer set without a heap producer, the legacy sampler, system traces off), but then nobody does: a
 * renderer's own entry would be a per-window value interleaving into the session, two heaps in one curve.
 */
export const ELECTRON_RENDERER_NEVER_WRITES: readonly TraceName[] = [
  TraceName.DISPLAYS,
  TraceName.CAPTURE,
  TraceName.RAM_JS_HEAP_TOTAL,
  TraceName.RAM_JS_HEAP_USED,
  TraceName.RAM_JS_HEAP_FREE,
];

/** The renderer's fail-closed DEFAULT before the handshake: the same names (main's `ho` can only ADD to them). */
export const ELECTRON_RENDERER_HOST_OWNED_TRACES: readonly TraceName[] =
  ELECTRON_RENDERER_NEVER_WRITES;
