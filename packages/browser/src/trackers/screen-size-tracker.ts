import { InterceptorBase } from '@bugsee/core';
import type { PageLifecycleTracker } from './page-lifecycle-tracker';

// Browser screen-size TRACKER (the producer is `screen_size`; deliberately NOT Android's `displays`, which is a
// display LIST): reports `{ width, height, dpr }` — CSS px of `screen.width/height` and `devicePixelRatio` — on
// every `resize` and `orientationchange` of the injected window. `resize` is also what a page-zoom (a dpr
// change) fires, and the producer's de-duplication drops a resize that moved neither. `orientationchange` comes
// from the shared PageLifecycleTracker (like the orientation tracker; without one, from the window), but `resize`
// is listened for here, on the injected window: nothing else consumes it, and a new lifecycle event would
// change the listener count of every lifecycle subscriber for one trace. Attached on the first subscriber,
// removed on the last. Any non-finite-positive value omits the whole reading (never 0).

export interface ScreenSizeState {
  width: number;
  height: number;
  dpr: number;
}
interface TargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
export interface ScreenSizeEnv {
  /** Shared lifecycle tracker for `orientationchange`; when absent it is listened for on `window`. */
  lifecycle?: Pick<PageLifecycleTracker, 'on'>;
  /** The injected window: `resize`/`orientationchange` source AND the LIVE `devicePixelRatio` (zoom changes it). */
  window?: Partial<TargetLike> & { readonly devicePixelRatio?: unknown };
  screen?: { readonly width?: unknown; readonly height?: unknown };
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export class ScreenSizeTracker extends InterceptorBase<{ state: ScreenSizeState }> {
  readonly name = 'browser-screen-size';
  readonly #env: ScreenSizeEnv;
  readonly #onError: ((error: unknown) => void) | undefined;
  #attached: Array<{ target: Partial<TargetLike>; type: string }> = [];
  #subscriptions: Array<() => void> = [];

  readonly #onChange = (): void => {
    const state = this.current(); // reports its own failures; never throws into the browser's event dispatch
    if (state !== undefined) this.emit('state', state);
  };

  constructor(env: ScreenSizeEnv, onError?: (error: unknown) => void) {
    super(onError);
    this.#env = env;
    this.#onError = onError;
  }

  /** The live size, or undefined when the screen or the pixel ratio is absent / not a finite positive number. */
  current(): ScreenSizeState | undefined {
    try {
      const screen = this.#env.screen;
      if (screen === undefined) return undefined;
      const width = screen.width;
      const height = screen.height;
      const dpr = this.#env.window?.devicePixelRatio;
      return positive(width) && positive(height) && positive(dpr)
        ? { width, height, dpr }
        : undefined;
    } catch (error) {
      try {
        this.#onError?.(error);
      } catch {
        /* the reporter itself failed */
      }
      return undefined;
    }
  }

  // Guarded: the tracker is already marked active before this runs; whatever attached before a throw is still
  // removed on deactivation.
  protected onActivate(): void {
    try {
      this.#listen('resize');
      const lifecycle = this.#env.lifecycle;
      if (lifecycle !== undefined) {
        this.#subscriptions.push(lifecycle.on('orientationchange', this.#onChange));
      } else {
        this.#listen('orientationchange');
      }
    } catch (error) {
      this.#onError?.(error);
    }
  }

  protected override onDeactivate(): void {
    const subscriptions = this.#subscriptions;
    this.#subscriptions = [];
    for (const off of subscriptions) off();
    const attached = this.#attached;
    this.#attached = [];
    for (const { target, type } of attached) {
      try {
        target.removeEventListener?.(type, this.#onChange);
      } catch {
        /* best-effort: one failed removal must not leak the other */
      }
    }
  }

  #listen(type: string): void {
    const target = this.#env.window;
    if (typeof target?.addEventListener !== 'function') return;
    target.addEventListener(type, this.#onChange);
    this.#attached.push({ target, type });
  }
}
