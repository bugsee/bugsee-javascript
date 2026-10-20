import { InterceptorBase } from '../interceptor-base';
import { hostRead } from './host-read';
import { createTrackerRegistry } from '../tracker-registry';

// The browser APPLICATION tracker (design §15; Android `BugseeTrackerApplication`): the domain owner of everything
// about the page being a running "application" — visible or hidden, frozen, leaving. It is the ONE owner of the
// window/document lifecycle listeners; the events source, the app_state trace and the fps/connection/orientation
// trackers subscribe to it instead of each attaching their own.
//
// RETENTION RULE. The DOM listeners attach on the FIRST subscriber and are removed on the LAST (a page with no
// capture pays nothing). What is retained across that gap is the last known `state`: on re-activation it is
// recomputed from the document (without emitting) so the `state` stage's de-duplication baseline is correct, and
// `current()` answers at once, with no wait for an event. Stopping therefore loses nothing a later subscriber needs.
//
// SINGLETON PER KEY. `applicationTrackerFor` returns one instance per KEY OBJECT: the document when one is given
// (it owns visibility/freeze/resume), else the window (pagehide), else a shared module key for an env with neither.
// LATEST request wins (see `rebind`): a defined onError replaces the reporter; while idle the window/document are
// re-bound, while active a differing window is kept and reported once.
//
// `online`/`offline`/`orientationchange` stay here for now so ConnectionTracker/OrientationTracker keep working
// unchanged; they move to the Connectivity (TR3) and UI/Display (TR2) trackers in those slices.

/** The Android app-state vocabulary (the viewer's table also has `started`, which the web never reports). */
export type ApplicationState = 'foreground' | 'background';

export interface ApplicationEvents {
  /** `pagehide`; `persisted` is true when the page enters the bfcache rather than unloading. */
  pagehide: { persisted: boolean };
  /** `visibilitychange`, reduced to whether the document is now visible. */
  visibility: { visible: boolean };
  /** The aggregated app state; emitted when a visibility change CHANGES it (de-duplicated). */
  state: { state: ApplicationState };
  /** Page Lifecycle `freeze` / `resume`: fired on the DOCUMENT and they do not bubble, so never listened for on window. */
  freeze: undefined;
  resume: undefined;
  online: undefined;
  offline: undefined;
  orientationchange: undefined;
}
interface TargetLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}
export interface ApplicationEnv {
  window?: TargetLike;
  document?: TargetLike & { readonly visibilityState?: string };
}

export class ApplicationTracker extends InterceptorBase<ApplicationEvents> {
  readonly name = 'browser-application';
  #env: ApplicationEnv;
  readonly #onError: (error: unknown) => void;
  readonly #sink: { current: ((error: unknown) => void) | undefined };
  #live = false;
  #mismatchReported = false;
  #state: ApplicationState | undefined;
  #attached: Array<{ target: Partial<TargetLike>; type: string; listener: (e: unknown) => void }> =
    [];

  constructor(env: ApplicationEnv, onError?: (error: unknown) => void) {
    // A throwing reporter must not escape into the host's event dispatch, so it is wrapped for the
    // emitter and for the tracker's own catch paths alike.
    const sink = { current: onError };
    const report = (error: unknown): void => {
      try {
        sink.current?.(error);
      } catch {
        /* the reporter itself failed; nothing left to tell */
      }
    };
    super(report);
    this.#env = env;
    this.#sink = sink;
    this.#onError = report;
  }

  // Guarded: the tracker is already marked active before this runs, so a throwing target must be reported
  // here, not leak out of `on()`. Whatever attached before the throw is still removed on deactivation.
  protected onActivate(): void {
    this.#live = true;
    const { window: win, document: doc } = this.#env;
    // Retention: catch up with whatever happened while nobody listened (no emit: nobody has been told anything yet).
    this.#state = this.#readState() ?? this.#state;
    try {
      this.#listen(win, 'pagehide', (e) =>
        this.#guard(() =>
          this.emit('pagehide', { persisted: (e as { persisted?: boolean }).persisted === true }),
        ),
      );
      for (const type of ['online', 'offline', 'orientationchange'] as const) {
        this.#listen(win, type, () => this.#guard(() => this.emit(type, undefined)));
      }
      this.#listen(doc, 'visibilitychange', () => this.#guard(() => this.#onVisibility()));
      // After visibilitychange: a document that refuses only the newer Page Lifecycle types must not cost
      // foreground/background (and app_state / fps) for an optional signal.
      for (const type of ['freeze', 'resume'] as const) {
        this.#listen(doc, type, () => this.#guard(() => this.emit(type, undefined)));
      }
    } catch (error) {
      this.#onError(error);
    }
  }

  /** The last known app state: read live from the document, else the retained value; undefined when never known. */
  current(): ApplicationState | undefined {
    return this.#readState() ?? this.#state;
  }

  /**
   * @internal Called by `applicationTrackerFor` on every request after the creating one: the LATEST launch wins.
   * A defined `onError` replaces the reporter (undefined keeps the current one: a launch that supplies none must not
   * silence an earlier launch's sink). While IDLE (no subscribers, so no DOM listeners) the window/document to attach
   * to are re-bound; while ACTIVE live listeners cannot move, so the binding stays and a mismatch is reported once.
   */
  rebind(env: ApplicationEnv, onError?: (error: unknown) => void): void {
    if (onError !== undefined) this.#sink.current = onError;
    if (!this.#live) {
      // Merge: only a target the new env actually supplies replaces the old one (a partial env never drops one).
      const window = env.window ?? this.#env.window;
      const document = env.document ?? this.#env.document;
      this.#env = {
        ...(window !== undefined ? { window } : {}),
        ...(document !== undefined ? { document } : {}),
      };
      return;
    }
    if (
      (env.window !== this.#env.window || env.document !== this.#env.document) &&
      !this.#mismatchReported
    ) {
      this.#mismatchReported = true;
      this.#onError(new Error('ApplicationTracker already bound to another window while active'));
    }
  }

  /** @internal Called by the registry on `reset`: drops every subscriber (which detaches the DOM listeners) and forgets the retained state. Test/teardown use. */
  reset(): void {
    this.removeAllListeners();
    this.#state = undefined;
  }

  #readState(): ApplicationState | undefined {
    const visibility = hostRead(() => this.#env.document?.visibilityState, this.#onError);
    if (typeof visibility !== 'string') return undefined;
    return visibility === 'visible' ? 'foreground' : 'background';
  }

  #onVisibility(): void {
    const state = this.#readState();
    // An unreadable document says nothing about visibility OR state: emit neither (never fabricate a
    // background, which would become process_background and pause fps).
    if (state === undefined) return;
    this.emit('visibility', { visible: state === 'foreground' });
    if (state === this.#state) return;
    this.#state = state;
    this.emit('state', { state });
  }

  protected override onDeactivate(): void {
    this.#live = false;
    this.#mismatchReported = false;
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

const registry = createTrackerRegistry<ApplicationTracker>();
// An env with neither document nor window has nothing to bind: all such callers share this key.
const NO_TARGET_KEY: object = {};

function keyOf(env: ApplicationEnv): object {
  return env.document ?? env.window ?? NO_TARGET_KEY;
}

/**
 * The singleton ApplicationTracker for `env`'s document (else window). The key is the document when present, so a
 * window-only env and a window+document env are DISTINCT trackers. The LATEST request's onError/env are bound (see `rebind`).
 */
export function applicationTrackerFor(
  env: ApplicationEnv,
  onError?: (error: unknown) => void,
): ApplicationTracker {
  return registry.for(
    keyOf(env),
    () => new ApplicationTracker(env, onError),
    (existing) => existing.rebind(env, onError),
  );
}

/** @internal Internal/test use: exported from `@bugsee/trackers/browser` but NOT re-exported by `@bugsee/browser`. Drop (and reset) the singleton for `env`'s key so the next request builds a fresh one. */
export function resetApplicationTracker(env: ApplicationEnv): void {
  registry.reset(keyOf(env));
}
