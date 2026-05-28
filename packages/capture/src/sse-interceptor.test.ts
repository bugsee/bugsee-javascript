import type { Interceptor } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import {
  createSseInterceptor,
  type SseInterceptorOptions,
  type SseTarget,
} from './sse-interceptor';

type ESCtor = new (url: string, init?: unknown) => unknown;

function makeES() {
  return class FakeES {
    url: string;
    closed = 0;
    readonly #listeners = new Map<string, Array<(e: unknown) => void>>();
    constructor(url: string, _init?: unknown) {
      this.url = url;
    }
    close(): void {
      this.closed += 1;
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
type FakeESInstance = InstanceType<ReturnType<typeof makeES>>;

function setup(opts: Partial<SseInterceptorOptions> = {}) {
  let current: ESCtor = makeES() as unknown as ESCtor;
  const target: SseTarget = {
    get: () => current as never,
    set: (ctor) => {
      current = ctor as unknown as ESCtor;
    },
  };
  const ic: Interceptor<Record<NetworkStage, NetworkEvent>> = createSseInterceptor({
    now: () => 100,
    newId: () => 's1',
    target,
    ...opts,
  });
  const events: Array<[NetworkStage, NetworkEvent]> = [];
  ic.onAny((stage, event) => events.push([stage, event]));
  const open = (url: string) => new current(url) as unknown as FakeESInstance;
  return { events, open };
}

describe('createSseInterceptor — capture', () => {
  it('emits before → open → message(in) → close, with the original close called', () => {
    const { events, open } = setup();
    const es = open('https://sse/');
    expect(events[0]?.[1]).toMatchObject({
      id: 's1',
      mechanism: 'sse',
      url: 'https://sse/',
      method: 'GET',
      type: 'before',
    });
    es.fire('open');
    es.fire('message', { type: 'message' });
    es.close();
    expect(events.map(([s]) => s)).toEqual(['before', 'open', 'message', 'close']);
    expect(events[2]?.[1]).toMatchObject({ type: 'message', direction: 'in', channel: 'message' });
    expect(events[3]?.[1]).toMatchObject({ type: 'close' });
    expect(es.closed).toBe(1); // original close() called through
  });

  it('uses the event name as the channel, falling back to "message"', () => {
    const { events, open } = setup();
    const es = open('https://sse/');
    es.fire('message', { type: 'update' });
    es.fire('message', {}); // no type → fallback
    expect(events.map(([, e]) => e.channel)).toEqual([undefined, 'update', 'message']); // [before, ...]
  });

  it('emits an error event', () => {
    const { events, open } = setup();
    const es = open('https://sse/');
    es.fire('error');
    expect(events.map(([s]) => s)).toEqual(['before', 'error']);
    expect(events[1]?.[1]).toMatchObject({ type: 'error', customError: 'eventsource error' });
  });

  it('shares one id per connection and increments per connection (default counter)', () => {
    const { events, open } = setup({ newId: undefined });
    open('https://a/');
    open('https://b/');
    expect(events.map(([, e]) => e.id)).toEqual(['s1', 's2']);
  });

  it('uses the default clock (Date.now) when none is injected', () => {
    const { events, open } = setup({ now: undefined });
    open('https://sse/');
    expect(events[0]?.[1].timestamp).toBeGreaterThan(0);
  });
});

describe('createSseInterceptor — activation', () => {
  it('is a safe no-op when the target has no EventSource', () => {
    const ic = createSseInterceptor({ target: { get: () => undefined, set: () => {} } });
    const off = ic.onAny(() => {});
    expect(() => off()).not.toThrow();
  });

  it('wraps and restores the global EventSource when no target is given', () => {
    const slot = globalThis as unknown as { EventSource?: unknown };
    const real = slot.EventSource;
    const FakeES = makeES();
    slot.EventSource = FakeES;
    try {
      const ic = createSseInterceptor();
      const off = ic.onAny(() => {});
      expect(slot.EventSource).not.toBe(FakeES);
      off();
      expect(slot.EventSource).toBe(FakeES);
    } finally {
      slot.EventSource = real;
    }
  });
});
