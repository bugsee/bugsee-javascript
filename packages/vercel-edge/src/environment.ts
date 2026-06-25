import { type EnvironmentEnvelope, optionsToWire, type PlatformType } from '@bugsee/protocol';

// The §8.6 environment envelope for edge runtimes (Vercel Edge / Cloudflare Workers). MINIMAL by necessity:
// an edge isolate has no os/process/hardware access — no cpu/memory/kernel reads — so we omit the `hardware`
// bag entirely (it's optional on the wire) and fill only `platform.type`/`version` (both required), the
// cheap `Intl`-derived utc_offset + locale (available on edge), plus `app` + `sdk`. The runtime exposes no
// clean version string, so `platform.version` defaults to empty. Pure given its input (utc_offset/locale are
// injectable for deterministic tests; the defaults read the real `Date`/`Intl`).

export interface EdgeEnvironmentInput {
  /** SDK package version (sdk.version). */
  sdkVersion: string;
  /** environment.platform.type — 'edge-light' (Vercel Edge) or 'workers' (Cloudflare). */
  platformType: PlatformType;
  /** platform.version — the edge runtime version, if any. Default '' (edge exposes none cleanly). */
  runtimeVersion?: string;
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
  /** Offset from UTC in minutes, positive east. Default the real timezone offset. */
  utcOffsetMinutes?: number;
  /** BCP-47 locale. Default the real resolved locale. */
  locale?: string;
}

export function buildEdgeEnvironment(input: EdgeEnvironmentInput): EnvironmentEnvelope {
  return {
    platform: {
      type: input.platformType,
      version: input.runtimeVersion ?? '',
      utc_offset: input.utcOffsetMinutes ?? -new Date().getTimezoneOffset(),
      locale: input.locale ?? new Intl.DateTimeFormat().resolvedOptions().locale,
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
