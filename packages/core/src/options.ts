import { BugseeOption } from '@bugsee/protocol';
import type { OptionGate } from './capture-coordinator';
import type { OptionsContainer } from './contracts';
import { parseLogLevelName } from './log-level';
import { parseSeverityName } from './reporting';

// Default OptionsContainer over a plain values map (Android OptionsContainer parity): the launch
// options bag passed to a component's start(options) so it (re)configures behavior per launch.
// Presence is decided by OWN keys (Object.hasOwn) so a key explicitly set to `undefined` is honored
// and inherited prototype members (toString, …) are never mistaken for options.
export function createOptionsContainer(values: Record<string, unknown> = {}): OptionsContainer {
  return {
    get<T>(key: string, fallback: T): T {
      return Object.hasOwn(values, key) ? (values[key] as T) : fallback;
    },
    has(key: string): boolean {
      return Object.hasOwn(values, key);
    },
  };
}

// Friendly-name → canonical-identifier option scheme (Android com.bugsee.option.* parity, design
// §2.4). Users pass idiomatic friendly names at launch; each maps to a canonical dotted identifier
// (the cross-SDK + wire identity). resolveLaunchOptions turns the friendly bag into the canonical
// form once: the OptionsContainer providers read (keyed by identifier), the gate the coordinators
// query, and the canonical record platforms serialize into environment.sdk.options (via optionsToWire).

/** One launch option: its public friendly name, canonical dotted identifier, and default value. */
export interface OptionDefinition {
  /** Public, friendly launch-option name (e.g. 'captureNetwork'). */
  readonly friendly: string;
  /** Canonical dotted identifier — the cross-SDK / wire identity (com.bugsee.option.*). */
  readonly key: string;
  /** Value applied when the user omits the friendly name. */
  readonly default: unknown;
  /**
   * Validates/normalizes a SUPPLIED value (never called for `undefined`). Returns the value in effect, or
   * `undefined` when invalid (the default then applies and `onError` is told, naming `expected`).
   */
  readonly normalize?: (value: unknown) => unknown;
  /** What `normalize` accepts, for the error message (e.g. `a boolean`). */
  readonly expected?: string;
}

const normalizeBoolean = (value: unknown): unknown =>
  typeof value === 'boolean' ? value : undefined;
const normalizeLogLevel = (value: unknown): unknown => parseLogLevelName(value);
const normalizeSeverity = (value: unknown): unknown => parseSeverityName(value);

const boolean = { normalize: normalizeBoolean, expected: 'a boolean' } as const;
const logLevel = {
  normalize: normalizeLogLevel,
  expected: 'one of error | warning | info | debug | verbose, or an integer 1-5',
} as const;
const severity = {
  normalize: normalizeSeverity,
  expected: 'one of verylow | low | medium | high | critical | blocker',
} as const;

export interface ResolvedLaunchOptions {
  /** Canonical identifier → value (defaults applied). Serialize via optionsToWire for the wire. */
  readonly canonical: Record<string, unknown>;
  /** ONLY the options the host supplied, by canonical identifier (no defaults, no unknown names). */
  readonly host: Record<string, unknown>;
  /** Launch options keyed by canonical identifier, passed to each provider's start(). */
  readonly options: OptionsContainer;
  /** A boolean option is enabled unless explicitly set to false (an unknown key defaults enabled). */
  readonly isEnabled: OptionGate;
}

function reportInvalid(
  onError: ((error: Error) => void) | undefined,
  def: OptionDefinition,
  supplied: unknown,
): void {
  try {
    onError?.(
      new Error(
        `${def.friendly} must be ${def.expected ?? 'valid'} (got ${String(supplied)}); using ${String(def.default)}`,
      ),
    );
  } catch {
    /* a throwing onError must not break launch */
  }
}

/** Resolve a friendly launch-options bag against `definitions` into canonical form + gate. */
export function resolveLaunchOptions(
  values: Record<string, unknown>,
  definitions: readonly OptionDefinition[],
  onError?: (error: Error) => void,
): ResolvedLaunchOptions {
  const canonical: Record<string, unknown> = {};
  const host: Record<string, unknown> = {};
  for (const def of definitions) {
    // An option passed as `undefined` is NOT supplied (so `{ captureNetworkDefaultSanitizer: undefined }`
    // keeps the default-on redaction instead of storing `undefined`, which a consumer could read as off).
    const supplied = Object.hasOwn(values, def.friendly) ? values[def.friendly] : undefined;
    if (supplied === undefined) {
      canonical[def.key] = def.default;
      continue;
    }
    // The value IN EFFECT is what is stored (and sent as sdk.options), not the raw host input.
    const value = def.normalize === undefined ? supplied : def.normalize(supplied);
    if (value === undefined) {
      canonical[def.key] = def.default;
      reportInvalid(onError, def, supplied);
      continue;
    }
    host[def.key] = value;
    canonical[def.key] = value;
  }
  return {
    canonical,
    host,
    options: createOptionsContainer(canonical),
    isEnabled: (key) => canonical[key] !== false,
  };
}

/** The cross-platform launch options every JS runtime shares; platform packages append their own. */
export const COMMON_OPTION_DEFINITIONS: readonly OptionDefinition[] = [
  { friendly: 'captureLogs', key: BugseeOption.CaptureLogs, default: true, ...boolean },
  { friendly: 'captureNetwork', key: BugseeOption.CaptureNetwork, default: true, ...boolean },
  {
    friendly: 'captureNetworkBodies',
    key: BugseeOption.CaptureNetworkBodies,
    default: true,
    ...boolean,
  },
  {
    friendly: 'maxNetworkBodySize',
    key: BugseeOption.CaptureNetworkBodySizeLimit,
    default: 20480,
  },
  {
    friendly: 'captureNetworkBodyWithoutType',
    key: BugseeOption.CaptureNetworkBodyWithoutType,
    default: false,
    ...boolean,
  },
  {
    friendly: 'captureSystemTraces',
    key: BugseeOption.CaptureSystemTraces,
    default: true,
    ...boolean,
  },
  {
    friendly: 'captureSystemEvents',
    key: BugseeOption.CaptureSystemEvents,
    default: true,
    ...boolean,
  },
  { friendly: 'detectCrashes', key: BugseeOption.DetectCrash, default: true, ...boolean },
  { friendly: 'maxRecordingTime', key: BugseeOption.Duration, default: 60 },
  // Mobile-parity options (Android OptionsDescriptors). `captureBreadcrumbs` deliberately defaults to TRUE
  // here although mobile defaults it to false — see docs/design/mobile-api-alignment.md, Kept differences.
  {
    friendly: 'captureLogsLevel',
    key: BugseeOption.CaptureLogsLevel,
    default: 'verbose',
    ...logLevel,
  },
  {
    friendly: 'captureBreadcrumbs',
    key: BugseeOption.CaptureBreadcrumbs,
    default: true,
    ...boolean,
  },
  { friendly: 'detectHttpErrors', key: BugseeOption.DetectHttpErrors, default: false, ...boolean },
  {
    friendly: 'captureNetworkDefaultSanitizer',
    key: BugseeOption.CaptureNetworkDefaultSanitizer,
    default: true,
    ...boolean,
  },
  {
    friendly: 'reportDefaultCrashPriority',
    key: BugseeOption.ReportingDefaultCrashPriority,
    default: 'blocker',
    ...severity,
  },
  {
    friendly: 'reportDefaultErrorPriority',
    key: BugseeOption.ReportingDefaultErrorPriority,
    default: 'high',
    ...severity,
  },
  // `notify()` batching window in ms (Android `NotifyFlushDelay`); 0 = send as soon as the tick ends.
  { friendly: 'notifyFlushDelay', key: BugseeOption.NotifyFlushDelay, default: 0 },
];
