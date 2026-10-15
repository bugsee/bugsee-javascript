import { InterceptorBase } from '@bugsee/core';

// Browser screen-orientation TRACKER (mirrors the mobile tracker/producer split): reports the current
// `screen.orientation` {type, angle} on every change. Both `screen.orientation` `change` and the window's
// legacy `orientationchange` are listened to (engines differ in which they fire); the producer's
// de-duplication collapses the double delivery. Attached on the first subscriber, removed on the last.

export interface OrientationState {
  type: string;
  angle: number;
}
interface TargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
export interface OrientationEnv {
  window?: TargetLike;
  screen?: {
    orientation?: { type: string; angle: number } & Partial<TargetLike>;
  };
}

export class OrientationTracker extends InterceptorBase<{ state: OrientationState }> {
  readonly name = 'browser-orientation';
  readonly #env: OrientationEnv;
  readonly #onError: ((error: unknown) => void) | undefined;
  #attached: Array<{ target: Partial<TargetLike>; type: string }> = [];

  readonly #onChange = (): void => {
    try {
      const state = this.#read();
      if (state !== undefined) this.emit('state', state);
    } catch (error) {
      this.#onError?.(error); // never throw into the browser's event dispatch
    }
  };

  constructor(env: OrientationEnv, onError?: (error: unknown) => void) {
    super(onError);
    this.#env = env;
    this.#onError = onError;
  }

  /** The live orientation, or undefined where the engine has no `screen.orientation`. */
  current(): OrientationState | undefined {
    try {
      return this.#read();
    } catch (error) {
      this.#onError?.(error);
      return undefined;
    }
  }

  // Guarded: the tracker is already marked active (and the subscriber registered) before this runs, so a
  // throwing `screen.orientation` getter must be reported here, not leak out of `on()`. Whatever attached
  // before the throw is still removed on deactivation.
  protected onActivate(): void {
    try {
      this.#listen(this.#env.screen?.orientation, 'change');
      this.#listen(this.#env.window, 'orientationchange');
    } catch (error) {
      this.#onError?.(error);
    }
  }

  protected override onDeactivate(): void {
    const attached = this.#attached;
    this.#attached = [];
    for (const { target, type } of attached) {
      try {
        target.removeEventListener?.(type, this.#onChange);
      } catch {
        /* best-effort: one detached target must not leak the other */
      }
    }
  }

  #listen(target: Partial<TargetLike> | undefined, type: string): void {
    if (typeof target?.addEventListener !== 'function') return;
    target.addEventListener(type, this.#onChange);
    this.#attached.push({ target, type });
  }

  #read(): OrientationState | undefined {
    const o = this.#env.screen?.orientation;
    return o === undefined ? undefined : { type: o.type, angle: o.angle };
  }
}
