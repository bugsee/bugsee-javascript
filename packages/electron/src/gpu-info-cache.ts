// GpuInfoCache — the Electron main process's GPU description, for `environment.hardware.gpu`.
//
// `app.getGPUInfo('basic')` returns a PROMISE, and the environment is assembled synchronously, so the
// answer is kicked once at launch, cached when (if) it settles, and read live through `current()`. Until
// it settles — or forever, when it rejects (a Linux host without GPU acceleration does) — `current()` is
// `undefined` and the report simply carries no `hardware.gpu`. Nothing here may throw into the host app or
// leave a rejected Promise unhandled (the session owner's own unhandled-rejection detection would report it).
//
// `electron` is injected (`ElectronGpuSourceLike`); this package keeps no electron dependency.

import type { HardwareExtras, HardwareGpu } from '@bugsee/node';

/** The slice of Electron's `app` the cache needs. Optional on `ElectronAppLike`: older Electron has none. */
export interface ElectronGpuSourceLike {
  getGPUInfo(type: GpuInfoType): Promise<unknown>;
}

/** Electron's `app.getGPUInfo` argument. */
export type GpuInfoType = 'basic' | 'complete';

export interface GpuInfoCacheOptions {
  /** Electron's `app` (or anything with `getGPUInfo`). When absent or without `getGPUInfo`, nothing is ever cached. */
  source?: Partial<ElectronGpuSourceLike> | undefined;
  /** The `getGPUInfo` argument. Default `'basic'`. */
  type?: GpuInfoType;
  /** Sink for a rejected/throwing `getGPUInfo` (omit-never-fabricate: the error is reported, the field is absent). */
  onError?: (error: unknown) => void;
}

export interface GpuInfoCache {
  /** Kick `getGPUInfo(type)` once. A second call while started is a no-op. Never throws. */
  start(): void;
  /** Abort the in-flight read: a late resolve/reject is ignored. An ALREADY-resolved value is kept (reports still draining on stop need it). */
  stop(): void;
  /** The cached `hardware` extra, or `undefined` while unsettled / failed / unusable. */
  current(): HardwareExtras | undefined;
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/**
 * Maps Electron's GPU info to the `hardware.gpu` block, defensively. The shapes are UNVERIFIED against a real
 * Electron: `'basic'` is documented as `{ gpuDevice: [{ vendorId, deviceId, active, vendorString?,
 * deviceString?, … }], auxAttributes? }` and often carries only the numeric ids; `'complete'` is heavier and
 * is expected to carry `auxAttributes.glVendor/glRenderer/glVersion/glExtensions`.
 *
 * The ACTIVE device is used (or the only device when exactly one is listed — never a guess among several):
 * `vendorString` -> `vendor`, `deviceString` -> `renderer`. `auxAttributes` (when present) fills what the
 * device left empty: `glVendor` -> `vendor`, `glRenderer` -> `renderer`, `glVersion` -> `gl_version`,
 * `glExtensions` -> `gl_extensions` (a string). Values are trimmed and empty/whitespace-only ones dropped; a
 * numeric id is NEVER turned into a name. Nothing usable -> `undefined`.
 */
export function mapGpuInfo(info: unknown): HardwareGpu | undefined {
  if (typeof info !== 'object' || info === null) return undefined;
  const { gpuDevice, auxAttributes } = info as { gpuDevice?: unknown; auxAttributes?: unknown };
  const objects = Array.isArray(gpuDevice)
    ? gpuDevice.filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
    : [];
  const device =
    objects.find((d) => d.active === true) ?? (objects.length === 1 ? objects[0] : undefined);
  const aux =
    typeof auxAttributes === 'object' && auxAttributes !== null
      ? (auxAttributes as Record<string, unknown>)
      : {};
  const vendor = nonEmpty(device?.vendorString) ?? nonEmpty(aux.glVendor);
  const renderer = nonEmpty(device?.deviceString) ?? nonEmpty(aux.glRenderer);
  const glVersion = nonEmpty(aux.glVersion);
  const glExtensions = nonEmpty(aux.glExtensions);
  const gpu: HardwareGpu = {
    ...(vendor !== undefined ? { vendor } : {}),
    ...(renderer !== undefined ? { renderer } : {}),
    ...(glVersion !== undefined ? { gl_version: glVersion } : {}),
    ...(glExtensions !== undefined ? { gl_extensions: glExtensions } : {}),
  };
  return Object.keys(gpu).length > 0 ? gpu : undefined;
}

export function createGpuInfoCache(options: GpuInfoCacheOptions = {}): GpuInfoCache {
  let generation = 0;
  let started = false;
  let gpu: HardwareGpu | undefined;

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // the error sink itself failed; the cache must stay silent toward the host app
    }
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      const mine = ++generation;
      const source = options.source;
      if (source === undefined || typeof source.getGPUInfo !== 'function') return;
      try {
        Promise.resolve(source.getGPUInfo(options.type ?? 'basic')).then(
          (info) => {
            if (mine !== generation) return; // stopped (or restarted) since: ignore, never write
            try {
              gpu = mapGpuInfo(info);
            } catch (error) {
              report(error);
            }
          },
          (error: unknown) => {
            if (mine === generation) report(error);
          },
        );
      } catch (error) {
        report(error); // getGPUInfo threw synchronously
      }
    },
    stop(): void {
      started = false;
      generation++; // a late resolve/reject of the in-flight read is now ignored
      // The cached value is deliberately KEPT: core `stop()` drains pending reports AFTER this runs, and
      // they must still carry hardware.gpu. A new `launchMain` builds a new cache, so nothing leaks.
    },
    current(): HardwareExtras | undefined {
      return gpu === undefined ? undefined : { gpu: { ...gpu } };
    },
  };
}
