import { InterceptorBase } from '@bugsee/core';

// Shared page-lifecycle TRACKER (the web analog of the mobile Application tracker that Android's TraceAppState
// and EventApplicationLifecycle both subscribe to): the ONE owner of the window/document lifecycle listeners.
// The system-events source and the connection tracker subscribe to it instead of each attaching
// their own, so the injected window+document are bound in exactly one place. Listeners attach on the first
// subscriber and are removed on the last.

export interface PageLifecycleEvents {
  /** `pagehide`; `persisted` is true when the page enters the bfcache rather than unloading. */
  pagehide: { persisted: boolean };
  /** `visibilitychange`, reduced to whether the document is now visible. */
  visibility: { visible: boolean };
  /** Page Lifecycle `freeze` / `resume`: fired on the DOCUMENT and they do not bubble, so never listened for on window. */
  freeze: undefined;
  resume: undefined;
  online: undefined;
  offline: undefined;
}
interface TargetLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}
export interface PageLifecycleEnv {
  window?: TargetLike;
  document?: TargetLike & { readonly visibilityState?: string };
}

export class PageLifecycleTracker extends InterceptorBase<PageLifecycleEvents> {
  readonly name = 'browser-page-lifecycle';
  readonly #env: PageLifecycleEnv;
  readonly #onError: (error: unknown) => void;
  #attached: Array<{ target: Partial<TargetLike>; type: string; listener: (e: unknown) => void }> =
    [];

  constructor(env: PageLifecycleEnv, onError?: (error: unknown) => void) {
    // A throwing reporter must not escape into the host's event dispatch, so it is wrapped for the
    // emitter and for the tracker's own catch paths alike.
    const report = (error: unknown): void => {
      try {
        onError?.(error);
      } catch {
        /* the reporter itself failed; nothing left to tell */
      }
    };
    super(report);
    this.#env = env;
    this.#onError = report;
  }

  // Guarded: the tracker is already marked active before this runs, so a throwing target must be reported
  // here, not leak out of `on()`. Whatever attached before the throw is still removed on deactivation.
  protected onActivate(): void {
    const { window: win, document: doc } = this.#env;
    try {
      this.#listen(win, 'pagehide', (e) =>
        this.#guard(() =>
          this.emit('pagehide', { persisted: (e as { persisted?: boolean }).persisted === true }),
        ),
      );
      for (const type of ['online', 'offline'] as const) {
        this.#listen(win, type, () => this.#guard(() => this.emit(type, undefined)));
      }
      this.#listen(doc, 'visibilitychange', () =>
        this.#guard(() => this.emit('visibility', { visible: doc?.visibilityState === 'visible' })),
      );
      // After visibilitychange: a document that refuses only the newer Page Lifecycle types must not cost
      // foreground/background (and app_state / fps) for an optional signal.
      for (const type of ['freeze', 'resume'] as const) {
        this.#listen(doc, type, () => this.#guard(() => this.emit(type, undefined)));
      }
    } catch (error) {
      this.#onError(error);
    }
  }

  protected override onDeactivate(): void {
    const attached = this.#attached;
    this.#attached = [];
    for (const { target, type, listener } of attached) {
      try {
        target.removeEventListener?.(type, listener);
      } catch {
        /* best-effort: one detached target must not leak the others */
      }
    }
  }

  #listen(
    target: Partial<TargetLike> | undefined,
    type: string,
    listener: (event: unknown) => void,
  ): void {
    if (typeof target?.addEventListener !== 'function') return;
    target.addEventListener(type, listener);
    this.#attached.push({ target, type, listener });
  }

  /** Never throw into the browser's event dispatch. */
  #guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.#onError(error);
    }
  }
}
