import {
  type EnvironmentEnvelope,
  type LogLevel,
  logLevelToWire,
  type Mechanism,
} from '@bugsee/protocol';
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
import { isThenable } from '@bugsee/util';
import { assembleBundle, type BundleAssemblyContext } from './bundle-assembler';
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
import { buildCrashJson, type FrameEnricher } from './crash';
import { checkOrSetAlreadyCaught } from './dedup';
import { createDetectionCoordinator } from './detection-coordinator';
import type { IdentifiedBundle } from './durable-upload-pipeline';
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
  type SpanFilter,
} from './filters';
import { callSiteFrames, parseV8Stack, type StackFrame } from './stack';

export type { Breadcrumb, BreadcrumbInput } from './events';

import { createExtensionRegistry } from './extension-registry';
import { createMemoryCaptureStore } from './memory-capture-store';
import { createOperationDispatcher } from './operation-dispatcher';
import { createOptionsContainer } from './options';
import { createRateLimiter, type RateLimiterOptions } from './rate-limiter';
import type { ReportMarkerStore } from './report-marker-store';
import { createReportingRequest, type ReportingRequest } from './reporting';
import { type ContextProvider, ContextProviderToken, type RequestContext } from './request-context';
import type { ServiceRegistrar, ServiceResolver } from './services';
import {
  type Bundle,
  isUploadSettled,
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

// The report description for an error: its stack, plus the `cause` chain (standard JS error chaining /
// Sentry-style LinkedErrors) — so wrapped context, e.g. the React component stack a framework adapter
// links via `error.cause`, travels with the report. Bounded depth + a seen-set guard against cycles; a
// non-Error cause ends the chain. Preserves the prior behaviour: a non-Error value, and an Error with no
// stack and no cause, both yield `undefined` (no description).
const MAX_CAUSE_DEPTH = 5;
function describeError(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const base = error.stack;
  const causes: string[] = [];
  const seen = new Set<unknown>([error]);
  let current: unknown = (error as { cause?: unknown }).cause;
  while (current instanceof Error && !seen.has(current) && causes.length < MAX_CAUSE_DEPTH) {
    seen.add(current);
    causes.push(`Caused by: ${current.stack ?? current.message}`);
    current = (current as { cause?: unknown }).cause;
  }
  if (base === undefined && causes.length === 0) return undefined;
  return [base ?? '', ...causes].filter(Boolean).join('\n');
}

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
  /**
   * Filter performance spans: mutate one, or return null to drop it. Runs for the transaction ROOT and
   * for every child; dropping the root drops the whole transaction.
   *
   * The stream that most needs it is consumed OpenTelemetry: those spans arrive with every attribute
   * intact, so `db.statement` reaches the SDK as raw SQL with literals unless something scrubs it.
   */
  setSpanFilter(filter: SpanFilter | null): void;
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
 * entries to merge into the assembled bundle (e.g. a browser DOM `viewtree`, or a node CPU `profile`).
 * Called once per live report at assembly time; may be synchronous (viewtree) OR async (a node CPU
 * profile — the inspector delivers it asynchronously), and the assembler awaits it either way.
 */
export type ReportSnapshotSource = (
  now: number,
) => readonly CaptureDataEntry[] | Promise<readonly CaptureDataEntry[]>;

export interface CreateClientOptions {
  /** Time source; injectable for tests. Default createSystemClock(). */
  clock?: Clock;
  /**
   * Runtime stack parser used to build the structured `crash.json` from a thrown Error's stack (SC3). The
   * browser tier injects its multi-engine (V8 + SpiderMonkey + JavaScriptCore) parser; V8 runtimes
   * (node/bun/deno + Chromium) get the default {@link parseV8Stack}. Absent → crash.json still builds via
   * the V8 default.
   */
  stackParser?: (stack: string) => StackFrame[];
  /**
   * Add to a crash's parsed frames before they reach the wire — the seam the node tier attaches captured
   * LOCAL VARIABLES through. Core defines it and never implements one: the inspector is node-only.
   */
  enrichFrames?: FrameEnricher;
  /**
   * Called at the public boundary of {@link BugseeClient.logException}, with the value being reported,
   * while the CALLER's frames are still on the stack.
   *
   * That instant is the whole point. A platform holding a debugger (node's opt-in local-variables
   * capture) can look at the scope the report was made FROM — the catch block and everything below it —
   * which no later hook can, because by the time the crash is built those frames have unwound. It runs
   * after every guard that could refuse the report, so a refused report never pays for a pause.
   *
   * Runtime-portable: core defines the seam and never implements one, exactly as it does for
   * {@link FrameEnricher}.
   */
  onReportSite?: (error: unknown) => void;
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
  /**
   * Per-file-type BINARY encoders, threaded into the bundle assembler (`BundleAssemblyContext.fileEncoders`)
   * — a type with an encoder serializes to bytes instead of JSON (e.g. `replay` → gzipped `replay.bin`,
   * registered by `@bugsee/replay` at launch). The SAME object is read by reference each report, so an
   * extension loaded AFTER `createClient` (replay is lazy-loaded) can add its encoder into it. Default none.
   */
  fileEncoders?: BundleAssemblyContext['fileEncoders'];
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
   * The active-request context provider (design: framework-adapters.md). When present, the capture
   * aggregator stamps each entry's payload with the active context's correlation ids (contextId + trace
   * ids), and it is registered as a container service (ContextProviderToken) for process-wide resolution.
   * Absent (default) → no stamping; behavior is byte-identical to today for non-adapter users.
   */
  contextProvider?: ContextProvider;
  /**
   * Internal error sink (§15.1). Receives provider-start failures (so launch() never throws) and
   * hub-listener / operation-observer failures. Platform tiers wire this to debug.warn. Default no-op.
   */
  onError?: (error: unknown) => void;
}

/** The global state a report is described by: snapshotted once, at submit, and read by both the
 *  recovery marker and the bundle so the two can never describe the same incident differently. */
interface ReportIdentity {
  attributes: Record<string, AttributeValue>;
  userIdentifier: string | null;
}

export function createClient(options: CreateClientOptions = {}): BugseeClient {
  const clock = options.clock ?? createSystemClock();
  const isEnabled = options.isEnabled ?? (() => true);
  const onError = options.onError ?? (() => {});
  // `onError` is the raw user callback, and the sites below call it from PROMISE callbacks where a throw
  // would surface as an unhandled rejection in the host application. Reporting a failure must never
  // become one.
  const onErrorSafe = (error: unknown): void => {
    try {
      onError(error);
    } catch {
      // a throwing sink must not defeat the guard either
    }
  };
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
  // The active-request context provider (framework adapters). When injected, the aggregator stamps each
  // entry's correlation ids and the provider is resolvable process-wide; absent → no-op.
  const contextProvider = options.contextProvider;
  if (contextProvider !== undefined) {
    services.addService(defineService(ContextProviderToken, () => contextProvider));
  }
  const captureAggregator = createCaptureAggregator(captureStore, {
    onError,
    ...(contextProvider !== undefined ? { getContext: () => contextProvider.getCurrent() } : {}),
  });
  // The request context captured at report-SUBMIT time (synchronously, while the request's async context
  // is still active), keyed by the report's request object. Read at ASSEMBLY time — which the trigger
  // pipeline runs detached/queued, after the originating async context is gone — so the report reflects
  // the request it fired in, not whatever is active when assembly happens to run. The WeakMap entry is
  // collected with the request (no manual cleanup, no leak).
  const reportContexts = new WeakMap<ReportingRequest, RequestContext>();
  // The GLOBAL attributes + user identifier as they stood at report-SUBMIT time, keyed by the report's
  // request object — the same detached-assembly problem `reportContexts` solves, for the same reason.
  // Assembly is queued behind the capture drain and any report snapshots, so reading the Environment
  // there reads whatever the app has done to it since: `logException(e)` followed by
  // `clearAllAttributes()` shipped an empty `manifest.attrs`, and the recovery marker — which has always
  // snapshotted at submit — described the same incident differently from its own live upload.
  const reportIdentity = new WeakMap<ReportingRequest, ReportIdentity>();
  const liveIdentity = (): ReportIdentity => ({
    attributes: environment.getAllAttributes(),
    userIdentifier: environment.getUserIdentifier(),
  });
  const captureExporter = createCaptureExporter(captureStore, undefined, onError);
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
  // Permanent kill-state (§1435/§1504): set when a report comes back with the collector's KILL_SDK
  // verdict (code 99099) — the app token has been switched OFF at the server. All capture goes no-op,
  // capture+detection halt, onError fires ONCE. An INVALID app token is a different thing entirely: it
  // classifies as `permanent` (drop this bundle) and leaves the client recording.
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
      // Scope the drain to the TENANT that faulted. On a multi-tenant isolate (Cloudflare Durable
      // Objects) an unscoped drain would put every other tenant's capture into this bundle — the leak
      // proven on real workerd (docs/review/cloudflare.md SEV1 #2). `owner` is undefined everywhere else,
      // where the partitioned store is a no-op and this is byte-identical to an unscoped drain.
      const reportContext = reportContexts.get(request);
      const capturedByType = await captureExporter.drain(
        reportContext?.owner !== undefined ? { owner: reportContext.owner } : undefined,
      );
      // Merge report-time snapshots (e.g. the DOM viewtree) into the drained map. Each source is
      // isolated: a throw goes to onError and the report still uploads (a missing snapshot must never
      // block delivery).
      if (options.reportSnapshots !== undefined) {
        const snapshotAt = clock.wallNow();
        for (const source of options.reportSnapshots) {
          try {
            for (const entry of await source(snapshotAt)) {
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
      const captured = reportContext;
      // Submit-time identity (see reportIdentity). Absent only on a hypothetical assembly that did not
      // come through submitReport, where reading the Environment live is the previous behaviour and a
      // strictly better degrade than shipping no attributes at all.
      const identity = reportIdentity.get(request) ?? liveIdentity();
      // Stamp the incident's id onto the bundle (NOT onto `request.json` — this never goes on the wire).
      // The durable queue writes it into its frame header, which is the only thing that later lets
      // recovery tell "this staged blob IS the incident that marker is still holding open" from "this
      // staged blob is an incident nothing has uploaded yet". See IdentifiedBundle.
      const bundle: IdentifiedBundle = {
        ...assembleBundle(request, capturedByType, {
          appToken,
          environment: getEnvironment(),
          attributes: identity.attributes,
          userIdentifier: identity.userIdentifier,
          clock,
          ...(captured !== undefined ? { requestContext: captured } : {}),
          ...(options.bundleFileName !== undefined ? { fileName: options.bundleFileName } : {}),
          ...(options.fileEncoders !== undefined ? { fileEncoders: options.fileEncoders } : {}),
        }),
        reportId: request.id,
      };
      return bundle;
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
      // Guarded, because the rejection handler beside this one covers `report` REJECTING and not this
      // handler's own throw — so reading a non-conforming result here would surface as precisely the
      // unhandled rejection the comment above says `track` exists to prevent. `uploadPipeline` and the
      // trigger pipeline are injectable seams; neither is guaranteed to answer with an `UploadResult`.
      try {
        // The collector's KILL_SDK verdict on any report trips the kill-state.
        if (result.ok === false && result.error?.fatal === true) {
          enterKillState(result.error);
        }
      } catch (error) {
        onError(error);
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

  // Enter the permanent kill-state (collector KILL_SDK): fire onError ONCE, then halt capture/detection.
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
  // retire it once the incident is genuinely accounted for. All marker I/O is guarded; it must never
  // block or throw the capture path.
  const reportMarkers = options.reportMarkers;
  const submitReport = (handled: ReportingRequest): Promise<UploadResult> => {
    // Capture the active request context NOW (submit is synchronous in the originating async context);
    // assembly runs detached/queued later, so it reads this snapshot from the WeakMap rather than a
    // by-then-stale active context. Absent contextProvider / no active context → nothing captured.
    // A custom provider whose getCurrent() throws degrades the same way — a broken binding must
    // never break reporting (the crash path is held to the same fail-safe as every other read of
    // the integrator-replaceable store; R-5).
    let captured: RequestContext | undefined;
    try {
      captured = contextProvider?.getCurrent();
    } catch {
      captured = undefined;
    }
    if (captured !== undefined) {
      reportContexts.set(handled, captured);
    }
    // Snapshot the global identity NOW, for the same reason and in the same turn as the context above.
    // The marker and the bundle read this ONE snapshot, so a recovered report and a live upload of the
    // same incident can never disagree.
    const identity = liveIdentity();
    reportIdentity.set(handled, identity);
    // Did this incident's marker reach DURABLE storage? `true` when there was nothing async to wait for
    // (a synchronous store that did not throw). It decides nothing about retirement — it decides whether
    // keeping the marker actually preserves the incident, or only looks like it does.
    let markerDurable: boolean | Promise<boolean> = true;
    if (reportMarkers !== undefined) {
      try {
        const written = reportMarkers.store.put({
          generation: reportMarkers.generation,
          request: handled,
          attributes: identity.attributes,
          userIdentifier: identity.userIdentifier,
        });
        markerDurable = isThenable(written)
          ? Promise.resolve(written).then(
              () => true,
              (error: unknown) => {
                onErrorSafe(error);
                return false;
              },
            )
          : true;
      } catch (error) {
        onError(error);
        markerDurable = false;
      }
    }
    const result = track(triggerPipeline?.report(handled) ?? Promise.resolve({ ok: false }));
    if (reportMarkers !== undefined) {
      // WHEN MAY THIS MARKER BE RETIRED?
      //
      // Retiring it is a DELETION, and the most consequential one the SDK performs on the live path: the
      // marker is the only trace of an incident whose bundle never reached durable storage, and it is
      // what holds that incident's capture generation against `recoverReports`'s sweep — so retiring it
      // early loses the report AND the recording of a crash that has already happened.
      //
      // It used to be `result.then(clear, clear)` — retire on ANY settlement, retryable failures and
      // rejections included — justified by "by which point the durable bundle queue owns delivery". The
      // durable queue does not always: it CATCHES a throwing `BundleStore.put` and attempts the upload
      // anyway (durable-upload-pipeline.ts, deliberately, so a full disk still gets the crash out), and
      // then nothing at all is staged. A read-only disk plus one 503 erased blob, marker and recording.
      //
      // So there are exactly two justifications. The first is the rule every other retirement site in the
      // SDK follows — `capture-recovery.ts:101,196` and `native-crash-recovery.ts:138` gate on
      // `isUploadSettled` ALONE and never read `retained`, which is the conservative half of this one:
      //
      //   • the upload SETTLED — delivered, or permanently refused. Nothing is left to carry forward.
      //   • the queue RETAINED the bundle — the bytes are durably staged under this incident's id, so the
      //     next launch replays them and reconciles this marker away. This is the case the old comment
      //     was describing; it is now checked instead of assumed.
      //
      // Anything else — a retryable failure with nothing staged, or a rejection, where NOTHING is known —
      // keeps the marker. That is not a leak: the next launch rebuilds the incident from it and retires it
      // on settle, which is precisely what capture recovery exists to do.
      const clear = (settled: UploadResult): void => {
        // The whole body is guarded, the predicate included. `settled` comes from an INJECTABLE pipeline
        // and so is not guaranteed to be an `UploadResult`; reading `.retained` off it outside the try
        // threw inside a `.then` whose only handler covers the upstream promise, which surfaced as an
        // unhandled rejection in the host application. Failing here also means nothing is known about
        // the upload, and the fail-safe answer to that is to KEEP the marker.
        try {
          if (!isUploadSettled(settled) && settled.retained !== true) {
            // Keeping the marker is the right answer — but it only preserves the incident if the marker
            // itself is durable. On the browser tier it shares a database with the bundle, so quota
            // exhaustion fails both together and the marker survives only in the store's in-memory
            // mirror, which dies with the page. Nothing can rescue the incident at that point; saying so
            // is the difference between a degraded install and an invisible one.
            void Promise.resolve(markerDurable).then((durable) => {
              if (!durable) {
                onErrorSafe(
                  new Error(
                    `Bugsee: incident ${handled.id} is unrecoverable — the upload did not complete, ` +
                      'nothing was durably staged, and its report marker could not be persisted.',
                  ),
                );
              }
            });
            return;
          }
          reportMarkers.store.remove(handled.id);
        } catch (error) {
          onError(error);
        }
      };
      result.then(clear, () => {});
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
    setSpanFilter(filter: SpanFilter | null): void {
      filters.span = filter;
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
      // The wire level is NUMERIC (design §8.9, mobile parity). Encoded AFTER the filter so a user's
      // `logFilter` still sees the friendly name it was written against — the same ordering the capture
      // provider uses. Wave 5.1 fixed that provider and left this path, the MANUAL API, shipping the string.
      const wire: LogEvent =
        typeof filtered.level === 'string'
          ? { ...filtered, level: logLevelToWire(filtered.level) }
          : filtered;
      captureAggregator.addEntry(new CaptureDataEntryBase('log', wire.timestamp, wire));
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

    logException: function logException(
      error: unknown,
      exceptionOptions?: LogExceptionOptions,
    ): Promise<UploadResult> {
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
      // The caller's catch block is still on the stack RIGHT HERE and nowhere after here. Isolated: a
      // platform failing to read the live scope must never cost the report it was decorating.
      try {
        options.onReportSite?.(error);
      } catch (reportSiteError) {
        onError(reportSiteError);
      }
      const message = error instanceof Error ? error.message : String(error);
      const description = describeError(error); // stack + the `cause` chain (LinkedErrors)
      // Structured crash.json (SC3): built from the Error's stack + per-frame debug-ids. handled: true —
      // logException is a programmatically-logged (caught) exception. Undefined for non-Errors.
      // A thrown non-Error has no stack of its own, and shipping `frames: []` cost grouping, not just a
      // location (see callSiteFrames). The Error is constructed HERE, inside the public boundary, which
      // is what both capture strategies depend on; `logException` is a named function expression purely
      // so it can name itself as that boundary.
      const syntheticFrames =
        error instanceof Error
          ? undefined
          : callSiteFrames(new Error(), logException, options.stackParser ?? parseV8Stack);
      const crash = buildCrashJson(error, {
        parseStack: options.stackParser,
        handled: true,
        ...(options.enrichFrames !== undefined ? { enrichFrames: options.enrichFrames } : {}),
        ...(syntheticFrames !== undefined ? { syntheticFrames } : {}),
      });
      const request = createReportingRequest({
        source: { type: 'error', mechanism: exceptionOptions?.mechanism ?? 'programmatic' },
        summary: message,
        ...(description !== undefined ? { description } : {}),
        ...(crash !== undefined ? { crash } : {}),
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
      // A killed client (collector KILL_SDK) is permanently dead: re-launching must not re-arm it.
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
      // Drive part rotation + out-of-window cleanup while launched (Android PartManager tick). Guarded: a
      // capture tick must NEVER throw out of the timer (it would surface as an uncaughtException and could
      // take down the host) — route any failure to onError instead.
      tickTimer = scheduler.setInterval(() => {
        try {
          captureStore.tick(clock.wallNow());
        } catch (error) {
          onError(error);
        }
      }, tickIntervalMs);
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
