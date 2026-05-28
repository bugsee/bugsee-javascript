import {
  type CaptureProviderInit,
  type CaptureStore,
  createCaptureAggregator,
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
import type { FetchTarget } from './fetch-interceptor';
import { installNetworkCapture } from './install-network-capture';

type FetchFn = (input: unknown, init?: unknown) => Promise<unknown>;
const mkStore = (): CaptureStore =>
  createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
const buildInit = (store: CaptureStore): CaptureProviderInit => ({
  operations: createOperationDispatcher(),
  captureAggregator: createCaptureAggregator(store),
});
const options: OptionsContainer = createOptionsContainer();
const drainNetwork = async (store: CaptureStore) =>
  (await createCaptureExporter(store).drain()).get('network');
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

describe('installNetworkCapture', () => {
  it('returns the umbrella interceptor + the network provider', () => {
    const { interceptor, provider } = installNetworkCapture();
    expect(interceptor.name).toBe('network');
    expect(provider.name).toBe('network');
    expect(provider.controllingOption).toBe('captureNetwork');
  });

  it('captures end-to-end: starting the provider activates fetch and records before+complete', async () => {
    const store = mkStore();
    const resp = { status: 200, statusText: 'OK', redirected: false, headers: {} };
    let current: FetchFn = async () => resp;
    const fetchTarget: FetchTarget = {
      get: () => current,
      set: (fn) => {
        current = fn;
      },
    };
    const { provider } = installNetworkCapture({ now: () => 1, fetchTarget });
    provider.init(buildInit(store));
    provider.start(options); // provider → umbrella → fetch sub activates → wraps the target
    await current('https://api/x'); // the now-wrapped fetch
    const entries = await drainNetwork(store);
    expect(entries?.map((e) => (e.data as NetworkEvent).type)).toEqual(['before', 'complete']);
    expect(entries?.[0]?.type).toBe('network');
  });

  it('threads isInternal through to the request interceptors (self-isolated requests skipped)', async () => {
    const store = mkStore();
    const resp = { status: 200, statusText: 'OK', redirected: false, headers: {} };
    let current: FetchFn = async () => resp;
    const fetchTarget: FetchTarget = {
      get: () => current,
      set: (fn) => {
        current = fn;
      },
    };
    const { provider } = installNetworkCapture({
      now: () => 1,
      fetchTarget,
      isInternal: () => true,
    });
    provider.init(buildInit(store));
    provider.start(options);
    await current('https://api/x'); // isInternal → true → not captured
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });

  it('aggregates additionalSources (e.g. a node:http interceptor) into the umbrella', async () => {
    const store = mkStore();
    const extra: MultiKeyEmitter<Record<NetworkStage, NetworkEvent>> = createMultiKeyEmitter();
    const { provider } = installNetworkCapture({ additionalSources: [extra] });
    provider.init(buildInit(store));
    provider.start(options);
    extra.emit('complete', netEvent({ url: 'https://extra/' }));
    expect((await drainNetwork(store))?.map((e) => (e.data as NetworkEvent).url)).toEqual([
      'https://extra/',
    ]);
  });

  it('does not capture before the provider starts (subscriber-presence)', async () => {
    const store = mkStore();
    const extra: MultiKeyEmitter<Record<NetworkStage, NetworkEvent>> = createMultiKeyEmitter();
    const { provider } = installNetworkCapture({ additionalSources: [extra] });
    provider.init(buildInit(store));
    extra.emit('complete', netEvent()); // provider not started → umbrella idle → not forwarded
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });
});
