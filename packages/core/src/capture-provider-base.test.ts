import type { FileType, NetworkEvent } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { createCaptureAggregator } from './capture-aggregator';
import { createCaptureCoordinator } from './capture-coordinator';
import { CaptureDataEntryBase } from './capture-data-entry';
import { createCaptureExporter } from './capture-exporter';
import { CaptureProviderBase } from './capture-provider-base';
import type { CaptureProviderInit, CaptureStore, OptionsContainer } from './contracts';
import { createEventHubs } from './hubs';
import { createMemoryCaptureStore } from './memory-capture-store';
import { createOperationDispatcher } from './operation-dispatcher';
import { createOptionsContainer } from './options';

const netEvent = (timestamp: number): NetworkEvent => ({
  timestamp,
  id: 'n',
  sequence: 'n',
  mechanism: 'fetch',
  url: 'u',
  method: 'GET',
  type: 'complete',
});

const mkStore = (): CaptureStore =>
  createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
// A fresh pipeline (hubs/operations/aggregator) over the given store — what init() supplies.
const buildInit = (store: CaptureStore): CaptureProviderInit => ({
  hubs: createEventHubs(),
  operations: createOperationDispatcher(),
  captureAggregator: createCaptureAggregator(store),
});
const options: OptionsContainer = createOptionsContainer();

// Read captured entries back through an exporter over the store (the aggregator is write-only).
const drainType = async (store: CaptureStore, type: FileType) =>
  (await createCaptureExporter(store).drain()).get(type);

// A concrete provider that subscribes to the network hub and captures each event as an entry.
class NetworkProvider extends CaptureProviderBase {
  readonly name = 'network';
  readonly controllingOption = 'captureNetwork';
  startedWith: OptionsContainer | null = null;
  stopped = 0;
  #off: (() => void) | null = null;

  protected onStart(launchOptions: OptionsContainer): void {
    this.startedWith = launchOptions;
    this.#off = this.pipeline.hubs.network.subscribe((event) => {
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

describe('CaptureProviderBase — lifecycle', () => {
  it('passes the launch options to onStart on start', () => {
    const provider = new NetworkProvider();
    provider.init(buildInit(mkStore()));
    provider.start(options);
    expect(provider.startedWith).toBe(options);
  });

  it('routes addEntry to the init-supplied aggregator', async () => {
    const provider = new NetworkProvider();
    const store = mkStore();
    provider.init(buildInit(store));
    provider.start(options);
    provider.pushLog();
    expect((await drainType(store, 'log'))?.map((e) => e.data)).toEqual([{ message: 'hi' }]);
  });

  it('capture() builds an entry of the given type/timestamp/data and routes it', async () => {
    const provider = new NetworkProvider();
    const store = mkStore();
    const init = buildInit(store);
    provider.init(init);
    provider.start(options);
    init.hubs.network.emit(netEvent(99));
    const entries = await drainType(store, 'network');
    expect(entries).toHaveLength(1);
    expect(entries?.map((e) => ({ type: e.type, timestamp: e.timestamp, data: e.data }))).toEqual([
      { type: 'network', timestamp: 99, data: netEvent(99) },
    ]);
  });

  it('throws when used before init() (deps accessed via this.pipeline)', () => {
    const provider = new NetworkProvider(); // never init()ed
    expect(() => provider.start(options)).toThrow(/before init/);
  });

  it('stop unsubscribes (later hub events are not captured) and runs onStop', async () => {
    const provider = new NetworkProvider();
    const store = mkStore();
    const init = buildInit(store);
    provider.init(init);
    provider.start(options);
    provider.stop();
    init.hubs.network.emit(netEvent(1)); // arrives after stop → must not be captured
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
    expect(provider.stopped).toBe(1);
  });

  it('uses the base default onStop when a subclass does not override it', () => {
    class Minimal extends CaptureProviderBase {
      readonly name = 'minimal';
      protected onStart(): void {}
    }
    const provider = new Minimal();
    provider.init(buildInit(mkStore()));
    provider.start(options);
    expect(() => provider.stop()).not.toThrow();
  });
});

describe('CaptureProviderBase — integration via the coordinator', () => {
  it('captures hub events into the aggregator when started via the coordinator', async () => {
    const store = mkStore();
    const init = buildInit(store);
    const coordinator = createCaptureCoordinator(init);
    coordinator.addProvider(new NetworkProvider());
    coordinator.start(options, (opt) => opt === 'captureNetwork');
    init.hubs.network.emit(netEvent(1));
    init.hubs.network.emit(netEvent(2));
    expect(await drainType(store, 'network')).toHaveLength(2);
  });

  it('a coordinator-disabled provider does not subscribe, so nothing is captured', async () => {
    const store = mkStore();
    const init = buildInit(store);
    const coordinator = createCaptureCoordinator(init);
    const provider = new NetworkProvider();
    coordinator.addProvider(provider);
    coordinator.start(options, () => false); // captureNetwork disabled
    init.hubs.network.emit(netEvent(1));
    expect(provider.startedWith).toBeNull();
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });
});
