import { serviceToken } from '@bugsee/core';
import { bytesToMegabytes, type EnvironmentEnvelope, optionsToWire } from '@bugsee/protocol';
import { detectBrowser, detectOs } from './user-agent';

// Builds the §8.6 environment envelope for the browser from navigator/screen/window/Intl. System reads
// go through an injectable BrowserProbe so the mapping is testable deterministically (the DOM globals
// are stubbed in tests); realBrowserProbe is the default. Pure given (input, probe) — persistence
// (device_id) is the caller's concern. Canonical (dotted) option keys are translated to colon wire form
// for sdk.options here, because the server treats dots as nested-document paths (§2.4).
//
// The OS and the browser are identified IN THE BROWSER (see ./user-agent.ts), from
// `navigator.userAgentData.platform` where the browser declares it and a user-agent parse otherwise.
// This used to be deferred to the backend — `platform.type: 'web'` with the raw UA string as
// `platform.version` — which left a browser session as the only kind naming no OS at all, in the very
// field the backend indexes as `os_version` (samples/FINDINGS.md F-X20). Doing it here also costs the
// server nothing per report. hardware.model / manufacturer stay omitted: no browser exposes them.
// deviceMemory + hardwareConcurrency are non-standard / not-everywhere, so their readers are optional
// and the builder omits absent fields.

export interface BrowserProbe {
  userAgent(): string;
  /**
   * `navigator.userAgentData.platform` — the browser's own declaration of its OS ('macOS', 'Windows',
   * 'Android', …). Chromium-only; undefined on Firefox/Safari, where the UA parse is the only source.
   */
  uaDataPlatform(): string | undefined;
  locale(): string;
  /** Offset from UTC in minutes, positive east (e.g. UTC+2 → 120). */
  utcOffsetMinutes(): number;
  screenWidth(): number;
  screenHeight(): number;
  pixelRatio(): number;
  /** navigator.deviceMemory as bytes (GB × 1024³); undefined where unsupported (non-Chromium). */
  deviceMemoryBytes(): number | undefined;
  /** navigator.hardwareConcurrency; undefined on browsers that don't expose it. */
  cpuCount(): number | undefined;
}

// Service token for the browser probe — registered by `launch` so the resolved probe is resolvable.
// Reuses the 'systemProbe' identifier (the cross-platform "the platform probe" slot; node uses it too).
export const BrowserProbeToken = serviceToken<BrowserProbe>('systemProbe');

export const realBrowserProbe: BrowserProbe = {
  userAgent: () => navigator.userAgent,
  uaDataPlatform: () =>
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform,
  locale: () => new Intl.DateTimeFormat().resolvedOptions().locale,
  utcOffsetMinutes: () => -new Date().getTimezoneOffset(),
  screenWidth: () => screen.width,
  screenHeight: () => screen.height,
  pixelRatio: () => window.devicePixelRatio,
  deviceMemoryBytes: () => {
    const gb = (navigator as { deviceMemory?: number }).deviceMemory;
    return gb === undefined ? undefined : gb * 1024 ** 3;
  },
  cpuCount: () => (navigator as { hardwareConcurrency?: number }).hardwareConcurrency,
};

export interface BrowserEnvironmentInput {
  /** SDK package version (sdk.version). */
  sdkVersion: string;
  /** app.package_id (default 'unknown'). */
  appId?: string;
  /** app.version (default '0.0.0'). */
  appVersion?: string;
  /** app.build (default '0'). */
  appBuild?: string;
  /** sdk.build — git SHA; omitted when absent. */
  sdkBuild?: string;
  /** sdk.options — canonical dotted option keys; wire-translated to colon form here. Omitted when absent. */
  options?: Record<string, unknown>;
  /** app.debuggable (default false). */
  debuggable?: boolean;
  /** hardware.device_id — persisted UUID supplied by the caller (null when none). */
  deviceId?: string;
}

export function buildBrowserEnvironment(
  input: BrowserEnvironmentInput,
  probe: BrowserProbe = realBrowserProbe,
): EnvironmentEnvelope {
  // MEGABYTES on the wire (see @bugsee/protocol bytesToMegabytes) — navigator.deviceMemory is a
  // GiB figure the probe hands back as bytes, and the viewer divides by 1024 to render GB.
  const bytes = probe.deviceMemoryBytes();
  const deviceMemory = bytes === undefined ? undefined : bytesToMegabytes(bytes);
  const cpuCount = probe.cpuCount();
  const userAgent = probe.userAgent();
  const os = detectOs(userAgent, probe.uaDataPlatform());
  const browser = detectBrowser(userAgent);
  return {
    // The OS, matching what every other Bugsee SDK puts here.
    platform: {
      type: os.type,
      version: os.version,
      utc_offset: probe.utcOffsetMinutes(),
      locale: probe.locale(),
      ...(deviceMemory !== undefined ? { memory_total: deviceMemory } : {}),
    },
    // Omitted rather than half-filled: a `{type: '', version: ''}` block renders as an empty,
    // icon-less Browser section in the viewer, which is worse than no section.
    ...(browser.type !== '' ? { browser: { type: browser.type, version: browser.version } } : {}),
    // `type` stays the closed RuntimeType enum ('web'); the browser's own version is the nearest
    // thing a page has to a runtime version, and this field shipped empty until it had a parser.
    runtime: {
      type: 'web',
      version: browser.version,
    },
    hardware: {
      screen_width: probe.screenWidth(),
      screen_height: probe.screenHeight(),
      pixel_ratio: probe.pixelRatio(),
      device_id: input.deviceId ?? null,
      ...(cpuCount !== undefined ? { cpu_count: cpuCount } : {}),
      ...(deviceMemory !== undefined ? { memory_total: deviceMemory } : {}),
    },
    app: {
      package_id: input.appId ?? 'unknown',
      version: input.appVersion ?? '0.0.0',
      build: input.appBuild ?? '0',
      debuggable: input.debuggable ?? false,
    },
    sdk: {
      version: input.sdkVersion,
      type: 'javascript',
      ...(input.sdkBuild !== undefined ? { build: input.sdkBuild } : {}),
      ...(input.options !== undefined ? { options: optionsToWire(input.options) } : {}),
    },
  };
}
