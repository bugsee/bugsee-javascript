import { serviceToken } from '@bugsee/core';
import { bytesToMegabytes, type EnvironmentEnvelope, optionsToWire } from '@bugsee/protocol';

// Builds the §8.6 environment envelope for the browser from navigator/screen/window/Intl. System reads
// go through an injectable BrowserProbe so the mapping is testable deterministically (the DOM globals
// are stubbed in tests); realBrowserProbe is the default. Pure given (input, probe) — persistence
// (device_id) is the caller's concern. Canonical (dotted) option keys are translated to colon wire form
// for sdk.options here, because the server treats dots as nested-document paths (§2.4).
//
// UA parsing is deliberately deferred: platform.version carries the raw navigator.userAgent and the
// backend parses it (a client-side parser is fragile under UA reduction/freezing). hardware.model /
// manufacturer are omitted for the same reason. deviceMemory + hardwareConcurrency are non-standard /
// not-everywhere, so their readers are optional and the builder omits absent fields.

export interface BrowserProbe {
  userAgent(): string;
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
  return {
    platform: {
      type: 'web',
      version: probe.userAgent(),
      utc_offset: probe.utcOffsetMinutes(),
      locale: probe.locale(),
      ...(deviceMemory !== undefined ? { memory_total: deviceMemory } : {}),
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
