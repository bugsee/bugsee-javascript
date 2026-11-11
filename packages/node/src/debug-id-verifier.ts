import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { RegistrationVerifier } from '@bugsee/core';
import { resolveFramePath } from './source-context';

// #185. Under `--enable-source-maps` a debug-ID registration's top frame may have been mapped to an ORIGINAL file
// (`src/main.js`) instead of the stamped bundle. The bundle a registration belongs to is proven by the file
// itself: `sourcemaps inject` leaves `//# debugId=<id>` in its tail (same marker the bundler plugin reads), so a
// registration is genuine only if its top-frame file still carries that id. Core cannot read files; node supplies this.

const MARKER = '//# debugId=';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAIL_BYTES = 16 * 1024;

/** The LAST `//# debugId=` stamp in `content` when it is a UUID (the bundler plugin's `readDebugId` rule). */
export function readStampedDebugId(content: string): string | undefined {
  const at = content.lastIndexOf(MARKER);
  if (at === -1) {
    return undefined;
  }
  const token = content
    .slice(at + MARKER.length)
    .trimStart()
    .slice(0, 36)
    .toLowerCase();
  return UUID_RE.test(token) ? token : undefined;
}

function readTail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * A {@link RegistrationVerifier}: true only when `file` (a scrubbed frame path: absolute, app-relative `./x`, or a
 * `file://` URL) exists and ends with the registered debug-id stamp. Any failure (missing file, bad URL) is a
 * rejection, never a throw: a registration that cannot be proven is not joined on.
 */
export function createStampedBundleVerifier(
  options: { appRoot?: string } = {},
): RegistrationVerifier {
  return (file, debugId) => {
    try {
      const path = file.startsWith('file://') ? fileURLToPath(file) : file;
      const stamped = readStampedDebugId(
        readTail(resolveFramePath(path, options.appRoot ?? process.cwd())),
      );
      return stamped === debugId.toLowerCase();
    } catch {
      return false;
    }
  };
}
