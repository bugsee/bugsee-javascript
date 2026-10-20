import { InterceptorBase } from '../interceptor-base';

// Shared machinery of the Electron DOMAIN trackers (power, display, application). It is NOT a tracker of its own: it
// is the one place that knows how to attach/release Electron listeners safely, so each domain tracker only says WHICH
// Electron events feed WHICH of its stages. `electron` is never imported: every source is a structural object.
//
// PER-STAGE ACTIVATION. A stage's Electron listeners are attached when the stage gets its first listener and released
// when its last one leaves (`onListenersChanged`), never at construction. A source that cannot be RELEASED (no
// `removeListener`/`off`) is never attached to, because a listener that could not be removed would outlive
// `client.stop()`. Attaching is ALL-OR-NOTHING per stage: a throwing `on` rolls back what was attached and reports.
// Every attached listener is wrapped in a liveness guard, so one whose removal failed can never emit afterwards.

/** An Electron-style emitter. Parameters are `never` so any concrete overloaded `on`/`removeListener` is assignable. */
export interface EmitterSource {
  on?(event: never, listener: never): unknown;
  removeListener?(event: never, listener: never): unknown;
  off?(event: never, listener: never): unknown;
}

type Listener = (...args: unknown[]) => void;
type RawEmitter = {
  on(event: string, listener: Listener): unknown;
  removeListener?(event: string, listener: Listener): unknown;
  off?(event: string, listener: Listener): unknown;
};

/** One listener to bind: `listener` runs for `event` on `src`. */
export interface Binding {
  src: EmitterSource;
  event: string;
  listener: Listener;
}

export type Report = (error: unknown) => void;

/** Calls the reporter; it may throw or return a rejecting Promise (both are absorbed: trackers are silent toward the host). */
export function reportTo(
  report: { fn: ((error: unknown) => unknown) | undefined },
  error: unknown,
): void {
  try {
    const result = report.fn?.(error);
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    /* the reporter itself failed */
  }
}

/**
 * True when `src` can be listened to AND released again. Every host property read is guarded: Electron's real `screen`
 * is a Proxy that THROWS on any property read before the app is ready, and that must mean "domain off", never a failed
 * launch. A throwing read is reported (when a reporter is given) and answers false.
 */
export function isReleasable(src: EmitterSource | undefined, report?: Report): boolean {
  if (src === undefined) return false;
  try {
    return (
      typeof src.on === 'function' &&
      (typeof src.removeListener === 'function' || typeof src.off === 'function')
    );
  } catch (error) {
    report?.(error);
    return false;
  }
}

/**
 * Attach every binding, all or nothing. Returns the release function, or undefined when a source cannot be released
 * (silent: the capability is absent) or an attach threw (reported; what was attached is rolled back). The release
 * disarms the wrappers first, then removes each listener in its own guard so one failing removal strands no other.
 */
export function bindAll(bindings: readonly Binding[], report: Report): (() => void) | undefined {
  if (!bindings.every((b) => isReleasable(b.src, report))) return undefined; // reported at most once: `every` stops
  let live = true;
  const removers: Array<() => void> = [];
  const release = (): void => {
    live = false;
    for (const remove of removers.splice(0)) {
      try {
        remove();
      } catch (error) {
        report(error);
      }
    }
  };
  for (const { src, event, listener } of bindings) {
    const raw = src as RawEmitter;
    const wrapper: Listener = (...args) => {
      if (live) listener(...args);
    };
    try {
      raw.on(event, wrapper);
    } catch (error) {
      release();
      report(error);
      return undefined;
    }
    removers.push(() => {
      if (typeof raw.removeListener === 'function') raw.removeListener(event, wrapper);
      else raw.off?.(event, wrapper);
    });
  }
  return release;
}

/**
 * Base of the Electron domain trackers. A subclass lists its `stages` and says, per stage, how to attach the Electron
 * listeners that feed it ({@link attachStage}); this class arms/releases them with the stage's listener count.
 */
export abstract class ElectronStageTracker<E> extends InterceptorBase<E> {
  /** Mutable indirection: the SHARED tracker outlives launches, so the reporter is always the latest launch's. */
  protected readonly reporter: { fn: ((error: unknown) => unknown) | undefined };
  readonly #released = new Map<keyof E, () => void>();

  protected abstract readonly stages: readonly (keyof E)[];
  /** Attach the Electron listeners feeding `stage`; the returned function releases them. Undefined: nothing attached. */
  protected abstract attachStage(stage: keyof E): (() => void) | undefined;

  constructor(onError?: (error: unknown) => unknown) {
    const reporter = { fn: onError };
    // A throwing reporter must not escape into the emitter's dispatch (which runs inside the host's events).
    super((error) => reportTo(reporter, error));
    this.reporter = reporter;
  }

  /** A defined `onError` replaces the reporter (undefined keeps it): the latest launch wins. */
  protected setReporter(onError?: (error: unknown) => unknown): void {
    if (onError !== undefined) this.reporter.fn = onError;
  }

  protected report = (error: unknown): void => reportTo(this.reporter, error);

  // Activation is per stage (onListenersChanged); the whole-tracker hook has nothing to do.
  protected onActivate(): void {}

  protected override onListenersChanged(): void {
    this.sync();
  }

  /** Arm every stage that has listeners and is not armed; release every armed stage that has none. */
  protected sync(): void {
    for (const stage of this.stages) {
      const armed = this.#released.get(stage);
      if (this.listenerCount(stage) === 0) {
        if (armed !== undefined) this.#detach(stage, armed);
      } else if (armed === undefined) {
        let release: (() => void) | undefined;
        try {
          release = this.attachStage(stage); // retried on the next listener change / rebind when undefined
        } catch (error) {
          this.report(error); // a hostile host object must not fail the subscriber (or the launch)
        }
        if (release !== undefined) this.#released.set(stage, release);
      }
    }
  }

  /** Release every armed stage (their listeners stay subscribed to the tracker); `sync()` re-arms them. */
  protected detachAll(): void {
    for (const [stage, release] of [...this.#released]) this.#detach(stage, release);
  }

  #detach(stage: keyof E, release: () => void): void {
    this.#released.delete(stage);
    try {
      release();
    } catch (error) {
      this.report(error);
    }
  }

  /** Test/teardown: drop EVERY listener, releasing every Electron listener. */
  reset(): void {
    this.removeAllListeners();
  }
}
