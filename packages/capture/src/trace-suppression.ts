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

/** A live, layered set of suppressed trace names. */
export interface TraceSuppression {
  /** Whether a value for `name` must be dropped now. */
  has(name: string): boolean;
  /** Every suppressed name (a copy). */
  names(): string[];
  /** Replace ONE layer's names; the other layers are untouched. */
  setLayer(layer: string, names: readonly string[]): void;
  /** Called after a change with the names it RELEASED (suppressed before, not any more). Returns the unsubscribe. */
  subscribe(listener: (released: readonly string[]) => void): () => void;
}

export function createTraceSuppression(
  initial: Readonly<Record<string, readonly string[]>> = {},
): TraceSuppression {
  const layers = new Map<string, ReadonlySet<string>>();
  for (const [layer, names] of Object.entries(initial)) layers.set(layer, new Set(names));
  const listeners = new Set<(released: readonly string[]) => void>();

  const has = (name: string): boolean => {
    for (const set of layers.values()) if (set.has(name)) return true;
    return false;
  };
  const names = (): string[] => [...new Set([...layers.values()].flatMap((set) => [...set]))];

  return {
    has,
    names,
    setLayer(layer, next): void {
      const before = names();
      layers.set(layer, new Set(next));
      const released = before.filter((name) => !has(name));
      if (released.length === 0) return;
      for (const listener of [...listeners]) {
        try {
          listener(released);
        } catch {
          /* a listener's failure must not undo the change or starve the others */
        }
      }
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** True for an object made by {@link createTraceSuppression} (structurally: it has the four methods). */
export function isTraceSuppression(value: unknown): value is TraceSuppression {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Record<keyof TraceSuppression, unknown>>;
  return (
    typeof v.has === 'function' &&
    typeof v.names === 'function' &&
    typeof v.setLayer === 'function' &&
    typeof v.subscribe === 'function'
  );
}

const MAX_NAMES = 64;
const MAX_NAME_LENGTH = 64;

/**
 * Validate trace names that arrive over a wire (a host's handshake reply): an array of at most 64 non-empty strings of at
 * most 64 characters each, returned as a copy; anything else is `undefined` (the whole declaration is ignored, never half
 * applied).
 */
export function sanitizeTraceNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_NAMES) return undefined;
  for (const name of value) {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
      return undefined;
    }
  }
  return [...value] as string[];
}

/**
 * Electron renderer: Electron MAIN writes the full `displays` list, the `capture` state (pixel video) and its own V8 heap
 * as `ram_js_heap_*`; a renderer writing them would put a second writer on the same name into the one session.
 * Everything else a renderer writes (device-level `battery`/`connection`, per-window state, page-owned traces) flows.
 */
export const ELECTRON_RENDERER_HOST_OWNED_TRACES: readonly string[] = [
  'displays',
  'capture',
  'ram_js_heap_total',
  'ram_js_heap_used',
  'ram_js_heap_free',
];

/**
 * WebView in a native app: the NATIVE host writes device battery, orientation, app state, connection, fps, view, display
 * and capture state (and Android `ram_system_advertised`), and the battery qualifiers only make sense next to the
 * host's `battery`. The page's OWN heap (`ram_js_heap_*`, other names than the host's `ram_jvm_heap_*`), `url`, `route`
 * and the page-owned traces stay with the WebView.
 */
export const WEBVIEW_HOST_OWNED_TRACES: readonly string[] = [
  'battery',
  'charging',
  'battery_charging_time_s',
  'battery_discharging_time_s',
  'orientation',
  'app_state',
  'connection',
  'fps',
  'view',
  'ram_system_advertised',
  'displays',
  'capture',
];
