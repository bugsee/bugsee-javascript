// SDK option-key translation for `environment.sdk.options`. The mobile
// contract uses colon-separated keys on the wire; SDK option keys are dotted, so dots become
// colons. Applied only inside `environment.sdk.options`.

/** Wire form of an option key: dots -> colons. */
export function optionKeyToWire(key: string): string {
  return key.replaceAll('.', ':');
}

/** Inverse of optionKeyToWire: colons -> dots. */
export function optionKeyFromWire(key: string): string {
  return key.replaceAll(':', '.');
}

/**
 * Translates an options record's keys to wire form. The result is a null-prototype object so a
 * `__proto__` key (e.g. from a JSON-sourced options bag) is stored as own data and can never
 * corrupt a prototype.
 */
export function optionsToWire<V>(options: Record<string, V>): Record<string, V> {
  const out = Object.create(null) as Record<string, V>;
  for (const [key, value] of Object.entries(options)) {
    out[optionKeyToWire(key)] = value;
  }
  return out;
}

// Canonical Bugsee option identifiers (Android `com.bugsee.option.*` parity). These dotted strings
// are the CROSS-SDK, on-the-wire identity of each option (sent in environment.sdk.options after
// optionsToWire); they never change per platform. Platforms expose friendly names that map onto
// these (see @bugsee/core option definitions); extension packages add their own keys under the same
// `com.bugsee.option.<namespace>.<feature>` convention and extend BugseeOptionTypes by declaration
// merging. Values are booleans/numbers/strings (Serializable), matching Android's option value set.
export const BugseeOption = {
  /** Capture console/logger output as logs. */
  CaptureLogs: 'com.bugsee.option.capture.logs',
  /** Capture network activity (fetch/xhr/ws/sse/webtransport, and node:http on Node). */
  CaptureNetwork: 'com.bugsee.option.capture.network',
  /** Capture request/response bodies (master toggle; default on). */
  CaptureNetworkBodies: 'com.bugsee.option.capture.network.bodies',
  /** Max captured request/response body size in bytes. */
  CaptureNetworkBodySizeLimit: 'com.bugsee.option.capture.network.body-size-limit',
  /** Capture a body even when its Content-Type is missing/blank (default off). */
  CaptureNetworkBodyWithoutType: 'com.bugsee.option.capture.network.body-without-type',
  /** Minimum console/log level captured: `error | warning | info | debug | verbose`. Default `verbose`. */
  CaptureLogsLevel: 'com.bugsee.option.capture.logs.level',
  /**
   * Capture breadcrumbs (manual `addBreadcrumb` and the automatic UI/route ones). Mobile defaults this
   * to false; JS defaults it to TRUE because UI-interaction breadcrumbs are a core web signal.
   */
  CaptureBreadcrumbs: 'com.bugsee.option.capture.breadcrumbs',
  /** Apply the default network PII sanitizer. */
  CaptureNetworkDefaultSanitizer: 'com.bugsee.option.capture.network.default-sanitizer',
  /** Capture periodic system traces (memory / cpu / event-loop lag). */
  CaptureSystemTraces: 'com.bugsee.option.capture.system-traces',
  /** Capture system events (process / app lifecycle). */
  CaptureSystemEvents: 'com.bugsee.option.capture.system-events',
  /**
   * Capture user interactions. Two destinations, ONE gate — the option means "do not watch what I click
   * and type", which must hold whatever stream the observation lands on:
   *   - device presses (pointer/key) → the SDK-captured `input` stream;
   *   - state changes (change/submit/focus) → `ui.*` BREADCRUMBS (Android's gesture-dispatcher split).
   * Never `events.user`, which is reserved for application-supplied `client.event()` data. Browser/DOM only.
   */
  CaptureInteractions: 'com.bugsee.option.capture.interactions',
  /** Capture a view hierarchy (DOM tree → viewtree) at report time. Browser/DOM only. */
  CaptureViewHierarchy: 'com.bugsee.option.capture.view-hierarchy',
  /**
   * Launch with a blackout ALREADY in force (as if `startBlackout()` had run before anything else): visual
   * and interaction capture stays suppressed until `endBlackout()`. For a page that renders sensitive
   * content from its first frame, where there is no moment to call `startBlackout()` before capture could
   * begin. Default false. Browser only.
   */
  CaptureStartInBlackout: 'com.bugsee.option.capture.start-in-blackout',
  /**
   * Browser only: observe environment hints that read as sensitive, starting with the PRIVATE-BROWSING heuristic (an
   * `private_mode_detected` event for a `yes` answer; the answer is never certain). The protocol layer only defines
   * the key and its boolean type; the default is set by the platform launch: the browser launch defaults to true
   * (`false` opts out, a non-boolean value is treated as off and reported), the WebView launch never enables it. Language and time-zone changes are NOT gated by this.
   */
  CaptureEnvironmentHints: 'com.bugsee.option.capture.environment-hints',
  /**
   * Disk-space TELEMETRY (iOS `monitorDiskSpace`, the same opt-in meaning): the `capture` trace's `low_disk_space` /
   * `no_disk_space` states and the Node-family `disk_mem_free` / `disk_mem_total` traces. Opt-in, default false; only
   * boolean `true` enables it. It does NOT gate the capture store's protection (see `CaptureDiskProtection`), which is
   * on by default, as on iOS.
   */
  CaptureDiskSpace: 'com.bugsee.option.capture.disk-space',
  /**
   * The capture store's disk-pressure PROTECTION (iOS runs it always; only its telemetry is behind the option): below
   * 50 MiB free the durable store stops persisting replay, log and network data, below 10 MiB it persists nothing, and
   * the in-memory window is kept either way. Applies only where a durable store exists (Node-family data directory,
   * browser IndexedDB). Default true; only boolean `false` opts out, any other value keeps it on.
   */
  CaptureDiskProtection: 'com.bugsee.option.capture.disk-protection',
  /** Detect uncaught exceptions / unhandled rejections and report them. */
  DetectCrash: 'com.bugsee.option.detect.crash',
  /** Report failed HTTP responses (>= 400) and network failures as `error` reports. Default false. */
  DetectHttpErrors: 'com.bugsee.option.detect.http-errors',
  /** Detect main-thread/event-loop hangs (Android `BugseeDetectionHang` parity). */
  DetectHang: 'com.bugsee.option.detect.hang',
  /** Hang escalation thresholds in ms (Android-canonical defaults 3000 / 5000 / 10000). */
  DetectHangFairMs: 'com.bugsee.option.detect.hang.level.fair',
  DetectHangMediumMs: 'com.bugsee.option.detect.hang.level.medium',
  DetectHangSevereMs: 'com.bugsee.option.detect.hang.level.severe',
  /** Rolling recording window in seconds. */
  Duration: 'com.bugsee.option.config.duration',
  /** Max captured data kept in the rolling buffer, in megabytes (memory/disk bound). */
  MaxDataSize: 'com.bugsee.option.config.data-size',
  /**
   * `notify()` coalescing window in milliseconds (Android `Options.NotifyFlushDelay`). `0` (default) sends
   * a burst of notifications as one request the moment the current tick ends; a larger value waits that
   * long after the first one so more can join the batch. An `urgent` notification skips the wait.
   */
  NotifyFlushDelay: 'com.bugsee.option.config.notify-flush-delay',
  /** Report dialog: the summary field must be filled in (Android `ReportingUISummaryRequired`). */
  ReportingUiSummaryRequired: 'com.bugsee.option.reporting.ui.summary-required',
  /** Report dialog: the description field must be filled in. */
  ReportingUiDescriptionRequired: 'com.bugsee.option.reporting.ui.description-required',
  /** Report dialog: the reporter email must be filled in. */
  ReportingUiEmailRequired: 'com.bugsee.option.reporting.ui.email-required',
  /** Report dialog: show the labels field (off by default, as on mobile). */
  ReportingUiLabelsEnabled: 'com.bugsee.option.reporting.ui.labels-enabled',
  /** Report dialog: at least one label must be given (only meaningful with labels enabled). */
  ReportingUiLabelsRequired: 'com.bugsee.option.reporting.ui.labels-required',
  /** Report dialog: show the severity picker (off by default, as on mobile). */
  ReportingUiPrioritySelectorEnabled: 'com.bugsee.option.reporting.ui.priority-selector-enabled',
  /**
   * Persist the user identifier across launches (iOS persists it; the browser tier honours this — it
   * keeps the identifier in localStorage). Default true. Set false when the identifier is PII you do
   * not want at rest on the device. Node/server tiers never persist it.
   */
  PersistUserIdentifier: 'com.bugsee.option.user.persist-identifier',
  /** Severity a bug report starts with: `low | medium | high | critical | blocker`. Default `high`. */
  ReportingDefaultBugPriority: 'com.bugsee.option.reporting.defaults.bug-priority',
  /** Severity a crash report starts with. Default `blocker`. */
  ReportingDefaultCrashPriority: 'com.bugsee.option.reporting.defaults.crash-priority',
  /** Severity an error report starts with. Default `high`. */
  ReportingDefaultErrorPriority: 'com.bugsee.option.reporting.defaults.error-priority',
} as const;

/** A canonical option identifier value (one of {@link BugseeOption}'s string values). */
export type BugseeOptionKey = (typeof BugseeOption)[keyof typeof BugseeOption];

/**
 * The value type carried by each canonical option key — the typed option contract. Platform and
 * extension packages widen it via declaration merging, e.g.
 * `declare module '@bugsee/protocol' { interface BugseeOptionTypes { 'com.bugsee.option.x': T } }`.
 */
export interface BugseeOptionTypes {
  'com.bugsee.option.capture.logs': boolean;
  'com.bugsee.option.capture.logs.level': string;
  'com.bugsee.option.capture.breadcrumbs': boolean;
  'com.bugsee.option.detect.http-errors': boolean;
  'com.bugsee.option.capture.network': boolean;
  'com.bugsee.option.capture.network.bodies': boolean;
  'com.bugsee.option.capture.network.body-size-limit': number;
  'com.bugsee.option.capture.network.body-without-type': boolean;
  'com.bugsee.option.capture.network.default-sanitizer': boolean;
  'com.bugsee.option.capture.system-traces': boolean;
  'com.bugsee.option.capture.system-events': boolean;
  'com.bugsee.option.capture.interactions': boolean;
  'com.bugsee.option.capture.view-hierarchy': boolean;
  'com.bugsee.option.capture.environment-hints': boolean;
  'com.bugsee.option.capture.start-in-blackout': boolean;
  'com.bugsee.option.capture.disk-space': boolean;
  'com.bugsee.option.capture.disk-protection': boolean;
  'com.bugsee.option.detect.crash': boolean;
  'com.bugsee.option.detect.hang': boolean;
  'com.bugsee.option.detect.hang.level.fair': number;
  'com.bugsee.option.detect.hang.level.medium': number;
  'com.bugsee.option.detect.hang.level.severe': number;
  'com.bugsee.option.config.duration': number;
  'com.bugsee.option.config.data-size': number;
  'com.bugsee.option.config.notify-flush-delay': number;
  'com.bugsee.option.reporting.ui.summary-required': boolean;
  'com.bugsee.option.reporting.ui.description-required': boolean;
  'com.bugsee.option.reporting.ui.email-required': boolean;
  'com.bugsee.option.reporting.ui.labels-enabled': boolean;
  'com.bugsee.option.reporting.ui.labels-required': boolean;
  'com.bugsee.option.reporting.ui.priority-selector-enabled': boolean;
  'com.bugsee.option.user.persist-identifier': boolean;
  'com.bugsee.option.reporting.defaults.bug-priority': string;
  'com.bugsee.option.reporting.defaults.crash-priority': string;
  'com.bugsee.option.reporting.defaults.error-priority': string;
}
