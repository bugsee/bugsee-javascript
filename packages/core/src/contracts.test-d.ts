// Type-level tests for the §16.2 contracts, checked by `tsc --noEmit`. Valid example implementations
// must type-check; @ts-expect-error negatives pin required members. Example object literals are
// type-checked (excess-property + missing-property checks).

import type { FileType, NetworkEvent } from '@bugsee/protocol';
import type {
  CaptureAggregator,
  CaptureDataEntry,
  CaptureProvider,
  Client,
  DetectionProvider,
  Extension,
  Interceptor,
  Operation,
  OperationDispatcher,
  TriggerHint,
} from './contracts';
import { createEventHubs } from './hubs';

const noop = (): void => {};

const operation: Operation = {
  type: 'http',
  timestamp: 1,
  description: 'GET /',
  data: { status: 200 },
};
const triggerHint: TriggerHint = {
  source: 'uncaught',
  severity: 'high',
  summary: 'Boom',
  description: 'detail',
  error: new Error('x'),
};
const entry: CaptureDataEntry = { type: 'log', timestamp: 1, data: { message: 'hi' } };

const dispatcher: OperationDispatcher = {
  registerObserver: () => noop,
  onOperation: noop,
};

const aggregator: CaptureAggregator = {
  addEntry: noop,
  addEntries: noop,
  snapshot: () => new Map<FileType, CaptureDataEntry[]>(),
  clear: noop,
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
      });
    });
  },
  stop: noop,
};

const detector: DetectionProvider = {
  name: 'crash',
  controllingOption: 'detectCrash',
  start: (_client: Client, trigger: (hint: TriggerHint) => void) => {
    trigger({ source: 'uncaught' });
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
// @ts-expect-error `source` is required on TriggerHint
export const badTriggerHint: TriggerHint = { summary: 'x' };
// @ts-expect-error `type` is required on CaptureDataEntry
export const badEntry: CaptureDataEntry = { timestamp: 1, data: {} };
// @ts-expect-error `addEntry` is required on CaptureAggregator
export const badAggregator: CaptureAggregator = {
  addEntries: noop,
  snapshot: () => new Map<FileType, CaptureDataEntry[]>(),
  clear: noop,
};
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
  typeof triggerHint,
  typeof entry,
  typeof dispatcher,
  typeof aggregator,
  typeof exampleClient,
  typeof interceptor,
  typeof networkProvider,
  typeof detector,
  typeof extension,
];
