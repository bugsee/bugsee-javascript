// Electron GPU description -> a neutral `{vendor?, renderer?, gl_version?, gl_extensions?}` block (the same
// field names `environment.hardware.gpu` carries; `@bugsee/node` types that as `HardwareGpu`, which this block is
// structurally assignable to; this package does not depend on it).
//
// The shapes of `app.getGPUInfo` are UNVERIFIED against a real Electron (see mapGpuInfo).

/** The mapped GPU description. Every field is optional and only present when Electron supplied a usable string. */
export interface ElectronGpu {
  vendor?: string;
  renderer?: string;
  gl_version?: string;
  gl_extensions?: string;
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
export function mapGpuInfo(info: unknown): ElectronGpu | undefined {
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
  const gpu: ElectronGpu = {
    ...(vendor !== undefined ? { vendor } : {}),
    ...(renderer !== undefined ? { renderer } : {}),
    ...(glVersion !== undefined ? { gl_version: glVersion } : {}),
    ...(glExtensions !== undefined ? { gl_extensions: glExtensions } : {}),
  };
  return Object.keys(gpu).length > 0 ? gpu : undefined;
}
