import type { VideoAuxEventDetail } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';

// The browser VIEWPORT SOURCE — the producer for the `video.aux` stream (version 2 of
// bugsee/specs `sdk/reporting/bundle/video-aux.md`). It answers one question over time: what frame were
// the recorded coordinates measured in?
//
// WHY THIS EXISTS AT ALL. `input`'s `x`/`y` are `clientX`/`clientY`: CSS px in the LAYOUT VIEWPORT. A
// consumer that has no frame to divide them by falls back to `environment.hardware.screen`, which for
// the web is `screen.width`/`screen.height` — the whole monitor, captured once at launch, and itself in
// CSS px, so it SHRINKS as the page is zoomed while `clientX` does not. Measured in headless Chrome
// varying only the CSS-px ratio: `screen.width` 800 → 534 → 400 while `getBoundingClientRect().left`
// stayed 100. A window that is not maximised breaks the same sum at any zoom. So a click rendered at
// 75% across the frame at 100% zoom lands off the frame at 200%, and nothing in the recording says why.
//
// FRAME UNITS (binding). `frameW`/`frameH` are written in the SAME unit as the coordinates — CSS px —
// never device pixels. `density` is `devicePixelRatio`, recorded so a consumer that wants device pixels
// can get them; nothing in the placement path divides by it. Writing device pixels into the frame is the
// one mistake here that looks harmless: every coordinate would land at `1/density` of where it belongs,
// and every number in the file would still look plausible. That is precisely the defect version 1 of
// this stream shipped on mobile (`screenW` was display px), which is why version 2 renamed the field.
//
// WHAT IT LISTENS TO, and why that is the complete set:
//   - `window` `resize` — a window drag, a monitor change, and a PAGE ZOOM (which moves `innerWidth` and
//     `devicePixelRatio` together). Also covers rotation: `orientationchange` fires BEFORE the new
//     dimensions are readable in some engines, and a `resize` always follows it.
//   - `visualViewport` `resize`/`scroll` — pinch zoom and panning a pinched page. This is a different
//     question from placement (the frame already places the coordinate correctly relative to the page);
//     it records what the person could actually SEE, which is why `scale`/`offset*`/`visible*` are
//     separate fields a consumer may ignore entirely.
// Page scroll is deliberately NOT listened to: `clientX` is relative to the layout viewport, so scrolling
// does not change the mapping. (`visualViewport` `scroll` fires on an ordinary page scroll in some
// engines; the dedup below drops those.)
//
// WHAT IT EMITS, and when — the spec's producer rules:
//   - ONE event on activation, UNCONDITIONALLY, before any input can be recorded. Not only on a change:
//     an Android recording once shipped an empty `events` array because the padding never changed, and
//     the viewer then had no geometry at all, not even a screen size (gap B6 in the spec).
//   - one event per animation frame at most, since a pinch and a window drag are continuous streams;
//   - nothing when the new geometry is identical to the last emitted.
//
// Observe-only, like every source here: these reads run from listeners the application also uses, so a
// throwing getter or a refused `addEventListener` must never reach the app (design: "interceptors must
// not alter app behaviour").

/** The window surface we measure and listen on. `visualViewport` is read from it when not injected. */
interface WindowLike {
  readonly innerWidth?: number;
  readonly innerHeight?: number;
  readonly devicePixelRatio?: number;
  /** `null` in the real DOM lib when the engine has none, so both empties are accepted. */
  readonly visualViewport?: VisualViewportLike | null;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The visual viewport — pinch zoom and the visible region. Absent in jsdom and in older engines. */
interface VisualViewportLike {
  readonly scale?: number;
  readonly offsetLeft?: number;
  readonly offsetTop?: number;
  readonly width?: number;
  readonly height?: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ViewportEnv {
  window?: WindowLike;
  visualViewport?: VisualViewportLike | null;
  /** Coalescing scheduler; returns its own cancel. Default: one animation frame, else a 0 ms timer. */
  schedule?: (callback: () => void) => () => void;
}

export type ViewportSource = Interceptor<{ viewport: VideoAuxEventDetail }>;

/** A finite, positive reading; anything else means the browser could not tell us. */
const isMeasured = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** A finite reading that may legitimately be zero (an offset). */
const isFinitePosition = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const sameGeometry = (a: VideoAuxEventDetail, b: VideoAuxEventDetail): boolean =>
  a.frameW === b.frameW &&
  a.frameH === b.frameH &&
  a.density === b.density &&
  a.scale === b.scale &&
  a.offsetX === b.offsetX &&
  a.offsetY === b.offsetY &&
  a.visibleW === b.visibleW &&
  a.visibleH === b.visibleH;

class BrowserViewportSource
  extends InterceptorBase<{ viewport: VideoAuxEventDetail }>
  implements ViewportSource
{
  readonly name = 'browser-viewport';
  readonly #window: WindowLike | undefined;
  readonly #visualViewport: VisualViewportLike | undefined;
  readonly #schedule: (callback: () => void) => () => void;
  #cancelPending: (() => void) | null = null;
  #last: VideoAuxEventDetail | null = null;
  readonly #onChange = () => this.#requestEmit();

  constructor(env: ViewportEnv) {
    super();
    this.#window = env.window;
    this.#visualViewport = env.visualViewport ?? env.window?.visualViewport ?? undefined;
    this.#schedule = env.schedule ?? defaultSchedule;
  }

  /** The geometry right now, or undefined when the frame cannot be measured. */
  #read(): VideoAuxEventDetail | undefined {
    const win = this.#window;
    if (win === undefined) {
      return undefined;
    }
    const frameW = win.innerWidth;
    const frameH = win.innerHeight;
    if (!isMeasured(frameW) || !isMeasured(frameH)) {
      // A zero or unreadable frame would make every placement a division by zero, and a consumer
      // cannot tell a fabricated frame from a measured one. Write nothing instead.
      return undefined;
    }
    // 1 is the identity ratio (CSS px ARE device px). The field is declared always-present and nothing
    // in the placement path divides by it, so a fallback here cannot move a coordinate.
    const density = isMeasured(win.devicePixelRatio) ? win.devicePixelRatio : 1;
    const event: VideoAuxEventDetail = { frameW, frameH, density };

    const vv = this.#visualViewport;
    if (vv === undefined) {
      return event;
    }
    // `scale` 1 is omitted: its ABSENCE is what tells a consumer the whole frame was visible, and at
    // scale 1 the visible region IS the frame, so writing it would be noise on every single event.
    if (isMeasured(vv.scale) && vv.scale !== 1) {
      event.scale = vv.scale;
      // Derivable from `frameW / scale`, written because engines round it differently.
      if (isMeasured(vv.width) && isMeasured(vv.height)) {
        event.visibleW = vv.width;
        event.visibleH = vv.height;
      }
    }
    // Recorded independently of `scale`: Safari reports an offset at scale 1 when a focused input
    // scrolls the visual viewport, and that still describes what the person could see.
    if (isFinitePosition(vv.offsetLeft) && vv.offsetLeft !== 0) {
      event.offsetX = vv.offsetLeft;
    }
    if (isFinitePosition(vv.offsetTop) && vv.offsetTop !== 0) {
      event.offsetY = vv.offsetTop;
    }
    return event;
  }

  /** Emit if the geometry is readable and actually different from the last one written. */
  #emitIfChanged(): void {
    const event = this.#read();
    if (event === undefined || (this.#last !== null && sameGeometry(this.#last, event))) {
      return;
    }
    this.#last = event;
    this.emit('viewport', event);
  }

  #requestEmit(): void {
    if (this.#cancelPending !== null) {
      return;
    }
    this.#cancelPending = this.#schedule(() => {
      this.#cancelPending = null;
      this.#emitIfChanged();
    });
  }

  protected onActivate(): void {
    try {
      // Unconditional and SYNCHRONOUS: the emitter registers a listener before it reports activation,
      // so this reaches the subscriber whose arrival activated us — which is what makes "before any
      // input can be recorded" true rather than merely intended.
      this.#emitIfChanged();
      this.#window?.addEventListener('resize', this.#onChange);
      this.#visualViewport?.addEventListener('resize', this.#onChange);
      this.#visualViewport?.addEventListener('scroll', this.#onChange);
    } catch {
      // Observe-only: a hostile getter or a refused listener registration costs us the stream, never
      // the application.
    }
  }

  protected override onDeactivate(): void {
    this.#cancelPending?.();
    this.#cancelPending = null;
    // Cleared so a later activation emits its own unconditional first event: the previous recording's
    // entries have been drained, and the next one must not start with no geometry.
    this.#last = null;
    try {
      this.#window?.removeEventListener('resize', this.#onChange);
      this.#visualViewport?.removeEventListener('resize', this.#onChange);
      this.#visualViewport?.removeEventListener('scroll', this.#onChange);
    } catch {
      // observe-only
    }
  }
}

const g = globalThis as unknown as {
  window?: WindowLike;
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/**
 * One animation frame, which is the rate a pinch or a window drag actually paints at. A runtime without
 * `requestAnimationFrame` (a worker, an older engine) falls back to a 0 ms timer: the coalescing still
 * holds, only its window is the task queue rather than the frame.
 */
function defaultSchedule(callback: () => void): () => void {
  const raf = g.requestAnimationFrame;
  if (typeof raf === 'function') {
    const handle = raf(callback);
    return () => g.cancelAnimationFrame?.(handle);
  }
  const handle = g.setTimeout(callback, 0);
  return () => g.clearTimeout(handle);
}

/** Build the viewport source over the real browser globals (each overridable / absent → self-skip). */
export function createBrowserViewportSource(env: ViewportEnv = {}): ViewportSource {
  return new BrowserViewportSource({
    window: 'window' in env ? env.window : g.window,
    visualViewport: 'visualViewport' in env ? env.visualViewport : undefined,
    schedule: env.schedule,
  });
}
