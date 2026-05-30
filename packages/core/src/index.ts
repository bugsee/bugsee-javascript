// @bugsee/core — the SDK kernel (tier 1, design §7/§16): Client, single global Environment, event hubs +
// EventEmitter, Interceptor/CaptureProvider/DetectionProvider + extension registry, ring buffers,
// the event/trigger pipeline, and BundleWriter. Built incrementally, test-first.

export {
  createServiceContainer,
  defineService,
  type InstantiationMode,
  type Provider,
  type Service,
  type ServiceContainer,
  type ServiceFactory,
} from '@bugsee/service';
export { type BugseeApiOptions, createBugseeApi } from './bugsee-api';
export { assembleBundle, type BundleAssemblyContext } from './bundle-assembler';
export { createBundleUploader } from './bundle-uploader';
export { type BundleFile, writeBundleZip } from './bundle-writer';
export { createCaptureAggregator } from './capture-aggregator';
export {
  type CaptureCoordinator,
  createCaptureCoordinator,
  type OptionGate,
} from './capture-coordinator';
export { CaptureDataEntryBase, defaultEntryFactory } from './capture-data-entry';
export { createCaptureExporter } from './capture-exporter';
export { CaptureProviderBase } from './capture-provider-base';
export {
  BUGSEE_SDK_VERSION,
  type BugseeCarrier,
  getCarrier,
  getCarrierClient,
  getFilters,
  getInternal,
  getOrCreateInterceptor,
  setCarrierClient,
} from './carrier';
export {
  type Breadcrumb,
  type BreadcrumbInput,
  type BugseeClient,
  type CreateClientOptions,
  createClient,
  type LogExceptionOptions,
  type Scheduler,
} from './client';
export { type Clock, createSystemClock } from './clock';
export type {
  CaptureAggregator,
  CaptureDataEntry,
  CaptureEntryFactory,
  CaptureExporter,
  CaptureProvider,
  CaptureProviderInit,
  CaptureSnapshot,
  CaptureStore,
  Client,
  DetectionProvider,
  Extension,
  FileStorageAdapter,
  Interceptor,
  Operation,
  OperationDispatcher,
  OperationObserver,
  OptionsContainer,
  StoredEntry,
} from './contracts';
export { checkOrSetAlreadyCaught } from './dedup';
export {
  createDetectionCoordinator,
  type DetectionCoordinator,
  type ReportListener,
} from './detection-coordinator';
export { DetectionProviderBase } from './detection-provider-base';
export {
  type BundleStore,
  createDurableUploadPipeline,
  type DurableUploadPipeline,
  type DurableUploadPipelineOptions,
  deserializeBundle,
  serializeBundle,
} from './durable-upload-pipeline';
export {
  createMultiKeyEmitter,
  type EventListener,
  type EventSubscribable,
  type MultiKeyEmitter,
  MultiKeyEmitterBase,
} from './emitter';
export { createEnvironment, type Environment } from './environment';
export { BugseeError, type BugseeErrorOptions } from './errors';
export { createEventEmitter, type EventEmitter, type Listener } from './event-emitter';
export type { InputEvent, LogEvent } from './events';
export { createExtensionRegistry, type ExtensionRegistry } from './extension-registry';
export { createFileCaptureStore, type FileCaptureStoreOptions } from './file-capture-store';
export {
  type BreadcrumbFilter,
  createFilterStore,
  type FilterStore,
  type LogEventFilter,
  type NetworkEventFilter,
  type ReportHandler,
  runFilter,
} from './filters';
export { InterceptorBase } from './interceptor-base';
export {
  createMemoryCaptureStore,
  type MemoryCaptureStoreOptions,
} from './memory-capture-store';
export { createOperationDispatcher } from './operation-dispatcher';
export {
  COMMON_OPTION_DEFINITIONS,
  createOptionsContainer,
  type OptionDefinition,
  type ResolvedLaunchOptions,
  resolveLaunchOptions,
} from './options';
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
export type { ServiceRegistrar, ServiceResolver } from './services';
export { formatStack, parseV8Stack, type StackFrame } from './stack';
export type {
  BugseeApi,
  Bundle,
  BundleUploader,
  DropReason,
  HttpRequestOptions,
  HttpResponse,
  HttpTransport,
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
