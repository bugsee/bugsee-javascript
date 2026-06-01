import os from 'node:os';
import process from 'node:process';
import { serviceToken } from '@bugsee/core';
import { type EnvironmentEnvelope, optionsToWire } from '@bugsee/protocol';

// Builds the §8.6 environment envelope for Node from process/os. System reads go through an
// injectable SystemProbe so the mapping is testable deterministically; realSystemProbe is the
// default. Pure given (input, probe) — persistence (device_id generation) is the caller's concern.
// Canonical (dotted) option keys are translated to colon wire form for sdk.options here, because the
// server treats dots as nested-document paths (§2.4).

export interface SystemProbe {
  nodeVersion(): string;
  osType(): string;
  osRelease(): string;
  machine(): string;
  cpuCount(): number;
  totalMemory(): number;
  /** Offset from UTC in minutes, positive east (e.g. UTC+2 → 120). */
  utcOffsetMinutes(): number;
  locale(): string;
}

// Service token for the Node SystemProbe — Node-specific (other platforms supply different probes), so
// the token lives here, not in core; `launch` registers the resolved probe so it is resolvable.
export const SystemProbeToken = serviceToken<SystemProbe>('systemProbe');

export const realSystemProbe: SystemProbe = {
  nodeVersion: () => process.versions.node,
  osType: () => os.type(),
  osRelease: () => os.release(),
  machine: () => os.machine(),
  cpuCount: () => os.cpus().length,
  totalMemory: () => os.totalmem(),
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

export function buildNodeEnvironment(
  input: NodeEnvironmentInput,
  probe: SystemProbe = realSystemProbe,
): EnvironmentEnvelope {
  const memoryTotal = probe.totalMemory();
  return {
    platform: {
      type: 'node',
      version: probe.nodeVersion(),
      kernel_version: probe.osRelease(),
      utc_offset: probe.utcOffsetMinutes(),
      memory_total: memoryTotal,
      locale: probe.locale(),
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
