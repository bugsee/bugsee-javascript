import {
  BOOLEAN_OPTION,
  FAIL_CLOSED_BOOLEAN_OPTION,
  FAIL_CLOSED_BOOLEAN_OR_BAG_OPTION,
  type OptionDefinition,
} from '@bugsee/core';

// @bugsee/node owns its platform-specific diagnostic options. These have NO Android counterpart and no
// cross-SDK identity, so — per the @bugsee/protocol convention (and as @bugsee/performance does) — they are
// declared HERE, not in the cross-SDK BugseeOption enum: the canonical com.bugsee.option.profiling.*
// identifiers, the typed value contract declaration-merged into BugseeOptionTypes, and the
// friendly→canonical definitions launch feeds to the resolver. (ANR/hang options join this module too.)

export const ProfilingOption = {
  /** Attach a rolling V8 CPU profile to incident bundles. Default off (overhead). */
  Enabled: 'com.bugsee.option.profiling.enabled',
  /** CPU profiler sampling interval in microseconds (lower = higher resolution + overhead). */
  SamplingInterval: 'com.bugsee.option.profiling.sampling-interval-micros',
} as const;

declare module '@bugsee/protocol' {
  interface BugseeOptionTypes {
    'com.bugsee.option.profiling.enabled': boolean;
    'com.bugsee.option.profiling.sampling-interval-micros': number;
  }
}

/** Friendly → canonical option definitions for the launch resolver. Profiling is opt-in (overhead). */
export const PROFILING_OPTION_DEFINITIONS: readonly OptionDefinition[] = [
  { friendly: 'profiling', key: ProfilingOption.Enabled, default: false, ...BOOLEAN_OPTION },
  {
    friendly: 'profilingSamplingIntervalMicros',
    key: ProfilingOption.SamplingInterval,
    default: 1000,
  },
];

export const NodeTraceOption = {
  /** Report `disk_mem_free` / `disk_mem_total` for the volume the data dir lives on. Opt-in (iOS parity). */
  CaptureDiskSpace: 'com.bugsee.option.node.capture-disk-space',
} as const;

declare module '@bugsee/protocol' {
  interface BugseeOptionTypes {
    'com.bugsee.option.node.capture-disk-space': boolean;
  }
}

/** Disk space is opt-in: only boolean `true` enables it. */
export const NODE_TRACE_OPTION_DEFINITIONS: readonly OptionDefinition[] = [
  {
    friendly: 'captureDiskSpace',
    key: NodeTraceOption.CaptureDiskSpace,
    default: false,
    ...BOOLEAN_OPTION,
  },
];

/**
 * Node-local identifiers for the opt-in enrichment / instrumentation switches that used to be read raw
 * (`captureLocalVariables: 0`, `null`, `''` and `'false'` turned them ON). No cross-SDK identity.
 */
export const NodePrivacyOption = {
  /** Collect local variables of the crash frames (opt-in: it reads application data). */
  CaptureLocalVariables: 'com.bugsee.option.capture.local-variables',
  /** Attach source lines around the crash frames (opt-in: it reads application source). */
  CaptureSourceContext: 'com.bugsee.option.capture.source-context',
  /** Auto-instrument incoming server requests. Default on; only boolean `false` opts out. */
  InstrumentIncomingRequests: 'com.bugsee.option.server.instrument-incoming-requests',
  /** Inject `traceparent` on outgoing requests (node's OWN switch; allowlist-gated). Default on; only `true` keeps it on. */
  PropagateTrace: 'com.bugsee.option.node.propagate-trace',
} as const;

/**
 * Friendly → canonical definitions. `captureLocalVariables` / `captureSourceContext` accept `true` or an options
 * object (recorded as `true`; the bag itself is read from the host's options): anything else is OFF + reported.
 * `instrumentIncomingRequests` and `propagateTrace` are ON by default and capture/emit data, so an invalid value is
 * OFF and reported; only boolean `false` is a deliberate opt-out.
 */
export const NODE_PRIVACY_OPTION_DEFINITIONS: readonly OptionDefinition[] = [
  {
    friendly: 'captureLocalVariables',
    key: NodePrivacyOption.CaptureLocalVariables,
    default: false,
    ...FAIL_CLOSED_BOOLEAN_OR_BAG_OPTION,
  },
  {
    friendly: 'captureSourceContext',
    key: NodePrivacyOption.CaptureSourceContext,
    default: false,
    ...FAIL_CLOSED_BOOLEAN_OR_BAG_OPTION,
  },
  {
    friendly: 'instrumentIncomingRequests',
    key: NodePrivacyOption.InstrumentIncomingRequests,
    default: true,
    ...FAIL_CLOSED_BOOLEAN_OPTION,
  },
  {
    friendly: 'propagateTrace',
    key: NodePrivacyOption.PropagateTrace,
    default: true,
    ...FAIL_CLOSED_BOOLEAN_OPTION,
  },
];
