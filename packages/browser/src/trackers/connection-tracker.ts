import { InterceptorBase } from '@bugsee/core';
import type { PageLifecycleTracker } from './page-lifecycle-tracker';

// Browser connectivity TRACKER (mirrors the mobile tracker/producer split): snapshots `navigator.onLine`
// plus NetworkInformation whenever the browser says either changed — `online`/`offline` on the window and
// `change` on `navigator.connection`. Safari and Firefox have no NetworkInformation, so `onLine` alone is
// still worth a row. Listeners are attached on the first subscriber and removed on the last.

/** The NetworkInformation fields the trace reads (all optional; Chromium-on-Android has the most). */
export interface ConnectionInfo {
  type?: string;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}
export interface ConnectionState {
  onLine: boolean;
  /** Absent where the browser has no NetworkInformation. */
  connection?: ConnectionInfo;
}
interface TargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
export interface ConnectionEnv {
  /** Shared lifecycle tracker for `online`/`offline`; when absent they are listened for on `window`. */
  lifecycle?: Pick<PageLifecycleTracker, 'on'>;
  window?: TargetLike;
  navigator?: {
    /** NetworkInformation; it is an EventTarget where it exists, but the fields are what matter. */
    connection?: ConnectionInfo & Partial<TargetLike>;
    onLine?: boolean;
  };
}

export class ConnectionTracker extends InterceptorBase<{ state: ConnectionState }> {
  readonly name = 'browser-connection';
  readonly #env: ConnectionEnv;
  readonly #onError: ((error: unknown) => void) | undefined;
  #attached: Array<{ target: Partial<TargetLike>; type: string }> = [];
  #subscriptions: Array<() => void> = [];

  readonly #onChange = (): void => {
    try {
      const state = this.#snapshot();
      if (state !== undefined) this.emit('state', state);
    } catch (error) {
      this.#onError?.(error); // never throw into the browser's event dispatch
    }
  };

  constructor(env: ConnectionEnv, onError?: (error: unknown) => void) {
    super(onError);
    this.#env = env;
    this.#onError = onError;
  }

  /** The live state, or undefined with no `navigator` (or a throwing getter). */
  current(): ConnectionState | undefined {
    try {
      return this.#snapshot();
    } catch (error) {
      this.#onError?.(error);
      return undefined;
    }
  }

  // Guarded: the tracker is already marked active (and the subscriber registered) before this runs, so a
  // throwing `navigator.connection` getter must be reported here, not leak out of `on()`. Whatever attached
  // before the throw is still removed on deactivation.
  protected onActivate(): void {
    try {
      const lifecycle = this.#env.lifecycle;
      if (lifecycle !== undefined) {
        this.#subscriptions.push(
          lifecycle.on('online', this.#onChange),
          lifecycle.on('offline', this.#onChange),
        );
      } else {
        this.#listen(this.#env.window, 'online');
        this.#listen(this.#env.window, 'offline');
      }
      this.#listen(this.#env.navigator?.connection, 'change');
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
        /* best-effort: one detached target must not leak the others */
      }
    }
  }

  #listen(target: Partial<TargetLike> | undefined, type: string): void {
    if (typeof target?.addEventListener !== 'function') return;
    target.addEventListener(type, this.#onChange);
    this.#attached.push({ target, type });
  }

  #snapshot(): ConnectionState | undefined {
    const nav = this.#env.navigator;
    if (nav === undefined) return undefined;
    const c = nav.connection;
    const onLine = nav.onLine !== false;
    if (c === undefined) return { onLine };
    // Only the fields that exist: a key holding undefined would not survive JSON anyway.
    const connection: ConnectionInfo = {
      ...(c.type !== undefined ? { type: c.type } : {}),
      ...(c.effectiveType !== undefined ? { effectiveType: c.effectiveType } : {}),
      ...(c.downlink !== undefined ? { downlink: c.downlink } : {}),
      ...(c.rtt !== undefined ? { rtt: c.rtt } : {}),
      ...(c.saveData !== undefined ? { saveData: c.saveData } : {}),
    };
    return { onLine, connection };
  }
}
