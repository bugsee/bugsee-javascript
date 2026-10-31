import { createReadStream, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BundleBody, BundleSink, BundleSinkWriter } from '@bugsee/core';
import { writeFully } from './write-fully';

// The node/electron-main sink for the streaming export (docs/design/streaming-export.md §4.5): the zip is written to a
// temp file under `dir` as it is built, and the finished body streams it from disk — a report never holds its bundle in
// the heap. The body owns the file: `dispose()` deletes it. Files are owner-only (0o600) like every other file here.

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const PREFIX = 'export-';
const SUFFIX = '.zip';

let counter = 0;
const uniqueName = (): string => {
  counter += 1;
  return `${PREFIX}${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 10)}${SUFFIX}`;
};

function fileBody(path: string, size: number): BundleBody {
  return {
    size,
    stream: (): AsyncIterable<Uint8Array> => createReadStream(path) as AsyncIterable<Uint8Array>,
    bytes: async (): Promise<Uint8Array> => new Uint8Array(await readFile(path)),
    peek: (): undefined => undefined,
    ready: async (): Promise<void> => {
      await stat(path); // rejects when the file is gone
    },
    dispose: async (): Promise<void> => {
      try {
        await unlink(path);
      } catch {
        // already gone
      }
    },
  };
}

/** A sink writing each export to its own temp file under `dir` (created owner-only on first use). */
export function createFileBundleSink(dir: string): BundleSink {
  return {
    async open(): Promise<BundleSinkWriter> {
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      const path = join(dir, uniqueName());
      const handle = await open(path, 'wx', FILE_MODE);
      let size = 0;
      let closed = false;
      const close = async (): Promise<void> => {
        if (!closed) {
          closed = true;
          await handle.close();
        }
      };
      return {
        async write(chunk): Promise<void> {
          await writeFully(handle, chunk); // a short write must not leave the file silently short
          size += chunk.length;
        },
        async finish(): Promise<BundleBody> {
          await close();
          return fileBody(path, size);
        },
        async abort(): Promise<void> {
          try {
            await close();
          } catch {
            // closing a failed handle can fail again; the file is removed regardless
          }
          try {
            await unlink(path);
          } catch {
            // already gone
          }
        },
      };
    },
  };
}

/**
 * Delete export files in `dir` untouched for longer than `olderThanMs` (a crash left them). Returns how many went. Meant
 * for a directory this process owns (the per-instance data subtree), so a live export of a sibling is never swept.
 */
export function sweepStaleExports(dir: string, olderThanMs: number): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // no directory, nothing to sweep
  }
  let removed = 0;
  const cutoff = Date.now() - olderThanMs;
  for (const name of names) {
    if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) {
      continue;
    }
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true });
        removed += 1;
      }
    } catch {
      // vanished between listing and stat
    }
  }
  return removed;
}
