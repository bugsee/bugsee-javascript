import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BundleBody, BundleStore } from '@bugsee/core';
import { ensureDir, listFiles, readFileBytes, remove, writeFileAtomic } from './fs-storage';
import { writeFully } from './write-fully';

// Node implementation of core's BundleStore (the durable bundle queue's storage) — one
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
    async putFrame(id: string, header: Uint8Array, body: BundleBody): Promise<void> {
      // The same atomic-publish discipline as `put`, with the body streamed: header, then each chunk, fsync, rename. The
      // name only ever refers to a complete frame; a failure at any point removes the temp sibling and leaves an existing
      // blob of that id untouched.
      const file = pathFor(id);
      const temp = `${file}.${process.pid}.tmp`;
      try {
        const handle = await open(temp, 'w', 0o600);
        try {
          await writeFully(handle, header);
          for await (const chunk of body.stream()) {
            await writeFully(handle, chunk);
          }
          await handle.sync(); // durable BEFORE the rename, so the rename cannot publish a short file
        } finally {
          await handle.close();
        }
        await rename(temp, file);
      } catch (error) {
        try {
          await unlink(temp);
        } catch {
          // already gone
        }
        throw error;
      }
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
