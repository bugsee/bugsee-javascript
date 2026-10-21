// @bugsee/core — the SDK kernel: Client, single global Environment, event hubs +
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
export {
  createMultiKeyEmitter,
  createTrackerRegistry,
  type EventListener,
  type EventSubscribable,
  InterceptorBase,
  type MultiKeyEmitter,
  MultiKeyEmitterBase,
  type TrackerRegistry,
} from '@bugsee/trackers';
export type { AttributeValue } from '@bugsee/types';
// Diagnostics helpers for packages that read a host option themselves (framework adapters) and must warn about
// an invalid value without ever breaking launch; they live in @bugsee/util.
export { describeValue, reportGuarded } from '@bugsee/util';
export {
  type AppIdentity,
  type AppIdentitySource,
  bundledAppIdentity,
  findNearestPackageVersion,
  PACKAGE_VERSION_MAX_DEPTH,
  type PackageVersionIo,
  resolveAppIdentity,
} from './app-identity';
export {
  addReportAttachment,
  decodeRequestFromMarker,
  encodeRequestForMarker,
  MAX_USER_ATTACHMENT_BYTES,
  MAX_USER_ATTACHMENTS,
} from './attachments';
export {
  type BlackoutChangeOptions,
  type BlackoutGate,
  type BlackoutState,
  BlackoutToken,
  createBlackoutState,
} from './blackout';
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
  clearCarrierClient,
  contributeServiceManifest,
  getCarrier,
  getCarrierBlackout,
  getCarrierClient,
  getCarrierLifecycleSlot,
  getCarrierPendingLaunch,
  getCarrierStatus,
  getFilters,
  getInternal,
  getOrCreateInterceptor,
  getProcessStatus,
  getServiceManifests,
  type ServiceManifest,
  sealCarrierLifecycleSlot,
  setCarrierBlackout,
  setCarrierClient,
  setCarrierLastLaunch,
  setCarrierPendingLaunch,
  setCarrierStatus,
  setProcessLifecycleEventsListener,
} from './carrier';
export type { ChunkBackend, FrozenPart, PartMeta, PartRef } from './chunk-backend';
export { type ChunkCaptureStoreOptions, createChunkCaptureStore } from './chunk-capture-store';
export { type ChunkStorage, ChunkStorageToken, createInMemoryChunkStorage } from './chunk-storage';
export {
  asInternalClient,
  type Breadcrumb,
  type BreadcrumbInput,
  type BugseeClient,
  type CreateClientOptions,
  createClient,
  type InternalBugseeClient,
  type InternalLogExceptionOptions,
  type InternalPreparedUpload,
  type InternalUploadOptions,
  type LogExceptionOptions,
  type PreparedUpload,
  type ReportSnapshotSource,
  type Scheduler,
  SchedulerToken,
  type UploadOptions,
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
  composeFrameEnrichers,
  type FrameEnricher,
  isUserFrame,
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
  createDiskPressure,
  DISK_LOW_BYTES,
  DISK_NONE_BYTES,
  DISK_RECOVERY_MARGIN_BYTES,
  type DiskPressure,
  type DiskPressureLevel,
  type DiskPressureOptions,
  type DiskPressureState,
  DiskPressureToken,
  isOutOfSpaceError,
} from './disk-pressure';
export { withDiskPressure } from './disk-pressure-backend';
export {
  type BundleStore,
  BundleStoreToken,
  createDurableUploadPipeline,
  DEFAULT_DURABLE_RETENTION,
  type DurableQueueRetention,
  type DurableUploadPipeline,
  type DurableUploadPipelineOptions,
  deserializeBundle,
  deserializeBundleFrame,
  type IdentifiedBundle,
  serializeBundle,
} from './durable-upload-pipeline';
export { createEnvironment, type Environment } from './environment';
export { BugseeError, type BugseeErrorOptions } from './errors';
export { createEventEmitter, type EventEmitter, type Listener } from './event-emitter';
export type { InputEvent, LogEvent, VideoAuxEvent } from './events';
export { InputTool } from './events';
export { createExtensionRegistry, type ExtensionRegistry } from './extension-registry';
export { createFileCaptureStore, type FileCaptureStoreOptions } from './file-capture-store';
export { createFileChunkBackend, type FileChunkBackendOptions } from './file-chunk-backend';
export {
  type BreadcrumbFilter,
  createFilterStore,
  type FilterableSpan,
  type FilterStore,
  FiltersToken,
  type LogEventFilter,
  type NetworkEventFilter,
  type ReportHandler,
  runFilter,
  type SpanFilter,
} from './filters';
export {
  type LaunchRecoveryOptions,
  type ReconcileOwnQueue,
  runLaunchRecovery,
} from './launch-recovery';
export { BugseeStatus } from './launch-status';
export {
  createLifecycleEmitter,
  type LifecycleEmitter,
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
  type LifecycleListenerSlot,
} from './lifecycle-events';
export { isLogLevelEnabled, parseLogLevelName } from './log-level';
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
export {
  createNotifyRelay,
  type NotifyInput,
  type NotifyRelay,
  type NotifyRelayOptions,
  type NotifySnapshot,
  type RelayTimers,
} from './notify-relay';
export { createOperationDispatcher } from './operation-dispatcher';
export {
  BOOLEAN_OPTION,
  BOOLEAN_OR_BAG_OPTION,
  COMMON_OPTION_DEFINITIONS,
  createOptionsContainer,
  FAIL_CLOSED_BOOLEAN_OPTION,
  FAIL_CLOSED_BOOLEAN_OR_BAG_OPTION,
  FAIL_ON_BOOLEAN_OPTION,
  type OptionDefinition,
  type ResolvedLaunchOptions,
  resolveFailClosedBoolean,
  resolveFailOnBoolean,
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
export { RELAUNCH_KEPT_OPTIONS, relaunchWith } from './relaunch';
export {
  type ReportMarker,
  type ReportMarkerStore,
  ReportMarkerStoreToken,
} from './report-marker-store';
export {
  createReportingRequest,
  hasDefaultSeverity,
  parseSeverityName,
  type Report,
  type ReportAttachment,
  type ReportAttachmentInput,
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
export {
  type FrameContext,
  formatStack,
  parseLocation,
  parseV8Stack,
  type StackFrame,
  setStackAppRoot,
} from './stack';
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
  NotifyItem,
  NotifyResult,
  OutcomeCategory,
  PutBundleOptions,
  PutResult,
  UploadHint,
  UploadPipeline,
  UploadResult,
} from './transport';
export {
  classifyServerErrorCode,
  isRetryableHttpStatus,
  isUploadSettled,
  SERVER_ERROR_CATEGORIES,
  type ServerErrorCategory,
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
