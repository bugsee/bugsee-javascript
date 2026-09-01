import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

// Synchronous owner-only (0o600/0o700) node:fs helpers (design §3.4: Node storage under tmpdir,
// files written mode 0o600). The fs-backed CaptureStore in @bugsee/node builds on these. Sync keeps
// the impl race-free and simple; reads/lists treat a missing path as empty rather than throwing.

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

/** Create `dir` (and parents) if absent, owner-only. Idempotent. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

/** Write `data` to `file`, replacing any existing content, owner-only. */
export function writeFileSecure(file: string, data: Uint8Array | string): void {
  writeFileSync(file, data, { mode: FILE_MODE });
}

/**
 * Write `data` to `file` ATOMICALLY and owner-only: a temp sibling, fsync'd, then renamed into place.
 *
 * For any file whose DETERMINISTIC final name is treated as proof of a complete artifact — a staged
 * bundle above all, where recovery parses the header and uploads whatever body follows. `writeFileSync`
 * truncates its target before writing, so a crash or an ENOSPC part-way leaves a parseable header over a
 * truncated body, and recovery then uploads a corrupt bundle as though it were valid. A rename is atomic
 * on POSIX, so the final name only ever refers to a file that was written in full. This is Android's
 * invariant too (`IssueReportingRequest.publishFinalBundle` fsyncs, renames, and CHECKS the rename).
 *
 * The temp sibling carries the pid so two processes sharing a directory cannot collide on it.
 */
export function writeFileAtomic(file: string, data: Uint8Array | string): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(temp, 'w', FILE_MODE);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd); // durable BEFORE the rename, so the rename cannot publish an empty file
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (error) {
    remove(temp); // best-effort: never leave a partial sibling behind
    throw error;
  }
}

/** Append `data` to `file`, creating it owner-only on first write. */
export function appendFileSecure(file: string, data: Uint8Array | string): void {
  appendFileSync(file, data, { mode: FILE_MODE });
}

/** Read `file`'s bytes, or undefined if it does not exist. */
export function readFileBytes(file: string): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(file));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

/** List file names directly under `dir`, or [] if the directory does not exist. */
export function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
}

/** Delete a file or directory tree; a no-op if the path is missing. */
export function remove(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
