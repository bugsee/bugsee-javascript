import { join } from 'node:path';
import type { BundleStore } from '@bugsee/core';
import { ensureDir, listFiles, readFileBytes, remove, writeFileSecure } from './fs-storage';

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
      writeFileSecure(pathFor(id), bytes);
    },
    list(): string[] {
      return listFiles(dir)
        .filter((name) => name.endsWith(SUFFIX))
        .map((name) => name.slice(0, -SUFFIX.length));
    },
    read(id: string): Uint8Array | undefined {
      return readFileBytes(pathFor(id));
    },
    remove(id: string): void {
      remove(pathFor(id));
    },
  };
}
