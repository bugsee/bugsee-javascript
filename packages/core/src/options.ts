import { BugseeOption } from '@bugsee/protocol';
import type { OptionGate } from './capture-coordinator';
import type { OptionsContainer } from './contracts';

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
}

export interface ResolvedLaunchOptions {
  /** Canonical identifier → value (defaults applied). Serialize via optionsToWire for the wire. */
  readonly canonical: Record<string, unknown>;
  /** Launch options keyed by canonical identifier, passed to each provider's start(). */
  readonly options: OptionsContainer;
  /** A boolean option is enabled unless explicitly set to false (an unknown key defaults enabled). */
  readonly isEnabled: OptionGate;
}

/** Resolve a friendly launch-options bag against `definitions` into canonical form + gate. */
export function resolveLaunchOptions(
  values: Record<string, unknown>,
  definitions: readonly OptionDefinition[],
): ResolvedLaunchOptions {
  const canonical: Record<string, unknown> = {};
  for (const def of definitions) {
    canonical[def.key] = Object.hasOwn(values, def.friendly) ? values[def.friendly] : def.default;
  }
  return {
    canonical,
    options: createOptionsContainer(canonical),
    isEnabled: (key) => canonical[key] !== false,
  };
}

/** The cross-platform launch options every JS runtime shares; platform packages append their own. */
export const COMMON_OPTION_DEFINITIONS: readonly OptionDefinition[] = [
  { friendly: 'captureLogs', key: BugseeOption.CaptureLogs, default: true },
  { friendly: 'captureNetwork', key: BugseeOption.CaptureNetwork, default: true },
  { friendly: 'captureNetworkBodies', key: BugseeOption.CaptureNetworkBodies, default: true },
  {
    friendly: 'maxNetworkBodySize',
    key: BugseeOption.CaptureNetworkBodySizeLimit,
    default: 20480,
  },
  {
    friendly: 'captureNetworkBodyWithoutType',
    key: BugseeOption.CaptureNetworkBodyWithoutType,
    default: false,
  },
  { friendly: 'captureSystemTraces', key: BugseeOption.CaptureSystemTraces, default: true },
  { friendly: 'captureSystemEvents', key: BugseeOption.CaptureSystemEvents, default: true },
  { friendly: 'detectCrashes', key: BugseeOption.DetectCrash, default: true },
  { friendly: 'maxRecordingTime', key: BugseeOption.Duration, default: 60 },
];
