import {
  type CaptureProviderInit,
  type CaptureStore,
  createCaptureAggregator,
  createCaptureCoordinator,
  createCaptureExporter,
  createMemoryCaptureStore,
  createMultiKeyEmitter,
  createOperationDispatcher,
  createOptionsContainer,
  type MultiKeyEmitter,
  type OptionsContainer,
} from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { createNetworkCaptureProvider } from './network-provider';

const mkStore = (): CaptureStore =>
  createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
const buildInit = (store: CaptureStore): CaptureProviderInit => ({
  operations: createOperationDispatcher(),
  captureAggregator: createCaptureAggregator(store),
});
const options: OptionsContainer = createOptionsContainer();
const mkSource = (): MultiKeyEmitter<Record<NetworkStage, NetworkEvent>> => createMultiKeyEmitter();
const netEvent = (over: Partial<NetworkEvent> = {}): NetworkEvent => ({
  timestamp: 1,
  id: 'n1',
  sequence: 'n1',
  mechanism: 'fetch',
  url: 'https://api/x',
  method: 'GET',
  type: 'complete',
  ...over,
});
const drainNetwork = async (store: CaptureStore) =>
  (await createCaptureExporter(store).drain()).get('network');

describe('createNetworkCaptureProvider', () => {
  it('is named "network" and gated by the captureNetwork option', () => {
    const p = createNetworkCaptureProvider(mkSource());
    expect(p.name).toBe('network');
    expect(p.controllingOption).toBe('captureNetwork');
  });

  it('captures events of every stage (onAny) as "network" entries', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('before', netEvent({ type: 'before', timestamp: 1 }));
    source.emit('complete', netEvent({ type: 'complete', timestamp: 2 }));
    const entries = await drainNetwork(store);
    expect(entries).toHaveLength(2);
    expect(entries?.map((e) => (e.data as NetworkEvent).type)).toEqual(['before', 'complete']);
    expect(entries?.[0]?.timestamp).toBe(1);
  });

  it('sanitizes sensitive request/response headers per event (non-mutating)', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    const event = netEvent({
      custom: { headers: { authorization: 'secret-token', accept: 'json' } },
    });
    source.emit('complete', event);
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.custom?.headers).toEqual({ authorization: '<redacted>', accept: 'json' });
    // the original event object was not mutated
    expect(event.custom?.headers).toEqual({ authorization: 'secret-token', accept: 'json' });
  });

  it('passes through an event with no headers untouched', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('error', netEvent({ type: 'error', customError: 'boom' }));
    expect((await drainNetwork(store))?.[0]?.data).toMatchObject({
      type: 'error',
      customError: 'boom',
    });
  });

  it('captures from multiple sources', async () => {
    const store = mkStore();
    const a = mkSource();
    const b = mkSource();
    const p = createNetworkCaptureProvider(a, b);
    p.init(buildInit(store));
    p.start(options);
    a.emit('complete', netEvent({ url: 'https://a/' }));
    b.emit('complete', netEvent({ url: 'https://b/' }));
    expect((await drainNetwork(store))?.map((e) => (e.data as NetworkEvent).url)).toEqual([
      'https://a/',
      'https://b/',
    ]);
  });

  it('stop unsubscribes from every source: later events are not captured', async () => {
    const store = mkStore();
    const a = mkSource();
    const b = mkSource();
    const p = createNetworkCaptureProvider(a, b);
    p.init(buildInit(store));
    p.start(options);
    p.stop();
    a.emit('complete', netEvent());
    b.emit('complete', netEvent());
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });

  it('stop before start is a safe no-op', () => {
    const p = createNetworkCaptureProvider(mkSource());
    p.init(buildInit(mkStore()));
    expect(() => p.stop()).not.toThrow();
  });

  it('integrates through the coordinator (enabled → captures; disabled → nothing)', async () => {
    const store = mkStore();
    const source = mkSource();
    const coordinator = createCaptureCoordinator(buildInit(store));
    coordinator.addProvider(createNetworkCaptureProvider(source));
    coordinator.start(options, (opt) => opt === 'captureNetwork');
    source.emit('complete', netEvent());
    expect(await drainNetwork(store)).toHaveLength(1);

    const offStore = mkStore();
    const offSource = mkSource();
    const offCoordinator = createCaptureCoordinator(buildInit(offStore));
    offCoordinator.addProvider(createNetworkCaptureProvider(offSource));
    offCoordinator.start(options, () => false);
    offSource.emit('complete', netEvent());
    expect((await createCaptureExporter(offStore).drain()).size).toBe(0);
  });
});
