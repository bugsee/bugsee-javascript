import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type { CrashpadSessionMarker, HarvestedDump, NativeCrashSource } from '@bugsee/core';

// The Electron/Crashpad NativeCrashSource (docs/design/electron-native-crashes.md §6.1). Crashpad writes a
// finalized minidump per crashed process under `<crashDumpsDir>/completed/*.dmp`. With uploadToServer:false
// it never uploads them itself — this source harvests those `.dmp`s on the next launch (the SDK bundles +
// session-stitches each) and claims (deletes) one once its bundle is delivered, so it is never re-uploaded.
// The fs is an injected seam so @bugsee/electron stays runtime-portable + unit-testable with a fake DB.
//
// v1 SCOPE: harvest ALL completed dumps and attribute them to the marker's session (its generation ties
// them to the crashed run's capture). Per-dump session matching via minidump annotation parsing (for the
// rare case of several concurrent dead siblings sharing one app-global Crashpad dir) is deferred (OQ-5);
// claim-once (delete on delivery) keeps a dump from being processed twice.

/** The subdir Crashpad finalizes completed minidumps into. `pending`/`new` hold mid-write dumps — skipped. */
const COMPLETED_DIR = 'completed';
const DUMP_SUFFIX = '.dmp';

/** The minimal filesystem seam the source needs (real impl = node:fs; a fake in tests). */
export interface CrashDumpFs {
  /** File names directly under `dir` (Crashpad's completed dir). */
  readdir(dir: string): string[];
  /** Read a dump file's bytes. */
  readFile(path: string): Uint8Array;
  /** Delete a claimed dump. */
  unlink(path: string): void;
  /** Whether a path exists (the completed dir / a specific dump). */
  exists(path: string): boolean;
}

export interface ElectronNativeCrashSourceOptions {
  /** Filesystem seam. Default node:fs (see {@link createNodeCrashDumpFs}). */
  fs: CrashDumpFs;
  /** Path join. Default node:path `join`. */
  join?: (...parts: string[]) => string;
}

/** The default node:fs-backed {@link CrashDumpFs}. */
export function createNodeCrashDumpFs(): CrashDumpFs {
  return {
    readdir: (dir: string) => readdirSync(dir),
    readFile: (path: string) => new Uint8Array(readFileSync(path)),
    unlink: (path: string) => unlinkSync(path),
    exists: (path: string) => existsSync(path),
  };
}

/** The Electron source harvests synchronously (node:fs) — a narrower shape than the async-capable seam it
 *  satisfies ({@link NativeCrashSource}); a sync `HarvestedDump[]` is assignable to the seam's union return. */
export interface ElectronNativeCrashSource {
  harvest(marker: CrashpadSessionMarker): HarvestedDump[];
  claim(marker: CrashpadSessionMarker, name: string): void;
}

export function createElectronNativeCrashSource(
  options: ElectronNativeCrashSourceOptions,
): ElectronNativeCrashSource {
  const join = options.join ?? pathJoin;
  const fs = options.fs;
  const dumpPath = (marker: CrashpadSessionMarker, name: string): string =>
    join(marker.dumpDir, COMPLETED_DIR, name);

  return {
    harvest(marker: CrashpadSessionMarker): HarvestedDump[] {
      const dir = join(marker.dumpDir, COMPLETED_DIR);
      if (!fs.exists(dir)) {
        return []; // no completed dir yet → no native crash to harvest
      }
      const dumps: HarvestedDump[] = [];
      for (const name of fs.readdir(dir)) {
        if (name.endsWith(DUMP_SUFFIX)) {
          dumps.push({ name, data: fs.readFile(join(dir, name)) });
        }
      }
      return dumps;
    },

    claim(marker: CrashpadSessionMarker, name: string): void {
      const path = dumpPath(marker, name);
      if (fs.exists(path)) {
        fs.unlink(path);
      }
    },
  };
}
