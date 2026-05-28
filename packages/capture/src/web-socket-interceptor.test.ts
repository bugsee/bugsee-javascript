import type { Interceptor } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import {
  createWebSocketInterceptor,
  type WebSocketInterceptorOptions,
  type WebSocketTarget,
} from './web-socket-interceptor';

type WSCtor = new (url: string, protocols?: unknown) => unknown;

// A fresh fake WebSocket CLASS per call. Instances record sent frames + registered listeners; fire()
// dispatches an event. The interceptor subclasses this and wraps each instance's send.
function makeWS() {
  return class FakeWS {
    url: string;
    readonly sent: unknown[] = [];
    readonly #listeners = new Map<string, Array<(e: unknown) => void>>();
    constructor(url: string, _protocols?: unknown) {
      this.url = url;
    }
    send(data: unknown): void {
      this.sent.push(data);
    }
    addEventListener(type: string, listener: (e: unknown) => void): void {
      const arr = this.#listeners.get(type) ?? [];
      arr.push(listener);
      this.#listeners.set(type, arr);
    }
    fire(type: string, event?: unknown): void {
      for (const listener of this.#listeners.get(type) ?? []) {
        listener(event);
      }
    }
  };
}
type FakeWSInstance = InstanceType<ReturnType<typeof makeWS>>;

function setup(opts: Partial<WebSocketInterceptorOptions> = {}) {
  let current: WSCtor = makeWS() as unknown as WSCtor;
  const target: WebSocketTarget = {
    get: () => current as never,
    set: (ctor) => {
      current = ctor as unknown as WSCtor;
    },
  };
  const ic: Interceptor<Record<NetworkStage, NetworkEvent>> = createWebSocketInterceptor({
    now: () => 100,
    newId: () => 'w1',
    target,
    ...opts,
  });
  const events: Array<[NetworkStage, NetworkEvent]> = [];
  ic.onAny((stage, event) => events.push([stage, event])); // activate → replaces the ctor with the subclass
  const open = (url: string) => new current(url) as unknown as FakeWSInstance;
  return { target, events, open, ic };
}

describe('createWebSocketInterceptor — capture', () => {
  it('emits the full connection lifecycle: before → open → message(out/in) → close', () => {
    const { events, open } = setup();
    const ws = open('wss://x/');
    expect(events[0]?.[1]).toMatchObject({
      id: 'w1',
      sequence: 'w1',
      mechanism: 'ws',
      url: 'wss://x/',
      method: 'GET',
      type: 'before',
    });
    ws.fire('open');
    ws.send('hello'); // outbound
    ws.fire('message', { data: 'hi' }); // inbound
    ws.fire('close', { code: 1000, reason: 'bye' });
    expect(events.map(([s]) => s)).toEqual(['before', 'open', 'message', 'message', 'close']);
    expect(events[2]?.[1]).toMatchObject({ type: 'message', direction: 'out' });
    expect(events[3]?.[1]).toMatchObject({ type: 'message', direction: 'in' });
    expect(events[4]?.[1]).toMatchObject({ type: 'close', code: 1000, reason: 'bye' });
    expect(ws.sent).toEqual(['hello']); // send passed through to the original
  });

  it('emits an error event', () => {
    const { events, open } = setup();
    const ws = open('wss://x/');
    ws.fire('error');
    expect(events.map(([s]) => s)).toEqual(['before', 'error']);
    expect(events[1]?.[1]).toMatchObject({ type: 'error', customError: 'websocket error' });
  });

  it('omits code/reason on a close event that has none', () => {
    const { events, open } = setup();
    const ws = open('wss://x/');
    ws.fire('close', {});
    const close = events[1]?.[1];
    expect(close?.type).toBe('close');
    expect(close?.code).toBeUndefined();
    expect(close?.reason).toBeUndefined();
  });

  it('shares one id per connection and increments per connection (default counter)', () => {
    const { events, open } = setup({ newId: undefined });
    const a = open('wss://a/');
    a.send('1');
    const b = open('wss://b/');
    b.send('2');
    expect(events.map(([, e]) => e.id)).toEqual(['w1', 'w1', 'w2', 'w2']);
  });

  it('uses the default clock (Date.now) when none is injected', () => {
    const { events, open } = setup({ now: undefined });
    open('wss://x/');
    expect(events[0]?.[1].timestamp).toBeGreaterThan(0);
  });
});

describe('createWebSocketInterceptor — activation', () => {
  it('replaces the constructor on activate and restores it on the last unsubscribe', () => {
    let current: WSCtor = makeWS() as unknown as WSCtor;
    const original = current;
    const target: WebSocketTarget = {
      get: () => current as never,
      set: (ctor) => {
        current = ctor as unknown as WSCtor;
      },
    };
    const ic = createWebSocketInterceptor({ target });
    const off = ic.onAny(() => {});
    expect(current).not.toBe(original); // replaced with the wrapping subclass
    off();
    expect(current).toBe(original); // restored
  });

  it('is a safe no-op when the target has no WebSocket', () => {
    const ic = createWebSocketInterceptor({ target: { get: () => undefined, set: () => {} } });
    const off = ic.onAny(() => {});
    expect(() => off()).not.toThrow();
  });

  it('defaults to the global WebSocket target (no-op in a runtime without WebSocket)', () => {
    const slot = globalThis as unknown as { WebSocket?: unknown };
    const real = slot.WebSocket;
    slot.WebSocket = undefined;
    try {
      const ic = createWebSocketInterceptor();
      const off = ic.onAny(() => {});
      expect(() => off()).not.toThrow();
    } finally {
      slot.WebSocket = real;
    }
  });

  it('wraps and restores the global WebSocket when no target is given', () => {
    const slot = globalThis as unknown as { WebSocket?: unknown };
    const real = slot.WebSocket;
    const FakeWS = makeWS();
    slot.WebSocket = FakeWS;
    try {
      const ic = createWebSocketInterceptor();
      const off = ic.onAny(() => {}); // activate → globalWsTarget.set(wrapped)
      expect(slot.WebSocket).not.toBe(FakeWS); // global replaced
      off(); // deactivate → globalWsTarget.set(original)
      expect(slot.WebSocket).toBe(FakeWS); // restored
    } finally {
      slot.WebSocket = real;
    }
  });
});
