import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { RegistrationVerifier } from '@bugsee/core';
import { resolveFramePath } from './source-context';

// #185. Under `--enable-source-maps` a debug-ID registration's top frame may have been mapped to an ORIGINAL file
// (`src/main.js`) instead of the stamped bundle. The bundle a registration belongs to is proven by the file
// itself: `sourcemaps inject` leaves `//# debugId=<id>` in its tail (same marker the bundler plugin reads, see
// `bundler-plugin-core/src/debug-ids.ts`; duplicated here because node must not depend on the build tooling), so a
// registration is genuine only if its top-frame file still carries that id. Core cannot read files; node supplies this.

const MARKER = '//# debugId=';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAIL_BYTES = 16 * 1024;
/** A registration's file does not change during a process, so answers are cached (bounded; emptied when full). */
const CACHE_MAX = 4096;

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
 * The filesystem paths a scrubbed frame `file` may denote, most literal first.
 *
 * Core's scrubber strips `file://` by slicing WITHOUT URL-decoding, so an ESM frame arrives percent-encoded and may
 * carry the import's `?v=1` / `#hash`: `/…/my%20app/dist/a.mjs` (posix), `/C:/app/dist/a.mjs` (Windows), and, for the
 * common case of a file UNDER the app root, `./dist/my%20chunk.mjs?v=1`. The literal path is tried first (a file
 * really named `a%20b`), then the decoded reading with the query/hash stripped, then the stripped literal.
 */
function candidatePaths(file: string, appRoot: string): string[] {
  if (file.startsWith('file://')) {
    return [fileURLToPath(file)];
  }
  const candidates = [resolveFramePath(file, appRoot)];
  const bare = file.replace(/[?#].*$/, '');
  let decoded: string | undefined;
  try {
    // An absolute posix/`/C:/` path goes through the file-URL reading (it also yields `C:\…` on a win32 host); a
    // relative one is a plain percent-decode.
    decoded = file.startsWith('/')
      ? fileURLToPath(`file://${bare}`)
      : resolveFramePath(decodeURIComponent(bare), appRoot);
  } catch {
    // a literal `%` / `%2F` in a real name is not a valid encoding; the literal path stands
  }
  if (decoded !== undefined) {
    candidates.push(decoded);
  }
  if (bare !== file) {
    candidates.push(resolveFramePath(bare, appRoot));
  }
  return candidates;
}

/** Errors that mean "there is no such file" (a stable answer), as opposed to a transient EMFILE / EACCES / EIO. */
const NO_SUCH_FILE = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EISDIR', 'EINVAL']);

/**
 * A {@link RegistrationVerifier}: true only when `file` (a scrubbed frame path: absolute, app-relative `./x`, a
 * URL-encoded ESM path or a `file://` URL) exists and ends with the registered debug-id stamp. Any failure (missing
 * file, bad URL) is a rejection, never a throw: a registration that cannot be proven is not joined on. Definitive
 * answers are cached per (file, id), so a report costs no file I/O after the first; an INCONCLUSIVE one (a transient
 * read error such as EMFILE) is not cached and is asked again next time.
 */
export function createStampedBundleVerifier(
  options: { appRoot?: string; readTail?: (path: string) => string } = {},
): RegistrationVerifier {
  const read = options.readTail ?? readTail;
  const cache = new Map<string, boolean>();
  /** true / false when definitive, undefined when a transient error stopped the check. */
  const check = (file: string, debugId: string): boolean | undefined => {
    const wanted = debugId.toLowerCase();
    let transient = false;
    for (const path of candidatePaths(file, options.appRoot ?? process.cwd())) {
      try {
        return readStampedDebugId(read(path)) === wanted;
      } catch (error) {
        // not openable under this reading; try the next
        const code = (error as { code?: unknown }).code;
        if (typeof code !== 'string' || !NO_SUCH_FILE.has(code)) {
          transient = true;
        }
      }
    }
    return transient ? undefined : false;
  };
  return (file, debugId) => {
    const key = `${file}\0${debugId}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      return hit;
    }
    let verdict: boolean | undefined;
    try {
      verdict = check(file, debugId);
    } catch {
      verdict = undefined; // a malformed file URL / cwd failure: reject now, ask again later
    }
    if (verdict === undefined) {
      return false;
    }
    if (cache.size >= CACHE_MAX) {
      cache.clear();
    }
    cache.set(key, verdict);
    return verdict;
  };
}
