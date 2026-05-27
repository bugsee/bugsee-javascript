// Type-level tests for the §16.2 contracts, checked by `tsc --noEmit`. Valid example implementations
// must type-check; @ts-expect-error negatives pin required members. Example object literals are
// type-checked (excess-property + missing-property checks).

import type { FileType, NetworkEvent } from '@bugsee/protocol';
import type {
  CaptureAggregator,
  CaptureDataEntry,
  CaptureEntryFactory,
  CaptureExporter,
  CaptureProvider,
  CaptureStore,
  Client,
  DetectionProvider,
  Extension,
  Interceptor,
  Operation,
  OperationDispatcher,
  StoredEntry,
} from './contracts';
import { createEventHubs } from './hubs';
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

// The store persists serialized records; reads drain raw StoredEntry, not deserialized entries.
const captureStore: CaptureStore = {
  add: (_record: StoredEntry) => {},
  stream: async function* () {},
  drainAll: async () => new Map<FileType, StoredEntry[]>(),
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
  hubs: createEventHubs(),
  operations: dispatcher,
  captureAggregator: aggregator,
  addCaptureProvider: noop,
  addDetectionProvider: noop,
};

const interceptor: Interceptor = {
  name: 'global-error',
  start: (_client: Client) => {},
  stop: noop,
};

// A provider subscribes to its hub and pushes filtered entries to the single aggregator.
const networkProvider: CaptureProvider = {
  name: 'network',
  controllingOption: 'captureNetwork',
  start: (client: Client) => {
    client.hubs.network.subscribe((event: NetworkEvent) => {
      client.captureAggregator.addEntry({
        type: 'network',
        timestamp: event.timestamp,
        data: event,
        serialize: () => JSON.stringify(event),
        deserialize: () => {},
      });
    });
  },
  stop: noop,
};

const detector: DetectionProvider = {
  name: 'crash',
  controllingOption: 'detectCrash',
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
// @ts-expect-error `stream` is required on CaptureStore (add/drainAll/clear present)
export const badStore: CaptureStore = {
  add: noop,
  drainAll: async () => new Map<FileType, StoredEntry[]>(),
  clear: noop,
};
// @ts-expect-error `drain` is required on CaptureExporter (stream present)
export const badExporter: CaptureExporter = { stream: async function* () {} };
// @ts-expect-error `start` is required on CaptureProvider
export const badCaptureProvider: CaptureProvider = { name: 'x', stop: noop };
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
  typeof aggregator,
  typeof exporter,
  typeof exampleClient,
  typeof interceptor,
  typeof networkProvider,
  typeof detector,
  typeof extension,
];
