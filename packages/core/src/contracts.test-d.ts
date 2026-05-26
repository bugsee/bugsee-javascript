// Type-level tests for the §16.2 contracts, checked by `tsc --noEmit`. Valid example implementations
// must type-check; @ts-expect-error negatives pin required members; a generic CaptureProvider<T> is
// exercised. Example object literals are type-checked (excess-property + missing-property checks).

import type { NetworkEvent } from '@bugsee/protocol';
import type {
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

const dispatcher: OperationDispatcher = {
  registerObserver: () => noop,
  onOperation: noop,
};

const exampleClient: Client = {
  hubs: createEventHubs(),
  operations: dispatcher,
  addCaptureProvider: noop,
  addDetectionProvider: noop,
};

const interceptor: Interceptor = {
  name: 'global-error',
  start: (_client: Client) => {},
  stop: noop,
};

// Generic capture provider over a concrete event type; serialize may return bytes or a string.
const networkProvider: CaptureProvider<NetworkEvent> = {
  name: 'network',
  wireFileType: 'network',
  filename: 'network.json',
  controllingOption: 'captureNetwork',
  start: (_client: Client) => {},
  stop: noop,
  serialize: (entries) => JSON.stringify(entries),
};

const screenshotProvider: CaptureProvider = {
  name: 'screenshot',
  wireFileType: 'screenshot',
  filename: 'screenshot.png',
  start: noop,
  stop: noop,
  serialize: () => new Uint8Array([1, 2, 3]),
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
// @ts-expect-error `wireFileType` is required on CaptureProvider
export const badCaptureProvider: CaptureProvider = {
  name: 'x',
  filename: 'x.json',
  start: noop,
  stop: noop,
  serialize: () => '',
};
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
  typeof dispatcher,
  typeof exampleClient,
  typeof interceptor,
  typeof networkProvider,
  typeof screenshotProvider,
  typeof detector,
  typeof extension,
];
