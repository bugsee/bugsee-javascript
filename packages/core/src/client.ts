import type { EnvironmentEnvelope, LogLevel, Mechanism } from '@bugsee/protocol';
import type {
  AttributeValue,
  LogLevelName,
  NameExtensionMapping,
  SeverityName,
} from '@bugsee/types';
import { assembleBundle } from './bundle-assembler';
import { createCaptureAggregator } from './capture-aggregator';
import { createCaptureCoordinator, type OptionGate } from './capture-coordinator';
import { CaptureDataEntryBase } from './capture-data-entry';
import { createCaptureExporter } from './capture-exporter';
import { type Clock, createSystemClock } from './clock';
import type { CaptureStore, Client } from './contracts';
import { checkOrSetAlreadyCaught } from './dedup';
import { createDetectionCoordinator } from './detection-coordinator';
import { createEnvironment } from './environment';
import { createExtensionRegistry } from './extension-registry';
import { createEventHubs, type LogEvent } from './hubs';
import { createMemoryCaptureStore } from './memory-capture-store';
import { createOperationDispatcher } from './operation-dispatcher';
import { createRateLimiter, type RateLimiterOptions } from './rate-limiter';
import { createReportingRequest, type ReportingRequest } from './reporting';
import type { Bundle, UploadPipeline, UploadResult } from './transport';
import { createTriggerPipeline, type TriggerPipeline } from './trigger-pipeline';

// The Client facade (design §7.1) — the runtime-agnostic composition root that wires the kernel
// together: registration seams (§16.3), identity/attribute delegation to the single global
// Environment (§7.2), manual capture entry points, lifecycle (launch/stop/flush), and the
// report/upload path. When given a report assembler's inputs (appToken + environment + upload
// pipeline), the Client builds the trigger pipeline itself (assembleBundle over the aggregator
// snapshot); logException instance-dedups + rate-limits, then reports. A dropped result is
// `{ ok: false }`. Platform specifics (EnvironmentEnvelope factory, transport impls, DOM) are
// injected.

/** A breadcrumb payload (design §10). */
export interface Breadcrumb {
  type?: string;
  category?: string;
  message?: string;
  level?: LogLevelName;
  data?: Record<string, unknown>;
  timestamp: number;
}

/** addBreadcrumb input: timestamp is optional (the Client stamps it from the clock). */
export type BreadcrumbInput = Omit<Breadcrumb, 'timestamp'> & { timestamp?: number };

/** Options for logException (a focused core subset of Android ExceptionOptions). */
export interface LogExceptionOptions {
  /** Capture mechanism for the wire source (default 'programmatic'). */
  mechanism?: Mechanism;
  /** Issue severity (default derived from the error issue type). */
  severity?: SeverityName;
  /** Extra labels for the issue. */
  labels?: string[];
}

/** The public client surface, extending the provider-facing {@link Client} (grown per slice). */
export interface BugseeClient extends Client {
  registerExt<K extends keyof NameExtensionMapping>(name: K, api: NameExtensionMapping[K]): void;
  ext<K extends keyof NameExtensionMapping>(name: K): NameExtensionMapping[K];

  setUserIdentifier(id: string): void;
  getUserIdentifier(): string | null;
  clearUserIdentifier(): void;

  setAttribute(key: string, value: AttributeValue): void;
  getAttribute(key: string): AttributeValue | undefined;
  clearAttribute(key: string): void;
  clearAllAttributes(): void;
  getAllAttributes(): Record<string, AttributeValue>;

  // Manual capture entry points (Android parity, §7.1). Each pushes a CaptureDataEntry.
  addBreadcrumb(breadcrumb: BreadcrumbInput): void;
  log(message: string, level?: LogLevel | LogLevelName, timestamp?: number): void;
  event(name: string, params?: Record<string, unknown>): void;
  trace(name: string, value: unknown): void;

  /** Capture an exception (instance-deduped + rate-limited) and trigger a report. */
  logException(error: unknown, options?: LogExceptionOptions): Promise<UploadResult>;

  // Lifecycle (§7.1).
  /** Start capture + detection. Idempotent — a second call while launched is ignored. */
  launch(): void;
  isLaunched(): boolean;
  /** Stop capture + detection and drain pending uploads. Resolves true if drained within `timeout`. */
  stop(timeout?: number): Promise<boolean>;
  /** Drain pending uploads. Resolves true if drained within `timeout`. */
  flush(timeout?: number): Promise<boolean>;
}

export interface CreateClientOptions {
  /** Time source; injectable for tests. Default createSystemClock(). */
  clock?: Clock;
  /** Capture storage backend (disk/IndexedDB on platform tiers). Default in-memory. */
  captureStore?: CaptureStore;
  /** Which capture/detection options are enabled (gates the coordinators). Default: all enabled. */
  isEnabled?: OptionGate;
  /** Capture-storm rate limit (§7.7). Default 100 / 60s. */
  captureRateLimit?: RateLimiterOptions;
  /** Upload pipeline (built by the platform from BugseeApi/BundleUploader); enables flush/stop drain. */
  uploadPipeline?: UploadPipeline;
  /** Plain-text app token (apptoken file); required to build the trigger pipeline. */
  appToken?: string;
  /** Builds the EnvironmentEnvelope at assembly time; required to build the trigger pipeline. */
  getEnvironment?: () => EnvironmentEnvelope;
  /** Bundle archive name generator (default `<random20>.bundle.zip`). */
  bundleFileName?: () => string;
  /** Trigger pipeline override; when omitted, built from uploadPipeline + appToken + getEnvironment. */
  triggerPipeline?: TriggerPipeline;
  /**
   * Internal error sink (§15.1). Receives provider-start failures (so launch() never throws) and
   * hub-listener / operation-observer failures. Platform tiers wire this to debug.warn. Default no-op.
   */
  onError?: (error: unknown) => void;
}

export function createClient(options: CreateClientOptions = {}): BugseeClient {
  const clock = options.clock ?? createSystemClock();
  const isEnabled = options.isEnabled ?? (() => true);
  const onError = options.onError ?? (() => {});
  const rateLimiter = createRateLimiter(clock, options.captureRateLimit);
  const environment = createEnvironment();
  const hubs = createEventHubs(onError);
  const operations = createOperationDispatcher(onError);
  // One store, two directions (§16): the aggregator writes (serialize + route), the exporter reads
  // (drain + deserialize) at trigger time.
  const captureStore = options.captureStore ?? createMemoryCaptureStore();
  const captureAggregator = createCaptureAggregator(captureStore);
  const captureExporter = createCaptureExporter(captureStore);
  const captureCoordinator = createCaptureCoordinator();
  const detectionCoordinator = createDetectionCoordinator();
  const extensionRegistry = createExtensionRegistry();
  let launched = false;

  // Build the trigger pipeline from the report assembler when its inputs are present (unless an
  // override is injected). assemble reads the aggregator snapshot + the live environment/attributes.
  const { uploadPipeline, appToken, getEnvironment } = options;
  let triggerPipeline = options.triggerPipeline;
  if (triggerPipeline === undefined && uploadPipeline && appToken !== undefined && getEnvironment) {
    const assemble = async (request: ReportingRequest): Promise<Bundle> =>
      assembleBundle(request, await captureExporter.drain(), {
        appToken,
        environment: getEnvironment(),
        attributes: environment.getAllAttributes(),
        clock,
        ...(options.bundleFileName !== undefined ? { fileName: options.bundleFileName } : {}),
      });
    triggerPipeline = createTriggerPipeline({ assemble, uploadPipeline });
  }

  // The provider/extension-facing surface (§16.3) passed to providers at start().
  const context: Client = {
    hubs,
    operations,
    captureAggregator,
    addCaptureProvider: captureCoordinator.addProvider,
    addDetectionProvider: detectionCoordinator.addProvider,
  };

  return {
    ...context,

    registerExt: extensionRegistry.registerExt,
    ext: extensionRegistry.ext,

    setUserIdentifier: environment.setUserIdentifier,
    getUserIdentifier: environment.getUserIdentifier,
    clearUserIdentifier: environment.clearUserIdentifier,

    setAttribute: environment.setAttribute,
    getAttribute: environment.getAttribute,
    clearAttribute: environment.clearAttribute,
    clearAllAttributes: environment.clearAllAttributes,
    getAllAttributes: environment.getAllAttributes,

    addBreadcrumb(breadcrumb: BreadcrumbInput): void {
      const timestamp = breadcrumb.timestamp ?? clock.wallNow();
      captureAggregator.addEntry(
        new CaptureDataEntryBase('breadcrumbs', timestamp, { ...breadcrumb, timestamp }),
      );
    },

    log(message: string, level: LogLevel | LogLevelName = 'info', timestamp?: number): void {
      const ts = timestamp ?? clock.wallNow();
      const entry: LogEvent = { timestamp: ts, level, source: 'logger', message };
      captureAggregator.addEntry(new CaptureDataEntryBase('log', ts, entry));
    },

    event(name: string, params?: Record<string, unknown>): void {
      const timestamp = clock.wallNow();
      captureAggregator.addEntry(
        new CaptureDataEntryBase('events.user', timestamp, {
          timestamp,
          name,
          ...(params !== undefined ? { params } : {}),
        }),
      );
    },

    trace(name: string, value: unknown): void {
      const timestamp = clock.wallNow();
      captureAggregator.addEntry(
        new CaptureDataEntryBase('traces.user', timestamp, { timestamp, name, value }),
      );
    },

    logException(error: unknown, exceptionOptions?: LogExceptionOptions): Promise<UploadResult> {
      // Instance dedup: a re-capture of the same thrown object is a no-op (§7.7).
      if (checkOrSetAlreadyCaught(error)) {
        return Promise.resolve({ ok: false });
      }
      // Storm self-protection: drop beyond the rolling capture rate (§7.7).
      if (!rateLimiter.tryAcquire()) {
        return Promise.resolve({ ok: false });
      }
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      const request = createReportingRequest({
        source: { type: 'error', mechanism: exceptionOptions?.mechanism ?? 'programmatic' },
        summary: message,
        ...(stack !== undefined ? { description: stack } : {}),
        ...(exceptionOptions?.severity !== undefined
          ? { severity: exceptionOptions.severity }
          : {}),
        ...(exceptionOptions?.labels !== undefined ? { labels: exceptionOptions.labels } : {}),
      });
      return triggerPipeline?.report(request) ?? Promise.resolve({ ok: false });
    },

    isLaunched(): boolean {
      return launched;
    },

    launch(): void {
      if (launched) {
        return;
      }
      launched = true;
      // launch() must never throw (§15.1): a throwing provider.start is isolated per coordinator
      // (a failed capture start must not prevent detection from starting) and routed to onError.
      try {
        captureCoordinator.start(context, isEnabled);
      } catch (error) {
        onError(error);
      }
      try {
        detectionCoordinator.start(context, isEnabled, (request) => {
          void triggerPipeline?.report(request);
        });
      } catch (error) {
        onError(error);
      }
    },

    stop(timeout?: number): Promise<boolean> {
      if (!launched) {
        return Promise.resolve(true);
      }
      launched = false;
      captureCoordinator.stop();
      detectionCoordinator.stop();
      return uploadPipeline?.flush(timeout) ?? Promise.resolve(true);
    },

    flush(timeout?: number): Promise<boolean> {
      return uploadPipeline?.flush(timeout) ?? Promise.resolve(true);
    },
  };
}
