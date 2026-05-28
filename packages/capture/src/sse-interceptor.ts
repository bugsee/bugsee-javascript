import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';

// Server-Sent Events (EventSource) capture SOURCE (design §16.2). EventSource is browser/Deno (and
// Node ≥ very recent), so the wrap installs only when it exists. Each connection is instrumented at
// creation by replacing the constructor with a thin subclass; one id+sequence per connection. SSE is
// read-only (server→client), so every message is direction 'in', with `channel` = the event name.
// close() is a method (no event), so it is wrapped per instance. Metadata-first: message PAYLOADS are
// deferred (a message records direction + event name + timing, not the data). Named events beyond the
// default 'message' channel are a follow-up. Installed only while ACTIVE; slots into the umbrella.

type ESInstance = {
  url: string;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
};
type ESConstructor = new (url: string, init?: unknown) => ESInstance;

/** A read/replace handle for the EventSource constructor — the global by default, or a custom impl. */
export interface SseTarget {
  get(): ESConstructor | undefined;
  set(ctor: ESConstructor): void;
}

const globalSseTarget: SseTarget = {
  get: () => (globalThis as unknown as { EventSource?: ESConstructor }).EventSource,
  set: (ctor) => {
    (globalThis as unknown as { EventSource?: ESConstructor }).EventSource = ctor;
  },
};

interface SseState {
  id: string;
  url: string;
}

export interface SseInterceptorOptions {
  now?: () => number;
  newId?: () => string;
  target?: SseTarget;
}

class SseInterceptor extends InterceptorBase<Record<NetworkStage, NetworkEvent>> {
  readonly name = 'sse';
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #target: SseTarget;
  #original: ESConstructor | null = null;
  #counter = 0;

  constructor(options: SseInterceptorOptions = {}) {
    super();
    this.#now = options.now ?? (() => Date.now());
    this.#newId =
      options.newId ??
      (() => {
        this.#counter += 1;
        return `s${this.#counter}`;
      });
    this.#target = options.target ?? globalSseTarget;
  }

  protected onActivate(): void {
    const original = this.#target.get();
    if (original === undefined) {
      return;
    }
    this.#original = original;
    const self = this;
    const wrapped = class extends original {
      constructor(url: string, init?: unknown) {
        super(url, init);
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

  #event(state: SseState, type: NetworkStage, extra: Partial<NetworkEvent> = {}): NetworkEvent {
    return {
      timestamp: this.#now(),
      id: state.id,
      sequence: state.id,
      mechanism: 'sse',
      url: state.url,
      method: 'GET',
      type,
      ...extra,
    };
  }

  #instrument(source: ESInstance, url: string): void {
    const state: SseState = { id: this.#newId(), url };
    this.emit('before', this.#event(state, 'before'));
    source.addEventListener('open', () => this.emit('open', this.#event(state, 'open')));
    source.addEventListener('message', (event) => {
      const channel = (event as { type?: string }).type ?? 'message';
      this.emit('message', this.#event(state, 'message', { direction: 'in', channel }));
    });
    source.addEventListener('error', () =>
      this.emit('error', this.#event(state, 'error', { customError: 'eventsource error' })),
    );
    // close() is a method, not an event — wrap it on this instance to emit a 'close'.
    const originalClose = source.close.bind(source);
    source.close = (): void => {
      this.emit('close', this.#event(state, 'close'));
      originalClose();
    };
  }
}

export function createSseInterceptor(
  options?: SseInterceptorOptions,
): Interceptor<Record<NetworkStage, NetworkEvent>> {
  return new SseInterceptor(options);
}
