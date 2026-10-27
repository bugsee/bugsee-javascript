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
 * full `displays` list and the `capture` state belong to main (pixel video; the blackout state is session-wide). Main may
 * not write them (no `screen`, no pixel video), but then nobody does: a renderer's own entry would be a second, per-window
 * value interleaving into the session.
 */
export const ELECTRON_RENDERER_NEVER_WRITES: readonly TraceName[] = [
  TraceName.DISPLAYS,
  TraceName.CAPTURE,
];

/**
 * The renderer's fail-closed DEFAULT before the handshake: the never-written names plus main's heap. The handshake reply
 * replaces the heap part with what main declares it writes; the never-written names stay.
 */
export const ELECTRON_RENDERER_HOST_OWNED_TRACES: readonly TraceName[] = [
  ...ELECTRON_RENDERER_NEVER_WRITES,
  ...ELECTRON_MAIN_HEAP_TRACES,
];
