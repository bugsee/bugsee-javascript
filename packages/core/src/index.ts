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
  type ServiceToken,
  serviceToken,
} from '@bugsee/service';
export type { AttributeValue } from '@bugsee/types';
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
export { drainReified } from './capture-drain';
export { createCaptureExporter } from './capture-exporter';
export { CaptureProviderBase } from './capture-provider-base';
export {
  createMarkerAwareBundleReplay,
  type MarkerAwareBundleReplay,
  type MarkerAwareBundleReplayOptions,
  type RecoverReportsOptions,
  recoverReports,
} from './capture-recovery';
export {
  BUGSEE_SDK_VERSION,
  type BugseeCarrier,
  contributeServiceManifest,
  getCarrier,
  getCarrierClient,
  getFilters,
  getInternal,
  getOrCreateInterceptor,
  getServiceManifests,
  type ServiceManifest,
  setCarrierClient,
} from './carrier';
export type { ChunkBackend, FrozenPart, PartMeta, PartRef } from './chunk-backend';
export { type ChunkCaptureStoreOptions, createChunkCaptureStore } from './chunk-capture-store';
export { type ChunkStorage, ChunkStorageToken, createInMemoryChunkStorage } from './chunk-storage';
export {
  type Breadcrumb,
  type BreadcrumbInput,
  type BugseeClient,
  type CreateClientOptions,
  createClient,
  type LogExceptionOptions,
  type ReportSnapshotSource,
  type Scheduler,
  SchedulerToken,
} from './client';
export { type Clock, ClockToken, createSystemClock } from './clock';
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
  ControllingOption,
  DetectionProvider,
  Extension,
  Interceptor,
  Operation,
  OperationDispatcher,
  OperationObserver,
  OptionsContainer,
  StoredEntry,
} from './contracts';
export { CaptureStoreToken } from './contracts';
export {
  type BuildCrashOptions,
  buildCrashJson,
  type CrashException,
  type CrashFrame,
  type CrashJson,
  type CrashProvenance,
  type NativeCrashJson,
  stampCrashProvenance,
} from './crash';
export {
  applyDebugIds,
  attachDebugIds,
  buildDebugIdMap,
  readDebugIds,
} from './debug-id';
export { checkOrSetAlreadyCaught } from './dedup';
export {
  createDetectionCoordinator,
  type DetectionCoordinator,
  type ReportListener,
} from './detection-coordinator';
export { DetectionProviderBase } from './detection-provider-base';
export {
  type BundleStore,
  BundleStoreToken,
  createDurableUploadPipeline,
  type DurableUploadPipeline,
  type DurableUploadPipelineOptions,
  deserializeBundle,
  type IdentifiedBundle,
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
export { InputTool } from './events';
export { createExtensionRegistry, type ExtensionRegistry } from './extension-registry';
export { createFileCaptureStore, type FileCaptureStoreOptions } from './file-capture-store';
export { createFileChunkBackend, type FileChunkBackendOptions } from './file-chunk-backend';
export {
  type BreadcrumbFilter,
  createFilterStore,
  type FilterStore,
  FiltersToken,
  type LogEventFilter,
  type NetworkEventFilter,
  type ReportHandler,
  runFilter,
} from './filters';
export { InterceptorBase } from './interceptor-base';
export {
  type LaunchRecoveryOptions,
  type ReconcileOwnQueue,
  runLaunchRecovery,
} from './launch-recovery';
export {
  createMemoryCaptureStore,
  type MemoryCaptureStoreOptions,
} from './memory-capture-store';
export { createMemoryChunkBackend, type MemoryChunkBackendOptions } from './memory-chunk-backend';
export {
  type CrashpadSessionMarker,
  type HarvestedDump,
  type NativeCrashRecoveryResult,
  type NativeCrashSource,
  type RecoverNativeCrashesOptions,
  recoverNativeCrashes,
} from './native-crash-recovery';
export { guarded, neverThrow } from './never-throw';
export { createOperationDispatcher } from './operation-dispatcher';
export {
  COMMON_OPTION_DEFINITIONS,
  createOptionsContainer,
  type OptionDefinition,
  type ResolvedLaunchOptions,
  resolveLaunchOptions,
} from './options';
export {
  createPartitionedCaptureStore,
  type PartitionedCaptureStore,
  type PartitionedCaptureStoreOptions,
  resolveMaxPartitions,
} from './partitioned-capture-store';
export {
  createRateLimiter,
  type RateLimiter,
  type RateLimiterOptions,
} from './rate-limiter';
export {
  type ReportMarker,
  type ReportMarkerStore,
  ReportMarkerStoreToken,
} from './report-marker-store';
export {
  createReportingRequest,
  type Report,
  type ReportAttachment,
  type ReportingRequest,
  type ReportingRequestInit,
  type ReportingSource,
  type ReportingTriggerType,
} from './reporting';
export {
  type ContextProvider,
  ContextProviderToken,
  type RequestContext,
} from './request-context';
export { createRingBuffer, type RingBuffer } from './ring-buffer';
export {
  isSensitiveInput,
  SENSITIVE_INPUT_MATCHERS,
  SENSITIVE_INPUT_SELECTOR,
} from './sensitive-input';
export type { ServiceRegistrar, ServiceResolver } from './services';
export { formatStack, parseLocation, parseV8Stack, type StackFrame } from './stack';
export {
  createStreamingCaptureStore,
  type StreamingCaptureEntry,
  type StreamingCaptureStoreOptions,
} from './streaming-capture-store';
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
  isRetryableHttpStatus,
  isUploadSettled,
  TransportToken,
  UploadPipelineToken,
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
