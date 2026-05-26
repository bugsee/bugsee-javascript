// @bugsee/core — the SDK kernel (tier 1, design §7/§16): Client, single global scope, event hubs +
// EventEmitter, Interceptor/CaptureProvider/DetectionProvider + extension registry, ring buffers,
// the event/trigger pipeline, and BundleWriter. Built incrementally, test-first.

export { type BundleFile, writeBundleZip } from './bundle-writer';
export {
  type CaptureCoordinator,
  createCaptureCoordinator,
  type OptionGate,
} from './capture-coordinator';
export { type Clock, createSystemClock } from './clock';
export type {
  CaptureProvider,
  Client,
  DetectionProvider,
  Extension,
  Interceptor,
  Operation,
  OperationDispatcher,
  OperationObserver,
  TriggerHint,
} from './contracts';
export { checkOrSetAlreadyCaught } from './dedup';
export {
  createDetectionCoordinator,
  type DetectionCoordinator,
  type TriggerListener,
} from './detection-coordinator';
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
  createRateLimiter,
  type RateLimiter,
  type RateLimiterOptions,
} from './rate-limiter';
export { createRingBuffer, type RingBuffer } from './ring-buffer';
export { type Breadcrumb, createScope, type Scope, type ScopeOptions } from './scope';
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
  createUploadPipeline,
  type PipelineOutcome,
  type UploadPipelineOptions,
} from './upload-pipeline';
