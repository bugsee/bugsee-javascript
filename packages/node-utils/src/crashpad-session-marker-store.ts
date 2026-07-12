import { join } from 'node:path';
import type { CrashpadSessionMarker } from '@bugsee/core';
import { ensureDir, listFiles, readFileBytes, remove, writeFileSecure } from './fs-storage';

// Node store for the SINGLE crashpad-session marker (native-crash recovery — docs/design/
// electron-native-crashes.md §6.1). Unlike ReportMarkerStore (a directory of per-incident markers), a
// launch has exactly ONE Crashpad session, so this is a single owner-only (0o600) `crashpad-session.json`
// under the instance's `incidents/` dir. Persisted at START (links the Crashpad dump dir -> this
// generation + session); read on the NEXT launch when a DEAD sibling subtree is recovered. A corrupt marker
// is routed to onError, purged, and treated as absent.

const FILENAME = 'crashpad-session.json';

/** Persist / read / clear a launch's single crashpad-session marker. */
export interface CrashpadSessionMarkerStore {
  /** Persist (replacing any prior) this launch's marker. */
  put(marker: CrashpadSessionMarker): void;
  /** The persisted marker, or undefined when absent/corrupt. */
  read(): CrashpadSessionMarker | undefined;
  /** Remove the marker; a no-op when absent. */
  remove(): void;
}

export function createNodeCrashpadSessionMarkerStore(
  dir: string,
  onError: (error: unknown) => void = (): void => {},
): CrashpadSessionMarkerStore {
  ensureDir(dir);
  const path = join(dir, FILENAME);
  return {
    put(marker: CrashpadSessionMarker): void {
      writeFileSecure(path, new TextEncoder().encode(JSON.stringify(marker)));
    },

    read(): CrashpadSessionMarker | undefined {
      // Only exists if written — listFiles avoids an ENOENT for the whole dir.
      if (!listFiles(dir).includes(FILENAME)) {
        return undefined;
      }
      try {
        return JSON.parse(new TextDecoder().decode(readFileBytes(path))) as CrashpadSessionMarker;
      } catch (error) {
        onError(error);
        remove(path); // purge an unparseable leftover so it can't wedge recovery forever
        return undefined;
      }
    },

    remove(): void {
      remove(path);
    },
  };
}
