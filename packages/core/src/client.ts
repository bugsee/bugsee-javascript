import type { EnvironmentEnvelope, LogLevel, Mechanism } from '@bugsee/protocol';
import {
  createServiceContainer,
  defineService,
  type Provider,
  type Service,
  type ServiceContainer,
  type ServiceToken,
  serviceToken,
} from '@bugsee/service';
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
import { type Clock, ClockToken, createSystemClock } from './clock';
import {
  type CaptureDataEntry,
  type CaptureProviderInit,
  type CaptureStore,
  CaptureStoreToken,
  type Client,
  type OptionsContainer,
} from './contracts';
import { checkOrSetAlreadyCaught } from './dedup';
import { createDetectionCoordinator } from './detection-coordinator';
import { createEnvironment } from './environment';
import type { BugseeError } from './errors';
import type { BreadcrumbInput, LogEvent } from './events';
import {
  type BreadcrumbFilter,
  createFilterStore,
  FiltersToken,
  type LogEventFilter,
  type NetworkEventFilter,
  type ReportHandler,
  runFilter,
} from './filters';

export type { Breadcrumb, BreadcrumbInput } from './events';

import { createExtensionRegistry } from './extension-registry';
import { createMemoryCaptureStore } from './memory-capture-store';
import { createOperationDispatcher } from './operation-dispatcher';
import { createOptionsContainer } from './options';
import { createRateLimiter, type RateLimiterOptions } from './rate-limiter';
import type { ReportMarkerStore } from './report-marker-store';
import { createReportingRequest, type ReportingRequest } from './reporting';
import type { ServiceRegistrar, ServiceResolver } from './services';
import {
  type Bundle,
  type UploadPipeline,
  UploadPipelineToken,
  type UploadResult,
} from './transport';
import { createTriggerPipeline, type TriggerPipeline } from './trigger-pipeline';

// The Client facade (design §7.1) — the runtime-agnostic composition root that wires the kernel
// together: registration seams (§16.3), identity/attribute delegation to the single global
// Environment (§7.2), manual capture entry points, lifecycle (launch/stop/flush), and the
// report/upload path. When given a report assembler's inputs (appToken + environment + upload
// pipeline), the Client builds the trigger pipeline itself (assembleBundle over the exporter
// drain); logException instance-dedups + rate-limits, then reports. A dropped result is
// `{ ok: false }`. Platform specifics (EnvironmentEnvelope factory, transport impls, DOM) are
// injected.

/**
 * Periodic scheduler driving the capture-store tick (part rotation + out-of-window cleanup).
 * Injectable for tests and for edge/lambda (where a long-lived timer is undesirable — pass a no-op).
 * Defaults to the global setInterval/clearInterval.
 */
export interface Scheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

// The scheduler's typed identity in the internal container (DI Phase 3); the client registers the
// resolved scheduler (injected or the default global timers) so it is resolvable via getService.
export const SchedulerToken = serviceToken<Scheduler>('scheduler');

const globalTimers = globalThis as unknown as {
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};
const defaultScheduler: Scheduler = {
  setInterval: (callback, ms) => {
    const handle = globalTimers.setInterval(callback, ms);
    // A background cleanup timer must not keep a Node process alive; unref where supported (no-op
    // in the browser, where setInterval returns a number).
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => globalTimers.clearInterval(handle),
};

const globalTimeout = globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown };
// A flush/stop deadline timer; unref'd so it never keeps a process alive when the drain wins.
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const handle = globalTimeout.setTimeout(resolve, ms);
    (handle as { unref?: () => void }).unref?.();
  });

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
export interface BugseeClient extends Client, ServiceResolver, ServiceRegistrar {
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

  // Redaction filters (§4.1#4 / §7.1): each runs per captured event to mutate it or DROP it (return
  // null). A network filter REPLACES the built-in sanitizer. Pass null to clear. Settable any time.
  setNetworkEventFilter(filter: NetworkEventFilter | null): void;
  setLogEventFilter(filter: LogEventFilter | null): void;
  setBreadcrumbFilter(filter: BreadcrumbFilter | null): void;
  /** `before` mutates/vetoes (return null) the report before assembly. `after` is accepted but deferred. */
  setReportHandler(handler: ReportHandler | null): void;

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

/**
 * A pull-at-report snapshot source: given the report's wall-clock timestamp, returns extra capture
 * entries to merge into the assembled bundle (e.g. a browser DOM `viewtree`). Synchronous and called
 * once per live report at assembly time.
 */
export type ReportSnapshotSource = (now: number) => readonly CaptureDataEntry[];

export interface CreateClientOptions {
  /** Time source; injectable for tests. Default createSystemClock(). */
  clock?: Clock;
  /** Capture storage backend (disk/IndexedDB on platform tiers). Default in-memory. */
  captureStore?: CaptureStore;
  /** The internal service container (the per-process DI registry). Default a fresh one. */
  services?: ServiceContainer;
  /** Recording window in seconds for the default in-memory store (design maxRecordingTime). Default 60. */
  maxRecordingTime?: number;
  /** Scheduler for the capture-store tick; injectable for tests/edge. Default global timers. */
  scheduler?: Scheduler;
  /** Capture-store tick interval in ms (part rotation + cleanup) while launched. Default 1000. */
  tickIntervalMs?: number;
  /** Which capture/detection options are enabled (gates the coordinators). Default: all enabled. */
  isEnabled?: OptionGate;
  /** Launch options passed to each provider's start(options) for per-launch reconfiguration. */
  launchOptions?: OptionsContainer;
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
   * Capture-recovery marker hook: a durable marker store + this launch's capture generation. When set,
   * each report persists a pending marker (tagged with the generation) BEFORE assembly and clears it on
   * settle — so an incident that beats the bundle assembly is rebuilt next launch from the durable
   * capture chunks. Omitted = no recovery markers (e.g. in-memory store / recovery disabled).
   */
  reportMarkers?: { store: ReportMarkerStore; generation: number };
  /**
   * Report-time snapshot sources (the browser DOM viewtree, a screenshot on platforms that have one).
   * Each is PULLED once per LIVE report at bundle assembly, with the assembly-time wall clock
   * (`clock.wallNow()`), and its entries are APPENDED to their file type in the drained capture map (so
   * e.g. a `viewtree` entry lands in the bundle). Appended AFTER any drained entries with no timestamp
   * re-sort — correct for a dedicated type like `viewtree` (its own file, one entry); a source that
   * emitted into a rolling-buffer type (log/events) would therefore land last regardless of its stamp.
   * A throwing source is isolated (→ onError) and the report still uploads. NOT used by capture-recovery
   * (a next-launch DOM is not the incident's), so a recovered bundle carries no snapshot. Default none.
   */
  reportSnapshots?: readonly ReportSnapshotSource[];
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
  // The internal service container (the "BugseeInternal" — the per-process DI registry, §7.4). Phase 1
  // stands it up; later phases migrate the hand-wired seams into it as registered services.
  const services = options.services ?? createServiceContainer();
  // Redaction filters: the first real service (§4.1#4). The facade's set* mutate this store; the
  // capture pipeline reads the same instance via the container (getFilters). Registered eagerly so a
  // pipeline resolve always finds it once a client exists.
  const filters = createFilterStore(onError);
  services.addService(defineService(FiltersToken, () => filters));
  const rateLimiter = createRateLimiter(clock, options.captureRateLimit);
  const environment = createEnvironment();
  const operations = createOperationDispatcher(onError);
  // One store, two directions (§16): the aggregator writes (serialize + route), the exporter reads
  // (drain + deserialize) at trigger time. The default in-memory store shares the Client's clock and
  // recording window so entries and the time-based retention agree on "now".
  const captureStore =
    options.captureStore ??
    createMemoryCaptureStore({
      clock,
      maxRecordingTimeMs: (options.maxRecordingTime ?? 60) * 1000,
    });
  // The resolved store (platform override or default) is a container service — resolvable process-wide
  // via getService(CaptureStoreToken), alongside transport/filters (DI Phase 3).
  services.addService(defineService(CaptureStoreToken, () => captureStore));
  services.addService(defineService(ClockToken, () => clock));
  const captureAggregator = createCaptureAggregator(captureStore);
  const captureExporter = createCaptureExporter(captureStore);
  // The capture-pipeline deps every provider gets once at registration (Android
  // BugseeCaptureDataProviderInit) — the data-plane subset of the Client, minus its registration seams.
  const captureProviderInit: CaptureProviderInit = { operations, captureAggregator };
  const captureCoordinator = createCaptureCoordinator(captureProviderInit);
  const launchOptions = options.launchOptions ?? createOptionsContainer();
  const detectionCoordinator = createDetectionCoordinator();
  const extensionRegistry = createExtensionRegistry();
  const scheduler = options.scheduler ?? defaultScheduler;
  services.addService(defineService(SchedulerToken, () => scheduler));
  const tickIntervalMs = options.tickIntervalMs ?? 1000;
  let launched = false;
  // True once stop() has run (until a re-launch): manual captures that upload become no-ops (§1501).
  // Distinct from `!launched` so capturing BEFORE the first launch is unaffected.
  let stopped = false;
  // Permanent kill-state (§1435/§1504): set when a report fails with an unrecoverable auth error
  // (invalid app token). All capture goes no-op, capture+detection halt, onError fires ONCE.
  let killed = false;
  let tickTimer: unknown = null;

  // Build the trigger pipeline from the report assembler when its inputs are present (unless an
  // override is injected). assemble reads the exporter drain + the live environment/attributes.
  const { uploadPipeline, appToken, getEnvironment } = options;
  // The platform's assembled upload orchestrator, when present, is also a container service (DI Phase 3).
  if (uploadPipeline !== undefined) {
    services.addService(defineService(UploadPipelineToken, () => uploadPipeline));
  }
  let triggerPipeline = options.triggerPipeline;
  if (triggerPipeline === undefined && uploadPipeline && appToken !== undefined && getEnvironment) {
    const assemble = async (request: ReportingRequest): Promise<Bundle> => {
      const capturedByType = await captureExporter.drain();
      // Merge report-time snapshots (e.g. the DOM viewtree) into the drained map. Each source is
      // isolated: a throw goes to onError and the report still uploads (a missing snapshot must never
      // block delivery).
      if (options.reportSnapshots !== undefined) {
        const snapshotAt = clock.wallNow();
        for (const source of options.reportSnapshots) {
          try {
            for (const entry of source(snapshotAt)) {
              const existing = capturedByType.get(entry.type);
              if (existing !== undefined) {
                existing.push(entry);
              } else {
                capturedByType.set(entry.type, [entry]);
              }
            }
          } catch (error) {
            onError(error);
          }
        }
      }
      return assembleBundle(request, capturedByType, {
        appToken,
        environment: getEnvironment(),
        attributes: environment.getAllAttributes(),
        userIdentifier: environment.getUserIdentifier(),
        clock,
        ...(options.bundleFileName !== undefined ? { fileName: options.bundleFileName } : {}),
      });
    };
    triggerPipeline = createTriggerPipeline({ assemble, uploadPipeline });
  }

  // In-flight report promises (logException + detection submissions). A report promise resolves
  // only after its full path completes (assemble → enqueue → upload), so flush()/stop() await these
  // to drain reports still ASSEMBLING — which uploadPipeline.flush alone misses (no upload enqueued
  // yet). This is what lets a crash flush-then-exit actually deliver the crash bundle.
  const pendingReports = new Set<Promise<UploadResult>>();
  const track = (report: Promise<UploadResult>): Promise<UploadResult> => {
    pendingReports.add(report);
    // Settle handler on BOTH outcomes (not .finally, whose returned promise would re-raise a
    // rejection as unhandled): the report pipeline is contractually non-rejecting, but this keeps
    // `track` self-defending so a stray rejection can't surface as an unhandled rejection.
    const forget = (): void => {
      pendingReports.delete(report);
    };
    report.then((result) => {
      forget();
      // An unrecoverable auth failure (invalid app token) on any report trips the kill-state.
      if (result.ok === false && result.error?.fatal === true) {
        enterKillState(result.error);
      }
    }, forget);
    return report;
  };
  // Drain in-flight reports (each resolves post-upload) then any directly-enqueued uploads, bounded
  // by `timeout` so a hung assemble/upload can't block shutdown. Resolves true if drained in time.
  const drainPending = (timeout?: number): Promise<boolean> => {
    const drained = Promise.allSettled([...pendingReports]).then(
      () => uploadPipeline?.flush(timeout) ?? true,
    );
    if (timeout === undefined) {
      return drained;
    }
    return Promise.race([drained, sleep(timeout).then(() => false)]);
  };

  // Halt the live capture machinery (tick + capture/detection coordinators). Shared by stop() and the
  // kill-state; the caller decides whether to also drain pending uploads.
  const haltCapture = (): void => {
    scheduler.clearInterval(tickTimer);
    tickTimer = null;
    captureCoordinator.stop();
    detectionCoordinator.stop();
  };

  // Enter the permanent kill-state (invalid app token): fire onError ONCE, then halt capture/detection.
  // Idempotent. Pending uploads are not drained — further uploads on a rejected token are futile.
  const enterKillState = (error: BugseeError): void => {
    if (killed) {
      return;
    }
    killed = true;
    onError(error);
    if (launched) {
      launched = false;
      haltCapture();
    }
  };

  // Apply the report handler's `before` (mutate/veto) at report entry — before assembly. null = veto.
  const applyReportBefore = (request: ReportingRequest): ReportingRequest | null =>
    runFilter(filters.report?.before ?? null, request, onError);

  // Submit a finalized (post-before-filter) report. When a capture-recovery marker hook is present,
  // persist a pending marker (with the incident-time attributes + user identifier) BEFORE assembly, then
  // clear it on settle — by which point the durable bundle queue owns delivery, so capture recovery need
  // not re-deliver it. All marker I/O is guarded; it must never block or throw the capture path.
  const reportMarkers = options.reportMarkers;
  const submitReport = (handled: ReportingRequest): Promise<UploadResult> => {
    if (reportMarkers !== undefined) {
      try {
        reportMarkers.store.put({
          generation: reportMarkers.generation,
          request: handled,
          attributes: environment.getAllAttributes(),
          userIdentifier: environment.getUserIdentifier(),
        });
      } catch (error) {
        onError(error);
      }
    }
    const result = track(triggerPipeline?.report(handled) ?? Promise.resolve({ ok: false }));
    if (reportMarkers !== undefined) {
      const clear = (): void => {
        try {
          reportMarkers.store.remove(handled.id);
        } catch (error) {
          onError(error);
        }
      };
      result.then(clear, clear);
    }
    return result;
  };

  // The provider/extension-facing surface (§16.3) passed to providers at start().
  const context: Client = {
    operations,
    captureAggregator,
    addCaptureProvider: captureCoordinator.addProvider,
    addDetectionProvider: detectionCoordinator.addProvider,
  };

  return {
    ...context,

    registerExt: extensionRegistry.registerExt,
    ext: extensionRegistry.ext,

    // Internal DI container facade (token-typed over the generic @bugsee/service container): a contract's
    // ServiceToken carries its instance type, so register/resolve are type-checked without a magic string.
    addService<T>(service: Service<T>): void {
      services.addService(service);
    },
    getService<T>(token: ServiceToken<T>): T {
      return services.getProvider(token).getImmediate();
    },
    getServiceProvider<T>(token: ServiceToken<T>): Provider<T> {
      return services.getProvider(token);
    },

    setUserIdentifier: environment.setUserIdentifier,
    getUserIdentifier: environment.getUserIdentifier,
    clearUserIdentifier: environment.clearUserIdentifier,

    setAttribute: environment.setAttribute,
    getAttribute: environment.getAttribute,
    clearAttribute: environment.clearAttribute,
    clearAllAttributes: environment.clearAllAttributes,
    getAllAttributes: environment.getAllAttributes,

    setNetworkEventFilter(filter: NetworkEventFilter | null): void {
      filters.network = filter;
    },
    setLogEventFilter(filter: LogEventFilter | null): void {
      filters.log = filter;
    },
    setBreadcrumbFilter(filter: BreadcrumbFilter | null): void {
      filters.breadcrumb = filter;
    },
    setReportHandler(handler: ReportHandler | null): void {
      filters.report = handler;
    },

    addBreadcrumb(breadcrumb: BreadcrumbInput): void {
      if (killed) {
        return;
      }
      const timestamp = breadcrumb.timestamp ?? clock.wallNow();
      const filtered = runFilter(filters.breadcrumb, { ...breadcrumb, timestamp }, onError);
      if (filtered === null) {
        return; // dropped by the breadcrumb filter
      }
      captureAggregator.addEntry(
        new CaptureDataEntryBase('breadcrumbs', filtered.timestamp, filtered),
      );
    },

    log(message: string, level: LogLevel | LogLevelName = 'info', timestamp?: number): void {
      if (killed) {
        return;
      }
      const ts = timestamp ?? clock.wallNow();
      const entry: LogEvent = { timestamp: ts, level, source: 'logger', message };
      const filtered = runFilter(filters.log, entry, onError);
      if (filtered === null) {
        return; // dropped by the log filter
      }
      captureAggregator.addEntry(new CaptureDataEntryBase('log', filtered.timestamp, filtered));
    },

    event(name: string, params?: Record<string, unknown>): void {
      if (killed) {
        return;
      }
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
      if (killed) {
        return;
      }
      const timestamp = clock.wallNow();
      captureAggregator.addEntry(
        new CaptureDataEntryBase('traces.user', timestamp, { timestamp, name, value }),
      );
    },

    logException(error: unknown, exceptionOptions?: LogExceptionOptions): Promise<UploadResult> {
      // After stop() (§1501) or in the kill-state (§1435), logException is a silent no-op.
      if (stopped || killed) {
        return Promise.resolve({ ok: false });
      }
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
      const handled = applyReportBefore(request);
      if (handled === null) {
        return Promise.resolve({ ok: false }); // vetoed by the report handler
      }
      return submitReport(handled);
    },

    isLaunched(): boolean {
      return launched;
    },

    launch(): void {
      // A killed client (invalid app token) is permanently dead: re-launching must not re-arm it.
      if (killed || launched) {
        return;
      }
      launched = true;
      stopped = false;
      // launch() must never throw (§15.1): a throwing provider.start is isolated per coordinator
      // (a failed capture start must not prevent detection from starting) and routed to onError.
      try {
        captureCoordinator.start(launchOptions, isEnabled);
      } catch (error) {
        onError(error);
      }
      try {
        detectionCoordinator.start(context, isEnabled, (request) => {
          const handled = applyReportBefore(request);
          if (handled !== null) {
            void submitReport(handled);
          }
        });
      } catch (error) {
        onError(error);
      }
      // Drive part rotation + out-of-window cleanup while launched (Android PartManager tick).
      tickTimer = scheduler.setInterval(() => captureStore.tick(clock.wallNow()), tickIntervalMs);
    },

    stop(timeout?: number): Promise<boolean> {
      if (!launched) {
        return Promise.resolve(true);
      }
      launched = false;
      stopped = true;
      haltCapture(); // launch() always sets tickTimer first, so it is set here (stop runs only if launched)
      return drainPending(timeout);
    },

    flush(timeout?: number): Promise<boolean> {
      return drainPending(timeout);
    },
  };
}
