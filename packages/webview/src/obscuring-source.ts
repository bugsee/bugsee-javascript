import type { SecureArea } from './protocol';

// The obscuring source (docs/design/webview-bridge.md D10) — the WebView-specific capability that lets the
// advanced SDK fully REPLACE the legacy inject-script. JS cannot redact native-rendered pixels, so it streams
// the viewport rects of sensitive elements + native masks them in its captured frames. Ported from the legacy
// `hidden-view` interceptor, but READ-ONLY: the legacy auto-added a `.bugsee-hide` class to password/cc inputs
// (a DOM mutation); we instead just MATCH those inputs, never mutating the embedded app's DOM ("interceptors
// must not alter app behavior"). Secured = secure INPUTS (`type=password` / `autocomplete*="cc-"` → `text`) +
// explicitly `.bugsee-hide`-marked elements (`hidden`). Change-tracked via MutationObserver + window
// scroll/resize/orientation + document focus/blur; `snapshot()` reads the current set on demand (native calls it
// synchronously at frame-capture time).

/** Secure INPUT fields auto-masked by default (passwords + payment-card inputs). `:not(.bugsee-show)` honors the
 *  legacy opt-out — an app may mark such a field `.bugsee-show` to keep it visible in the capture. */
const SECURE_INPUT_SELECTOR =
  'input[type=password]:not(.bugsee-show), input[autocomplete*="cc-"]:not(.bugsee-show)';
/** Elements an app/integrator explicitly marks to mask. */
const HIDE_SELECTOR = '.bugsee-hide';
// The events that can move/add/remove a secure area. `load` (window) matters for COMPOSITION: when the frame
// tree finishes loading, a recompute re-bubbles a static sub-frame's rects up — so a deep static child that
// bubbled on its own start() before its parent's `message` listener was attached is not lost (legacy parity:
// the legacy `hidden-view` re-ran on `load`/`DOMContentLoaded` for exactly this).
const WINDOW_EVENTS = ['scroll', 'resize', 'orientationchange', 'load'] as const;
const DOCUMENT_EVENTS = ['focus', 'blur'] as const;

interface RectEl {
  getBoundingClientRect(): { top: number; left: number; bottom: number; right: number };
}
/** The minimal DOM document surface the source needs. */
export interface SecureDocument {
  querySelectorAll(selectors: string): ArrayLike<RectEl>;
  addEventListener(type: string, listener: () => void, options?: unknown): void;
  removeEventListener(type: string, listener: () => void, options?: unknown): void;
  /** The mutation-observation root (defaults to the document itself when absent). */
  body?: unknown;
}
/** The minimal window surface (a change-event target for scroll/resize/orientation). */
export interface SecureWindow {
  addEventListener(type: string, listener: () => void, options?: unknown): void;
  removeEventListener(type: string, listener: () => void, options?: unknown): void;
}
interface MutationObserverLike {
  observe(target: unknown, options?: unknown): void;
  disconnect(): void;
}
export type MutationObserverCtor = new (callback: () => void) => MutationObserverLike;

/** Read the current secure areas from the document, each a VIEWPORT-relative rect (`getBoundingClientRect`). The
 *  obscuring COMPOSER applies the offsets that turn these into document-absolute coordinates — the top-frame
 *  scroll, and (for rects bubbled up from a sub-frame) the iframe's position — so the source itself stays a pure
 *  per-frame collector. */
export function collectSecureAreas(document: SecureDocument): SecureArea[] {
  const seen = new Set<RectEl>();
  const areas: SecureArea[] = [];
  const add = (element: RectEl, type: SecureArea['type']): void => {
    if (seen.has(element)) {
      return; // an input matched by BOTH selectors is reported once (as `text`, collected first)
    }
    seen.add(element);
    const r = element.getBoundingClientRect();
    areas.push({ type, top: r.top, left: r.left, bottom: r.bottom, right: r.right });
  };
  for (const element of Array.from(document.querySelectorAll(SECURE_INPUT_SELECTOR))) {
    add(element, 'text');
  }
  for (const element of Array.from(document.querySelectorAll(HIDE_SELECTOR))) {
    add(element, 'hidden');
  }
  return areas;
}

export interface ObscuringSource {
  /** The current secure areas (native calls this synchronously at frame-capture time). */
  snapshot(): SecureArea[];
  /** Begin change-tracking; `onChange(areas)` fires on mutation/scroll/resize/orientation/focus/blur. */
  start(): void;
  /** Stop tracking + detach all observers/listeners. */
  stop(): void;
}

/** Build the obscuring source over a document (+ optional window) — read-only, never mutates the app's DOM. */
export function createObscuringSource(opts: {
  document: SecureDocument;
  window?: SecureWindow;
  onChange: (areas: SecureArea[]) => void;
  /** MutationObserver constructor; injectable for tests. Default `globalThis.MutationObserver`. */
  mutationObserver?: MutationObserverCtor;
}): ObscuringSource {
  const { document, window, onChange } = opts;
  const areas = (): SecureArea[] => collectSecureAreas(document);
  const recompute = (): void => onChange(areas());
  const detach: Array<() => void> = [];
  let started = false;

  return {
    snapshot: areas,
    start(): void {
      if (started) {
        return; // idempotent — a second start() must not double-attach observers/listeners (duplicate emits)
      }
      started = true;
      const Observer =
        opts.mutationObserver ??
        (globalThis as { MutationObserver?: MutationObserverCtor }).MutationObserver;
      if (Observer !== undefined) {
        const observer = new Observer(recompute);
        observer.observe(document.body ?? document, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true, // a text-node change can move/resize a secure element (legacy parity)
        });
        detach.push(() => observer.disconnect());
      }
      const options = { capture: true, passive: true };
      if (window !== undefined) {
        for (const type of WINDOW_EVENTS) {
          window.addEventListener(type, recompute, options);
          detach.push(() => window.removeEventListener(type, recompute, options));
        }
      }
      for (const type of DOCUMENT_EVENTS) {
        document.addEventListener(type, recompute, options);
        detach.push(() => document.removeEventListener(type, recompute, options));
      }
    },
    stop(): void {
      started = false;
      for (const off of detach.splice(0)) {
        off();
      }
    },
  };
}
