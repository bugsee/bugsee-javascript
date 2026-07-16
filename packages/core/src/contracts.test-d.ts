// Type-level tests for the §16.2 contracts, checked by `tsc --noEmit`. Valid example implementations
// must type-check; @ts-expect-error negatives pin required members. Example object literals are
// type-checked (excess-property + missing-property checks).

import { BugseeOption, type FileType, type NetworkEvent } from '@bugsee/protocol';
import type {
  CaptureAggregator,
  CaptureDataEntry,
  CaptureEntryFactory,
  CaptureExporter,
  CaptureProvider,
  CaptureProviderInit,
  CaptureSnapshot,
  CaptureStore,
  Client,
  ControllingOption,
  DetectionProvider,
  Extension,
  Interceptor,
  Operation,
  OperationDispatcher,
  OptionsContainer,
  StoredEntry,
} from './contracts';
import { InterceptorBase } from './interceptor-base';
import { createReportingRequest, type ReportingRequest } from './reporting';

const noop = (): void => {};

const operation: Operation = {
  type: 'http',
  timestamp: 1,
  description: 'GET /',
  data: { status: 200 },
};

// An entry owns its serialize/deserialize (Android-style instance deserialize).
const entry: CaptureDataEntry = {
  type: 'log',
  timestamp: 1,
  data: { message: 'hi' },
  serialize: () => '{"message":"hi"}',
  deserialize: (_serialized: string) => {},
};

const entryFactory: CaptureEntryFactory = (type) => ({
  type,
  timestamp: 0,
  data: undefined,
  serialize: () => '',
  deserialize: () => {},
});

const storedEntry: StoredEntry = { type: 'log', timestamp: 1, serialized: '{}' };

const dispatcher: OperationDispatcher = {
  registerObserver: () => noop,
  onOperation: noop,
};

// The store routes records into the current part; snapshot() freezes them; tick() rotates + GCs.
const captureSnapshot: CaptureSnapshot = {
  stream: async function* () {},
  drainAll: async () => new Map<FileType, StoredEntry[]>(),
  release: noop,
};
const captureStore: CaptureStore = {
  add: (_record: StoredEntry) => {},
  tick: (_nowMs: number) => {},
  snapshot: () => captureSnapshot,
  clear: noop,
};

// The aggregator is write-only: accept → serialize → route.
const aggregator: CaptureAggregator = {
  addEntry: noop,
  addEntries: noop,
  clear: noop,
};

// The exporter is the only reader: it deserializes records back into entries.
const exporter: CaptureExporter = {
  stream: async function* () {},
  drain: async () => new Map<FileType, CaptureDataEntry[]>(),
};

const exampleClient: Client = {
  operations: dispatcher,
  captureAggregator: aggregator,
  addCaptureProvider: noop,
  addDetectionProvider: noop,
};

// An interceptor is listenable (extends EventSubscribable): InterceptorBase supplies the emitter
// surface, the subclass adds name + onStart/onStop. The contract holder can subscribe to stages.
class ExampleInterceptor extends InterceptorBase<{ tick: number }> {
  readonly name = 'global-error';
  protected onActivate(): void {}
}
const interceptor: Interceptor<{ tick: number }> = new ExampleInterceptor();
const offTick: () => void = interceptor.on('tick', (n: number) => n);
offTick();
interceptor.addEventListener('tick', () => {});
interceptor.once('tick', () => {});
interceptor.off('tick', () => {});
interceptor.removeEventListener('tick', () => {});
interceptor.removeAllListeners();

// The pipeline deps a provider receives once via init() (subset of Client, no registration seams).
const captureProviderInit: CaptureProviderInit = {
  operations: dispatcher,
  captureAggregator: aggregator,
};

// The launch-options bag passed to start(options) for per-launch reconfiguration.
const launchOptions: OptionsContainer = {
  get: <T>(_key: string, fallback: T): T => fallback,
  has: (_key: string) => false,
};

// A provider receives its deps via init(); on a (sanitized) source event it pushes an entry to the
// single aggregator. Sources are subscribed to separately (an interceptor), not via a hub.
const networkProvider: CaptureProvider = {
  name: 'network',
  controllingOption: BugseeOption.CaptureNetwork,
  init: (deps: CaptureProviderInit) => {
    const event: NetworkEvent = {
      timestamp: 1,
      id: 'a',
      sequence: 'a',
      mechanism: 'fetch',
      url: '/',
      method: 'GET',
      type: 'complete',
    };
    deps.captureAggregator.addEntry({
      type: 'network',
      timestamp: event.timestamp,
      data: event,
      serialize: () => JSON.stringify(event),
      deserialize: () => {},
    });
  },
  start: (options: OptionsContainer) => {
    options.get('captureNetworkBodySizeLimit', 20480);
  },
  stop: noop,
};

const detector: DetectionProvider = {
  name: 'crash',
  controllingOption: BugseeOption.DetectCrash,
  start: (_client: Client, report: (request: ReportingRequest) => void) => {
    report(createReportingRequest({ source: { type: 'crash' }, id: 'r1' }));
  },
  stop: noop,
};

const extension: Extension = {
  name: 'performance',
  setup: (_client: Client) => {},
  stop: noop,
};

// --- ControllingOption: a canonical BugseeOption identifier (editor autocomplete) that still accepts any string. ---
export const gateCanonical: ControllingOption = BugseeOption.CaptureNetwork; // a canonical option key
export const gateArbitrary: ControllingOption = 'x-extension-defined-option'; // open: any string identifier accepted
// @ts-expect-error controllingOption is a string identifier, never a non-string
export const gateNotAString: ControllingOption = 123;

// --- Negatives: omitting a required member must NOT type-check. ---
// @ts-expect-error `timestamp` is required on Operation
export const badOperation: Operation = { type: 'http' };
// @ts-expect-error `type` is required on CaptureDataEntry (timestamp/data/serialize/deserialize present)
export const badEntry: CaptureDataEntry = {
  timestamp: 1,
  data: {},
  serialize: () => '',
  deserialize: () => {},
};
// @ts-expect-error `serialize` is required on CaptureDataEntry (type/timestamp/data/deserialize present)
export const badEntryNoSerialize: CaptureDataEntry = {
  type: 'log',
  timestamp: 1,
  data: {},
  deserialize: () => {},
};
// @ts-expect-error `addEntry` is required on CaptureAggregator (addEntries/clear present)
export const badAggregator: CaptureAggregator = { addEntries: noop, clear: noop };
// @ts-expect-error `tick` is required on CaptureStore (add/snapshot/clear present)
export const badStore: CaptureStore = {
  add: noop,
  snapshot: () => captureSnapshot,
  clear: noop,
};
// @ts-expect-error `release` is required on CaptureSnapshot (stream/drainAll present)
export const badSnapshot: CaptureSnapshot = {
  stream: async function* () {},
  drainAll: async () => new Map<FileType, StoredEntry[]>(),
};
// @ts-expect-error `drain` is required on CaptureExporter (stream present)
export const badExporter: CaptureExporter = { stream: async function* () {} };
// @ts-expect-error `start` is required on CaptureProvider (name/init/stop present)
export const badCaptureProvider: CaptureProvider = { name: 'x', init: noop, stop: noop };
// @ts-expect-error `init` is required on CaptureProvider (name/start/stop present)
export const badCaptureProviderNoInit: CaptureProvider = { name: 'x', start: noop, stop: noop };
// @ts-expect-error `start` is required on Interceptor
export const badInterceptor: Interceptor = { name: 'x', stop: noop };
// @ts-expect-error `name` is required on Extension
export const badExtension: Extension = { setup: noop, stop: noop };
// @ts-expect-error `onOperation` is required on OperationDispatcher
export const badDispatcher: OperationDispatcher = { registerObserver: () => noop };
// @ts-expect-error `start` is required on DetectionProvider
export const badDetector: DetectionProvider = { name: 'x', stop: noop };

export type ContractAssertions = [
  typeof operation,
  typeof entry,
  typeof entryFactory,
  typeof storedEntry,
  typeof dispatcher,
  typeof captureStore,
  typeof captureSnapshot,
  typeof aggregator,
  typeof exporter,
  typeof exampleClient,
  typeof interceptor,
  typeof captureProviderInit,
  typeof launchOptions,
  typeof networkProvider,
  typeof detector,
  typeof extension,
];
