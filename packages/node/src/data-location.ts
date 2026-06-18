import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

/** The subset of `fs.Stats` the data-root security check needs (so it is testable without real files). */
export interface SecureDirStat {
  isDirectory(): boolean;
  uid: number;
  mode: number;
}

/** Injectable fs/identity seams for `ensureSecureDataRoot` (default the real node:fs + process.getuid). */
export interface SecureRootDeps {
  mkdir?: (dir: string) => void;
  lstat?: (dir: string) => SecureDirStat;
  /** This process's uid resolver; pass `undefined` to model a platform without uids (Windows). */
  getuid?: (() => number) | undefined;
}

const SECURE_DIR_MODE = 0o700;

/** Resolve this process's uid for the ownership check (POSIX); absent on Windows. */
function resolveUid(deps: SecureRootDeps): number | undefined {
  if ('getuid' in deps) {
    return deps.getuid?.();
  }
  /* v8 ignore next -- platform: process.getuid is POSIX-only (always present in CI); the Windows path is untestable here */
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * Harden + verify the PREDICTABLE, shared DEFAULT data root (`<tmp>/bugsee/<appTokenHash>`) before any
 * capture is written there. `mkdirSync(recursive)` is a NO-OP on a pre-existing directory — it does NOT
 * re-apply the mode — so a local attacker who pre-creates `<tmp>/bugsee` owns it and could rename/symlink the
 * SDK's subtree out from under us, or redirect our `0600` writes (CWE-377 insecure-temp / CWE-59 symlink).
 * After creating each level (base then per-token leaf), `lstat` it and REFUSE — throw, so the launch canary
 * DEGRADES to in-memory capture — unless it is a real directory (not a symlink), owned by this user, with no
 * group/other access. Only the default tmp root is checked; an explicit `dataDir` is the caller's own choice.
 * On a platform without uids (Windows) the ownership check is skipped; the is-a-directory + mode checks remain.
 */
export function ensureSecureDataRoot(dataDir: string, deps: SecureRootDeps = {}): void {
  const mkdir =
    deps.mkdir ??
    ((dir: string): void => {
      mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });
    });
  const lstat = deps.lstat ?? ((dir: string): SecureDirStat => lstatSync(dir));
  const ourUid = resolveUid(deps);
  // Verify the per-app base (<tmp>/bugsee) BEFORE creating the per-token leaf inside it, so the leaf is
  // never created through a foreign/symlinked base.
  for (const dir of [dirname(dataDir), dataDir]) {
    mkdir(dir);
    const stat = lstat(dir);
    if (!stat.isDirectory()) {
      throw new Error(`Bugsee data root is not a directory (symlink/file in the path): ${dir}`);
    }
    if (ourUid !== undefined && stat.uid !== ourUid) {
      throw new Error(`Bugsee data root is not owned by this user (pre-created/foreign): ${dir}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`Bugsee data root is group/other-accessible (unsafe mode): ${dir}`);
    }
  }
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
