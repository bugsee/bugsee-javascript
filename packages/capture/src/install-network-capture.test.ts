import {
  type CaptureProviderInit,
  type CaptureStore,
  createCaptureAggregator,
  createCaptureExporter,
  createMemoryCaptureStore,
  createMultiKeyEmitter,
  createOperationDispatcher,
  createOptionsContainer,
  getCarrier,
  type MultiKeyEmitter,
  type OptionsContainer,
} from '@bugsee/core';
import { BugseeOption, type NetworkEvent, type NetworkStage } from '@bugsee/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchTarget } from './fetch-interceptor';
import { installNetworkCapture } from './install-network-capture';

// installNetworkCapture now registers its network leaves on the process Carrier (default the real
// globalThis). Reset it between tests so each gets fresh interceptors (no cross-test reuse).
afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

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
    expect(provider.controllingOption).toBe(BugseeOption.CaptureNetwork);
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

describe('installNetworkCapture — carrier (process-global leaf singletons)', () => {
  const LEAF_NAMES = ['fetch', 'sse', 'websocket', 'webtransport', 'xhr'];

  it('registers each network leaf on the carrier by name', () => {
    const carrier = {};
    installNetworkCapture({ carrier });
    expect([...getCarrier(carrier).interceptors.keys()].sort()).toEqual(LEAF_NAMES);
  });

  it('reuses the SAME leaf instances on a second install sharing the carrier (one patch)', () => {
    const carrier = {}; // a single process global both "module copies" see
    installNetworkCapture({ carrier });
    const first = getCarrier(carrier).interceptors.get('fetch');
    installNetworkCapture({ carrier }); // a duplicated copy installs again
    expect(getCarrier(carrier).interceptors.get('fetch')).toBe(first); // not a second instance
    expect(getCarrier(carrier).interceptors.size).toBe(5); // leaves not doubled
  });

  it('builds fresh leaves for a different carrier', () => {
    const a = {};
    const b = {};
    installNetworkCapture({ carrier: a });
    installNetworkCapture({ carrier: b });
    expect(getCarrier(a).interceptors.get('fetch')).not.toBe(
      getCarrier(b).interceptors.get('fetch'),
    );
  });
});
