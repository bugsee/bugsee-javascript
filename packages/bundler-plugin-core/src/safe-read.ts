// Bounded, race-resistant reads of build-output files.
//
// A path in a build output is untrusted input to a diagnostic: it can be a FIFO (opening it blocks for ever), a
// device (`/dev/zero` never ends), a symlink out of the tree, or a file that is swapped between a check and the
// read. So the file is OPENED first (without following a symlink in the last component, and without blocking on a
// FIFO), and every judgement (regular file? how big?) is made on the open descriptor, not on the path.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export type ReadResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: string; tooLarge?: { size: number } };

/** `O_NOFOLLOW` / `O_NONBLOCK` are absent on some platforms (Windows): then the descriptor checks still apply. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Read a regular file of at most `limit` bytes. Never follows a symlink in the last component (ELOOP is "is a
 * symbolic link"), never blocks on a FIFO, never reads a device, and never reads more than the size the open
 * descriptor reported. A failure is a value, not a throw.
 */
export async function readRegularFile(path: string, limit: number): Promise<ReadResult> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    return {
      ok: false,
      reason: code === 'ELOOP' ? 'is a symbolic link' : `could not be read (${code})`,
    };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      return { ok: false, reason: 'is not a regular file' };
    }
    if (info.size > limit) {
      return { ok: false, reason: 'is too large to read', tooLarge: { size: info.size } };
    }
    const bytes = Buffer.alloc(info.size);
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled);
      /* v8 ignore next 3 -- a file truncated between the stat and the read; not reproducible deterministically */
      if (bytesRead === 0) {
        break; // the file shrank after the stat: judge what is there
      }
      filled += bytesRead;
    }
    return { ok: true, bytes: filled === bytes.length ? bytes : bytes.subarray(0, filled) };
    /* v8 ignore start -- an I/O error on an already open regular file (EIO); not reproducible in a test */
  } catch (error) {
    return {
      ok: false,
      reason: `could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`,
    };
    /* v8 ignore stop */
  } finally {
    await handle.close();
  }
}
