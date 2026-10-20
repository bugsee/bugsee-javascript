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
  /** Omitted when `navigator.onLine` could not be read (never fabricated as true). */
  online?: boolean;
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
    // Guarded: a throwing reporter must not escape the emitter's subscriber isolation into a DOM dispatch.
    super((error) => {
      try {
        report.fn?.(error);
      } catch {
        /* the reporter itself failed */
      }
    });
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

  // Nothing here can throw out of `on()`: every host read is hostRead-guarded, each listener registration is its own
  // failure domain (a refused one is reported ONCE and the others still attach — they stay attached, like the other
  // trackers; the next deactivation removes them), and the emitter isolates subscriber failures through a guarded
  // reporter.
  #attach(): void {
    const win = this.#window as Partial<TargetLike> | undefined;
    this.#listen(win, 'online', () => this.#changed('online', true));
    this.#listen(win, 'offline', () => this.#changed('online', false));
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
      // Baseline: every stage that has a value, so a subscriber to any one starts from the current truth.
      if (state.online !== undefined) this.emit('online', { online: state.online });
      if (state.networkInfo !== undefined) this.emit('networkInfo', state.networkInfo);
      this.emit('state', state);
    }
  }

  #listen(target: Partial<TargetLike> | undefined, type: string, run: () => void): void {
    if (target === undefined) return;
    // The READ can throw too (a cross-origin WindowProxy): reported, and the other listeners still attach.
    const add = hostRead(
      () => target.addEventListener,
      (e) => this.#onError(e),
    );
    if (typeof add !== 'function') return;
    const listener = (): void => {
      try {
        run();
      } catch (error) /* v8 ignore next 3 -- defense in depth: reads and the emitter are already guarded */ {
        this.#onError(error);
      }
    };
    // Recorded BEFORE attaching so a failing addEventListener still leaves a removable record.
    this.#attached.push({ target, type, listener });
    try {
      add.call(target, type, listener);
    } catch (error) {
      this.#onError(error);
    }
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

  // `hint` is what the event itself says. It is only evidence when `onLine` could not be read (a readable value wins).
  #changed(kind: 'online' | 'networkInfo', hint?: boolean): void {
    const read = this.#read();
    if (read === undefined) return;
    const state: ConnectivityState =
      kind === 'online' && read.online === undefined && hint !== undefined
        ? { ...read, online: hint }
        : read;
    if (kind === 'online') {
      if (state.online !== undefined) this.emit('online', { online: state.online });
    } else if (state.networkInfo !== undefined) this.emit('networkInfo', state.networkInfo);
    this.emit('state', state);
  }

  /** Reads the host; undefined when there is no navigator. */
  #read(): ConnectivityState | undefined {
    const nav = this.#navigator as { onLine?: unknown; connection?: unknown } | undefined;
    if (nav === undefined) return undefined;
    const report = (error: unknown): void => this.#onError(error);
    // A failed read is NOT "online": the value is omitted. A merely absent `onLine` stays treated as online.
    let failed = false;
    const onLine = hostRead(
      () => nav.onLine,
      (error) => {
        failed = true;
        report(error);
      },
    );
    const connection = hostRead(() => nav.connection, report);
    const state: ConnectivityState = failed ? {} : { online: onLine !== false };
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

// The key is derived from the reads the caller already made (one read of each, so a flaky getter is reported once and
// the key cannot differ from the host it was built with).
function keyOf(win: object | undefined, nav: object | undefined, env: object): object {
  return win ?? nav ?? env;
}

function asObject(value: unknown): object | undefined {
  return typeof value === 'object' && value !== null ? value : undefined;
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
  const win = asObject(hostRead(() => env.window, onError));
  const nav = asObject(hostRead(() => env.navigator, onError));
  const host: ConnectivityHost = {
    ...(win !== undefined ? { window: win } : {}),
    ...(nav !== undefined ? { navigator: nav } : {}),
  };
  return registry.for(
    keyOf(win, nav, env),
    () => new ConnectivityTracker(host, onError),
    (tracker) => tracker.rebind(host, onError),
  );
}

/**
 * Test/teardown: drop the env's tracker (resetting it, so its listeners are released). Best-effort for a hostile env
 * whose getters answer differently from call to call: the first of window / navigator / env that HAS a tracker wins.
 */
export function resetConnectivityTracker(env: ConnectivityHost): void {
  const win = asObject(hostRead(() => env.window));
  const nav = asObject(hostRead(() => env.navigator));
  for (const key of [win, nav, env]) {
    if (key !== undefined && registry.peek(key) !== undefined) {
      registry.reset(key);
      return;
    }
  }
}
