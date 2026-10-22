import { serviceToken } from '@bugsee/core';
import { type EnvironmentEnvelope, optionsToWire } from '@bugsee/protocol';
import { detectBrowser, detectOs, UNKNOWN_OS } from './user-agent';

// Builds the environment envelope for the browser from navigator/screen/window/Intl. System reads
// go through an injectable BrowserProbe so the mapping is testable deterministically (the DOM globals
// are stubbed in tests); realBrowserProbe is the default. Pure given (input, probe) — persistence
// (device_id) is the caller's concern. Canonical (dotted) option keys are translated to colon wire form
// for sdk.options here, because the server treats dots as nested-document paths.
//
// The OS and the browser are identified IN THE BROWSER (see ./user-agent.ts), from
// `navigator.userAgentData.platform` where the browser declares it and a user-agent parse otherwise.
// This used to be deferred to the backend — `platform.type: 'web'` with the raw UA string as
// `platform.version` — which left a browser session as the only kind naming no OS at all, in the very
// field the backend indexes as `os_version`. Doing it here also costs the
// server nothing per report. hardware.model / manufacturer stay omitted: no browser exposes them.
// deviceMemory + hardwareConcurrency are non-standard / not-everywhere, so their readers are optional
// and the builder omits absent fields.

export interface BrowserProbe {
  userAgent(): string;
  /**
   * `navigator.userAgentData.platform` — the browser's own declaration of its OS ('macOS', 'Windows',
   * 'Android', …). Chromium-only; undefined on Firefox/Safari, where the UA parse is the only source.
   *
   * OPTIONAL, and called optionally, because `systemProbe` is a public launch option: a caller may hand
   * us a probe written against an older shape of this interface, and a missing method must degrade to
   * the user-agent parse rather than throw. It threw once — inside report ASSEMBLY, so every report
   * silently disappeared instead of failing visibly.
   */
  uaDataPlatform?(): string | undefined;
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
  /**
   * Seconds since the document's time origin (`performance.now() / 1000`, fractional). OPTIONAL and called
   * optionally: a probe without a clock leaves `app.uptime_s` out.
   */
  uptimeSeconds?(): number | undefined;
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
  uptimeSeconds: () => performance.now() / 1000,
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
  /**
   * Seconds since the document's time origin at the moment the capture session STARTED (a snapshot taken
   * once by the caller). Written as `app.uptime_s`, floored; omitted when absent or not a finite number >= 0.
   */
  uptimeSeconds?: number;
}

/**
 * The environment WITHOUT `app.uptime_s`, for rebuilding a PRIOR process's incident at recovery: the live
 * session's uptime is the new process's, so it would be wrong for the old incident. Omitted rather than wrong.
 */
export function withoutUptime(env: EnvironmentEnvelope): EnvironmentEnvelope {
  if (env.app === undefined || !('uptime_s' in env.app)) return env;
  const { uptime_s: _dropped, ...app } = env.app;
  return { ...env, app };
}

export function buildBrowserEnvironment(
  input: BrowserEnvironmentInput,
  probe: BrowserProbe = realBrowserProbe,
): EnvironmentEnvelope {
  // NO memory_total, on either block. `navigator.deviceMemory` is the only memory reading a page gets
  // and it is a deliberately coarse bucket — a 64 GB machine reports 32 (measured, Chrome 151) —
  // while `memory_total` means ACTUAL physical RAM on every other Bugsee SDK (node reads os.totalmem,
  // Android reads MemoryInfo). The viewer synthesizes its "System memory (RAM) / Total" trace directly
  // from this field (recording-helper.service.ts:186), so filling it with a bucket put a confidently
  // wrong number under an exact label. The reading still ships, as the `ram_system_advertised` TRACE —
  // Android's own name for "advertised memory ... might be different from getSystemTotalMemory()".
  const cpuCount = probe.cpuCount();
  const userAgent = probe.userAgent();
  const os = detectOs(userAgent, probe.uaDataPlatform?.());
  const browser = detectBrowser(userAgent);
  return {
    // The OS, matching what every other Bugsee SDK puts here.
    platform: {
      type: os.type || UNKNOWN_OS,
      version: os.version,
      utc_offset: probe.utcOffsetMinutes(),
      locale: probe.locale(),
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
    },
    app: {
      package_id: input.appId ?? 'unknown',
      version: input.appVersion ?? '0.0.0',
      build: input.appBuild ?? '0',
      debuggable: input.debuggable ?? false,
      ...(input.uptimeSeconds !== undefined &&
      Number.isFinite(input.uptimeSeconds) &&
      input.uptimeSeconds >= 0
        ? { uptime_s: Math.floor(input.uptimeSeconds) }
        : {}),
    },
    sdk: {
      version: input.sdkVersion,
      type: 'javascript',
      ...(input.sdkBuild !== undefined ? { build: input.sdkBuild } : {}),
      ...(input.options !== undefined ? { options: optionsToWire(input.options) } : {}),
    },
  };
}
