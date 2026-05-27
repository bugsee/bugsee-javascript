import { join } from 'node:path';
import type { FileStorageAdapter } from '@bugsee/core';
import { appendFileSecure, ensureDir, listFiles, readFileBytes, remove } from './fs-storage';

// The Node implementation of core's FileStorageAdapter (design §3.4) — one file per stream under
// `dir`, owner-only (0o600). @bugsee/node passes this to core's createFileCaptureStore; bun and
// electron-main reuse it (deno ships a Deno.* adapter). The directory is created on construction.

export function createNodeFileStorageAdapter(dir: string): FileStorageAdapter {
  ensureDir(dir);
  const pathFor = (name: string): string => join(dir, name);
  return {
    append(name: string, data: string): void {
      appendFileSecure(pathFor(name), data);
    },
    read(name: string): string | undefined {
      const bytes = readFileBytes(pathFor(name));
      return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');
    },
    names(): string[] {
      return listFiles(dir);
    },
    remove(name: string): void {
      remove(pathFor(name));
    },
  };
}
