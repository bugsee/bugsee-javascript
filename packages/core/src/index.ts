// @bugsee/core — the SDK kernel (tier 1, design §7/§16): Client, single global Environment, event hubs +
// EventEmitter, Interceptor/CaptureProvider/DetectionProvider + extension registry, ring buffers,
// the event/trigger pipeline, and BundleWriter. Built incrementally, test-first.

export { type BundleFile, writeBundleZip } from './bundle-writer';
export { createCaptureAggregator } from './capture-aggregator';
export {
  type CaptureCoordinator,
  createCaptureCoordinator,
  type OptionGate,
} from './capture-coordinator';
export { CaptureProviderBase } from './capture-provider-base';
export { type BugseeClient, createClient } from './client';
export { type Clock, createSystemClock } from './clock';
export type {
  CaptureAggregator,
  CaptureDataEntry,
  CaptureProvider,
  CaptureStore,
  Client,
  DetectionProvider,
  Extension,
  Interceptor,
  Operation,
  OperationDispatcher,
  OperationObserver,
} from './contracts';
export { checkOrSetAlreadyCaught } from './dedup';
export {
  createDetectionCoordinator,
  type DetectionCoordinator,
  type ReportListener,
} from './detection-coordinator';
export { DetectionProviderBase } from './detection-provider-base';
export { createEnvironment, type Environment } from './environment';
export { BugseeError, type BugseeErrorOptions } from './errors';
export { createEventEmitter, type EventEmitter, type Listener } from './event-emitter';
export { createExtensionRegistry, type ExtensionRegistry } from './extension-registry';
export {
  createEventHubs,
  type EventHubs,
  type InputEvent,
  type LogEvent,
} from './hubs';
export {
  createMemoryCaptureStore,
  type MemoryCaptureStoreOptions,
} from './memory-capture-store';
export { createOperationDispatcher } from './operation-dispatcher';
export {
  createRateLimiter,
  type RateLimiter,
  type RateLimiterOptions,
} from './rate-limiter';
export {
  createReportingRequest,
  type Report,
  type ReportingRequest,
  type ReportingRequestInit,
  type ReportingSource,
  type ReportingTriggerType,
} from './reporting';
export { createRingBuffer, type RingBuffer } from './ring-buffer';
export type {
  BugseeApi,
  Bundle,
  BundleUploader,
  DropReason,
  IssueCreateResult,
  OutcomeCategory,
  PutBundleOptions,
  PutResult,
  UploadHint,
  UploadPipeline,
  UploadResult,
} from './transport';
export {
  createTriggerPipeline,
  type TriggerPipeline,
  type TriggerPipelineOptions,
} from './trigger-pipeline';
export {
  createUploadPipeline,
  type PipelineOutcome,
  type UploadPipelineOptions,
} from './upload-pipeline';
