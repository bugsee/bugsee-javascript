import { join } from 'node:path';

// Where the Node SDK stores captured data (server write-path P1, D3). On servers (node/bun/deno) durable
// disk capture is the DEFAULT — opt-out, not opt-in — so a crash/OOM that beats the bundle assembly still
// delivers the last recording window on the next launch. `'memory'` opts out to the legacy in-RAM path.
// When disk is on but no `dataDir` was given, the data lives under `os.tmpdir()/bugsee` with the
// per-instance subtree (multi-instance-disk-coexistence) layered under, so several aggregators sharing the
// default root never collide. An explicit `dataDir` overrides the location.

export type CapturedDataStore = 'memory' | 'disk';

/** The default on-disk root (under the runtime tmp dir) when disk capture is on but no `dataDir` was given. */
export const DEFAULT_DATA_SUBDIR = 'bugsee';

export interface ResolvedDataLocation {
  /** The effective root dir for on-disk data (per-instance subtrees + durable bundles), or undefined. */
  dataDir: string | undefined;
  /** Whether the rolling capture buffer is persisted to disk (vs kept in memory). */
  diskCapture: boolean;
}

/**
 * Resolve the on-disk data location + whether capture goes to disk, from the launch flags. `diskCapture`
 * follows `capturedDataStore` (default `'disk'`); the location is the explicit `dataDir`, else the tmp
 * default when disk capture is on, else undefined (a pure in-memory launch). An explicit `dataDir` with
 * `capturedDataStore: 'memory'` keeps the location (durable bundles/markers) but leaves capture in RAM.
 */
export function resolveDataLocation(
  options: { dataDir?: string; capturedDataStore?: CapturedDataStore },
  tmpBase: string,
): ResolvedDataLocation {
  const diskCapture = (options.capturedDataStore ?? 'disk') !== 'memory';
  const dataDir = options.dataDir ?? (diskCapture ? join(tmpBase, DEFAULT_DATA_SUBDIR) : undefined);
  return { dataDir, diskCapture };
}
