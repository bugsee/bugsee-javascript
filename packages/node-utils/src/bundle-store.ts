import { join } from 'node:path';
import type { BundleStore } from '@bugsee/core';
import { ensureDir, listFiles, readFileBytes, remove, writeFileAtomic } from './fs-storage';

// Node implementation of core's BundleStore (the durable bundle queue's storage, design §7.8) — one
// owner-only (0o600) file per pending bundle under `dir`, named `<id>.bundle`. @bugsee/node points
// the durable upload pipeline at this; bun and electron-main reuse it (deno ships a Deno.* store).
// The directory must be STABLE across launches (not per-generation) so recover() can re-upload what a
// prior run left behind. Ids are assumed filename-safe (the pipeline's default ids are digits/dashes).

const SUFFIX = '.bundle';

export function createNodeBundleStore(dir: string): BundleStore {
  ensureDir(dir);
  const pathFor = (id: string): string => join(dir, `${id}${SUFFIX}`);
  return {
    put(id: string, bytes: Uint8Array): void {
      // ATOMIC. `<id>.bundle` is a deterministic name that `recover()` treats as a complete artifact —
      // it parses the frame header and uploads whatever body follows — so a truncated file here is a
      // corrupt bundle delivered as if it were valid. A temp sibling + rename means the name only ever
      // refers to a fully written file. Android holds the same invariant.
      writeFileAtomic(pathFor(id), bytes);
    },
    list(): string[] {
      return (
        listFiles(dir)
          // `.tmp` siblings never match, so a partial write in flight is invisible to recovery.
          .filter((name) => name.endsWith(SUFFIX))
          .map((name) => name.slice(0, -SUFFIX.length))
      );
    },
    read(id: string): Uint8Array | undefined {
      return readFileBytes(pathFor(id));
    },
    remove(id: string): void {
      remove(pathFor(id));
    },
  };
}
