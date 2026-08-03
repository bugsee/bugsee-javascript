import {
  createObscuringSource,
  FAIL_CLOSED_AREA,
  type MutationObserverCtor,
  type SecureDocument,
  type SecureWindow,
} from './obscuring-source';
import type { SecureArea } from './protocol';

// Sub-frame secure-rect COMPOSITION (docs/design/webview-bridge.md D9/D10 — the open frame-attribution item).
// A WebView can host (cross-origin) sub-frames, each injected with its own SDK. The native mask is composed over
// the WHOLE page, so the TOP frame must report the UNION of every frame's secure rects (in top-document
// coordinates) — otherwise native can't drop its legacy masking. Ported from the legacy `VIEWS_BUBBLE` mechanism:
//   - each frame's obscuring SOURCE produces VIEWPORT-relative rects for that frame;
//   - a CHILD frame `postMessage`s its composed rects up to `window.parent` (cross-origin-safe — see below);
//   - a frame RECEIVES a child's bubble, re-maps it by that child's `<iframe>` offset (read FRESH each compose,
//     so an intermediate-frame scroll never goes stale) into its own viewport space, and folds it in;
//   - the TOP frame adds the page scroll → DOCUMENT-ABSOLUTE → posts the `secure` message to native.
// SECURITY: the bubble carries only NON-PII rect coordinates, so `targetOrigin:'*'` (required cross-origin) is
// safe; a bubble is accepted ONLY from a window verified to be one of this frame's `<iframe>.contentWindow`
// (foreign messages ignored). Composition only ADDS rects, so a malicious bubble can only OVER-mask, never leak.

/** The cross-frame bubble marker + version (a JS<->JS channel, distinct from the JS<->native bridge protocol). */
const BUBBLE_KEY = '__bugsee_secure_bubble';
const BUBBLE_VERSION = 1;

interface ComposerElement {
  /** Present on `<iframe>` elements — the framed window (matched against a bubble's `event.source`). */
  contentWindow?: unknown;
  getBoundingClientRect(): {
    readonly top: number;
    readonly left: number;
    readonly bottom: number;
    readonly right: number;
  };
}
/** The document surface the composer needs — the source's, plus `querySelectorAll('iframe')` returning elements
 *  that expose `contentWindow`. Assignable to {@link SecureDocument} (a superset), so the source shares it. */
export interface ComposerDocument {
  querySelectorAll(selectors: string): ArrayLike<ComposerElement>;
  addEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
  body?: unknown;
}
/** The window surface — a change-event target + `message` channel, the page scroll, and `parent` to bubble to. */
export interface ComposerWindow {
  addEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
  readonly scrollX?: number;
  readonly scrollY?: number;
  readonly parent?: { postMessage(message: unknown, targetOrigin: string): void };
}

export interface ObscuringComposer {
  /** Begin tracking (the source + the cross-frame bubble listener). A child bubbles its initial areas on start. */
  start(): void;
  /** Stop + detach everything. */
  stop(): void;
  /** The current composed secure areas — top frame: document-absolute (the native pull). */
  snapshot(): SecureArea[];
  /** Recompute + re-emit/re-bubble now (the native `snapshot` control command). */
  refresh(): void;
}

/** Build the per-frame obscuring composer. Top frame → `onCompose(documentAbsoluteAreas)`; child → bubble up. */
export function createObscuringComposer(opts: {
  document: ComposerDocument;
  window?: ComposerWindow;
  /** Is this the TOP frame? Top composes+scrolls and posts to native; a child bubbles to its parent. */
  isTopFrame: boolean;
  /** Top frame: receives the composed DOCUMENT-ABSOLUTE areas whenever they change. */
  onCompose?: (areas: SecureArea[]) => void;
  /** MutationObserver constructor; injectable for tests. */
  mutationObserver?: MutationObserverCtor;
  /** Where a collection/compose failure is reported (Wave 1.4). */
  onError?: (error: unknown) => void;
}): ObscuringComposer {
  const { document, window, isTopFrame, onCompose } = opts;
  const onError = opts.onError;
  // Raw child-VIEWPORT areas keyed by the bubbling child window (re-mapped fresh at compose time).
  const childAreas = new Map<unknown, readonly SecureArea[]>();
  let ownAreas: readonly SecureArea[] = [];

  const offset = (areas: readonly SecureArea[], dx: number, dy: number): SecureArea[] =>
    areas.map((a) => ({
      type: a.type,
      top: a.top + dy,
      left: a.left + dx,
      bottom: a.bottom + dy,
      right: a.right + dx,
    }));

  /** Keep only well-formed secure areas from a received bubble — a valid type + four FINITE numeric coords. A
   *  bubble comes from an embedded (page-trusted) frame, but a buggy/hostile child must not be able to inject
   *  NaN/Infinity/non-numeric coordinates into the native obscuring payload. */
  const sanitize = (areas: readonly unknown[]): SecureArea[] => {
    const out: SecureArea[] = [];
    for (const raw of areas) {
      const a = raw as Partial<SecureArea>;
      if (
        (a?.type === 'text' || a?.type === 'hidden') &&
        Number.isFinite(a.top) &&
        Number.isFinite(a.left) &&
        Number.isFinite(a.bottom) &&
        Number.isFinite(a.right)
      ) {
        out.push({
          type: a.type,
          top: a.top as number,
          left: a.left as number,
          bottom: a.bottom as number,
          right: a.right as number,
        });
      }
    }
    return out;
  };

  /** Find the `<iframe>` whose `contentWindow` is `win` (a verified child frame), or undefined. */
  const iframeFor = (win: unknown): ComposerElement | undefined => {
    for (const el of Array.from(document.querySelectorAll('iframe'))) {
      if (el.contentWindow === win) {
        return el;
      }
    }
    return undefined;
  };

  /** Compose own areas + every child's (re-mapped by its iframe's CURRENT offset); a removed iframe is GC'd. */
  const compose = (): SecureArea[] => {
    const result = [...ownAreas];
    for (const [win, areas] of childAreas) {
      const iframe = iframeFor(win);
      if (iframe === undefined) {
        childAreas.delete(win); // the iframe was removed — drop its stale rects
        continue;
      }
      const r = iframe.getBoundingClientRect();
      result.push(...offset(areas, Math.floor(r.left), Math.floor(r.top)));
    }
    return result;
  };

  /** Emit: top frame → composed+scrolled to native; child frame → bubble composed (viewport) to the parent. */
  const emit = (): void => {
    const composed = compose();
    if (isTopFrame) {
      onCompose?.(
        offset(composed, Math.floor(window?.scrollX ?? 0), Math.floor(window?.scrollY ?? 0)),
      );
    } else {
      window?.parent?.postMessage({ [BUBBLE_KEY]: BUBBLE_VERSION, areas: composed }, '*');
    }
  };

  const onMessage = (event: unknown): void => {
    const e = event as { data?: unknown; source?: unknown };
    const data = e.data as { [BUBBLE_KEY]?: unknown; areas?: unknown } | null | undefined;
    if (data == null || typeof data !== 'object') {
      return; // not an object
    }
    if (data[BUBBLE_KEY] !== BUBBLE_VERSION || !Array.isArray(data.areas)) {
      return; // not a current-version Bugsee bubble
    }
    if (iframeFor(e.source) === undefined) {
      return; // SECURITY: only accept bubbles from a verified child iframe of THIS frame
    }
    childAreas.set(e.source, sanitize(data.areas)); // drop malformed/non-finite rects before composing
    emit();
  };

  const source = createObscuringSource({
    document,
    ...(window !== undefined ? { window: window as unknown as SecureWindow } : {}),
    onChange: (areas) => {
      ownAreas = areas;
      emit();
    },
    ...(opts.mutationObserver !== undefined ? { mutationObserver: opts.mutationObserver } : {}),
    ...(onError !== undefined ? { onError } : {}),
  });

  let detachMessage: (() => void) | undefined;
  const documentAbsolute = (composed: readonly SecureArea[]): SecureArea[] =>
    offset(composed, Math.floor(window?.scrollX ?? 0), Math.floor(window?.scrollY ?? 0));

  return {
    snapshot(): SecureArea[] {
      // The synchronous native pull, at frame-capture time. `source.snapshot()` already fails closed, but
      // compose() reads every child iframe's live rect and documentAbsolute() reads window scroll — either
      // can throw on a hostile or mid-teardown page, and native has already stood its own masking down.
      try {
        ownAreas = source.snapshot(); // fresh own areas for the synchronous native pull
        const composed = compose();
        return isTopFrame ? documentAbsolute(composed) : [...composed];
      } catch (error) {
        onError?.(error);
        return [FAIL_CLOSED_AREA];
      }
    },
    refresh(): void {
      ownAreas = source.snapshot();
      emit();
    },
    start(): void {
      ownAreas = source.snapshot();
      source.start();
      if (window !== undefined) {
        const handler = (e: unknown): void => onMessage(e);
        window.addEventListener('message', handler);
        detachMessage = (): void => window.removeEventListener('message', handler);
      }
      if (!isTopFrame) {
        emit(); // a child bubbles its initial areas so STATIC child content still reaches the parent
      }
    },
    stop(): void {
      source.stop();
      detachMessage?.();
      detachMessage = undefined;
      childAreas.clear();
    },
  };
}
