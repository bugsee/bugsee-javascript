// SDK option-key translation for `environment.sdk.options` (design §2.4 / §8.6). The mobile
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
  /** Detect uncaught exceptions / unhandled rejections and report them. */
  DetectCrash: 'com.bugsee.option.detect.crash',
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
  'com.bugsee.option.capture.network': boolean;
  'com.bugsee.option.capture.network.bodies': boolean;
  'com.bugsee.option.capture.network.body-size-limit': number;
  'com.bugsee.option.capture.network.body-without-type': boolean;
  'com.bugsee.option.capture.network.default-sanitizer': boolean;
  'com.bugsee.option.capture.system-traces': boolean;
  'com.bugsee.option.capture.system-events': boolean;
  'com.bugsee.option.capture.interactions': boolean;
  'com.bugsee.option.capture.view-hierarchy': boolean;
  'com.bugsee.option.detect.crash': boolean;
  'com.bugsee.option.detect.hang': boolean;
  'com.bugsee.option.detect.hang.level.fair': number;
  'com.bugsee.option.detect.hang.level.medium': number;
  'com.bugsee.option.detect.hang.level.severe': number;
  'com.bugsee.option.config.duration': number;
  'com.bugsee.option.config.data-size': number;
}
