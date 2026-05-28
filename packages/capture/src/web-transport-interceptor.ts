import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';

// WebTransport capture SOURCE (design §16.2). WebTransport is browser + Deno, so the wrap installs
// only when it exists. Each session is instrumented at creation by replacing the constructor with a
// thin subclass; one id+sequence per session. WebTransport exposes lifecycle as PROMISES rather than
// events: `ready` resolves when the session opens (→ open) or rejects on failure (→ error); `closed`
// resolves on a clean close (→ close) or rejects on an error close (→ close with a reason). Coarse
// session-level capture only — per-stream / per-datagram data is deferred (the equivalent of body
// capture). Installed only while ACTIVE; slots into the NetworkInterceptor umbrella.

type WTInstance = {
  ready: Promise<unknown>;
  closed: Promise<unknown>;
};
type WTConstructor = new (url: string, options?: unknown) => WTInstance;

/** A read/replace handle for the WebTransport constructor — the global by default, or a custom impl. */
export interface WebTransportTarget {
  get(): WTConstructor | undefined;
  set(ctor: WTConstructor): void;
}

const globalWtTarget: WebTransportTarget = {
  get: () => (globalThis as unknown as { WebTransport?: WTConstructor }).WebTransport,
  set: (ctor) => {
    (globalThis as unknown as { WebTransport?: WTConstructor }).WebTransport = ctor;
  },
};

interface WtState {
  id: string;
  url: string;
}

export interface WebTransportInterceptorOptions {
  now?: () => number;
  newId?: () => string;
  target?: WebTransportTarget;
}

class WebTransportInterceptor extends InterceptorBase<Record<NetworkStage, NetworkEvent>> {
  readonly name = 'webtransport';
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #target: WebTransportTarget;
  #original: WTConstructor | null = null;
  #counter = 0;

  constructor(options: WebTransportInterceptorOptions = {}) {
    super();
    this.#now = options.now ?? (() => Date.now());
    this.#newId =
      options.newId ??
      (() => {
        this.#counter += 1;
        return `t${this.#counter}`;
      });
    this.#target = options.target ?? globalWtTarget;
  }

  protected onActivate(): void {
    const original = this.#target.get();
    if (original === undefined) {
      return;
    }
    this.#original = original;
    const self = this;
    const wrapped = class extends original {
      constructor(url: string, options?: unknown) {
        super(url, options);
        self.#instrument(this, String(url));
      }
    };
    this.#target.set(wrapped);
  }

  protected override onDeactivate(): void {
    if (this.#original !== null) {
      this.#target.set(this.#original);
      this.#original = null;
    }
  }

  #event(state: WtState, type: NetworkStage, extra: Partial<NetworkEvent> = {}): NetworkEvent {
    return {
      timestamp: this.#now(),
      id: state.id,
      sequence: state.id,
      mechanism: 'webtransport',
      url: state.url,
      method: 'CONNECT',
      type,
      ...extra,
    };
  }

  #instrument(session: WTInstance, url: string): void {
    const state: WtState = { id: this.#newId(), url };
    this.emit('before', this.#event(state, 'before'));
    session.ready.then(
      () => this.emit('open', this.#event(state, 'open')),
      () => this.emit('error', this.#event(state, 'error', { customError: 'webtransport failed' })),
    );
    session.closed.then(
      () => this.emit('close', this.#event(state, 'close')),
      () => this.emit('close', this.#event(state, 'close', { reason: 'error' })),
    );
  }
}

export function createWebTransportInterceptor(
  options?: WebTransportInterceptorOptions,
): Interceptor<Record<NetworkStage, NetworkEvent>> {
  return new WebTransportInterceptor(options);
}
