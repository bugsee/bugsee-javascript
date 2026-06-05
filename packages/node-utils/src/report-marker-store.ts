import { join } from 'node:path';
import type { ReportMarker, ReportMarkerStore } from '@bugsee/core';
import { ensureDir, listFiles, readFileBytes, remove, writeFileSecure } from './fs-storage';

// Node implementation of core's ReportMarkerStore (capture recovery, the detected-incident gap) — one
// owner-only (0o600) JSON file per pending incident under `dir`, named `<reportId>.marker`. The
// directory must be STABLE across launches (not per-generation) so the next launch can read what a
// crashed run left. A corrupt/torn marker is skipped, routed to onError, and purged (mirroring the
// durable bundle queue's recover()). @bugsee/node points capture recovery at this; bun/electron reuse it.

const SUFFIX = '.marker';

export function createNodeReportMarkerStore(
  dir: string,
  onError: (error: unknown) => void = (): void => {},
): ReportMarkerStore {
  ensureDir(dir);
  const pathFor = (id: string): string => join(dir, `${id}${SUFFIX}`);
  return {
    put(marker: ReportMarker): void {
      writeFileSecure(pathFor(marker.request.id), new TextEncoder().encode(JSON.stringify(marker)));
    },

    list(): ReportMarker[] {
      const markers: ReportMarker[] = [];
      for (const name of listFiles(dir)) {
        if (!name.endsWith(SUFFIX)) {
          continue;
        }
        const path = join(dir, name);
        try {
          // A torn/corrupt marker — or one removed between list and read (decode(undefined) → '') —
          // throws on parse and is purged.
          markers.push(JSON.parse(new TextDecoder().decode(readFileBytes(path))) as ReportMarker);
        } catch (error) {
          onError(error);
          remove(path); // purge an unparseable leftover
        }
      }
      return markers;
    },

    remove(id: string): void {
      remove(pathFor(id));
    },
  };
}
