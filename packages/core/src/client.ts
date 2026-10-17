import type { FileType } from '@bugsee/protocol';
import {
  BugseeOption,
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
import {
  encodeRequestForMarker,
  limitAttachmentsForMarker,
  normalizeReportAttachments,
  reportChangeSignature,
} from './attachments';
import { type BlackoutState, BlackoutToken, createBlackoutState } from './blackout';
import { assembleBundle, type BundleAssemblyContext } from './bundle-assembler';
import { createCaptureAggregator } from './capture-aggregator';
import { createCaptureCoordinator, type OptionGate } from './capture-coordinator';
import { CaptureDataEntryBase } from './capture-data-entry';
import { createCaptureExporter } from './capture-exporter';
import {
  type CarrierBlackoutOwner,
  claimCarrierBlackoutOwner,
  getCarrier,
  getCarrierBlackout,
  getCarrierBlackoutOwner,
  getCarrierLifecycleSlot,
  getCarrierRelaunchEpoch,
  getCarrierRelaunching,
  setCarrierBlackout,
} from './carrier';
import { type Clock, ClockToken, createSystemClock } from './clock';
import {
  type CaptureDataEntry,
  type CaptureProviderInit,
  type CaptureStore,
  CaptureStoreToken,
  type Client,
  type OptionsContainer,
} from './contracts';
import { applyExceptionOptions, buildCrashJson, type FrameEnricher } from './crash';
import { checkOrSetAlreadyCaught } from './dedup';
import { createDetectionCoordinator } from './detection-coordinator';
import type { IdentifiedBundle } from './durable-upload-pipeline';
import { createEnvironment } from './environment';
import { BugseeError } from './errors';
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
import { neverThrow } from './never-throw';
import { createNotifyRelay } from './notify-relay';
import { callSiteFrames, parseV8Stack, type StackFrame } from './stack';

export type { Breadcrumb, BreadcrumbInput } from './events';

import { createExtensionRegistry } from './extension-registry';
import { BugseeStatus } from './launch-status';
import {
  createLifecycleEmitter,
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
} from './lifecycle-events';
import { isLogLevelEnabled, parseLogLevelName } from './log-level';
import { createMemoryCaptureStore } from './memory-capture-store';
import { createOperationDispatcher } from './operation-dispatcher';
import { createOptionsContainer } from './options';
import { createRateLimiter, type RateLimiterOptions } from './rate-limiter';
import type { ReportMarkerStore } from './report-marker-store';
import {
  createReportingRequest,
  hasDefaultSeverity,
  parseSeverityName,
  type ReportAttachmentInput,
  type ReportingRequest,
} from './reporting';
import { type ContextProvider, ContextProviderToken, type RequestContext } from './request-context';
import type { ServiceRegistrar, ServiceResolver } from './services';
import {
  type Bundle,
  isUploadSettled,
  type NotifyItem,
  type NotifyResult,
  type UploadPipeline,
  UploadPipelineToken,
  type UploadResult,
} from './transport';
import { createTriggerPipeline, type TriggerPipeline } from './trigger-pipeline';

// The Client facade — the runtime-agnostic composition root that wires the kernel
// together: registration seams, identity/attribute delegation to the single global
// Environment, manual capture entry points, lifecycle (launch/stop/flush), and the
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

// The scheduler's typed identity in the internal container; the client registers the
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
  /** Issue severity (default derived from the error issue type). */
  severity?: SeverityName;
  /** Extra labels for the issue. */
  labels?: string[];
  /**
   * Exception domain (Android `ExceptionOptions.Domain`, iOS `exceptionDomain`): a short category such as
   * `checkout` that categorises the error. Sent as `crash.json` `exception.domain`; JavaScript reports are not
   * grouped by it yet. A non-string or empty value is ignored and reported through `onError`.
   */
  domain?: string;
  /**
   * Number of top stack frames to leave out of issue grouping (Android `ExceptionOptions.SkipFrames`, iOS
   * `mergingRules[skipFrames]`). Hides the top N frames of the reported value's OWN stack. Use it when the
   * Error is created, or a non-Error is logged, inside a helper, so errors do not group at that helper. A
   * caught Error's stack does not contain your `logException` call, so skipping frames there hides where it
   * was thrown. The frames stay visible in the trace. Must be a non-negative integer; anything else is
   * ignored and reported through `onError`.
   */
  skipFrames?: number;
}

/**
 * {@link LogExceptionOptions} plus the wire `source.mechanism`. SDK-internal: the mobile SDKs expose no
 * such option, so the public `BugseeClient` does not accept it. Adapters and platform packages reach it
 * through {@link asInternalClient}.
 * @internal
 */
export interface InternalLogExceptionOptions extends LogExceptionOptions {
  /** Capture mechanism for the wire source (default 'programmatic'). */
  mechanism?: Mechanism;
  /**
   * The function whose caller is the application, when it is NOT the method the crash is built in: the
   * public `logException` wrapper supplies itself here so a non-Error throwable's synthetic stack starts
   * at the app's call site and `skipFrames` counts from there. The wrapper always overwrites it.
   * `sdkFrames` is the frames above the application when `Error.captureStackTrace` is unavailable.
   */
  callSite?: { boundary: (...args: never[]) => unknown; sdkFrames: number };
}

/**
 * Options for {@link BugseeClient.upload} — a report the application (or the report dialog) asks for
 * explicitly, as opposed to one the SDK detects. Mirrors Android's `Bugsee.upload` /
 * `showReportDialog` field set.
 */
export interface UploadOptions {
  summary?: string;
  description?: string;
  /** Default `high`, as on mobile. */
  severity?: SeverityName;
  labels?: string[];
  /** Reporter email; when absent the global user identifier is used, as for any report. */
  email?: string;
  /** Files to attach (3 of 3 MB each at most; over-limit ones are dropped and reported via `onError`). */
  attachments?: ReportAttachmentInput[];
}

/**
 * {@link UploadOptions} plus the wire `source.type`. SDK-internal: the mobile SDKs expose no such option.
 * @internal
 */
export interface InternalUploadOptions extends UploadOptions {
  /**
   * Who asked: `code_upload` (the default — the app called `upload()` directly) or `code_dialog` (the
   * user filled in the report dialog). It is the report's `source.type` on the wire, which the viewer
   * shows and filters on.
   */
  trigger?: 'code_upload' | 'code_dialog';
}

/**
 * A report prepared ahead of time (Android: the report is built BEFORE the dialog is shown). The capture
 * is frozen at the moment of preparation, so what the user does while filling in a form never pushes the
 * incident out of the rolling buffer or into the report.
 */
export interface PreparedUpload {
  /** Send the report, carrying the capture as it was when prepared. At most once; `{ ok: false }` after. */
  send(options?: UploadOptions): Promise<UploadResult>;
  /** Release the frozen capture without sending anything. */
  discard(): void;
}

/** {@link PreparedUpload} whose `send` also accepts the internal `trigger`. @internal */
export interface InternalPreparedUpload extends PreparedUpload {
  send(options?: InternalUploadOptions): Promise<UploadResult>;
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

  // Redaction filters: each runs per captured event to mutate it or DROP it (return
  // null). A network filter REPLACES the built-in sanitizer. Pass null to clear. Settable any time.
  /**
   * Filter captured network events: mutate one, or return null to drop it.
   *
   * **A network filter REPLACES the built-in sanitizer — it does not layer on top of it.** Once a filter is
   * set, nothing is redacted unless the filter does it: URLs, headers, bodies and error text are captured
   * as-is. To keep the default redaction and add rules of your own, call the default sanitizer from inside
   * the filter:
   *
   * ```ts
   * import { getDefaultNetworkSanitizer } from '@bugsee/bugsee';
   * const defaults = getDefaultNetworkSanitizer(); // { sanitize, sanitizeUrl, sanitizeErrorMessage }
   * client.setNetworkEventFilter((event) =>
   *   event.url.includes('/health') ? null : defaults.sanitize(event),
   * );
   * ```
   *
   * The filter runs once per stage (`before`, `complete`, `error`, …) of a request, so a veto must be
   * returned for every stage of the requests you want gone.
   */
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
  /**
   * `before` mutates/vetoes (return null) the report before assembly. `after` (Android
   * `onAfterReportCreated`) runs next, once the report exists and BEFORE the bundle is built or uploaded,
   * and may still mutate the request (labels, attributes, attachments). It is not called when no report
   * was created: a veto, no upload pipeline, or a report the queue refused. How the upload ended is
   * observable through the lifecycle events (`AfterReportUploaded`, `ReportUploadFailed`, ...). A throwing
   * handler is routed to `onError` and never breaks reporting.
   */
  setReportHandler(handler: ReportHandler | null): void;

  /**
   * Observe SDK lifecycle milestones (Android `setLifecycleEventsListener`). One listener at a time;
   * `null` clears it. See {@link LifecycleEvents} for the event names. A throwing listener is routed to
   * `onError` and never affects the SDK.
   *
   * The listener is PROCESS-level (Android keeps one static listener): it survives `relaunch()`, and the
   * `lifecycleEventsListener` launch option installs it before launch so Launching and Launched are
   * observable. Events are delivered after the SDK state has changed, and an event caused from inside a
   * listener (calling `launch()`, `stop()`, `startBlackout()`...) is queued until the listener returns.
   */
  setLifecycleEventsListener(listener: LifecycleEventsListener | null): void;

  // Manual capture entry points (Android parity). Each pushes a CaptureDataEntry.
  addBreadcrumb(breadcrumb: BreadcrumbInput): void;
  log(message: string, level?: LogLevel | LogLevelName, timestamp?: number): void;
  event(name: string, params?: Record<string, unknown>): void;
  trace(name: string, value: unknown): void;

  /** Capture an exception (instance-deduped + rate-limited) and trigger a report. */
  logException(error: unknown, options?: LogExceptionOptions): Promise<UploadResult>;

  /**
   * Relay a message to the app's configured messaging integrations (Slack, webhooks, ...) — mobile
   * `Bugsee.notify`. It skips the bug-report pipeline: no video, logs or events, just the message.
   *
   * Notifications are queued, sent in batches (window: the `notifyFlushDelay` launch option, default 0 =
   * the end of the current tick) and retried with backoff. `urgent` sends this one at once, ahead of
   * the window. An empty `title`, a call before `launch()` or after `stop()`, and a SDK killed by the
   * collector are silent no-ops. `fields` keeps only string values. `flush()`/`stop()` deliver what is
   * pending. Unlike mobile the queue is in memory: a page closed with an unsent message loses it.
   */
  notify(
    title: string,
    body?: string,
    severity?: SeverityName,
    fields?: Record<string, string>,
    urgent?: boolean,
  ): void;

  /**
   * Send a report on request (Android `Bugsee.upload`). Unlike {@link logException} it is neither
   * instance-deduped nor rate-limited — every call is something a person or the app explicitly wanted
   * — but it still runs the report handler (`before` may mutate or veto it). A silent no-op
   * (`{ ok: false }`) after `stop()` or once the SDK has been killed.
   */
  upload(options?: UploadOptions): Promise<UploadResult>;

  /**
   * Freeze the capture NOW and return a handle that sends it later (the report dialog uses this, as the
   * mobile SDKs do). `null` after `stop()` or once the SDK has been killed.
   */
  prepareUpload(): PreparedUpload | null;

  // Blackout (mobile `startBlackout`/`endBlackout`/`isBlackout`).
  /**
   * Suppress ALL visual / interaction capture (session replay, input presses, `ui.*` interaction
   * breadcrumbs, the report-time view hierarchy) until {@link endBlackout}. Logs, network, traces and
   * events continue (so do request/response bodies, navigation URLs and `video.aux` geometry). Idempotent and NOT counted: one `endBlackout()` ends any
   * number of calls, as on mobile.
   *
   * A NO-OP while the client is not launched (before it is launched, after `stop()`, or once the SDK has been
   * killed): there is nothing to suppress yet, and the call is not remembered. To be dark from the very first
   * frame use the `startInBlackout` launch option (browser) instead of calling this right after `launch()`.
   */
  startBlackout(): void;
  /**
   * End a blackout; visual capture resumes (replay with a fresh full snapshot). No-op when not active.
   *
   * PRIVACY: the replay snapshot is taken from the LIVE page at this moment, so if the sensitive view is
   * still on screen it contains whatever it holds then, including values typed during the blackout when
   * `maskAllInputs` is false. Call `endBlackout()` only AFTER the sensitive view is gone.
   */
  endBlackout(): void;
  /** Whether a blackout is currently in force. */
  isBlackout(): boolean;

  // Lifecycle.
  /** Start capture + detection. Idempotent — a second call while launched is ignored. */
  launch(): void;
  isLaunched(): boolean;
  /** The lifecycle state (Stopped / Launching / Launched / Stopping). `Stopping` lasts until the drain settles. */
  getStatus(): BugseeStatus;
  /** The effective launch options (host-supplied over defaults), by canonical `com.bugsee.option.*` key. */
  getLaunchOptions(): Record<string, unknown>;
  /** Only the options the host supplied at launch, by canonical key. */
  getHostLaunchOptions(): Record<string, unknown>;
  /** Stop capture + detection and drain pending uploads. Resolves true if drained within `timeout`. */
  stop(timeout?: number): Promise<boolean>;
  /** Drain pending uploads. Resolves true if drained within `timeout`. */
  flush(timeout?: number): Promise<boolean>;
}

/**
 * The client as the SDK's own packages see it: the public {@link BugseeClient} plus the wire-level
 * options (`mechanism`, `trigger`) the public surface deliberately omits. A subtype, so it is assignable
 * to `BugseeClient`; the reverse needs {@link asInternalClient}.
 * @internal
 */
export interface InternalBugseeClient extends BugseeClient {
  logException(error: unknown, options?: InternalLogExceptionOptions): Promise<UploadResult>;
  upload(options?: InternalUploadOptions): Promise<UploadResult>;
  prepareUpload(): InternalPreparedUpload | null;
  /**
   * Emit a lifecycle event from a platform tier that owns the milestone (the browser report dialog
   * emits BeforeReportShown / AfterReportShown through this). Never throws. Internal: on the PUBLIC
   * surface an application could fake SDK events.
   */
  emitLifecycleEvent(eventType: LifecycleEventType, data?: unknown): void;
  /**
   * A blackout raised SILENTLY before `launch()` (`startInBlackout`) owes the application one BlackoutStarted: owe
   * it. It is announced after Launching/Launched when the client is still launched and still dark, and BEFORE
   * the BlackoutEnded of a Launching listener that lifts the blackout at once, so Started always precedes Ended
   * Without this call a silent hold never announces itself.
   */
  deferBlackoutStarted(): void;
}

/**
 * What `createClient` returns: the internal client WITHOUT `emitLifecycleEvent`, which exists only behind
 * {@link asInternalClient} so application code cannot fake SDK events.
 * @internal
 */
export type CreatedClient = Omit<
  InternalBugseeClient,
  'emitLifecycleEvent' | 'deferBlackoutStarted'
>;

/**
 * View a public client through its internal surface. Returns a COPY of the client carrying the unstripped
 * wire-level `logException` / `upload` / `prepareUpload` (the public methods strip `trigger` / `mechanism`
 * at runtime), so it is NOT the same object as `client` and a wrapper that replaces public methods on the
 * client does not affect it. A client without the brand (a test double) is cast as is. This is an SDK-internal
 * seam, not a security boundary: code that can import `@bugsee/core` can call it.
 * @internal
 */
export function asInternalClient(client: BugseeClient): InternalBugseeClient {
  const internal = (client as { [INTERNAL_METHODS]?: InternalMethods })[INTERNAL_METHODS];
  // A client without the brand was not made by `createClient` (a test double): nothing to unwrap.
  return internal === undefined ? (client as InternalBugseeClient) : { ...client, ...internal };
}

// The wire-level methods of a client, kept under a symbol so the PUBLIC `upload` / `logException` /
// `prepareUpload` can strip `trigger` / `mechanism` at RUNTIME (types alone do not stop plain JavaScript from
// forging `code_dialog`). `Symbol.for`, so two copies of this module (the ESM and CJS builds) agree on it;
// an enumerable own property, so a platform wrapper that spreads the client carries it along.
const INTERNAL_METHODS = Symbol.for('com.bugsee.internal-client');
type InternalMethods = Pick<
  InternalBugseeClient,
  'logException' | 'upload' | 'prepareUpload' | 'emitLifecycleEvent' | 'deferBlackoutStarted'
>;

/** A copy of `options` without `keys`; anything that is not an object (null, a string) counts as none. */
function withoutWireOptions<T>(options: T, ...keys: string[]): T | undefined {
  if (typeof options !== 'object' || options === null) {
    return undefined;
  }
  const copy = { ...options } as Record<string, unknown>;
  for (const key of keys) {
    delete copy[key];
  }
  return copy as T;
}

/** The public face of a freshly built client: the same methods, minus the wire-level options. */
function exposePublicSurface(client: InternalBugseeClient): CreatedClient {
  const internal: InternalMethods = {
    logException: client.logException,
    upload: client.upload,
    prepareUpload: client.prepareUpload,
    emitLifecycleEvent: client.emitLifecycleEvent,
    deferBlackoutStarted: client.deferBlackoutStarted,
  };
  const {
    emitLifecycleEvent: _internalOnly,
    deferBlackoutStarted: _alsoInternalOnly,
    ...publicMethods
  } = client;
  return {
    ...publicMethods,
    logException: function logException(error, options) {
      // The wrapper is itself an SDK frame: it names itself as the boundary so the application, not
      // `Object.logException`, is frame 0 of a non-Error's synthetic stack.
      // NOT a tail call: JavaScriptCore drops the frame of a function that tail-calls, which would make
      // `sdkFrames: 2` remove the application frame in the fallback path.
      const result = internal.logException(error, {
        ...withoutWireOptions(options, 'mechanism'),
        callSite: { boundary: logException, sdkFrames: 2 },
      });
      return result;
    },
    upload: (options) => internal.upload(withoutWireOptions(options, 'trigger')),
    prepareUpload: () => {
      const prepared = internal.prepareUpload();
      return prepared === null
        ? null
        : {
            send: (options) => prepared.send(withoutWireOptions(options, 'trigger')),
            discard: () => prepared.discard(),
          };
    },
    [INTERNAL_METHODS]: internal,
  } as CreatedClient;
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
   * Runtime stack parser used to build the structured `crash.json` from a thrown Error's stack. The
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
  /**
   * Delivers a `notify()` batch (the platform wires this to `BugseeApi.notify`). Without it `notify()` is
   * a silent no-op, as on a build that has no collector transport.
   */
  notifySender?: (items: readonly NotifyItem[]) => Promise<NotifyResult>;
  /** Capture storage backend (disk/IndexedDB on platform tiers). Default in-memory. */
  captureStore?: CaptureStore;
  /** The internal service container (the per-process DI registry). Default a fresh one. */
  services?: ServiceContainer;
  /** Recording window in seconds for the default in-memory store (maxRecordingTime). Default 60. */
  maxRecordingTime?: number;
  /** Scheduler for the capture-store tick; injectable for tests/edge. Default global timers. */
  scheduler?: Scheduler;
  /** Capture-store tick interval in ms (part rotation + cleanup) while launched. Default 1000. */
  tickIntervalMs?: number;
  /** Which capture/detection options are enabled (gates the coordinators). Default: all enabled. */
  isEnabled?: OptionGate;
  /** Launch options passed to each provider's start(options) for per-launch reconfiguration. */
  launchOptions?: OptionsContainer;
  /**
   * The introspectable form of the launch options for `getLaunchOptions()` / `getHostLaunchOptions()`
   * (canonical keys). Never put secrets in here — the platform passes only registered option definitions.
   */
  launchOptionsView?: {
    effective: Readonly<Record<string, unknown>>;
    host: Readonly<Record<string, unknown>>;
  };
  /** Capture-storm rate limit. Default 100 / 60s. */
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
   * The active-request context provider. When present, the capture
   * aggregator stamps each entry's payload with the active context's correlation ids (contextId + trace
   * ids), and it is registered as a container service (ContextProviderToken) for process-wide resolution.
   * Absent (default) → no stamping; behavior is byte-identical to today for non-adapter users.
   */
  contextProvider?: ContextProvider;
  /**
   * The process carrier host (default none). When given, PROCESS-level state lives on it, so it outlives a
   * single client and `relaunch()` (which builds a new client) keeps it: the lifecycle listener and
   * the blackout state. Without it both stay private to this client.
   */
  carrier?: object;
  /**
   * The host's lifecycle listener (the `lifecycleEventsListener` launch option), installed at creation —
   * before `launch()` can emit Launching — so the application observes the whole launch. Same as calling
   * `setLifecycleEventsListener` first; on a carrier it applies to every later client too.
   */
  lifecycleEventsListener?: LifecycleEventsListener;
  /**
   * Whether `launch()` may start this client again after `stop()`. Default `true` (the bare kernel). The
   * platform composition roots pass `false`: their `stop()` tears down what the platform armed (exit and
   * signal handlers, heartbeat, server instrumentation, page-hide flush, the carrier slot), and a bare core
   * restart would bring capture back WITHOUT any of it (a live instance judged dead, two clients per
   * process). A refused `launch()` reports through `onError` and changes nothing; build a new client with the
   * platform's `launch(appToken)` / `relaunch()` instead.
   */
  restartable?: boolean;
  /**
   * Internal error sink. Receives provider-start failures (so launch() never throws) and
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

export function createClient(options: CreateClientOptions = {}): CreatedClient {
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
  // The internal service container (the "BugseeInternal" — the per-process DI registry). It starts out
  // empty; the hand-wired seams migrate into it as registered services.
  const services = options.services ?? createServiceContainer();
  // Redaction filters: the first real service. The facade's set* mutate this store; the
  // capture pipeline reads the same instance via the container (getFilters). Registered eagerly so a
  // pipeline resolve always finds it once a client exists.
  const filters = createFilterStore(onError);
  const processCarrier = options.carrier;
  const lifecycle = createLifecycleEmitter(
    onError,
    processCarrier !== undefined ? getCarrierLifecycleSlot(processCarrier) : undefined,
  );
  // Own property only: a page that plants `lifecycleEventsListener` on `Object.prototype` must not be handed
  // the lifecycle stream through an options bag that simply omits it.
  if (
    Object.hasOwn(options, 'lifecycleEventsListener') &&
    options.lifecycleEventsListener !== undefined
  ) {
    lifecycle.set(options.lifecycleEventsListener);
  }
  // Requests whose bundle was assembled: only these have an upload to report on (a vetoed report, a
  // failed assembly or an injected trigger pipeline that never assembles must not emit upload events).
  const assembledReports = new WeakSet<ReportingRequest>();
  services.addService(defineService(FiltersToken, () => filters));
  const rateLimiter = createRateLimiter(clock, options.captureRateLimit);
  const environment = createEnvironment();
  const operations = createOperationDispatcher(onError);
  // One store, two directions: the aggregator writes (serialize + route), the exporter reads
  // (drain + deserialize) at trigger time. The default in-memory store shares the Client's clock and
  // recording window so entries and the time-based retention agree on "now".
  const captureStore =
    options.captureStore ??
    createMemoryCaptureStore({
      clock,
      maxRecordingTimeMs: (options.maxRecordingTime ?? 60) * 1000,
    });
  // The resolved store (platform override or default) is a container service — resolvable process-wide
  // via getService(CaptureStoreToken), alongside transport/filters (DI).
  services.addService(defineService(CaptureStoreToken, () => captureStore));
  services.addService(defineService(ClockToken, () => clock));
  // The blackout state: visual providers read it (and subscribe to its changes) via the container, so the
  // kernel never has to know which of them are visual. `client.getService(BlackoutToken).onChange` is the
  // internal subscription the lifecycle events (BlackoutStarted/Ended) hang off.
  // The state is process-level when a carrier is given: a relaunch builds a NEW client and must not
  // silently end a blackout the application asked for. It starts in the carried state, silently.
  const blackout: BlackoutState = createBlackoutState(
    onErrorSafe,
    processCarrier !== undefined && getCarrierBlackout(processCarrier),
  );
  services.addService(defineService(BlackoutToken, () => blackout));
  // Who may change the PROCESS-wide blackout: the newest client created or launched on the carrier. An
  // older handle (stopped, or replaced by a relaunch) would otherwise clear the flag under the live client,
  // so the next relaunch would start un-dark. A client without a carrier is its own owner.
  const blackoutOwner: CarrierBlackoutOwner = {
    start: () => {
      if (launched) {
        blackout.start();
      }
    },
    isLaunched: () => launched,
  };
  const ownsBlackout = (): boolean => {
    if (processCarrier === undefined) {
      return true;
    }
    const owner = getCarrierBlackoutOwner(processCarrier);
    return owner === undefined || owner === blackoutOwner;
  };
  if (processCarrier !== undefined) {
    claimCarrierBlackoutOwner(blackoutOwner, processCarrier);
  }
  let blackoutStartedOwed = false; // see InternalBugseeClient.deferBlackoutStarted
  blackout.onChange((active) => {
    if (processCarrier !== undefined && ownsBlackout()) {
      setCarrierBlackout(active, processCarrier);
    }
    // A silent change (a launch hold, a handshake release) is bookkeeping the application never asked for, and
    // a blackout can only be ENDED while the client is not launched: that clears the carried state
    // quietly, since nothing is being captured for the events to describe.
    if (launched && !blackout.isChangeSilent()) {
      if (blackoutStartedOwed) {
        // The owed announcement is ahead of whatever the application did to the blackout since: an Ended
        // must never be heard for a blackout whose Started was not.
        blackoutStartedOwed = false;
        if (!active) {
          lifecycle.emit(LifecycleEvents.BlackoutStarted);
        }
      }
      lifecycle.emit(active ? LifecycleEvents.BlackoutStarted : LifecycleEvents.BlackoutEnded);
    }
  });
  // The active-request context provider. When injected, the aggregator stamps each
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
  // The handler's `after` as it stood at submit: the handler that ran `before` is the one that runs `after`,
  // even if the app replaces it while the report waits for assembly.
  const reportAfter = new WeakMap<ReportingRequest, NonNullable<ReportHandler['after']>>();
  const liveIdentity = (): ReportIdentity => ({
    attributes: environment.getAllAttributes(),
    userIdentifier: environment.getUserIdentifier(),
  });
  const captureExporter = createCaptureExporter(captureStore, undefined, onError);
  // The capture-pipeline deps every provider gets once at registration (Android
  // BugseeCaptureDataProviderInit) — the data-plane subset of the Client, minus its registration seams.
  const captureProviderInit: CaptureProviderInit = { operations, captureAggregator };
  const captureCoordinator = createCaptureCoordinator(captureProviderInit, onError);
  const launchOptions = options.launchOptions ?? createOptionsContainer();
  // Launch options that arrive as untrusted strings are normalised once, here, with a warning: a typo
  // ('urgent', 'warn') must not leave a report with no severity or silently change what is captured.
  const logsLevelOption = launchOptions.get<unknown>(BugseeOption.CaptureLogsLevel, 'verbose');
  const logsLevel = parseLogLevelName(logsLevelOption) ?? 'verbose';
  if (parseLogLevelName(logsLevelOption) === undefined) {
    onError(
      new Error(
        `captureLogsLevel must be one of error | warning | info | debug | verbose (got ${String(logsLevelOption)}); using verbose`,
      ),
    );
  }
  const resolvePriority = (
    key: string,
    friendly: string,
    fallback: 'blocker' | 'high',
  ): SeverityName => {
    const configured = launchOptions.get<unknown>(key, fallback);
    const parsed = parseSeverityName(configured);
    if (parsed === undefined) {
      onError(
        new Error(
          `${friendly} must be one of verylow | low | medium | high | critical | blocker (got ${String(configured)}); using ${fallback}`,
        ),
      );
    }
    return parsed ?? fallback;
  };
  const crashPriority = resolvePriority(
    BugseeOption.ReportingDefaultCrashPriority,
    'reportDefaultCrashPriority',
    'blocker',
  );
  const errorPriority = resolvePriority(
    BugseeOption.ReportingDefaultErrorPriority,
    'reportDefaultErrorPriority',
    'high',
  );
  // Android applies `ReportingDefaultBugPriority` to every bug report (an upload, a shake, the report
  // dialog), so it is applied here for every platform, not only the browser dialog.
  const bugPriority = resolvePriority(
    BugseeOption.ReportingDefaultBugPriority,
    'reportDefaultBugPriority',
    'high',
  );
  const detectionCoordinator = createDetectionCoordinator(onError);
  const extensionRegistry = createExtensionRegistry();
  const scheduler = options.scheduler ?? defaultScheduler;
  services.addService(defineService(SchedulerToken, () => scheduler));
  const tickIntervalMs = options.tickIntervalMs ?? 1000;
  let launched = false;
  // True once stop() has run (until a re-launch): manual captures that upload become no-ops.
  // Distinct from `!launched` so capturing BEFORE the first launch is unaffected.
  let stopped = false;
  // True from stop() until its upload drain settles (BugseeStatus.Stopping).
  let stopping = false;
  // True from launch() until providers are started (BugseeStatus.Launching).
  let launching = false;
  // Bumped by every launch(), stop() and kill: a drain that finishes after a newer transition is STALE and
  // must not emit Stopped, suspend the notify relay or clear `stopping` for the launch that replaced it.
  let generation = 0;
  // Permanent kill-state: set when a report comes back with the collector's KILL_SDK
  // verdict (code 99099) — the app token has been switched OFF at the server. All capture goes no-op,
  // capture+detection halt, onError fires ONCE. An INVALID app token is a different thing entirely: it
  // classifies as `permanent` (drop this bundle) and leaves the client recording.
  let killed = false;
  let tickTimer: unknown = null;
  // Captures frozen by `prepareUpload`, keyed by the request they will be sent with (see assemble).
  const frozenCaptures = new WeakMap<
    ReportingRequest,
    Promise<Map<FileType, CaptureDataEntry[]>>
  >();
  let collectCapture: (owner?: string) => Promise<Map<FileType, CaptureDataEntry[]>> = async () =>
    new Map();

  // Build the trigger pipeline from the report assembler when its inputs are present (unless an
  // override is injected). assemble reads the exporter drain + the live environment/attributes.
  const { uploadPipeline, appToken, getEnvironment } = options;
  // `notify()`. The window is read once: a non-number, negative or non-finite value is treated as the
  // default 0 rather than reported, because a typo here only changes batching, never what is sent.
  const notifyDelayOption = launchOptions.get<unknown>(BugseeOption.NotifyFlushDelay, 0);
  const notifyFlushDelayMs =
    typeof notifyDelayOption === 'number' &&
    Number.isFinite(notifyDelayOption) &&
    notifyDelayOption > 0
      ? Math.floor(notifyDelayOption)
      : 0;
  const notifyRelay =
    options.notifySender === undefined
      ? undefined
      : createNotifyRelay({
          send: options.notifySender,
          clock,
          flushDelayMs: notifyFlushDelayMs,
          onError: onErrorSafe,
          // A batch still in a request when relaunch() took the queue, failing later.
          onHandBack: (items) => handBackNotify(items),
          // The relay's own `403 KillSdk` verdict switches the SDK off exactly like a report's.
          onKill: () =>
            enterKillState(
              new BugseeError('Notification relay: the SDK has been disabled by the server', 403, {
                fatal: true,
              }),
            ),
          snapshot: () => {
            let builtEnvironment: EnvironmentEnvelope | undefined;
            try {
              builtEnvironment = getEnvironment?.();
            } catch (error) {
              onError(error); // the message still goes out, without the device block
            }
            return {
              userIdentifier: environment.getUserIdentifier(),
              attributes: environment.getAllAttributes(),
              ...(builtEnvironment !== undefined ? { environment: builtEnvironment } : {}),
            };
          },
        });
  // The platform's assembled upload orchestrator, when present, is also a container service (DI).
  if (uploadPipeline !== undefined) {
    services.addService(defineService(UploadPipelineToken, () => uploadPipeline));
  }
  // relaunch() hands what the old client could not deliver (an offline notify() queue) to the client it builds
  // The decision is taken when stop() is CALLED (`getCarrierRelaunching` is true only for the stop that
  // relaunch() itself issues), never when the drain finishes: a slow old stop can settle after the new client
  // is up. Where the items go, in order: the client that has already adopted (it registered as the carrier's
  // adopter), else the carrier backlog its launch() will drain. A plain stop() keeps nothing on the carrier,
  // which sits on `globalThis` and would otherwise hold user-identifying notifications for a process that never
  // relaunches.
  const notifyOwner = {};
  /** The carrier's failed-relaunch counter when the handing-over stop() was issued. */
  let handoverEpoch = 0;
  const handBackNotify = (items: NotifyItem[]): void => {
    if (processCarrier === undefined || items.length === 0) {
      return;
    }
    if (getCarrierRelaunchEpoch(processCarrier) !== handoverEpoch) {
      // The relaunch attempt this hand-over belonged to failed: nobody will adopt these.
      onErrorSafe(
        new Error(
          `notify: dropped ${items.length} notification(s); the relaunch they were handed to failed`,
        ),
      );
      return;
    }
    const carrier = getCarrier(processCarrier);
    const adopter = carrier.notifyAdopter;
    if (adopter !== undefined && adopter.owner !== notifyOwner) {
      adopter.adopt(items);
    } else {
      carrier.notifyBacklog = [...(carrier.notifyBacklog ?? []), ...items];
    }
  };
  const stashNotifyBacklog = (): void => {
    if (notifyRelay !== undefined) {
      handBackNotify(notifyRelay.take());
    }
  };
  const adoptNotifyBacklog = (): void => {
    if (processCarrier === undefined || notifyRelay === undefined) {
      return;
    }
    const carrier = getCarrier(processCarrier);
    carrier.notifyAdopter = { owner: notifyOwner, adopt: (items) => notifyRelay.adopt(items) };
    if (carrier.notifyBacklog !== undefined) {
      const backlog = carrier.notifyBacklog;
      carrier.notifyBacklog = undefined;
      notifyRelay.adopt(backlog);
    }
  };
  let triggerPipeline = options.triggerPipeline;
  if (triggerPipeline === undefined && uploadPipeline && appToken !== undefined && getEnvironment) {
    // The captured data for a report: the exporter's drain plus the report-time snapshot sources (e.g. the
    // DOM viewtree). Used LIVE at assembly, and EARLY by `prepareUpload` so the dialog's report is the
    // moment it was opened, not the moment Send was pressed.
    //
    // Scope the drain to the TENANT that faulted. On a multi-tenant isolate (Cloudflare Durable Objects)
    // an unscoped drain would put every other tenant's capture into this bundle — the leak proven on real
    // workerd. `owner` is undefined everywhere else, where the
    // partitioned store is a no-op and this is byte-identical to an unscoped drain.
    collectCapture = async (owner?: string): Promise<Map<FileType, CaptureDataEntry[]>> => {
      const capturedByType = await captureExporter.drain(
        owner !== undefined ? { owner } : undefined,
      );
      // Merge report-time snapshots into the drained map. Each source is isolated: a throw goes to
      // onError and the report still uploads (a missing snapshot must never block delivery).
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
      return capturedByType;
    };
    const assemble = async (request: ReportingRequest): Promise<Bundle> => {
      lifecycle.emit(LifecycleEvents.BeforeReportAssembled, { reportId: request.id });
      let bundle: Bundle;
      try {
        bundle = await assembleReport(request);
      } catch (error) {
        lifecycle.emit(LifecycleEvents.ReportAssemblyFailed, { reportId: request.id, error });
        throw error;
      }
      assembledReports.add(request);
      lifecycle.emit(LifecycleEvents.AfterReportAssembled, { reportId: request.id });
      // The assembled bundle goes straight to the upload pipeline from here.
      lifecycle.emit(LifecycleEvents.BeforeReportUploaded, { reportId: request.id });
      return bundle;
    };
    const assembleReport = async (request: ReportingRequest): Promise<Bundle> => {
      // Scope the drain to the TENANT that faulted. On a multi-tenant isolate (Cloudflare Durable
      // Objects) an unscoped drain would put every other tenant's capture into this bundle — the leak
      // proven on real workerd. `owner` is undefined everywhere else,
      // where the partitioned store is a no-op and this is byte-identical to an unscoped drain.
      const reportContext = reportContexts.get(request);
      // A prepared upload carries the capture it froze; anything else drains live. A frozen capture that
      // could not be read falls back to the live one — a stale-but-present report beats none.
      const frozen = frozenCaptures.get(request);
      const capturedByType =
        (frozen !== undefined ? await frozen.catch(() => undefined) : undefined) ??
        (await collectCapture(reportContext?.owner));
      // ReportHandler.after (Android `onAfterReportCreated`): the report exists and `before` has had its say;
      // assembly has not started. The handler may still mutate the request (labels, attributes,
      // attachments) and the bundle below carries the result. Reaching here is what "created" means, so a
      // veto, a missing pipeline, a queue overflow and a failed capture drain never call it.
      const afterHandler = reportAfter.get(request) ?? filters.report?.after;
      const beforeAfter =
        afterHandler !== undefined ? reportChangeSignature(request.report) : undefined;
      neverThrow(() => afterHandler?.(request), onErrorSafe);
      const captured = reportContext;
      // Submit-time identity (see reportIdentity). Absent only on a hypothetical assembly that did not
      // come through submitReport, where reading the Environment live is the previous behaviour and a
      // strictly better degrade than shipping no attributes at all.
      const identity = reportIdentity.get(request) ?? liveIdentity();
      // What `after` just changed is part of the report, so it belongs in the recovery marker too.
      // The marker is written at SUBMIT, before assembly - the crash-safety point - and `after` runs at
      // assembly, so it is REPLACED here (same id) rather than the handler being run earlier, which would
      // change when `after` fires for a refused or failed report. The remaining difference is a crash in the
      // window between submit and this point, which recovers the report as `before` left it.
      // Only when `after` actually changed the report: an unreadable report counts as changed.
      if (
        afterHandler !== undefined &&
        reportMarkers !== undefined &&
        (beforeAfter === undefined || beforeAfter !== reportChangeSignature(request.report))
      ) {
        try {
          const rewritten = reportMarkers.store.put({
            generation: reportMarkers.generation,
            request: encodeRequestForMarker(limitAttachmentsForMarker(request)),
            attributes: identity.attributes,
            userIdentifier: identity.userIdentifier,
          });
          if (isThenable(rewritten)) {
            Promise.resolve(rewritten).catch(onErrorSafe);
          }
        } catch (error) {
          onErrorSafe(error);
        }
      }
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
          onError: onErrorSafe,
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

  // The worker's Android path caps the exception domain at 150 characters; never leave a lone surrogate behind.
  const MAX_DOMAIN_LENGTH = 150;
  const capDomain = (domain: string, sink: (error: unknown) => void): string => {
    if (domain.length <= MAX_DOMAIN_LENGTH) {
      return domain;
    }
    sink(
      new Error(
        `logException: \`domain\` is longer than ${MAX_DOMAIN_LENGTH} characters; truncated`,
      ),
    );
    const last = domain.charCodeAt(MAX_DOMAIN_LENGTH - 1);
    return domain.slice(
      0,
      last >= 0xd800 && last <= 0xdbff ? MAX_DOMAIN_LENGTH - 1 : MAX_DOMAIN_LENGTH,
    );
  };

  // Build, filter and submit a report someone explicitly asked for (`upload` / a prepared upload).
  const sendUpload = (
    uploadOptions: InternalUploadOptions,
    frozen?: Promise<Map<FileType, CaptureDataEntry[]>>,
  ): Promise<UploadResult> => {
    const request = createReportingRequest({
      source: { type: uploadOptions.trigger ?? 'code_upload' },
      ...(uploadOptions.summary !== undefined ? { summary: uploadOptions.summary } : {}),
      ...(uploadOptions.description !== undefined
        ? { description: uploadOptions.description }
        : {}),
      ...(uploadOptions.severity !== undefined ? { severity: uploadOptions.severity } : {}),
      ...(uploadOptions.labels !== undefined ? { labels: uploadOptions.labels } : {}),
      ...(uploadOptions.email !== undefined ? { email: uploadOptions.email } : {}),
      ...(uploadOptions.attachments !== undefined
        ? { userAttachments: uploadOptions.attachments }
        : {}),
    });
    const handled = applyReportBefore(request);
    if (handled === null) {
      return Promise.resolve({ ok: false }); // vetoed by the report handler
    }
    if (frozen !== undefined) {
      frozenCaptures.set(handled, frozen);
    }
    return submitReport(handled);
  };

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
  // Start draining in-flight reports (each resolves post-upload) then any directly-enqueued uploads. The
  // returned promise is the REAL drain: it settles when the work does, however long that takes.
  const startDrain = (timeout?: number): Promise<boolean> =>
    Promise.allSettled([...pendingReports])
      .then(async () => {
        // Notifications go out alongside the report uploads; either one still pending makes this false.
        const [uploaded, notified] = await Promise.all([
          uploadPipeline?.flush(timeout) ?? true,
          notifyRelay?.flush() ?? true,
        ]);
        return uploaded && notified;
        // An injected pipeline whose flush rejects must not leave stop() rejecting without ever emitting Stopped.
      })
      .catch(() => false);
  // Give up on `drained` after `timeout` (resolving false) so a hung assemble/upload can't block shutdown;
  // the drain itself keeps running. Resolves true if drained in time.
  const boundDrain = (drained: Promise<boolean>, timeout?: number): Promise<boolean> =>
    timeout === undefined ? drained : Promise.race([drained, sleep(timeout).then(() => false)]);
  const drainPending = (timeout?: number): Promise<boolean> =>
    boundDrain(startDrain(timeout), timeout);
  // The REAL drain of the latest stop(), kept after it settles: a repeat stop() while it is still
  // running, or after a bounded stop() gave up on it, must answer for THAT drain. Answering "drained" at once
  // let a platform mark the instance's data recoverable (node `.stopped`) or release its lock (browser,
  // worker) while the first stop's upload was still going. Cleared by launch().
  let stopDrain: Promise<boolean> | undefined;

  // Halt the live capture machinery (tick + capture/detection coordinators). Shared by stop() and the
  // kill-state; the caller decides whether to also drain pending uploads.
  const haltCapture = (): void => {
    if (tickTimer !== null) {
      scheduler.clearInterval(tickTimer);
      tickTimer = null;
    }
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
    notifyRelay?.suspend(); // a switched-off SDK sends nothing more, notifications included
    if (launched) {
      // The same transition a stop() makes, announced the same way: Stopping, then Stopped, with the
      // state already settled when each is delivered. There is no drain to wait for.
      generation += 1; // a transition like stop(): any drain started before it is stale
      launched = false;
      launching = false;
      haltCapture();
      stopping = true;
      lifecycle.emit(LifecycleEvents.Stopping);
      stopping = false;
      lifecycle.emit(LifecycleEvents.Stopped);
    }
  };

  // Apply the report handler's `before` (mutate/veto) at report entry — before assembly. null = veto.
  // Before the handler runs, a crash/error report whose severity was only DERIVED takes the configured
  // `reportDefault{Crash,Error,Bug}Priority`; the handler (and any explicit severity) still wins.
  const applyReportBefore = (request: ReportingRequest): ReportingRequest | null => {
    const { report } = request;
    if (hasDefaultSeverity(report)) {
      if (report.type === 'crash') {
        report.severity = crashPriority;
      } else if (report.type === 'error') {
        report.severity = errorPriority;
      } else if (report.type === 'bug') {
        report.severity = bugPriority;
      }
    }
    return runFilter(filters.report?.before ?? null, request, onError);
  };

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
    const submittedAfter = filters.report?.after;
    if (submittedAfter !== undefined) {
      reportAfter.set(handled, submittedAfter);
    }
    // Did this incident's marker reach DURABLE storage? `true` when there was nothing async to wait for
    // (a synchronous store that did not throw). It decides nothing about retirement — it decides whether
    // keeping the marker actually preserves the incident, or only looks like it does.
    let markerDurable: boolean | Promise<boolean> = true;
    // Apply the attachment limits NOW, so the marker below persists at most 3 x 3 MB of valid data (not an
    // arbitrary pile of bytes) and assembly never meets a malformed one. Never lets the report be lost.
    let markerRequest: ReportingRequest | undefined = handled;
    try {
      normalizeReportAttachments(handled.report, onErrorSafe);
    } catch (error) {
      onErrorSafe(error);
      // The limits could not be applied in place (a handler froze the report): the marker still must not
      // persist what they would drop, so it encodes a limited COPY. Assembly applies them again.
      // A hostile report (throwing Proxy/getter) can throw here too: the encode below is guarded and the
      // report must never be lost to its own recovery marker.
      try {
        markerRequest = limitAttachmentsForMarker(handled);
      } catch (limitError) {
        onErrorSafe(limitError);
        // Fail CLOSED: the unlimited request must not reach the marker, so it persists no
        // user attachments at all. Assembly still limits and ships them on the live path.
        try {
          markerRequest = { ...handled, report: { ...handled.report, userAttachments: [] } };
        } catch (copyError) {
          // Not even a copy can be made: persist no marker rather than an unlimited one.
          onErrorSafe(copyError);
          markerRequest = undefined;
        }
      }
    }
    if (markerRequest === undefined) {
      markerDurable = false; // no marker is persisted at all: the "unrecoverable" warning must still fire
    }
    if (reportMarkers !== undefined && markerRequest !== undefined) {
      try {
        const written = reportMarkers.store.put({
          generation: reportMarkers.generation,
          request: encodeRequestForMarker(markerRequest),
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
    if (options.triggerPipeline !== undefined) {
      // An injected pipeline (Electron renderer, WebView) never goes through `assembleReport`, which is where
      // `after` runs for the built one. The report exists and `before` has had its say: same moment.
      neverThrow(() => filters.report?.after?.(handled), onErrorSafe);
    }
    const result = track(triggerPipeline?.report(handled) ?? Promise.resolve({ ok: false }));
    // Once the pipeline settles: tell the lifecycle listener how the upload went. Guarded — observing a
    // report must never be able to break it. (The report handler's `after` is NOT here: it runs before
    // assembly, see `assembleReport`.)
    const onSettled = (settled: UploadResult | undefined): void => {
      try {
        if (settled !== undefined && assembledReports.has(handled)) {
          const data = { reportId: handled.id, result: settled };
          if (settled.ok) {
            lifecycle.emit(LifecycleEvents.AfterReportUploaded, data);
          } else if (settled.permanent !== true && settled.retained === true) {
            // Not refused, and durably staged: the next launch will retry it.
            lifecycle.emit(LifecycleEvents.ReportUploadFailedWithFutureRetry, data);
          } else {
            lifecycle.emit(LifecycleEvents.ReportUploadFailed, data);
          }
        }
      } catch (error) {
        onErrorSafe(error);
      }
    };
    result.then(onSettled, () => onSettled(undefined));
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

  // The provider/extension-facing surface passed to providers at start().
  const context: Client = {
    operations,
    captureAggregator,
    addCaptureProvider: captureCoordinator.addProvider,
    addDetectionProvider: detectionCoordinator.addProvider,
  };

  // `getLaunchOptions()` / `getHostLaunchOptions()` report the values the client actually applies, not the
  // raw host input: an unrecognised priority or log level reads as the fallback it was replaced by,
  // and the notify window as the whole-millisecond figure in force. Only keys the view already carries
  // are rewritten, so the host view still lists only what the host supplied.
  const inEffect = (
    view: Readonly<Record<string, unknown>> | undefined,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...view };
    const applied: Record<string, unknown> = {
      [BugseeOption.CaptureLogsLevel]: logsLevel,
      [BugseeOption.ReportingDefaultCrashPriority]: crashPriority,
      [BugseeOption.ReportingDefaultErrorPriority]: errorPriority,
      [BugseeOption.NotifyFlushDelay]: notifyFlushDelayMs,
    };
    for (const [key, value] of Object.entries(applied)) {
      if (key in out) {
        out[key] = value;
      }
    }
    if (BugseeOption.ReportingDefaultBugPriority in out) {
      out[BugseeOption.ReportingDefaultBugPriority] =
        parseSeverityName(out[BugseeOption.ReportingDefaultBugPriority]) ?? 'high';
    }
    return out;
  };

  const client: InternalBugseeClient = {
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
    setLifecycleEventsListener: lifecycle.set,
    emitLifecycleEvent: lifecycle.emit,
    deferBlackoutStarted(): void {
      blackoutStartedOwed = true;
    },

    addBreadcrumb(breadcrumb: BreadcrumbInput): void {
      if (killed || !isEnabled(BugseeOption.CaptureBreadcrumbs)) {
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
      if (killed || !isLogLevelEnabled(level, logsLevel)) {
        return;
      }
      const ts = timestamp ?? clock.wallNow();
      const entry: LogEvent = { timestamp: ts, level, source: 'logger', message };
      const filtered = runFilter(filters.log, entry, onError);
      if (filtered === null) {
        return; // dropped by the log filter
      }
      // The wire level is NUMERIC (mobile parity). Encoded AFTER the filter so a user's
      // `logFilter` still sees the friendly name it was written against — the same ordering the capture
      // provider uses. This path, the MANUAL API, was left unfixed and kept shipping the string.
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
      exceptionOptions?: InternalLogExceptionOptions,
    ): Promise<UploadResult> {
      // After stop or in the kill-state, logException is a silent no-op.
      if (stopped || killed) {
        return Promise.resolve({ ok: false });
      }
      // Instance dedup: a re-capture of the same thrown object is a no-op.
      if (checkOrSetAlreadyCaught(error)) {
        return Promise.resolve({ ok: false });
      }
      // Storm self-protection: drop beyond the rolling capture rate.
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
      // Structured crash.json: built from the Error's stack + per-frame debug-ids. handled: true —
      // logException is a programmatically-logged (caught) exception. Undefined for non-Errors.
      // A thrown non-Error has no stack of its own, and shipping `frames: []` cost grouping, not just a
      // location (see callSiteFrames). The Error is constructed HERE, inside the public boundary, which
      // is what both capture strategies depend on; `logException` is a named function expression purely
      // so it can name itself as that boundary.
      const syntheticFrames =
        error instanceof Error
          ? undefined
          : callSiteFrames(
              new Error(),
              exceptionOptions?.callSite?.boundary ?? logException,
              options.stackParser ?? parseV8Stack,
              exceptionOptions?.callSite?.sdkFrames,
            );
      const crash = buildCrashJson(error, {
        parseStack: options.stackParser,
        handled: true,
        ...(options.enrichFrames !== undefined ? { enrichFrames: options.enrichFrames } : {}),
        ...(syntheticFrames !== undefined ? { syntheticFrames } : {}),
      });
      const crashOptions: { domain?: string; skipFrames?: number } = {};
      const domain = exceptionOptions?.domain;
      if (domain !== undefined) {
        if (typeof domain === 'string' && domain !== '') {
          crashOptions.domain = capDomain(domain, onError);
        } else {
          onError(
            new Error('logException: ignoring invalid `domain` (expected a non-empty string)'),
          );
        }
      }
      const skipFrames = exceptionOptions?.skipFrames;
      if (skipFrames !== undefined) {
        if (Number.isInteger(skipFrames) && skipFrames >= 0) {
          crashOptions.skipFrames = skipFrames;
        } else {
          onError(
            new Error(
              'logException: ignoring invalid `skipFrames` (expected a non-negative integer)',
            ),
          );
        }
      }
      applyExceptionOptions(crash, crashOptions, onError);
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

    upload(uploadOptions: InternalUploadOptions = {}): Promise<UploadResult> {
      if (stopped || killed) {
        return Promise.resolve({ ok: false });
      }
      return sendUpload(uploadOptions);
    },

    notify(
      title: string,
      body?: string,
      severity?: SeverityName,
      fields?: Record<string, string>,
      urgent?: boolean,
    ): void {
      // `killed` implies `!launched` (the kill-state halts the client and a killed client never re-launches).
      if (!launched) {
        return;
      }
      try {
        notifyRelay?.enqueue({
          title,
          ...(body !== undefined ? { body } : {}),
          ...(severity !== undefined ? { severity } : {}),
          ...(fields !== undefined ? { fields } : {}),
          ...(urgent !== undefined ? { urgent } : {}),
        });
      } catch (error) {
        onError(error); // notify() must never throw into the host (hostile `fields`, ...)
      }
    },

    prepareUpload(): InternalPreparedUpload | null {
      if (stopped || killed) {
        return null;
      }
      // Freeze the capture now. The tenant scope is the one the eventual report will carry: the active
      // request context at THIS call (a dialog is opened from the context it was asked for in).
      let owner: string | undefined;
      try {
        owner = contextProvider?.getCurrent()?.owner;
      } catch {
        owner = undefined;
      }
      const frozen = collectCapture(owner);
      // A rejected freeze is handled at assembly (live-drain fallback); this keeps it from being reported
      // as unhandled in the meantime.
      frozen.catch(() => undefined);
      let spent = false;
      return {
        send(sendOptions: InternalUploadOptions = {}): Promise<UploadResult> {
          if (spent || stopped || killed) {
            return Promise.resolve({ ok: false });
          }
          spent = true;
          return sendUpload(sendOptions, frozen);
        },
        discard(): void {
          spent = true;
        },
      };
    },

    isLaunched(): boolean {
      return launched;
    },

    // Refused while the client is not launched, as on Android: there is nothing to black out, and the
    // BlackoutStarted/Ended events would describe a state that changed nothing.
    startBlackout(): void {
      if (!ownsBlackout()) {
        // A stale handle: the blackout belongs to the current client, so the request goes THERE (fail closed:
        // an app asking for privacy gets it). Nobody launched to take it: say so rather than ignore it.
        const current = getCarrierBlackoutOwner(processCarrier);
        if (current?.isLaunched() === true) {
          current.start();
        } else {
          onErrorSafe(
            new Error(
              'Bugsee: startBlackout() on a stale client handle, and no client is launched; ignored',
            ),
          );
        }
        return;
      }
      if (launched) {
        blackout.start();
      }
    },

    // Allowed while stopped, unlike start: an app that stopped during a blackout must be able to lift
    // it, or the carried process flag would make the NEXT launch start dark with no event to say so.
    endBlackout(): void {
      if (!ownsBlackout()) {
        // Never lifted from a stale handle: that would clear the process flag under the live client.
        onErrorSafe(
          new Error(
            'Bugsee: endBlackout() on a stale client handle ignored; end the blackout through the current client',
          ),
        );
        return;
      }
      blackout.end();
    },

    isBlackout(): boolean {
      // A stale handle answers with the PROCESS flag: its own state is a stopped client's memory.
      return !ownsBlackout() && processCarrier !== undefined
        ? getCarrierBlackout(processCarrier)
        : blackout.isActive();
    },

    getStatus(): BugseeStatus {
      if (stopping) {
        return BugseeStatus.Stopping;
      }
      if (!launched) {
        return BugseeStatus.Stopped;
      }
      return launching ? BugseeStatus.Launching : BugseeStatus.Launched;
    },

    getLaunchOptions(): Record<string, unknown> {
      return inEffect(options.launchOptionsView?.effective);
    },

    getHostLaunchOptions(): Record<string, unknown> {
      return inEffect(options.launchOptionsView?.host);
    },

    launch(): void {
      // A killed client (collector KILL_SDK) is permanently dead: re-launching must not re-arm it.
      if (killed || launched) {
        return;
      }
      if (options.restartable === false && (stopped || stopping)) {
        onError(
          new Error(
            'Bugsee: launch() was called on a client that has been stopped; build a new one with the platform launch(appToken) or relaunch()',
          ),
        );
        return;
      }
      if (stopping) {
        // A launch while the previous stop() is still draining ends that stop: from here on the client is
        // running, so the stale drain must not report Stopped (or suspend anything) when it finishes.
        stopping = false;
        lifecycle.emit(LifecycleEvents.Stopped);
      }
      // State first, events second: by the time a listener hears Launching the client already reads as
      // launching, so a listener that calls launch() again is a no-op and one that calls stop() aborts this
      // launch cleanly instead of racing it.
      generation += 1;
      const mine = generation;
      launched = true;
      launching = true;
      stopped = false;
      if (processCarrier !== undefined) {
        claimCarrierBlackoutOwner(blackoutOwner, processCarrier);
      }
      lifecycle.emit(LifecycleEvents.Launching);
      if (mine !== generation) {
        return; // a listener stopped the client before it started
      }
      stopDrain = undefined; // this launch starts a fresh life: a repeat stop() answers for ITS drain
      notifyRelay?.resume(); // a stop() suspended it; what was kept goes out now
      adoptNotifyBacklog();
      // launch() must never throw: a throwing provider.start is isolated per coordinator
      // (a failed capture start must not prevent detection from starting) and routed to onError.
      try {
        captureCoordinator.start(launchOptions, isEnabled);
      } catch (error) {
        /* v8 ignore next 2 -- belt and braces: the coordinator already isolates every provider failure */
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
        /* v8 ignore next 2 -- belt and braces: the coordinator already isolates every provider failure */
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
      launching = false;
      lifecycle.emit(LifecycleEvents.Launched);
      if (blackoutStartedOwed) {
        blackoutStartedOwed = false;
        if (launched && blackout.isActive()) {
          lifecycle.emit(LifecycleEvents.BlackoutStarted);
        }
      }
    },

    stop(timeout?: number): Promise<boolean> {
      if (!launched) {
        // Already stopped, or stopping: answer for the drain of THAT stop, within this call's own bound.
        // Never started, or killed (no drain was started): there is nothing left to wait for.
        return stopDrain !== undefined ? boundDrain(stopDrain, timeout) : Promise.resolve(true);
      }
      // Is this the stop relaunch() issues? Decided NOW: by the time the drain settles the new client may be up.
      const handsOver = processCarrier !== undefined && getCarrierRelaunching(processCarrier);
      if (handsOver) {
        handoverEpoch = getCarrierRelaunchEpoch(processCarrier);
      }
      generation += 1;
      const mine = generation;
      launched = false;
      launching = false;
      stopped = true;
      haltCapture(); // also valid mid-launch: a stop from the Launching listener has nothing started yet
      stopping = true;
      lifecycle.emit(LifecycleEvents.Stopping);
      // The shared drain is UNBOUNDED: it is the one real drain every stop() answers for, so a first
      // caller's deadline must not cap it (a repeat stop() could then never report true). Each caller applies
      // its own timeout only when racing it.
      const realDrain = startDrain();
      stopDrain = realDrain;
      return boundDrain(realDrain, timeout)
        .finally(() => {
          // Only the LATEST transition owns these: a launch() that superseded this stop has already cleared
          // `stopping`, and its notify relay must keep running.
          if (mine === generation) {
            stopping = false;
            // A notification still waiting (offline) keeps its place for a re-launch but stops retrying: a
            // stopped SDK must not keep a timer, and so a request, alive.
            notifyRelay?.suspend();
            if (handsOver) {
              stashNotifyBacklog();
            }
          }
        })
        .then((drained) => {
          // After `stopping` clears, so a listener that reads getStatus() sees Stopped, not Stopping.
          if (mine === generation) {
            lifecycle.emit(LifecycleEvents.Stopped);
          }
          return drained;
        });
    },

    flush(timeout?: number): Promise<boolean> {
      return drainPending(timeout);
    },
  };
  return exposePublicSurface(client);
}
