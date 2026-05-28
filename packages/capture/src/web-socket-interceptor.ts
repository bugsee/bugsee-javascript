import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';

// WebSocket capture SOURCE (design §16.2). global WebSocket is broadly available (browser/workers/
// Deno/Bun; Node ≥ 22), so the wrap installs only when it exists (availability-detected). Because each
// connection must be instrumented at CREATION, the wrap replaces the constructor with a thin subclass:
// its constructor calls through, assigns a per-connection id, emits `before`, and attaches open/message/
// close/error listeners; outbound `send` is wrapped per instance (no prototype mutation). One id+sequence
// per connection ties its events together; each message carries a direction. Metadata-first: frame
// PAYLOADS are deferred (a `message` records direction + timing, not content). Raw events. Installed
// only while ACTIVE (subscriber-presence / start). Slots into the NetworkInterceptor umbrella.

type WSInstance = {
  url: string;
  send(data: unknown): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
};
type WSConstructor = new (url: string, protocols?: unknown) => WSInstance;

/** A read/replace handle for the WebSocket constructor — the global by default, or a custom impl. */
export interface WebSocketTarget {
  get(): WSConstructor | undefined;
  set(ctor: WSConstructor): void;
}

const globalWsTarget: WebSocketTarget = {
  get: () => (globalThis as unknown as { WebSocket?: WSConstructor }).WebSocket,
  set: (ctor) => {
    (globalThis as unknown as { WebSocket?: WSConstructor }).WebSocket = ctor;
  },
};

interface WsState {
  id: string;
  url: string;
}

export interface WebSocketInterceptorOptions {
  now?: () => number;
  newId?: () => string;
  /** Where to read/replace the wrapped WebSocket constructor — the global by default, or a custom impl. */
  target?: WebSocketTarget;
}

class WebSocketInterceptor extends InterceptorBase<Record<NetworkStage, NetworkEvent>> {
  readonly name = 'websocket';
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #target: WebSocketTarget;
  #original: WSConstructor | null = null;
  #counter = 0;

  constructor(options: WebSocketInterceptorOptions = {}) {
    super();
    this.#now = options.now ?? (() => Date.now());
    this.#newId =
      options.newId ??
      (() => {
        this.#counter += 1;
        return `w${this.#counter}`;
      });
    this.#target = options.target ?? globalWsTarget;
  }

  protected onActivate(): void {
    const original = this.#target.get();
    if (original === undefined) {
      return; // no WebSocket in this runtime / target
    }
    this.#original = original;
    const self = this;
    const wrapped = class extends original {
      constructor(url: string, protocols?: unknown) {
        super(url, protocols);
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

  #event(state: WsState, type: NetworkStage): NetworkEvent {
    return {
      timestamp: this.#now(),
      id: state.id,
      sequence: state.id,
      mechanism: 'ws',
      url: state.url,
      method: 'GET',
      type,
    };
  }

  #instrument(socket: WSInstance, url: string): void {
    // `state` is captured by the listeners + the send wrap below — one id+url per connection.
    const state: WsState = { id: this.#newId(), url };
    this.emit('before', this.#event(state, 'before'));
    socket.addEventListener('open', () => this.emit('open', this.#event(state, 'open')));
    socket.addEventListener('message', () =>
      this.emit('message', { ...this.#event(state, 'message'), direction: 'in' }),
    );
    socket.addEventListener('close', (event) => {
      const e = event as { code?: number; reason?: string };
      this.emit('close', {
        ...this.#event(state, 'close'),
        ...(e.code !== undefined ? { code: e.code } : {}),
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
      });
    });
    socket.addEventListener('error', () =>
      this.emit('error', { ...this.#event(state, 'error'), customError: 'websocket error' }),
    );
    // Wrap outbound send on this instance (no prototype mutation): emit a 'message' (direction out).
    const originalSend = socket.send.bind(socket);
    socket.send = (data: unknown): void => {
      this.emit('message', { ...this.#event(state, 'message'), direction: 'out' });
      originalSend(data);
    };
  }
}

export function createWebSocketInterceptor(
  options?: WebSocketInterceptorOptions,
): Interceptor<Record<NetworkStage, NetworkEvent>> {
  return new WebSocketInterceptor(options);
}
