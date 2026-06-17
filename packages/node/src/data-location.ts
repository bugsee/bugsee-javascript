import { join } from 'node:path';

// Where the Node SDK stores captured data (server write-path P1, D3). On servers (node/bun/deno) durable
// disk capture is the DEFAULT — opt-out, not opt-in — so a crash/OOM that beats the bundle assembly still
// delivers the last recording window on the next launch. `'memory'` opts out to the legacy in-RAM path.
// When disk is on but no `dataDir` was given, the data lives under `os.tmpdir()/bugsee/<appTokenHash>`
// (sdk-design §12.5) with the per-instance subtree (multi-instance-disk-coexistence) layered under. The
// per-APP-TOKEN segment scopes recovery + the sibling sweep to THIS app, so two different Bugsee apps
// sharing a host never recover/delete each other's data through the wrong app token. An explicit `dataDir`
// overrides the location entirely.

export type CapturedDataStore = 'memory' | 'disk';

/** The default on-disk root (under the runtime tmp dir) when disk capture is on but no `dataDir` was given. */
export const DEFAULT_DATA_SUBDIR = 'bugsee';

/**
 * A small synchronous, dependency-free hash of the app token, for the default data-root path segment. NOT
 * cryptographic — it only namespaces the root per app token (so two apps sharing a host don't collide) and
 * keeps the raw token out of a world-listable path. Two FNV-1a passes → 64 bits, hex-encoded. (Synchronous +
 * no `node:crypto` so this stays usable wherever the framework adapters consume launch's source.)
 */
export function hashAppToken(appToken: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < appToken.length; i++) {
    const c = appToken.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export interface ResolvedDataLocation {
  /** The effective root dir for on-disk data (per-instance subtrees + durable bundles), or undefined. */
  dataDir: string | undefined;
  /** Whether the rolling capture buffer is persisted to disk (vs kept in memory). */
  diskCapture: boolean;
}

/**
 * Resolve the on-disk data location + whether capture goes to disk, from the launch flags. `diskCapture`
 * follows `capturedDataStore` (default `'disk'`); the location is the explicit `dataDir`, else the
 * `<tmpBase>/bugsee/<appTokenHash>` default when disk capture is on, else undefined (a pure in-memory
 * launch). An explicit `dataDir` with `capturedDataStore: 'memory'` keeps the location (durable
 * bundles/markers) but leaves capture in RAM. `appToken` is hashed to namespace the default root per app.
 */
export function resolveDataLocation(
  options: { dataDir?: string; capturedDataStore?: CapturedDataStore },
  tmpBase: string,
  appToken: string,
): ResolvedDataLocation {
  const diskCapture = (options.capturedDataStore ?? 'disk') !== 'memory';
  const dataDir =
    options.dataDir ??
    (diskCapture ? join(tmpBase, DEFAULT_DATA_SUBDIR, hashAppToken(appToken)) : undefined);
  return { dataDir, diskCapture };
}
