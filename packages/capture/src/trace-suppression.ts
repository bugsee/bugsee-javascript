// One name, one writer per session. A trace name a HOST already writes (the native app around a WebView, Electron's main
// process around a renderer), or that only one window may write (Electron's key window), must not also be written by the
// page SDK running inside it. This file is the whole mechanism, kept tiny so every host reaches for the same thing:
//
//   - {@link createTraceSuppression}: a LIVE set of suppressed trace names, made of independent LAYERS (`host`: what the
//     host declares it owns, `window`: what a non-key window must not write). The system-traces provider consults it for
//     every value, so a layer that changes mid-session (the host's handshake reply, a window gaining or losing the key)
//     takes effect on the very next value, and a name that is RELEASED has its held value re-recorded (see the provider).
//   - the per-host default tables below. They are the fail-closed value BEFORE the host has answered the handshake, and
//     the handshake then REPLACES the `host` layer with what the host really declares.
//
// Ownership rules come from spec platforms/javascript.md "Host-owned traces in WebViews and Electron renderers".

import { TraceName } from '@bugsee/protocol';

/** A live, layered set of suppressed trace names. */
export interface TraceSuppression {
  /** Whether a value for `name` must be dropped now. */
  has(name: string): boolean;
  /** Replace ONE layer's names; the other layers are untouched. */
  setLayer(layer: string, names: readonly string[]): void;
  /** Called after a change with the names it RELEASED (suppressed before, not any more). Returns the unsubscribe. */
  subscribe(listener: (released: readonly string[]) => void): () => void;
}

// Kept deliberately small: it ships inside the WebView's injectable bundle, which has a gzip budget.
export function createTraceSuppression(
  initial: Readonly<Record<string, readonly string[]>> = {},
): TraceSuppression {
  const layers: Record<string, readonly string[]> = { ...initial };
  const listeners = new Set<(released: readonly string[]) => void>();
  const all = (): readonly string[] => Object.values(layers).flat();
  const has = (name: string): boolean => all().includes(name);
  return {
    has,
    setLayer(layer, next): void {
      const before = all();
      layers[layer] = [...next];
      const released = before.filter((name) => !has(name));
      if (released.length) {
        for (const listener of [...listeners]) {
          try {
            listener(released);
          } catch {
            /* a listener's failure must not undo the change or starve the others */
          }
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** True for an object made by {@link createTraceSuppression} (structurally: it has the three methods). */
export function isTraceSuppression(value: unknown): value is TraceSuppression {
  const v = value as Partial<Record<keyof TraceSuppression, unknown>> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.has === 'function' &&
    typeof v.setLayer === 'function' &&
    typeof v.subscribe === 'function'
  );
}

/**
 * Validate trace names that arrive over a wire (a host's handshake reply): an array of at most 64 non-empty strings of at
 * most 64 characters each, returned as a copy; anything else is `undefined` (the whole declaration is ignored, never half
 * applied).
 */
export const sanitizeTraceNames = (value: unknown): string[] | undefined =>
  Array.isArray(value) &&
  value.length <= 64 &&
  value.every((name) => typeof name === 'string' && name.length > 0 && name.length <= 64)
    ? [...value]
    : undefined;

/** The node trace set's V8 heap names: written by Electron MAIN for its own heap (never by a renderer). */
export const ELECTRON_MAIN_HEAP_TRACES: readonly string[] = [
  TraceName.RAM_JS_HEAP_TOTAL,
  TraceName.RAM_JS_HEAP_USED,
  TraceName.RAM_JS_HEAP_FREE,
];

/**
 * Electron renderer: Electron MAIN writes the full `displays` list, the `capture` state (pixel video) and its own V8 heap
 * as `ram_js_heap_*`; a renderer writing them would put a second writer on the same name into the one session.
 * Everything else a renderer writes (device-level `battery`/`connection`, per-window state, page-owned traces) flows.
 */
export const ELECTRON_RENDERER_HOST_OWNED_TRACES: readonly string[] = [
  TraceName.DISPLAYS,
  TraceName.CAPTURE,
  // (written out, not spread: a spread is not provably pure, and would keep this table in the WebView bundle)
  TraceName.RAM_JS_HEAP_TOTAL,
  TraceName.RAM_JS_HEAP_USED,
  TraceName.RAM_JS_HEAP_FREE,
];

/**
 * WebView in a native app: the NATIVE host writes device battery, orientation, app state, connection, fps, view, display
 * and capture state (and Android `ram_system_advertised`), and the battery qualifiers only make sense next to the
 * host's `battery`. The page's OWN heap (`ram_js_heap_*`, other names than the host's `ram_jvm_heap_*`), `url`, `route`
 * and the page-owned traces stay with the WebView.
 */
export const WEBVIEW_HOST_OWNED_TRACES: readonly string[] = [
  TraceName.BATTERY,
  TraceName.CHARGING,
  TraceName.BATTERY_CHARGING_TIME_S,
  TraceName.BATTERY_DISCHARGING_TIME_S,
  TraceName.ORIENTATION,
  TraceName.APP_STATE,
  TraceName.CONNECTION,
  TraceName.FPS,
  TraceName.VIEW,
  TraceName.RAM_SYSTEM_ADVERTISED,
  TraceName.DISPLAYS,
  TraceName.CAPTURE,
];
