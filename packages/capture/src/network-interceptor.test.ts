import { createMultiKeyEmitter, type MultiKeyEmitter } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { createFetchInterceptor, type FetchTarget } from './fetch-interceptor';
import { createNetworkInterceptor } from './network-interceptor';
import type { RequestDecorator } from './request-decorator';

// A source that is also RequestDecoratable (like the fetch/xhr leaves), recording add/remove.
function mkDecoratableSource() {
  const added: RequestDecorator[] = [];
  const removed: RequestDecorator[] = [];
  const source = Object.assign(createMultiKeyEmitter<Record<NetworkStage, NetworkEvent>>(), {
    addRequestDecorator(decorator: RequestDecorator) {
      added.push(decorator);
      return () => removed.push(decorator);
    },
  });
  return { source, added, removed };
}

type FetchFn = (input: unknown, init?: unknown) => Promise<unknown>;
const mkSource = (): MultiKeyEmitter<Record<NetworkStage, NetworkEvent>> => createMultiKeyEmitter();
const netEvent = (over: Partial<NetworkEvent> = {}): NetworkEvent => ({
  timestamp: 1,
  id: 'n',
  sequence: 'n',
  mechanism: 'fetch',
  url: 'u',
  method: 'GET',
  type: 'complete',
  ...over,
});

describe('createNetworkInterceptor (umbrella)', () => {
  it('is named "network"', () => {
    expect(createNetworkInterceptor().name).toBe('network');
  });

  it('forwards events from every source to its subscribers (stage + event)', () => {
    const a = mkSource();
    const b = mkSource();
    const umbrella = createNetworkInterceptor(a, b);
    const seen: Array<[NetworkStage, NetworkEvent]> = [];
    umbrella.onAny((stage, event) => seen.push([stage, event]));
    const evA = netEvent({ type: 'before', url: 'a' });
    const evB = netEvent({ type: 'complete', url: 'b' });
    a.emit('before', evA);
    b.emit('complete', evB);
    expect(seen).toEqual([
      ['before', evA],
      ['complete', evB],
    ]);
  });

  it('supports per-stage subscription on the umbrella', () => {
    const a = mkSource();
    const umbrella = createNetworkInterceptor(a);
    const completes: NetworkEvent[] = [];
    umbrella.on('complete', (e) => completes.push(e));
    a.emit('before', netEvent({ type: 'before' })); // other stage → not delivered to on('complete')
    const ev = netEvent({ type: 'complete' });
    a.emit('complete', ev);
    expect(completes).toEqual([ev]);
  });

  it('only forwards while active (subscribes to sources on activate, unsubscribes on deactivate)', () => {
    const a = mkSource();
    const umbrella = createNetworkInterceptor(a);
    const seen: NetworkEvent[] = [];
    a.emit('complete', netEvent({ url: '0' })); // umbrella idle → not subscribed to a → not forwarded
    const off = umbrella.onAny((_stage, event) => seen.push(event)); // activate → subscribe to a
    a.emit('complete', netEvent({ url: '1' })); // forwarded
    off(); // last subscriber gone → deactivate → unsubscribe from a
    a.emit('complete', netEvent({ url: '2' })); // not forwarded
    expect(seen.map((e) => e.url)).toEqual(['1']);
  });

  it('cascades activation: subscribing to the umbrella activates a real sub-interceptor', () => {
    const impl: FetchFn = async () => ({
      status: 200,
      statusText: 'OK',
      redirected: false,
      headers: {},
    });
    let current: FetchFn = impl;
    const target: FetchTarget = {
      get: () => current,
      set: (fn) => {
        current = fn;
      },
    };
    const fetchIc = createFetchInterceptor({ target });
    const umbrella = createNetworkInterceptor(fetchIc);
    expect(target.get()).toBe(impl); // fetch not patched while the umbrella is idle
    const off = umbrella.onAny(() => {}); // subscribe → umbrella subscribes to fetchIc → fetchIc activates
    expect(target.get()).not.toBe(impl); // patched via the cascade
    off(); // deactivate cascade → fetchIc restores
    expect(target.get()).toBe(impl);
  });
});

describe('createNetworkInterceptor — request-decorator fan-out', () => {
  it('fans addRequestDecorator out to the decoratable leaves only (ws/sse/wt skipped)', () => {
    const d1 = mkDecoratableSource();
    const plain = createMultiKeyEmitter<Record<NetworkStage, NetworkEvent>>(); // not decoratable
    const d2 = mkDecoratableSource();
    const umbrella = createNetworkInterceptor(d1.source, plain, d2.source);
    const decorator: RequestDecorator = () => ({ traceparent: 'X' });

    const off = umbrella.addRequestDecorator(decorator);
    expect(d1.added).toEqual([decorator]);
    expect(d2.added).toEqual([decorator]); // both decoratable leaves got it
    // the plain source has no addRequestDecorator and was simply skipped (no throw)

    off(); // combined unsubscribe removes from every decoratable leaf
    expect(d1.removed).toEqual([decorator]);
    expect(d2.removed).toEqual([decorator]);
  });

  it('is a harmless no-op when no source is decoratable', () => {
    const umbrella = createNetworkInterceptor(
      createMultiKeyEmitter<Record<NetworkStage, NetworkEvent>>(),
    );
    const off = umbrella.addRequestDecorator(() => undefined);
    expect(() => off()).not.toThrow();
  });
});
