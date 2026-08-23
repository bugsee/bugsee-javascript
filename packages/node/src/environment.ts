import os from 'node:os';
import process from 'node:process';
import { serviceToken } from '@bugsee/core';
import {
  bytesToMegabytes,
  type EnvironmentEnvelope,
  optionsToWire,
  type RuntimeType,
} from '@bugsee/protocol';

// Builds the §8.6 environment envelope for Node from process/os. System reads go through an
// injectable SystemProbe so the mapping is testable deterministically; realSystemProbe is the
// default. Pure given (input, probe) — persistence (device_id generation) is the caller's concern.
// Canonical (dotted) option keys are translated to colon wire form for sdk.options here, because the
// server treats dots as nested-document paths (§2.4).

export interface SystemProbe {
  /** The runtime tag for environment.runtime.type ('node' here; a sibling tier supplies e.g. 'bun'). */
  platformType(): RuntimeType;
  /** The runtime's own version string for environment.runtime.version (process.versions.node here). */
  runtimeVersion(): string;
  /** os.type() — the kernel name ('Darwin'/'Linux'/'Windows_NT'); surfaces as hardware.manufacturer. */
  osType(): string;
  /** os.platform() — the OS id ('darwin'/'linux'/'win32'), mapped to the wire's platform.type. */
  osPlatform(): string;
  /** os.release() — platform.version + platform.kernel_version. */
  osRelease(): string;
  /** os.arch() — platform.arch. */
  osArch(): string;
  machine(): string;
  cpuCount(): number;
  /** Total system memory in BYTES (os.totalmem); the builder converts to the wire's megabytes. */
  totalMemory(): number;
  /** Free system memory in BYTES (os.freemem); the builder converts to the wire's megabytes. */
  freeMemory(): number;
  /** Offset from UTC in minutes, positive east (e.g. UTC+2 → 120). */
  utcOffsetMinutes(): number;
  locale(): string;
}

// Service token for the Node SystemProbe — Node-specific (other platforms supply different probes), so
// the token lives here, not in core; `launch` registers the resolved probe so it is resolvable.
export const SystemProbeToken = serviceToken<SystemProbe>('systemProbe');

export const realSystemProbe: SystemProbe = {
  platformType: () => 'node',
  runtimeVersion: () => process.versions.node,
  osType: () => os.type(),
  osPlatform: () => os.platform(),
  osRelease: () => os.release(),
  osArch: () => os.arch(),
  machine: () => os.machine(),
  cpuCount: () => os.cpus().length,
  totalMemory: () => os.totalmem(),
  freeMemory: () => os.freemem(),
  utcOffsetMinutes: () => -new Date().getTimezoneOffset(),
  locale: () => new Intl.DateTimeFormat().resolvedOptions().locale,
};

export interface NodeEnvironmentInput {
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

// os.platform() → the wire's platform.type. Named for the OS as a user knows it, and matching the set
// bugsee-rust already reports for the same hosts ('macos' | 'linux' | 'windows'); anything else passes
// through as node names it, which is still an OS name and still better than a runtime tag.
export function osPlatformToWire(osPlatform: string): string {
  if (osPlatform === 'darwin') return 'macos';
  if (osPlatform === 'win32') return 'windows';
  return osPlatform;
}

export function buildNodeEnvironment(
  input: NodeEnvironmentInput,
  probe: SystemProbe = realSystemProbe,
): EnvironmentEnvelope {
  // MEGABYTES on the wire (see @bugsee/protocol bytesToMegabytes): every Bugsee SDK reports
  // platform.memory_* in MB and the viewer divides by 1024 again to render GB. `memory_free` is the
  // Android-canonical sibling of `memory_total`, which the viewer already renders as "Free RAM".
  const memoryTotal = bytesToMegabytes(probe.totalMemory());
  const memoryFree = bytesToMegabytes(probe.freeMemory());
  return {
    // The OS, not the runtime. `type` matches what Bugsee's other host-level SDK reports
    // ('macos'/'linux'/'windows' — bugsee-rust asserts exactly that set), and `version` is the OS
    // release, which the backend indexes as `os_version`. Node exposes no portable PRODUCT version, so
    // os.release() serves as both: it is the true kernel release on macOS/Linux and the actual OS
    // build on Windows. The runtime that used to occupy these two fields now has its own block below.
    platform: {
      type: osPlatformToWire(probe.osPlatform()),
      version: probe.osRelease(),
      kernel_version: probe.osRelease(),
      arch: probe.osArch(),
      utc_offset: probe.utcOffsetMinutes(),
      memory_total: memoryTotal,
      memory_free: memoryFree,
      locale: probe.locale(),
    },
    runtime: {
      type: probe.platformType(),
      version: probe.runtimeVersion(),
    },
    hardware: {
      model: probe.machine(),
      manufacturer: probe.osType(),
      cpu_count: probe.cpuCount(),
      memory_total: memoryTotal,
      device_id: input.deviceId ?? null,
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
