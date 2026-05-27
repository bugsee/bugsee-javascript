import type { FileType, NetworkEvent } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { createCaptureCoordinator } from './capture-coordinator';
import { CaptureDataEntryBase } from './capture-data-entry';
import { createCaptureExporter } from './capture-exporter';
import { CaptureProviderBase } from './capture-provider-base';
import { createClient } from './client';
import type { CaptureStore, Client } from './contracts';
import { createMemoryCaptureStore } from './memory-capture-store';

const netEvent = (timestamp: number): NetworkEvent => ({
  timestamp,
  id: 'n',
  sequence: 'n',
  mechanism: 'fetch',
  url: 'u',
  method: 'GET',
  type: 'complete',
});

// Read captured entries back through an exporter over the client's store (the aggregator is write-only).
const drainType = async (store: CaptureStore, type: FileType) =>
  (await createCaptureExporter(store).drain()).get(type);

// A concrete provider that subscribes to the network hub and captures each event as an entry.
class NetworkProvider extends CaptureProviderBase {
  readonly name = 'network';
  readonly controllingOption = 'captureNetwork';
  startedWith: Client | null = null;
  stopped = 0;
  #off: (() => void) | null = null;

  protected onStart(client: Client): void {
    this.startedWith = client;
    this.#off = client.hubs.network.subscribe((event) => {
      this.capture('network', event.timestamp, event);
    });
  }
  protected override onStop(): void {
    this.stopped += 1;
    this.#off?.();
  }

  // expose addEntry for direct routing tests
  pushLog(): void {
    this.addEntry(new CaptureDataEntryBase('log', 5, { message: 'hi' }));
  }
}

describe('CaptureProviderBase', () => {
  it('calls onStart with the client on start', () => {
    const provider = new NetworkProvider();
    const client = createClient();
    provider.start(client);
    expect(provider.startedWith).toBe(client);
  });

  it('routes addEntry to the client aggregator', async () => {
    const provider = new NetworkProvider();
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store });
    provider.start(client);
    provider.pushLog();
    expect((await drainType(store, 'log'))?.map((e) => e.data)).toEqual([{ message: 'hi' }]);
  });

  it('capture() builds an entry of the given type/timestamp/data and routes it', async () => {
    const provider = new NetworkProvider();
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store });
    provider.start(client);
    client.hubs.network.emit(netEvent(99));
    const entries = await drainType(store, 'network');
    expect(entries).toHaveLength(1);
    expect(entries?.map((e) => ({ type: e.type, timestamp: e.timestamp, data: e.data }))).toEqual([
      { type: 'network', timestamp: 99, data: netEvent(99) },
    ]);
  });

  it('addEntry is a no-op before start', () => {
    const provider = new NetworkProvider();
    expect(() => provider.pushLog()).not.toThrow();
  });

  it('detaches the aggregator on stop (subsequent entries are not routed) and calls onStop', async () => {
    const provider = new NetworkProvider();
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store });
    provider.start(client);
    provider.stop();
    provider.pushLog();
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
    expect(provider.stopped).toBe(1);
  });

  it('uses the base default onStop when a subclass does not override it', () => {
    class Minimal extends CaptureProviderBase {
      readonly name = 'minimal';
      protected onStart(): void {}
    }
    const provider = new Minimal();
    provider.start(createClient());
    expect(() => provider.stop()).not.toThrow();
  });

  // Integration: the base provider works through the real capture coordinator + client.
  it('captures hub events into the aggregator when started via the coordinator', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store });
    const coordinator = createCaptureCoordinator();
    coordinator.addProvider(new NetworkProvider());
    coordinator.start(client, (opt) => opt === 'captureNetwork');
    client.hubs.network.emit(netEvent(1));
    client.hubs.network.emit(netEvent(2));
    expect(await drainType(store, 'network')).toHaveLength(2);
  });

  it('a coordinator-disabled provider does not subscribe, so nothing is captured', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store });
    const coordinator = createCaptureCoordinator();
    const provider = new NetworkProvider();
    coordinator.addProvider(provider);
    coordinator.start(client, () => false); // captureNetwork disabled
    client.hubs.network.emit(netEvent(1));
    expect(provider.startedWith).toBeNull();
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });
});
