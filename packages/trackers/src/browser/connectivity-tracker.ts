import { InterceptorBase } from '../interceptor-base';
import { createTrackerRegistry } from '../tracker-registry';
import { hostRead } from './host-read';

// Browser CONNECTIVITY tracker (domain tracker, design §15; Android reference: BugseeTrackerConnectivity). It owns
// EVERY connectivity listener itself: `online`/`offline` on the window and the Network Information API on
// `navigator.connection` (type, effectiveType, downlink, downlinkMax, rtt, saveData, and its `change` event). It does
// not depend on the page-lifecycle tracker.
//
// Stages (notification kinds):
//   * `online`      {online}        — `online`/`offline` window events.
//   * `networkInfo` {type?, …}      — `navigator.connection` `change`; a field is OMITTED when absent or not a usable
//                                     value (zero downlink/downlinkMax/rtt are "no estimate", never data).
//   * `state`       {online, networkInfo?} — the aggregate; emitted alongside either of the above. Activation emits a
//                     baseline of all three.
//
// SINGLETON per window (see `connectivityTrackerFor`). RETENTION rule: stopping loses nothing a later subscriber
// needs. The state is not cached at all: it lives in `navigator`, which the tracker keeps (retains) across the last
// unsubscribe and READS LIVE (`current()`, and a fresh baseline on every activation) — a cached snapshot could only
// be staler. The listeners are the only thing released.

export interface NetworkInfo {
  /** Transport (`wifi`, `cellular`, …). Chromium-on-Android in practice. */
  type?: string;
  /** Speed bucket (`4g`, `3g`, …), NOT a transport. */
  effectiveType?: string;
  /** Mbps. Omitted when 0/NaN/Infinity/negative. */
  downlink?: number;
  /** Mbps, the upper bound of the underlying link. Omitted when 0/NaN/Infinity/negative. */
  downlinkMax?: number;
  /** Round-trip time in ms. Omitted when 0/NaN/Infinity/negative. */
  rtt?: number;
  saveData?: boolean;
}
export interface ConnectivityState {
  online: boolean;
  /** Absent where the browser has no NetworkInformation. */
  networkInfo?: NetworkInfo;
}
export interface ConnectivityEvents {
  online: { online: boolean };
  networkInfo: NetworkInfo;
  state: ConnectivityState;
}

interface TargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
/** What the tracker needs from a launch. */
export interface ConnectivityHost {
  /** Source of `online`/`offline`. */
  window?: object;
  navigator?: object;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export class ConnectivityTracker extends InterceptorBase<ConnectivityEvents> {
  readonly name = 'browser-connectivity';
  #window: object | undefined;
  #navigator: object | undefined;
  #running = false;
  #attached: Array<{ target: Partial<TargetLike>; type: string; listener: () => void }> = [];

  // Mutable indirection: the SHARED tracker outlives launches, so the reporter is always the latest launch's.
  readonly #report: { fn: ((error: unknown) => void) | undefined };

  constructor(host: ConnectivityHost, onError?: (error: unknown) => void) {
    const report = { fn: onError };
    super((error) => report.fn?.(error));
    this.#report = report;
    this.#window = host.window;
    this.#navigator = host.navigator;
  }

  /**
   * Hand the latest launch's seams to this shared tracker (latest launch wins, but a PARTIAL env never drops what
   * the tracker already has): a defined `onError`/`window`/`navigator` replaces ours, an undefined one keeps it. A
   * running tracker whose window or navigator changed moves its listeners to the new objects and re-reads.
   */
  rebind(host: ConnectivityHost, onError?: (error: unknown) => void): void {
    if (onError !== undefined) this.#report.fn = onError;
    const moved =
      (host.window !== undefined && host.window !== this.#window) ||
      (host.navigator !== undefined && host.navigator !== this.#navigator);
    if (host.window !== undefined) this.#window = host.window;
    if (host.navigator !== undefined) this.#navigator = host.navigator;
    if (moved && this.#running) {
      this.#detach();
      this.#attach();
    }
  }

  #onError(error: unknown): void {
    try {
      this.#report.fn?.(error);
    } catch {
      /* the reporter itself failed */
    }
  }

  /**
   * The LIVE state (read on every call, never stale), or undefined with no `navigator`.
   */
  current(): ConnectivityState | undefined {
    return this.#read();
  }

  /** Test/teardown: release the listeners. */
  reset(): void {
    this.#running = false;
    this.#detach();
  }

  protected onActivate(): void {
    this.#running = true;
    this.#attach();
  }

  protected override onDeactivate(): void {
    this.#running = false;
    this.#detach(); // listeners go; the host objects are retained
  }

  // Guarded: the subscriber is registered before this runs, so a hostile host must be reported here, not leak
  // out of `on()`. Whatever attached before a throw is removed again.
  #attach(): void {
    try {
      const win = this.#window as Partial<TargetLike> | undefined;
      this.#listen(win, 'online', () => this.#changed('online'));
      this.#listen(win, 'offline', () => this.#changed('online'));
      const nav = this.#navigator;
      const connection =
        nav === undefined
          ? undefined
          : hostRead(
              () => (nav as { connection?: unknown }).connection,
              (e) => this.#onError(e),
            );
      this.#listen(
        typeof connection === 'object' && connection !== null
          ? (connection as Partial<TargetLike>)
          : undefined,
        'change',
        () => this.#changed('networkInfo'),
      );
      const state = this.#read();
      if (state !== undefined) {
        // Baseline: every stage, so a subscriber to any one of them starts from the current truth.
        this.emit('online', { online: state.online });
        if (state.networkInfo !== undefined) this.emit('networkInfo', state.networkInfo);
        this.emit('state', state);
      }
    } catch (error) {
      this.#detach();
      this.#onError(error);
    }
  }

  #listen(target: Partial<TargetLike> | undefined, type: string, listener: () => void): void {
    if (typeof target?.addEventListener !== 'function') return;
    // `run` cannot throw into the browser's event dispatch: reads are hostRead-guarded and the emitter isolates
    // (and reports) subscriber failures.
    // Recorded BEFORE attaching so a failing addEventListener still unwinds exactly what was registered.
    this.#attached.push({ target, type, listener });
    target.addEventListener(type, listener);
  }

  #detach(): void {
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

  #changed(kind: 'online' | 'networkInfo'): void {
    const state = this.#read();
    if (state === undefined) return;
    if (kind === 'online') this.emit('online', { online: state.online });
    else if (state.networkInfo !== undefined) this.emit('networkInfo', state.networkInfo);
    this.emit('state', state);
  }

  /** Reads the host; undefined when there is no navigator. */
  #read(): ConnectivityState | undefined {
    const nav = this.#navigator as { onLine?: unknown; connection?: unknown } | undefined;
    if (nav === undefined) return undefined;
    const report = (error: unknown): void => this.#onError(error);
    const online = hostRead(() => nav.onLine, report) !== false;
    const connection = hostRead(() => nav.connection, report);
    const state: ConnectivityState = { online };
    if (typeof connection === 'object' && connection !== null) {
      const c = connection as Record<string, unknown>;
      // Each getter is its own failure domain: a hostile one costs only that field.
      const type = hostRead(() => c.type, report);
      const effectiveType = hostRead(() => c.effectiveType, report);
      const downlink = positive(hostRead(() => c.downlink, report));
      const downlinkMax = positive(hostRead(() => c.downlinkMax, report));
      const rtt = positive(hostRead(() => c.rtt, report));
      const saveData = hostRead(() => c.saveData, report);
      state.networkInfo = {
        ...(typeof type === 'string' && type !== '' ? { type } : {}),
        ...(typeof effectiveType === 'string' && effectiveType !== '' ? { effectiveType } : {}),
        ...(downlink !== undefined ? { downlink } : {}),
        ...(downlinkMax !== undefined ? { downlinkMax } : {}),
        ...(rtt !== undefined ? { rtt } : {}),
        ...(typeof saveData === 'boolean' ? { saveData } : {}),
      };
    }
    return state;
  }
}

const registry = createTrackerRegistry<ConnectivityTracker>();

function keyOf(env: ConnectivityHost, onError?: (error: unknown) => void): object {
  const win = hostRead(() => env.window, onError);
  if (typeof win === 'object' && win !== null) return win;
  const nav = hostRead(() => env.navigator, onError);
  if (typeof nav === 'object' && nav !== null) return nav;
  return env;
}

/**
 * The singleton ConnectivityTracker for the env's window (else its navigator, else the env object). Every call (a
 * relaunch included) hands the shared tracker the latest launch's `onError`, window and navigator (see
 * {@link ConnectivityTracker.rebind}).
 */
export function connectivityTrackerFor(
  env: ConnectivityHost,
  onError?: (error: unknown) => void,
): ConnectivityTracker {
  const win = hostRead(() => env.window, onError);
  const nav = hostRead(() => env.navigator, onError);
  const host: ConnectivityHost = {
    ...(typeof win === 'object' && win !== null ? { window: win } : {}),
    ...(typeof nav === 'object' && nav !== null ? { navigator: nav } : {}),
  };
  return registry.for(
    keyOf(env, onError),
    () => new ConnectivityTracker(host, onError),
    (tracker) => tracker.rebind(host, onError),
  );
}

/** Test/teardown: drop the env's tracker (resetting it, so its listeners are released). */
export function resetConnectivityTracker(env: ConnectivityHost): void {
  registry.reset(keyOf(env));
}
