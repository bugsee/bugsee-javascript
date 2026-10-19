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
  getGPUInfo(type: 'basic'): Promise<unknown>;
}

export interface GpuInfoCacheOptions {
  /** Electron's `app` (or anything with `getGPUInfo`). When absent or without `getGPUInfo`, nothing is ever cached. */
  source?: Partial<ElectronGpuSourceLike> | undefined;
  /** Sink for a rejected/throwing `getGPUInfo` (omit-never-fabricate: the error is reported, the field is absent). */
  onError?: (error: unknown) => void;
}

export interface GpuInfoCache {
  /** Kick `getGPUInfo('basic')` once. A second call while started is a no-op. Never throws. */
  start(): void;
  /** Abort: a late resolve is ignored and the cached value is dropped. A later `start()` begins afresh. */
  stop(): void;
  /** The cached `hardware` extra, or `undefined` while unsettled / failed / unusable. */
  current(): HardwareExtras | undefined;
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/**
 * Maps Electron's `'basic'` GPU info to `{vendor, renderer}` defensively. The shape is UNVERIFIED against a
 * real Electron: `basic` is documented as `{ gpuDevice: [{ vendorId, deviceId, active, vendorString?,
 * deviceString?, … }] }`. The ACTIVE device is used (or the only device when exactly one is listed — never a
 * guess among several); `vendorString`/`deviceString` fill `vendor`/`renderer` ONLY when they are real
 * strings. A numeric id is never turned into a vendor name. Nothing usable → `undefined`.
 */
export function mapGpuInfo(info: unknown): HardwareGpu | undefined {
  if (typeof info !== 'object' || info === null) return undefined;
  const devices = (info as { gpuDevice?: unknown }).gpuDevice;
  if (!Array.isArray(devices)) return undefined;
  const objects = devices.filter(
    (d): d is Record<string, unknown> => typeof d === 'object' && d !== null,
  );
  const device =
    objects.find((d) => d.active === true) ?? (objects.length === 1 ? objects[0] : undefined);
  if (device === undefined) return undefined;
  const vendor = nonEmpty(device.vendorString);
  const renderer = nonEmpty(device.deviceString);
  if (vendor === undefined && renderer === undefined) return undefined;
  return {
    ...(vendor !== undefined ? { vendor } : {}),
    ...(renderer !== undefined ? { renderer } : {}),
  };
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
        Promise.resolve(source.getGPUInfo('basic')).then(
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
      generation++;
      gpu = undefined;
    },
    current(): HardwareExtras | undefined {
      return gpu === undefined ? undefined : { gpu: { ...gpu } };
    },
  };
}
