import { detectBrowser, detectOs } from '@bugsee/browser';
import { bytesToMegabytes, type EnvironmentEnvelope, optionsToWire } from '@bugsee/protocol';

// The §8.6 environment envelope for a Web Worker / Service Worker. A worker has a `navigator`
// (WorkerNavigator: userAgent, language, hardwareConcurrency, and deviceMemory on Chromium) but NO `screen`
// and NO `window` — so this is the browser envelope MINUS the screen/pixel-ratio hardware reads. System reads
// go through an injectable WorkerProbe so the mapping is testable deterministically (the worker globals are
// stubbed in tests); realWorkerProbe is the default. platform.type is the worker variant ('web-worker' /
// 'service-worker') and rides in `runtime`; `platform` carries the OS, identified in-worker from the same
// navigator the browser tier reads (see @bugsee/browser's user-agent.ts). It used to carry the worker tag
// and the raw userAgent — the same conflation fixed for the page tier in samples/FINDINGS.md F-X20.

/** The worker platform identity. */
export type WorkerPlatformType = 'web-worker' | 'service-worker';

export interface WorkerProbe {
  userAgent(): string;
  /** `navigator.userAgentData.platform` — Chromium-only; undefined elsewhere. See BrowserProbe. */
  uaDataPlatform(): string | undefined;
  locale(): string;
  /** Offset from UTC in minutes, positive east (e.g. UTC+2 → 120). */
  utcOffsetMinutes(): number;
  /** navigator.deviceMemory as bytes (GB × 1024³); undefined where unsupported (non-Chromium). */
  deviceMemoryBytes(): number | undefined;
  /** navigator.hardwareConcurrency; undefined where unexposed. */
  cpuCount(): number | undefined;
}

export const realWorkerProbe: WorkerProbe = {
  userAgent: () => navigator.userAgent,
  uaDataPlatform: () =>
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform,
  locale: () => new Intl.DateTimeFormat().resolvedOptions().locale,
  utcOffsetMinutes: () => -new Date().getTimezoneOffset(),
  deviceMemoryBytes: () => {
    const gb = (navigator as { deviceMemory?: number }).deviceMemory;
    return gb === undefined ? undefined : gb * 1024 ** 3;
  },
  cpuCount: () => (navigator as { hardwareConcurrency?: number }).hardwareConcurrency,
};

export interface WorkerEnvironmentInput {
  /** SDK package version (sdk.version). */
  sdkVersion: string;
  /** platform.type — 'web-worker' (dedicated/shared) or 'service-worker'. */
  platformType: WorkerPlatformType;
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

export function buildWorkerEnvironment(
  input: WorkerEnvironmentInput,
  probe: WorkerProbe = realWorkerProbe,
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
    platform: {
      type: os.type,
      version: os.version,
      utc_offset: probe.utcOffsetMinutes(),
      locale: probe.locale(),
      ...(deviceMemory !== undefined ? { memory_total: deviceMemory } : {}),
    },
    // Omitted rather than half-filled — see the same guard in @bugsee/browser.
    ...(browser.type !== '' ? { browser: { type: browser.type, version: browser.version } } : {}),
    // Which KIND of worker this is; the browser's version is the nearest thing it has to a runtime one.
    runtime: {
      type: input.platformType,
      version: browser.version,
    },
    hardware: {
      // No screen on a worker — only the navigator-derived hardware + the caller's device id.
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
